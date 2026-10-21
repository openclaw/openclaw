import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  removeTempDirectory as remove,
  removeTempDirectoryAsync as removeAsync,
} from "./sqlite-readonly-location-cleanup.js";
import { defer, deferAsync, useSqliteTempDirs } from "./sqlite-shard-lifecycle.test-support.js";
import { beginSqliteSnapshotRetirement } from "./sqlite-snapshot-retirement.js";
import * as probe from "./sqlite-snapshot-staging-owner.test-support.js";
import {
  createSqliteSnapshotStagingDirectory as createStaging,
  createSqliteSnapshotStagingDirectorySync as createStagingSync,
} from "./sqlite-snapshot-staging.js";
import { acquireSqliteStagingToken } from "./sqlite-staging-token.js";

const tempDirs = useSqliteTempDirs(() => vi.restoreAllMocks());

const createFixture = () => probe.createStagingFixture(tempDirs.make("sqlite-staging-ownership-"));

it("preserves a live child during parent cleanup", async () => {
  const { cache, source } = createFixture();
  const parent = await createStaging(cache, false, undefined, true);
  const child = await createStaging(parent, false, undefined, true);
  const location = path.join(child, "database.sqlite");
  fs.copyFileSync(source, location);
  await using _ = deferAsync(async () => {
    await removeAsync(child);
    await removeAsync(parent);
  });
  expect(await removeAsync(parent)).toBe(false);
  probe.expectWrappedProbe(location);
  expect([await removeAsync(child), await removeAsync(parent)]).toEqual([true, true]);
});

const prefix = "openclaw-sqlite-readonly-v2-";
it.each([
  [`${prefix}Parent`, "", "owner.sqlite-journal", true],
  [`${prefix}Parent`, "other", undefined, true],
  ["generic", "", undefined, true],
  [`${prefix}Orphan`, "", undefined, false],
] as const)("refuses unowned retirement: %s/%s, %s", (parentName, layout, artifact, nested) => {
  const { cache, source } = createFixture();
  const parent = path.join(cache, parentName);
  const orphan = nested ? path.join(parent, layout, `${prefix}Orphan`) : parent;
  fs.mkdirSync(orphan, { recursive: true });
  const payload = path.join(parent, "database.sqlite");
  if (nested) {
    fs.copyFileSync(source, payload);
  }
  if (artifact) {
    fs.writeFileSync(path.join(orphan, artifact), "retain");
  }
  const token = nested ? acquireSqliteStagingToken(parent, "create") : undefined;
  using _ = defer(() => token?.());
  expect(() => beginSqliteSnapshotRetirement(parent, { token })).toThrow(
    "SQLite snapshot token ownership is unknown",
  );
  if (nested) {
    probe.expectWrappedProbe(payload);
  }
  expect(fs.existsSync(orphan)).toBe(true);
});

it.each([false, true])("cleans owned legacy staging (async: %s)", async (asynchronous) => {
  const { cache, source } = createFixture();
  const directory = await createStaging(cache, true, undefined, asynchronous);
  fs.copyFileSync(source, path.join(directory, "database.sqlite"));
  expect(asynchronous ? await removeAsync(directory) : remove(directory)).toBe(true);
  expect(fs.existsSync(directory)).toBe(false);
});

it.each([
  "directory",
  "token",
  ...(process.platform === "win32" ? (["unknown"] as const) : []),
] as const)("preserves payload after %s identity drift", (kind) => {
  const { cache, source } = createFixture();
  const directory = createStagingSync(cache);
  const location = path.join(directory, "database.sqlite");
  fs.copyFileSync(source, location);
  const target = kind === "token" ? path.join(directory, "owner.sqlite") : directory;
  const lstat = fs.lstatSync;
  const changed = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (stat && String(args[0]) === target && typeof stat.ino === "bigint") {
      Object.defineProperty(stat, "ino", { value: kind === "unknown" ? 0n : stat.ino + 1n });
    }
    return stat;
  });
  using _ = defer(() => {
    changed.mockRestore();
    expect(remove(directory)).toBe(true);
  });
  expect(remove(directory)).toBe(false);
  probe.expectWrappedProbe(location);
});
