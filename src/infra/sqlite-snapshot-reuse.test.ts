import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { useSqliteTempDirs } from "./sqlite-shard-lifecycle.test-support.js";
import {
  bindReusableSqliteSource,
  captureReusableSqliteSource,
  leaseReusableSqliteSnapshot,
  publishBoundReusableSqliteSnapshot,
  publishReusableSqliteSnapshot,
  withSqliteSnapshotReuse,
} from "./sqlite-snapshot-reuse.js";

const directories = useSqliteTempDirs();
const aged = new Date(Date.now() - 60_000);

/** Each test owns a scope; nothing here can outlive it. */
function reusing(name: string, body: () => void | Promise<void>) {
  it(name, () => withSqliteSnapshotReuse(async () => body()));
}

/** A settled source plus one image, with the producer's retirement observable. */
function seed() {
  const root = directories.make("sqlite-snapshot-reuse-");
  const source = path.join(root, "source.sqlite");
  fs.writeFileSync(source, "main");
  fs.utimesSync(source, aged, aged);
  const location = path.join(root, "image.sqlite");
  fs.writeFileSync(location, "image");
  const retire = vi.fn();
  const captured = captureReusableSqliteSource(source);
  expect(captured).toBeDefined();
  return {
    source,
    retire,
    lease: publishReusableSqliteSnapshot(source, captured!, { location }, retire),
    location,
  };
}

reusing("lends one image to interleaved readers while the source is unchanged", () => {
  const { source, retire, lease, location } = seed();
  const second = leaseReusableSqliteSnapshot(source);
  lease.cleanup();
  const third = leaseReusableSqliteSnapshot(source);
  expect([second?.location, third?.location]).toEqual([location, location]);
  second?.cleanup();
  third?.cleanup();
  expect(retire).not.toHaveBeenCalled();
});

reusing("retires instead of lending once a commit changes the source", () => {
  const { source, retire, lease } = seed();
  fs.writeFileSync(`${source}-wal`, "frame");
  expect(leaseReusableSqliteSnapshot(source)).toBeUndefined();
  // The image stays until its current reader leaves.
  expect(retire).not.toHaveBeenCalled();
  lease.cleanup();
  lease.cleanup();
  expect(retire).toHaveBeenCalledOnce();
});

reusing("refuses reuse across a replaced main file and a rollback journal", () => {
  const replaced = seed();
  const replacement = `${replaced.source}.next`;
  fs.writeFileSync(replacement, "main");
  fs.utimesSync(replacement, aged, aged);
  fs.renameSync(replacement, replaced.source);
  expect(leaseReusableSqliteSnapshot(replaced.source)).toBeUndefined();

  const journaled = seed();
  fs.writeFileSync(`${journaled.source}-journal`, "hot");
  expect(leaseReusableSqliteSnapshot(journaled.source)).toBeUndefined();
  expect(captureReusableSqliteSource(journaled.source)).toBeUndefined();
});

reusing("ignores changes that leave committed bytes alone", () => {
  const { source } = seed();
  // Readers can leave an empty WAL and an index behind.
  fs.writeFileSync(`${source}-wal`, "");
  fs.writeFileSync(`${source}-shm`, "index");
  expect(leaseReusableSqliteSnapshot(source)).toBeDefined();
});

reusing("keeps lending when root SQLite fchowns the WAL on open", () => {
  const root = directories.make("sqlite-snapshot-reuse-");
  const source = path.join(root, "source.sqlite");
  fs.writeFileSync(source, "main");
  fs.writeFileSync(`${source}-wal`, "frame");
  for (const file of [source, `${source}-wal`]) {
    fs.utimesSync(file, aged, aged);
  }
  const location = path.join(root, "image.sqlite");
  fs.writeFileSync(location, "image");
  publishReusableSqliteSnapshot(
    source,
    captureReusableSqliteSource(source)!,
    { location },
    vi.fn(),
  );
  // A same-mode chmod changes ctime alone, as fchown does.
  fs.chmodSync(`${source}-wal`, fs.statSync(`${source}-wal`).mode);
  expect(leaseReusableSqliteSnapshot(source)).toBeDefined();
});

reusing("sees commits and restores through an alias and preserved timestamps", async () => {
  const { source } = seed();
  const alias = `${source}.alias`;
  fs.symlinkSync(source, alias);
  expect(leaseReusableSqliteSnapshot(alias)).toBeDefined();
  fs.writeFileSync(`${source}-wal`, "frame");
  expect(leaseReusableSqliteSnapshot(alias)).toBeUndefined();

  const restored = seed();
  // Clear the filesystem's timestamp tick so the restore below is observable.
  await delay(50);
  // An in-place restore can keep size and mtime; only the main file's ctime moves.
  fs.writeFileSync(restored.source, "MAIN");
  fs.utimesSync(restored.source, aged, aged);
  expect(leaseReusableSqliteSnapshot(restored.source)).toBeUndefined();
});

reusing("does not retain a source written within the timestamp quantum", () => {
  const root = directories.make("sqlite-snapshot-reuse-");
  const source = path.join(root, "source.sqlite");
  fs.writeFileSync(source, "main");
  expect(captureReusableSqliteSource(source)).toBeUndefined();
});

reusing("leaves callers pinned to another identity to the producer's refusal", () => {
  const { source, retire } = seed();
  expect(leaseReusableSqliteSnapshot(source, { key: "other" })).toBeUndefined();
  expect(retire).not.toHaveBeenCalled();
  expect(leaseReusableSqliteSnapshot(source)).toBeDefined();
});

it("reuses only inside its scope and retires when the scope ends", async () => {
  let retire = vi.fn();
  let source = "";
  await withSqliteSnapshotReuse(async () => {
    const seeded = seed();
    ({ retire, source } = seeded);
    seeded.lease.cleanup();
    expect(retire).not.toHaveBeenCalled();
  });
  expect(retire).toHaveBeenCalledOnce();
  expect(leaseReusableSqliteSnapshot(source)).toBeUndefined();
  expect(captureReusableSqliteSource(source)).toBeUndefined();
});

reusing("joins a repeated publication of the same flight image", () => {
  const { source, retire, lease, location } = seed();
  const captured = captureReusableSqliteSource(source)!;
  const joinedRetire = vi.fn();
  const joined = publishReusableSqliteSnapshot(source, captured, { location }, joinedRetire);
  expect(joinedRetire).toHaveBeenCalledOnce();
  lease.cleanup();
  joined.cleanup();
  expect(retire).not.toHaveBeenCalled();
});

reusing("keeps a single-flight image under its producer's observation, not a late waiter's", () => {
  const root = directories.make("sqlite-snapshot-reuse-");
  const source = path.join(root, "source.sqlite");
  fs.writeFileSync(source, "main");
  fs.utimesSync(source, aged, aged);
  const location = path.join(root, "image.sqlite");
  fs.writeFileSync(location, "image");
  bindReusableSqliteSource(location, captureReusableSqliteSource(source));
  // A commit lands while the producer is still copying and a waiter joins.
  fs.writeFileSync(`${source}-wal`, "frame");
  fs.utimesSync(`${source}-wal`, aged, aged);
  const retire = vi.fn();
  publishBoundReusableSqliteSnapshot(source, { location }, retire);
  expect(leaseReusableSqliteSnapshot(source)).toBeUndefined();
});

reusing("returns an unbound image to its owner instead of retaining it", () => {
  const { source, location } = seed();
  const unbound = { location: `${location}.other` };
  expect(publishBoundReusableSqliteSnapshot(source, unbound, vi.fn())).toBe(unbound);
});
