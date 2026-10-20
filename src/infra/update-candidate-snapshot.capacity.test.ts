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
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
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
  return Promise.all(
    files.map(async (file) =>
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    ),
  );
}

function availableSpace(bytes: number) {
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
    targetPath,
    checkedPath: targetPath,
    availableBytes: bytes,
    totalBytes: 1024 ** 3,
  }));
}

it("admits one private generation and sequential scratch without reserving removed copies", async () => {
  const f = await fixture();
  availableSpace(100 * 1024 ** 2);
  const result = await f.assess();
  expect(result.exitCode, result.stderrTail ?? undefined).toBe(0);
  await f.unchanged();
});

it("copies and verifies both databases within the admitted capacity", async () => {
  const f = await fixture();
  await materializeUpdateCandidateStateWorker(f.root);
  availableSpace(100 * 1024 ** 2);
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

it("refuses insufficient capacity without changing the source databases", async () => {
  const f = await fixture();
  availableSpace(70 * 1024 ** 2);
  const result = await f.assess();
  expect(result.exitCode).toBe(1);
  expect(result.stderrTail).toContain("snapshot-capacity-insufficient");
  await f.unchanged();
});

it("defers unknown free space to the complete candidate check", async () => {
  const f = await fixture();
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue(null);
  const result = await f.assess();
  expect(result.exitCode).toBe(0);
  expect(result.diagnostics?.join("\n")).toContain("free space unknown");
});

it("keeps the larger allowance when the candidate omits the copy capability", async () => {
  const f = await fixture();
  await materializeUpdateCandidateStateWorker(f.root);
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
  availableSpace(100 * 1024 ** 2);
  await expect(f.prepare()).rejects.toMatchObject({
    capacity: { reason: "snapshot-capacity-insufficient" },
  });
  await f.unchanged();
});

it.each([
  ["global", { database: { engine: "postgres" } }],
  ["mixed-workboard", { database: { families: { workboard: { engine: "postgres" } } } }],
  [
    "global with SQLite built-in overrides",
    {
      database: {
        engine: "postgres",
        families: {
          state: { engine: "sqlite" },
          agent: { engine: "sqlite" },
          workboard: { engine: "sqlite" },
          logbook: { engine: "sqlite" },
          "team-reports": { engine: "sqlite" },
        },
      },
    },
  ],
] satisfies Array<[string, OpenClawConfig]>)(
  "keeps the larger allowance for %s PostgreSQL portable exports",
  async (_selection, config) => {
    const f = await fixture();
    await materializeUpdateCandidateStateWorker(f.root);
    availableSpace(100 * 1024 ** 2);
    const rehearsal = f.prepare({
      ...config,
      database: {
        ...config.database,
        postgres: { connection: "postgresql://fixture:fixture@127.0.0.1:1/snapshot_fixture" },
      },
    });
    try {
      await expect(rehearsal).rejects.toMatchObject({
        capacity: { reason: "snapshot-capacity-insufficient" },
      });
    } finally {
      await rehearsal.then(
        (result) => result.cleanup(),
        () => {},
      );
    }
    await f.unchanged();
  },
);
