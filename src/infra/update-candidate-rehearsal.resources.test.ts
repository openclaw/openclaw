import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as diskSpace from "./disk-space.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(sizeMiB = 0) {
  const root = tempDirs.make("candidate-resources-");
  const stateDir = path.join(root, "source");
  const file = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = openNodeSqliteDatabase(file);
  db.exec("CREATE TABLE evidence (value BLOB)");
  db.prepare("INSERT INTO evidence VALUES (zeroblob(?))").run(sizeMiB * 1024 * 1024);
  db.close();
  return { root, stateDir, file };
}

async function withSyntheticSnapshotWorker(
  body: string,
  run: (fixture: { root: string; stateDir: string; receipt: string }) => Promise<void>,
) {
  const root = tempDirs.make("candidate-progress-");
  const stateDir = path.join(root, "source");
  const receipt = path.join(root, "child.json");
  const worker = path.join(root, "dist", "infra", "update-candidate-state.worker.js");
  await fs.mkdir(stateDir);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    worker,
    `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { setTimeout as sleep } from "node:timers/promises";
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      const input = JSON.parse(text);
      const scratch = path.join(input.targetStateDir, ".sqlite-snapshot-fixture");
      await fs.mkdir(scratch);
      await fs.writeFile(${JSON.stringify(receipt)}, JSON.stringify({
        pid: process.pid,
        directory: input.targetStateDir,
      }));
      ${body}
    `,
  );
  const entrypoint = runtimeProcessEntrypoints.updateCandidateState;
  const currentModuleUrl = entrypoint.currentModuleUrl;
  Object.assign(entrypoint, {
    currentModuleUrl: pathToFileURL(path.join(root, "dist", "updater.js")).href,
  });
  try {
    await run({ root, stateDir, receipt });
  } finally {
    Object.assign(entrypoint, { currentModuleUrl });
  }
}

it("renews the snapshot deadline while the worker keeps writing its private copy", async () => {
  await withSyntheticSnapshotWorker(
    `
      for (let index = 0; index < 10; index++) {
        await fs.appendFile(path.join(scratch, "database.sqlite"), Buffer.alloc(1024));
        await sleep(250);
      }
      process.stdout.write(JSON.stringify({ versions: [], pluginPaths: {} }));
    `,
    async ({ root, stateDir }) => {
      const started = Date.now();
      const realStarted = performance.now();
      vi.spyOn(Date, "now").mockImplementation(
        () => started + (performance.now() - realStarted) * 200,
      );
      const rehearsal = await prepareUpdateCandidateRehearsal({
        config: {},
        stateDir,
        candidateRoot: root,
        timeoutMs: 300_000,
        signal: AbortSignal.timeout(10_000),
        env: {},
      });
      try {
        expect(Date.now() - started).toBeGreaterThan(300_000);
        expect(
          (
            await fs.stat(
              path.join(rehearsal.stateDir, ".sqlite-snapshot-fixture", "database.sqlite"),
            )
          ).size,
        ).toBe(10 * 1024);
      } finally {
        await rehearsal.cleanup();
      }
      await expect(fs.readdir(stateDir)).resolves.toEqual([]);
    },
  );
});

it("reaps a stalled snapshot worker before removing its database and WAL scratch", async () => {
  await withSyntheticSnapshotWorker(
    `
      await fs.writeFile(path.join(scratch, "database.sqlite"), "partial database");
      await fs.writeFile(path.join(scratch, "database.sqlite-wal"), "partial WAL");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `,
    async ({ root, stateDir, receipt }) => {
      const started = Date.now();
      const realStarted = performance.now();
      vi.spyOn(Date, "now").mockImplementation(
        () => started + (performance.now() - realStarted) * 200,
      );
      await expect(
        prepareUpdateCandidateRehearsal({
          config: {},
          stateDir,
          candidateRoot: root,
          timeoutMs: 300_000,
          signal: AbortSignal.timeout(10_000),
          env: {},
        }),
      ).rejects.toThrow(/snapshot made no progress.*Check storage performance/);
      const child = z
        .object({ pid: z.number().int().positive(), directory: z.string() })
        .parse(JSON.parse(await fs.readFile(receipt, "utf8")));
      expect(() => process.kill(child.pid, 0)).toThrow();
      await expect(fs.stat(child.directory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(stateDir)).resolves.toEqual([]);
    },
  );
});

it("keeps the SQLite startup floor when the caller supplies a smaller timeout", async () => {
  const f = await fixture(8);
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config: {},
    stateDir: f.stateDir,
    candidateRoot: f.root,
    timeoutMs: 1,
    env: {},
  });
  try {
    const db = openNodeSqliteDatabase(
      path.join(rehearsal.stateDir, "agents/main/agent/openclaw-agent.sqlite"),
    );
    expect(db.prepare("SELECT length(value) AS bytes FROM evidence").get()).toEqual({
      bytes: 8 * 1024 * 1024,
    });
    db.close();
  } finally {
    await rehearsal.cleanup();
  }
});

it.each([false, true])(
  "admits snapshot capacity before copying (state volume full: %s)",
  async (full) => {
    const f = await fixture();
    const before = await fs.readFile(f.file);
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: !full && targetPath.startsWith(f.stateDir + path.sep) ? 10 * 1024 ** 3 : 0,
      totalBytes: 10 * 1024 ** 3,
    }));
    const pending = prepareUpdateCandidateRehearsal({
      config: {},
      stateDir: f.stateDir,
      candidateRoot: f.root,
      env: {},
    });
    if (full) {
      try {
        const outcome = await pending.then(
          () => "unexpected success",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(outcome).toMatch(/snapshot.*requires.*available/i);
        expect(outcome).toContain(os.tmpdir());
        expect(outcome).toContain(path.join(f.stateDir, "tmp"));
        expect(await fs.readdir(f.stateDir)).toEqual(["agents"]);
      } finally {
        await pending.then(
          (rehearsal) => rehearsal.cleanup(),
          () => undefined,
        );
      }
    } else {
      const rehearsal = await pending;
      try {
        expect(
          rehearsal.stateDir.startsWith(path.join(await fs.realpath(f.stateDir), "tmp") + path.sep),
        ).toBe(true);
        expect(rehearsal.env.TMPDIR).toBe(rehearsal.stateDir);
        expect(rehearsal.env.XDG_CACHE_HOME).toBe(path.join(rehearsal.stateDir, "cache"));
      } finally {
        await rehearsal.cleanup();
      }
    }
    expect(await fs.readFile(f.file)).toEqual(before);
  },
);
