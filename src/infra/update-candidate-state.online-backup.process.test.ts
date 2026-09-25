import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { findVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { runCommandBuffered } from "../process/exec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  UpdateCandidateSnapshotInventorySchema,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";

let fixtureCompletion: Promise<void> | undefined;
let releaseFixture: (() => void) | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Vitest cancellation can finish the test before its async body reaches finally.
    // Join the body and the existing process owner before removing their files.
    try {
      await fixtureCompletion;
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      // The test already reports ordinary failures; only uncertain cleanup retains state.
    }
    cleanup();
    releaseFixture?.();
    releaseFixture = undefined;
    fixtureCompletion = undefined;
  }),
);

async function waitForFile(file: string): Promise<void> {
  await expect
    .poll(async () => fs.readFile(file, "utf8").catch(() => ""), {
      timeout: 10_000,
    })
    .not.toBe("");
}

async function readWriterGeneration(file: string): Promise<number> {
  // Ignore an in-flight final record; only newline-terminated commits are observable.
  const generations = (await fs.readFile(file, "utf8")).split("\n");
  return Number(generations.at(-2) ?? -1);
}

it.for(["inventory", "snapshot"] as const)(
  "%s acquires coherent rehearsal copies while an independent WAL writer commits",
  { timeout: 30_000 },
  async (mode, { signal }) => {
    if (fixtureCompletion) {
      throw new Error("Previous online-backup fixture did not finish cleanup");
    }
    // A retained fixture must survive the enclosing runner's namespace cleanup too.
    releaseFixture = findVitestResourceOwner()?.claim();
    await (fixtureCompletion = withCommandProcessScope(async () => {
      const root = await fs.realpath(tempDirs.make("rehearsal-online-backup-"));
      const stateDir = path.join(root, "source");
      const targetStateDir = path.join(root, "candidate");
      const candidateRoot = path.join(root, "package");
      const shared = path.join(stateDir, "state", "openclaw.sqlite");
      const agent = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      for (const file of [shared, agent]) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const db = openNodeSqliteDatabase(file);
        try {
          db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA user_version = 3;
          CREATE TABLE witness (id INTEGER PRIMARY KEY, generation INTEGER, inverse INTEGER);
          INSERT INTO witness VALUES (1, 0, 0), (2, 0, 0);
          CREATE TABLE payload (bytes BLOB);
          INSERT INTO payload VALUES (zeroblob(4194304));
        `);
          if (file === shared) {
            db.exec("CREATE TABLE agent_databases (path TEXT);");
            db.prepare("INSERT INTO agent_databases VALUES (?)").run(
              path.relative(stateDir, agent),
            );
          }
        } finally {
          db.close();
        }
      }
      await fs.mkdir(candidateRoot);
      await fs.writeFile(path.join(candidateRoot, "package.json"), '{"type":"module"}');
      const ready = path.join(root, "writer-ready");
      const stop = path.join(root, "writer-stop");
      const progress = path.join(root, "writer-progress");
      const writer = path.join(root, "writer.mjs");
      await fs.writeFile(
        writer,
        `
      import fs from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      import { setTimeout as sleep } from "node:timers/promises";
      const files = ${JSON.stringify([shared, agent])};
      const stores = files.map(file => new DatabaseSync(file));
      try {
        for (const db of stores) db.exec("PRAGMA busy_timeout = 1000; PRAGMA wal_autocheckpoint = 128;");
        fs.writeFileSync(${JSON.stringify(progress)}, "");
        fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        let generation = 0;
        while (!fs.existsSync(${JSON.stringify(stop)})) {
          for (const db of stores) {
            db.exec("BEGIN IMMEDIATE");
            db.prepare("UPDATE witness SET generation = ?, inverse = ?").run(generation, -generation);
            db.exec("COMMIT");
          }
          fs.appendFileSync(${JSON.stringify(progress)}, String(generation++) + "\\n");
          for (const file of files) {
            if (fs.statSync(file + "-wal").size > 16 * 1024 * 1024) {
              throw new Error("bounded writer WAL exceeded 16 MiB");
            }
          }
          await sleep(10);
        }
        process.stdout.write(JSON.stringify({ generation }));
      } finally {
        for (const db of stores) db.close();
      }
    `,
      );
      const preload = path.join(root, "slow-source-copy.cjs");
      const backups = path.join(root, "backups.jsonl");
      // Reproduce a busy family changing during raw copy without replacing SQLite or its worker.
      await fs.writeFile(
        preload,
        `
      const fs = require("node:fs");
      const sqlite = require("node:sqlite");
      const backup = sqlite.backup;
      sqlite.backup = async function(source, destination, ...args) {
        fs.appendFileSync(${JSON.stringify(backups)}, JSON.stringify({ destination }) + "\\n");
        return backup(source, destination, ...args);
      };
      const opened = new Map();
      const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
      const sources = new Set(${JSON.stringify([shared, agent])});
      fs.openSync = function(file, ...args) {
        const fd = open.call(this, file, ...args);
        if (sources.has(String(file))) opened.set(fd, true);
        return fd;
      };
      fs.readSync = function(fd, buffer, offset, length, position) {
        if (opened.has(fd) && length >= 1024 * 1024) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        }
        return read.call(this, fd, buffer, offset, length, position);
      };
      fs.closeSync = function(fd) { opened.delete(fd); return close.call(this, fd); };
    `,
      );
      const workerArgv = [
        process.execPath,
        "--require",
        preload,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
        ),
      ];
      const input = {
        stateDir,
        targetStateDir,
        candidateRoot,
        config: {},
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      };
      const runWorker = (request: object) =>
        runCommandBuffered(workerArgv, {
          input: JSON.stringify({ ...input, ...request }),
          signal,
          timeoutMs: 20_000,
          killGraceMs: 500,
          maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
          env: { XDG_CACHE_HOME: path.join(root, "cache"), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        });
      let admission: { pluginPlanPath: string; databaseInventory: string[] } | undefined;
      if (mode === "snapshot") {
        const initial = await runWorker({ mode: "inventory" });
        expect(initial.code, initial.stderr.toString()).toBe(0);
        const inventory = UpdateCandidateSnapshotInventorySchema.parse(
          JSON.parse(initial.stdout.toString()),
        );
        admission = {
          pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
          databaseInventory: [...inventory.databases.keys()],
        };
      }
      await fs.writeFile(backups, "");
      const writing = runCommandBuffered([process.execPath, writer], {
        signal,
        timeoutMs: 30_000,
        killGraceMs: 500,
        maxOutputBytes: { stdout: 4096, stderr: 4096 },
      });
      try {
        await waitForFile(ready);
        await expect
          .poll(() => readWriterGeneration(progress), { timeout: 10_000 })
          .toBeGreaterThanOrEqual(0);
        const before = await readWriterGeneration(progress);
        const result = await runWorker({ mode, ...admission });
        expect(result.code, result.stderr.toString()).toBe(0);
        // One fresh materialization per source; verification consumes that private image.
        expect((await fs.readFile(backups, "utf8")).split("\n").filter(Boolean)).toHaveLength(
          mode === "snapshot" ? 2 : 1,
        );
        const observedAfter = await readWriterGeneration(progress);
        expect(observedAfter).toBeGreaterThan(before);
        // A committed generation can precede its watermark; join the writer before bounding copies.
        await fs.writeFile(stop, "stop");
        await writing;
        const after = await readWriterGeneration(progress);
        if (mode === "inventory") {
          const inventory = UpdateCandidateSnapshotInventorySchema.parse(
            JSON.parse(result.stdout.toString()),
          );
          expect([...inventory.databases.keys()]).toEqual(expect.arrayContaining([shared, agent]));
        } else {
          const snapshot = UpdateCandidateStateSnapshotSchema.parse(
            JSON.parse(result.stdout.toString()),
          );
          expect(snapshot.versions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: shared, userVersion: 3 }),
              expect.objectContaining({ path: agent, userVersion: 3 }),
            ]),
          );
          for (const source of [shared, agent]) {
            const db = openNodeSqliteDatabase(
              path.join(targetStateDir, path.relative(stateDir, source)),
              { readOnly: true },
            );
            try {
              expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
              const rows = db.prepare("SELECT generation, inverse FROM witness ORDER BY id").all();
              expect(rows).toHaveLength(2);
              expect(rows[0]).toEqual(rows[1]);
              expect(rows[0]?.generation).toBeGreaterThanOrEqual(before);
              expect(rows[0]?.generation).toBeLessThanOrEqual(after);
              expect(Number(rows[0]?.generation) + Number(rows[0]?.inverse)).toBe(0);
              expect(db.prepare("SELECT length(bytes) AS bytes FROM payload").get()).toEqual({
                bytes: 4194304,
              });
            } finally {
              db.close();
            }
          }
        }
        console.log(
          JSON.stringify({
            mode,
            writerPid: Number(await fs.readFile(ready, "utf8")),
            before,
            after,
          }),
        );
      } finally {
        await fs.writeFile(stop, "stop");
        const ended = await writing;
        expect(ended.code, ended.stderr.toString()).toBe(0);
      }
      for (const source of [shared, agent]) {
        const db = openNodeSqliteDatabase(source, { readOnly: true });
        try {
          expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
          expect(
            db.prepare("SELECT count(*) AS n FROM witness WHERE generation + inverse != 0").get(),
          ).toEqual({ n: 0 });
          expect(db.prepare("SELECT length(bytes) AS bytes FROM payload").get()).toEqual({
            bytes: 4194304,
          });
        } finally {
          db.close();
        }
      }
    }, signal));
  },
);
