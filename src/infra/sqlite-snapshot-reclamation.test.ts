import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { reclaimAbandonedSqliteSnapshots } from "./sqlite-snapshot-reclamation.js";
import {
  acquireSqliteSnapshotReadToken,
  createSqliteSnapshotStagingTokenSync,
} from "./sqlite-snapshot-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
const hours = (count: number) => count * 60 * 60_000;

function age(location: string, ms: number): void {
  const time = new Date(Date.now() - ms);
  for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
    const child = path.join(location, entry.name);
    if (entry.isDirectory()) {
      age(child, ms);
    } else {
      fs.utimesSync(child, time, time);
    }
  }
  fs.utimesSync(location, time, time);
}

/** A snapshot whose creator wrote a nested child copy, then exited without retiring it. */
function strand(root: string, idleMs: number, hold?: "creator" | "reader") {
  const outer = createSqliteSnapshotStagingTokenSync(root);
  const child = createSqliteSnapshotStagingTokenSync(outer.directory);
  fs.writeFileSync(path.join(child.directory, "database.sqlite"), "copied bytes");
  fs.writeFileSync(path.join(child.directory, "database.sqlite.partial"), "interrupted compaction");
  child.release();
  let release: () => void = () => {};
  if (hold === "creator") {
    release = outer.release;
  } else {
    outer.release();
    if (hold === "reader") {
      release = acquireSqliteSnapshotReadToken(outer.directory);
    }
  }
  age(outer.directory, idleMs);
  return { directory: outer.directory, release };
}

describe.skipIf(process.platform === "win32")("abandoned SQLite snapshot reclamation", () => {
  function installation() {
    const base = tempDirs.make("sqlite-stranded-");
    vi.stubEnv("XDG_CACHE_HOME", path.join(base, "cache"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
    const own = resolvePrivateSqliteSnapshotStagingRoot();
    const parent = path.dirname(own);
    const foreign = path.join(parent, `sqlite-${"0e5d8581".repeat(3)}`);
    fs.mkdirSync(foreign, { mode: 0o700 });
    return { own, parent, foreign };
  }
  const sweep = () => reclaimAbandonedSqliteSnapshots(new AbortController().signal);

  it("reclaims day-old copies stranded beside this installation's namespace", async () => {
    const { own, parent, foreign } = installation();
    const stranded = [strand(foreign, hours(25)), strand(parent, hours(25))];
    const ownCopy = strand(own, hours(1));

    expect(await sweep()).toMatchObject({ removed: 3, skipped: 0 });
    for (const { directory } of [...stranded, ownCopy]) {
      expect(fs.existsSync(directory)).toBe(false);
    }
    // Namespaces stay; another installation may allocate into its own at any time.
    expect(fs.readdirSync(parent).toSorted()).toEqual(
      [path.basename(foreign), path.basename(own)].toSorted(),
    );
  });

  it("keeps stranded copies that are recent, held, or carry no lifetime token", async () => {
    const { parent, foreign } = installation();
    const recent = strand(foreign, hours(1));
    const creator = strand(foreign, hours(25), "creator");
    const reader = strand(parent, hours(25), "reader");
    const tokenless = path.join(foreign, "openclaw-sqlite-readonly-v2-aB3dE6");
    fs.mkdirSync(tokenless, { mode: 0o700 });
    fs.writeFileSync(path.join(tokenless, "database.sqlite"), "unknown owner");
    age(tokenless, hours(25));
    // An unreadable sibling is counted and skipped; it never fails the sweep.
    const unreadable = path.join(parent, `sqlite-${"ac549b06".repeat(3)}`);
    fs.mkdirSync(unreadable, { mode: 0o000 });
    try {
      expect(await sweep()).toEqual({ removed: 0, bytes: 0, skipped: 5 });
      for (const directory of [recent.directory, creator.directory, reader.directory, tokenless]) {
        expect(fs.existsSync(directory)).toBe(true);
      }
    } finally {
      fs.chmodSync(unreadable, 0o700);
      creator.release();
      reader.release();
    }
    // Once their holders exited a day ago, the same copies are reclaimed.
    age(creator.directory, hours(25));
    age(reader.directory, hours(25));
    expect(await sweep()).toMatchObject({ removed: 2, skipped: 2 });
    expect(fs.existsSync(creator.directory)).toBe(false);
    expect(fs.existsSync(reader.directory)).toBe(false);
  });
});
