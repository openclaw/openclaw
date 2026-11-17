import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import {
  createSqliteReadOnlyWorkerScope,
  reclaimAbandonedSqliteSnapshots,
} from "./sqlite-readonly-worker.js";
import {
  acquireSqliteSnapshotReadToken,
  createSqliteSnapshotStagingTokenSync,
} from "./sqlite-snapshot-staging.js";

// mock-isolation: Observe the real child's physical close; keep native execution unchanged.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { mockChildProcesses } = await import("./sqlite-readonly.test-support.js");
  return mockChildProcesses(actual);
});

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
  return {
    directory: outer.directory,
    payload: path.join(child.directory, "database.sqlite"),
    release,
  };
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

  it("reclaims abandoned inspection trees containing the schema discovery ownership record", async () => {
    const { own } = installation();
    const { directory } = strand(own, hours(1));
    fs.writeFileSync(path.join(directory, "schema-discovery-ownership.json"), "{}");
    age(directory, hours(1));

    expect(await sweep()).toMatchObject({ removed: 1, skipped: 0 });
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("reclaims day-old copies stranded beside this installation's namespace", async () => {
    const { own, parent, foreign } = installation();
    expect(isMainThread).toBe(true);
    {
      using observed = observeMainThreadFs();
      expect(await sweep()).toEqual({ removed: 0, bytes: 0, skipped: 0 });
      expect(observed.calls()).toEqual({});
    }
    const stranded = [strand(foreign, hours(25)), strand(parent, hours(25))];
    const ownCopy = strand(own, hours(1));

    {
      using observed = observeMainThreadFs();
      expect(await sweep()).toMatchObject({ removed: 3, skipped: 0 });
      expect(observed.calls()).toEqual({});
    }
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

  it.for(["caller", "scope"] as const)(
    "joins the real installation sweep before %s cancellation settles",
    async (ending, { signal }) => {
      const { own, foreign } = installation();
      const abandoned = strand(own, hours(1));
      const held = strand(foreign, hours(25), "reader");
      const root = tempDirs.make("sqlite-sweep-cancel-");
      const preload = path.join(root, "hold-retirement.mjs");
      fs.writeFileSync(
        preload,
        `import fs from "node:fs";
const remove = fs.rmSync;
fs.rmSync = (target, ...args) => {
  if (process.argv.includes("staging-sweep") && target === ${JSON.stringify(abandoned.payload)}) {
    fs.writeFileSync(${JSON.stringify(path.join(root, "ready"))}, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return remove(target, ...args);
};
`,
      );
      const option = process.versions.bun ? "BUN_OPTIONS" : "NODE_OPTIONS";
      const previous = process.env[option];
      vi.stubEnv(
        option,
        [
          previous,
          `${process.versions.bun ? "--preload" : "--import"}=${pathToFileURL(preload).href}`,
        ]
          .filter(Boolean)
          .join(" "),
      );
      const entered = createDeferred();
      const watcher = fs.watch(root, (_event, filename) => {
        if (filename === "ready") {
          entered.resolve();
        }
      });
      const scope = createSqliteReadOnlyWorkerScope();
      const controller = new AbortController();
      const reason = new Error("snapshot maintenance stopped");
      vi.mocked(execFile).mockClear();
      const pending = scope.run(() => reclaimAbandonedSqliteSnapshots(controller.signal));
      void pending.catch(() => {});
      let closing: Promise<void> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, pending, "sweep settled before retirement"),
          signal,
        );
        const launched = vi
          .mocked(execFile)
          .mock.calls.findIndex(([, args]) => args?.includes("staging-sweep"));
        const result = vi.mocked(execFile).mock.results[launched];
        if (result?.type !== "return") {
          throw new Error("real sweep child was not captured");
        }
        const child = result.value;
        let closed = false;
        child.once("close", () => {
          closed = true;
        });
        const settled = pending.catch((error: unknown) => {
          expect(closed).toBe(true);
          throw error;
        });
        if (ending === "caller") {
          controller.abort(reason);
        } else {
          closing = scope.close();
        }
        await withinTest(
          expect(settled).rejects.toThrow(ending === "caller" ? reason.message : "scope closed"),
          signal,
        );
        await closing;
        expect(child.signalCode).toBe("SIGKILL");
        expect(fs.readFileSync(abandoned.payload, "utf8")).toBe("copied bytes");
        expect(fs.readFileSync(held.payload, "utf8")).toBe("copied bytes");
        vi.stubEnv(option, previous);
        age(abandoned.directory, hours(1));
        expect(await sweep()).toMatchObject({ removed: 1, skipped: 1 });
        expect(fs.existsSync(abandoned.directory)).toBe(false);
        expect(fs.existsSync(held.directory)).toBe(true);
      } finally {
        watcher.close();
        controller.abort(reason);
        await Promise.allSettled([pending, closing, scope.close()]);
        held.release();
      }
    },
  );
});
