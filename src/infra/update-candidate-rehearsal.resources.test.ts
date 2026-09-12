import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import * as diskSpace from "./disk-space.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
      if (input.mode === "inventory") {
        process.stdout.write(JSON.stringify({ databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json" }));
        process.exit(0);
      }
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
      availableBytes: !full && targetPath === `${f.stateDir}.update-captures` ? 10 * 1024 ** 3 : 0,
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
        expect(outcome).toContain(`${f.stateDir}.update-captures`);
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
          rehearsal.stateDir.startsWith(
            `${await fs.realpath(f.stateDir)}.update-captures${path.sep}`,
          ),
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

it.skipIf(process.platform === "win32")(
  "keeps the system temporary fallback when TMPDIR is full",
  async () => {
    const f = await fixture();
    const nominated = path.join(f.root, "operator-temp");
    await fs.mkdir(nominated);
    vi.stubEnv("TMPDIR", nominated);
    vi.stubEnv("TMP", undefined);
    vi.stubEnv("TEMP", undefined);
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: targetPath === "/tmp" ? 1024 ** 3 : 0,
      totalBytes: 1024 ** 3,
    }));
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config: {},
      stateDir: f.stateDir,
      candidateRoot: f.root,
      env: { ...process.env },
    });
    try {
      expect(rehearsal.snapshotCapacity).toMatchObject({
        reason: "system-tmpdir",
        candidates: expect.arrayContaining([
          { kind: "explicit-tmpdir", directory: nominated, availableBytes: 0 },
          { kind: "system-tmpdir", directory: "/tmp", availableBytes: 1024 ** 3 },
        ]),
      });
      expect(rehearsal.stateDir.startsWith(`${await fs.realpath("/tmp")}${path.sep}`)).toBe(true);
    } finally {
      await rehearsal.cleanup();
    }
  },
);

it.each([
  { explicit: 1024 ** 3, state: 1024 ** 3, system: 1024 ** 3, kind: "explicit-tmpdir" },
  { explicit: 0, state: 1024 ** 3, system: 1024 ** 3, kind: "state-volume" },
  { explicit: 0, state: 0, system: 1024 ** 3, kind: "system-tmpdir" },
  { explicit: null, state: 1024 ** 3, system: null, kind: "state-volume" },
])("selects $kind from measured snapshot capacity", async ({ explicit, state, system, kind }) => {
  const f = await fixture();
  const nominated = path.join(f.root, "operator-temp");
  await fs.mkdir(nominated);
  const sibling = `${f.stateDir}.update-captures`;
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => {
    const availableBytes =
      targetPath === nominated ? explicit : targetPath === sibling ? state : system;
    return availableBytes === null
      ? null
      : {
          targetPath,
          checkedPath: targetPath,
          availableBytes,
          totalBytes: 1024 ** 3,
        };
  });
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config: {},
    stateDir: f.stateDir,
    candidateRoot: f.root,
    env: { TMPDIR: nominated },
  });
  try {
    const root =
      kind === "explicit-tmpdir" ? nominated : kind === "state-volume" ? sibling : os.tmpdir();
    expect(rehearsal.stateDir.startsWith(`${await fs.realpath(root)}${path.sep}`)).toBe(true);
    expect(rehearsal.snapshotCapacity).toMatchObject({
      reason: kind,
      selection: { kind, directory: rehearsal.stateDir },
    });
  } finally {
    await rehearsal.cleanup();
  }
});

it("skips an explicit temporary path that is a file without changing it", async () => {
  const f = await fixture();
  const nominated = path.join(f.root, "operator-file");
  await fs.writeFile(nominated, "preserved");
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
    targetPath,
    checkedPath: path.dirname(targetPath),
    availableBytes: 1024 ** 3,
    totalBytes: 1024 ** 3,
  }));
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config: {},
    stateDir: f.stateDir,
    candidateRoot: f.root,
    env: { TMPDIR: nominated },
  });
  try {
    expect(rehearsal.snapshotCapacity).toMatchObject({
      reason: "state-volume",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          directory: nominated,
          allocationError: expect.stringContaining("directory"),
        }),
      ]),
    });
    expect(await fs.readFile(nominated, "utf8")).toBe("preserved");
  } finally {
    await rehearsal.cleanup();
  }
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "falls back when the state sibling parent is not writable",
  async () => {
    const f = await fixture();
    await fs.chmod(f.root, 0o500);
    let rehearsal: Awaited<ReturnType<typeof prepareUpdateCandidateRehearsal>> | undefined;
    try {
      rehearsal = await prepareUpdateCandidateRehearsal({
        config: {},
        stateDir: f.stateDir,
        candidateRoot: f.root,
        env: {},
      });
      expect(rehearsal.snapshotCapacity).toMatchObject({
        reason: "system-tmpdir",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            directory: `${f.stateDir}.update-captures`,
            allocationError: expect.stringContaining("EACCES"),
          }),
        ]),
      });
    } finally {
      await fs.chmod(f.root, 0o700);
      await rehearsal?.cleanup();
    }
  },
);

it.each([false, true])(
  "budgets active plugin payloads before copying (all volumes full: %s)",
  async (full) => {
    const f = await fixture();
    const plugin = path.join(f.stateDir, "npm/projects/demo/node_modules/demo");
    const nominated = path.join(f.root, "operator-temp");
    await fs.mkdir(nominated);
    await fs.mkdir(plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, "package.json"), '{"name":"demo"}');
    const payload = path.join(plugin, "payload.bin");
    await fs.writeFile(payload, "");
    await fs.truncate(payload, 160 * 1024 ** 2);
    const sibling = `${await fs.realpath(f.stateDir)}.update-captures`;
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: !full && targetPath === sibling ? 1024 ** 3 : 128 * 1024 ** 2,
      totalBytes: 1024 ** 3,
    }));
    const worker = vi.spyOn(exec, "runCommandBuffered");
    const pending = prepareUpdateCandidateRehearsal({
      config: { plugins: { installs: { demo: { source: "npm", installPath: plugin } } } },
      stateDir: f.stateDir,
      candidateRoot: f.root,
      env: { TMPDIR: nominated },
    });
    try {
      if (full) {
        await expect(pending).rejects.toMatchObject({
          capacity: {
            pluginBytes: expect.any(Number),
            requiredBytes: expect.any(Number),
            selection: null,
            candidates: expect.arrayContaining([
              expect.objectContaining({ directory: sibling, availableBytes: 128 * 1024 ** 2 }),
            ]),
          },
        });
        expect(
          worker.mock.calls.some(([, opts]) => JSON.parse(String(opts?.input)).mode === "snapshot"),
        ).toBe(false);
      } else {
        const rehearsal = await pending;
        expect(rehearsal.stateDir.startsWith(sibling + path.sep)).toBe(true);
        expect(rehearsal).toMatchObject({
          snapshotCapacity: {
            pluginBytes: expect.any(Number),
            selection: { kind: "state-volume", directory: rehearsal.stateDir },
          },
        });
        expect(
          (
            await fs.stat(
              path.join(rehearsal.stateDir, "npm/projects/demo/node_modules/demo/payload.bin"),
            )
          ).size,
        ).toBe(160 * 1024 ** 2);
      }
    } finally {
      await pending.then(
        (rehearsal) => rehearsal.cleanup(),
        () => undefined,
      );
    }
    expect((await fs.stat(payload)).size).toBe(160 * 1024 ** 2);
    expect(await fs.readdir(nominated)).toEqual([]);
  },
);
