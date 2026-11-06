import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { useSqliteTempDirs } from "./sqlite-shard-lifecycle.test-support.js";
import { withSqliteSnapshotReuse } from "./sqlite-snapshot-reuse.js";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-snapshot-source.js";

const worker = vi.hoisted(() => ({ copies: 0 }));

vi.mock("./sqlite-readonly-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-readonly-worker.js")>()),
  runSqliteReadOnlyWorkerSync: (source: string, stagingRoot: string) => {
    worker.copies += 1;
    const location = path.join(stagingRoot, "database.sqlite");
    fs.copyFileSync(source, location);
    return location;
  },
}));

const directories = useSqliteTempDirs();

function settledSource() {
  const source = path.join(directories.make("sqlite-source-reuse-"), "source.sqlite");
  fs.writeFileSync(source, "main");
  const aged = new Date(Date.now() - 60_000);
  fs.utimesSync(source, aged, aged);
  return source;
}

beforeEach(() => {
  worker.copies = 0;
});

it("copies an unchanged source once across a scope's read-only requests", () =>
  withSqliteSnapshotReuse(async () => {
    const source = settledSource();
    const first = prepareSqliteReadOnlyLocationSync(source, undefined, { reuse: true });
    const second = prepareSqliteReadOnlyLocationSync(source, undefined, { reuse: true });
    expect(second.location).toBe(first.location);
    first.cleanup();
    second.cleanup();
    const third = prepareSqliteReadOnlyLocationSync(source, undefined, { reuse: true });
    expect(fs.readFileSync(third.location, "utf8")).toBe("main");
    third.cleanup();
    expect(worker.copies).toBe(1);
  }));

it("copies again after a commit, and never lends to a caller that did not opt in", () =>
  withSqliteSnapshotReuse(async () => {
    const source = settledSource();
    const image = prepareSqliteReadOnlyLocationSync(source, undefined, { reuse: true });
    const exclusive = prepareSqliteReadOnlyLocationSync(source);
    expect(exclusive.location).not.toBe(image.location);
    expect(worker.copies).toBe(2);
    exclusive.cleanup();
    fs.writeFileSync(`${source}-wal`, "frame");
    const fresh = prepareSqliteReadOnlyLocationSync(source, undefined, { reuse: true });
    expect(fresh.location).not.toBe(image.location);
    expect(worker.copies).toBe(3);
    image.cleanup();
    fresh.cleanup();
  }));

it("copies per request outside a reuse scope", () => {
  const source = settledSource();
  const first = prepareSqliteReadOnlyLocationSync(source, undefined, { reuse: true });
  const second = prepareSqliteReadOnlyLocationSync(source, undefined, { reuse: true });
  expect(second.location).not.toBe(first.location);
  expect(worker.copies).toBe(2);
  first.cleanup();
  second.cleanup();
});
