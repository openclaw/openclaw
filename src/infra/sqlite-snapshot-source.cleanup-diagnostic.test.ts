import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteSnapshotSource } from "./sqlite-snapshot-source.js";

// The worker child is replaced so the snapshot source owner adopts a real outer
// staging root with an inner child directory, mirroring the production layout
// without spawning a process.
const workerMocks = vi.hoisted(() => ({
  runSqliteReadOnlyWorker:
    vi.fn<typeof import("./sqlite-readonly-worker.js").runSqliteReadOnlyWorker>(),
}));
vi.mock("./sqlite-readonly-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite-readonly-worker.js")>();
  return { ...actual, runSqliteReadOnlyWorker: workerMocks.runSqliteReadOnlyWorker };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
let cacheRoot: string;
beforeEach(() => {
  cacheRoot = tempDirs.make("openclaw-snapshot-cleanup-cache-");
  vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
  workerMocks.runSqliteReadOnlyWorker.mockReset();
});

function createDatabaseWithJournal(): string {
  const dir = tempDirs.make("openclaw-snapshot-cleanup-source-");
  const pathname = path.join(dir, "source.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('preserved');");
  database.close();
  // prepareSqliteSnapshotSource only checks that a -journal sidecar exists as a
  // regular file; a placeholder is enough to route through the worker path.
  fs.writeFileSync(`${pathname}-journal`, "rollback-journal-placeholder");
  return pathname;
}

describe("withSqliteSnapshotSource cleanup diagnostic", () => {
  it("reports the staging root cleanup owns, not the inner child location", async () => {
    const source = createDatabaseWithJournal();
    let stagingRoot: string | undefined;
    let innerChild: string | undefined;

    // The mocked worker mirrors the real child: it places its snapshot inside an
    // inner child of the staging root so cleanup owns the outer root.
    workerMocks.runSqliteReadOnlyWorker.mockImplementation(async (_pathname, options) => {
      stagingRoot = options.stagingRoot;
      innerChild = path.join(stagingRoot!, "worker-child");
      fs.mkdirSync(innerChild, { recursive: true });
      fs.writeFileSync(path.join(innerChild, "database.sqlite"), "private snapshot bytes");
      return path.join(innerChild, "database.sqlite");
    });

    const remove = fs.rmSync;
    // Recursive removal deletes the inner child first, then fails on the outer
    // staging root — leaving the diagnostic to name a directory that still exists.
    const stub = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const targetPath = String(target);
      if (stagingRoot && targetPath === stagingRoot && options?.recursive) {
        // Depth-first removal succeeds on the child before the outer root rejects
        // the final rmdir.
        remove(innerChild!, { force: true, recursive: true });
        throw Object.assign(new Error("staging root busy"), { code: "EBUSY" });
      }
      return remove(targetPath, options);
    });

    let message: string | undefined;
    try {
      await withSqliteSnapshotSource(source, async (snapshotPath) => {
        expect(fs.existsSync(snapshotPath)).toBe(true);
        return "operation-ok";
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      stub.mockRestore();
    }

    // The diagnostic must name the outer staging root cleanup owns (which still
    // exists on disk), not the inner child the recursive removal already deleted.
    expect(message).toMatch(/SQLite snapshot cleanup failed/);
    expect(stagingRoot).toBeDefined();
    expect(message).toContain(stagingRoot);
    expect(innerChild).toBeDefined();
    expect(message).not.toContain(innerChild!);
    expect(fs.existsSync(stagingRoot!)).toBe(true);
    expect(fs.existsSync(innerChild!)).toBe(false);
  });
});
