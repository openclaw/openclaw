import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import * as diskSpace from "./disk-space.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { assessInitialUpdateSnapshotCapacity } from "./update-candidate-snapshot.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const capacityFailure = { capacity: { reason: "snapshot-capacity-insufficient" } };
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture(mebibytes: number | null, worker = false) {
  const root = tempDirs.make("snapshot-capacity-");
  const stateDir = path.join(root, "source");
  const files = ["main", "second"].map((id) =>
    path.join(stateDir, "agents", id, "agent", "openclaw-agent.sqlite"),
  );
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = openNodeSqliteDatabase(file);
    try {
      db.exec("CREATE TABLE evidence (value BLOB)");
      db.prepare("INSERT INTO evidence VALUES (zeroblob(?))").run(8 * 1024 ** 2);
    } finally {
      db.close();
    }
  }
  if (worker) {
    await materializeUpdateCandidateStateWorker(root);
  }
  availableSpace(mebibytes === null ? null : mebibytes * 1024 ** 2);
  const before = await databaseHashes(files);
  const options = { config: {}, stateDir, candidateRoot: root, env: {} };
  return {
    root,
    stateDir,
    files,
    assess: () => assessInitialUpdateSnapshotCapacity(options),
    prepare: (config: OpenClawConfig = {}) =>
      prepareUpdateCandidateRehearsal({ ...options, config }),
    unchanged: async () => expect(await databaseHashes(files)).toEqual(before),
  };
}

async function databaseHashes(files: string[]) {
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return Promise.all(files.map(async (file) => hash(await fs.readFile(file))));
}

function availableSpace(bytes: number | null) {
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) =>
    bytes === null
      ? null
      : {
          targetPath,
          checkedPath: targetPath,
          availableBytes: bytes,
          totalBytes: 1024 ** 3,
        },
  );
}

it.each([
  { space: 100, exitCode: 0, diagnostic: "" },
  { space: 70, exitCode: 1, diagnostic: "snapshot-capacity-insufficient" },
  { space: null, exitCode: 0, diagnostic: "free space unknown" },
])(
  "preflights one generation with $space MiB free (exit=$exitCode)",
  async ({ space, exitCode, diagnostic }) => {
    const f = await fixture(space);
    const result = await f.assess();
    expect(result.exitCode, result.stderrTail ?? undefined).toBe(exitCode);
    if (diagnostic) {
      expect(result.stderrTail ?? result.diagnostics?.join("\n")).toContain(diagnostic);
    }
    await f.unchanged();
  },
);

it("copies and verifies both databases within the admitted capacity", async () => {
  const f = await fixture(100, true);
  const rehearsal = await f.prepare();
  try {
    expect(rehearsal.snapshotCapacity.requiredBytes).toBeLessThan(100 * 1024 ** 2);
    for (const file of f.files) {
      const copy = path.join(rehearsal.stateDir, path.relative(f.stateDir, file));
      const db = openNodeSqliteDatabase(copy, { readOnly: true });
      try {
        expect(db.prepare("SELECT length(value) AS bytes FROM evidence").get()).toEqual({
          bytes: 8 * 1024 ** 2,
        });
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        db.close();
      }
    }
  } finally {
    await rehearsal.cleanup();
  }
  await expect(fs.stat(rehearsal.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  await f.unchanged();
});

it("keeps the larger allowance when the candidate omits the copy capability", async () => {
  const f = await fixture(100, true);
  const worker = path.join(f.root, "dist", "infra", "update-candidate-state.worker.js");
  // Exercise the real worker, but present the inventory contract of an older candidate.
  const source = await fs.readFile(worker, "utf8");
  await fs.writeFile(
    worker,
    `const originalWrite = process.stdout.write.bind(process.stdout);
     process.stdout.write = (chunk, ...args) => {
       const output = JSON.parse(String(chunk));
       delete output.snapshotSpace;
       return originalWrite(JSON.stringify(output), ...args);
     };
     ${source}`,
  );
  await expect(f.prepare()).rejects.toMatchObject(capacityFailure);
  await f.unchanged();
});

it.each(["global", "mixed-workboard", "global with SQLite built-in overrides"] as const)(
  "keeps the larger allowance for %s PostgreSQL portable exports",
  async (selection) => {
    const f = await fixture(100, true);
    const database: OpenClawConfig["database"] =
      selection === "mixed-workboard"
        ? { families: { workboard: { engine: "postgres" } } }
        : { engine: "postgres" };
    if (selection === "global with SQLite built-in overrides") {
      database.families = Object.fromEntries(
        ["state", "agent", "workboard", "logbook", "team-reports"].map((family) => [
          family,
          { engine: "sqlite" } as const,
        ]),
      );
    }
    const rehearsal = f.prepare({
      database: {
        ...database,
        postgres: { connection: "postgresql://fixture:fixture@127.0.0.1:1/snapshot_fixture" },
      },
    });
    await rehearsal.then(
      async (result) => {
        await result.cleanup();
        expect.fail("Capacity preflight unexpectedly admitted a portable PostgreSQL export");
      },
      (error: unknown) => expect(error).toMatchObject(capacityFailure),
    );
    await f.unchanged();
  },
);
