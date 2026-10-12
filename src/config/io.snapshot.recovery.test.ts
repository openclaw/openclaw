import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as deferredMigrations from "../infra/deferred-plugin-migrations.js";
import { acquireStartupMigrationLeaseWithWait } from "../infra/startup-migration-checkpoint.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createConfigIoContext } from "./io.context.js";
import { createConfigIO } from "./io.factory.js";
import {
  captureConfigHealthStateStore,
  patchConfigHealthEntryToStore,
  readConfigHealthStateFromStore,
} from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";
import type { ConfigIoFactoryOptions } from "./io.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function manifest(root: string) {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .toSorted()
    .filter((entry) => fs.statSync(path.join(root, entry)).isFile())
    .map((entry) => [
      entry,
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, entry)))
        .digest("hex"),
    ]);
}

function clobberFiles(root: string) {
  return fs.readdirSync(root).filter((name) => name.startsWith("openclaw.json.clobbered."));
}

function expectUnchanged(root: string, configPath: string, original: string) {
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  expect(clobberFiles(root)).toEqual([]);
}

function fixture(options: ConfigIoFactoryOptions = {}) {
  const root = tempDirs.make("openclaw-prepared-config-recovery-");
  const configPath = path.join(root, "openclaw.json");
  const original = '{ "update": { "channel": "beta" } }\n';
  const backup = JSON.stringify({
    gateway: { mode: "local", port: 18720 },
    env: { vars: { RECOVERY_MARKER: "backup" } },
  });
  fs.writeFileSync(configPath, original);
  fs.writeFileSync(`${configPath}.bak`, backup);
  const env = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    VITEST: "true",
  };
  const databasePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const io = createConfigIO({
    env,
    configPath,
    homedir: () => root,
    observe: false,
    logger: { warn: vi.fn(), error: vi.fn() },
    ...options,
  });
  return { root, configPath, original, backup, databasePath, env, io };
}

async function prepare(io: ReturnType<typeof createConfigIO>) {
  const current = await withArtifactPreservingStateReads(() => io.readConfigFileSnapshot());
  return io.prepareConfigRecovery(current);
}

async function recovery(io: ReturnType<typeof createConfigIO>) {
  const plan = await prepare(io);
  if (!plan) {
    throw new Error("Expected a prepared recovery");
  }
  return plan;
}

describe("prepared config recovery", () => {
  it.each(["sync", "async"] as const)(
    "preserves unavailable dependencies when preparing a backup candidate (%s)",
    async (mode) => {
      const root = tempDirs.make("openclaw-backup-preparation-io-");
      const context = createConfigIoContext({
        configPath: path.join(root, "openclaw.json"),
        env: { HOME: root, OPENCLAW_STATE_DIR: root },
        observe: false,
      });
      const unavailable = Object.assign(new Error("migration metadata unavailable"), {
        code: "EIO",
      });
      const candidate = {
        raw: '{"gateway":{"mode":"local"}}',
        parsed: { gateway: { mode: "local" } },
      };
      if (mode === "sync") {
        const read = vi
          .spyOn(deferredMigrations, "readDeferredPluginMigrations")
          .mockImplementation(() => {
            throw unavailable;
          });
        try {
          expect(() => context.prepareRecoveryBackupCandidate(candidate)).toThrow(unavailable);
        } finally {
          read.mockRestore();
        }
      } else {
        const read = vi
          .spyOn(deferredMigrations, "readDeferredPluginMigrationsAsync")
          .mockRejectedValue(unavailable);
        try {
          await expect(context.prepareRecoveryBackupCandidateAsync(candidate)).rejects.toBe(
            unavailable,
          );
        } finally {
          read.mockRestore();
        }
      }
    },
  );

  it.each(["absent", "unparseable", "externally-owned"] as const)(
    "does not prepare recovery for %s config or backup",
    async (kind) => {
      const { root, configPath, original, io } = fixture();
      const backupPath = `${configPath}.bak`;
      const bytes = "{ not JSON5";
      if (kind === "absent") {
        fs.unlinkSync(backupPath);
      } else if (kind === "unparseable") {
        fs.writeFileSync(backupPath, bytes);
      } else {
        io.env.OPENCLAW_CONFIG_READONLY = "1";
      }
      const before = kind === "externally-owned" ? manifest(root) : undefined;
      await expect(prepare(io)).resolves.toBeNull();
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      if (kind === "unparseable") {
        expect(fs.readFileSync(backupPath, "utf8")).toBe(bytes);
      }
      expect(clobberFiles(root)).toEqual([]);
      if (kind === "externally-owned") {
        expect(manifest(root)).toEqual(before);
      }
    },
  );

  it.each(["sync-read", "sync-stat", "async-read", "async-stat"] as const)(
    "preserves unavailable backup I/O during %s instead of reporting recovery drift",
    async (phase) => {
      const readError = Object.assign(new Error("backup device unavailable"), { code: "EIO" });
      let armed = false;
      const isBackup = (target: fs.PathLike | number) => String(target).endsWith(".bak");
      const { root, configPath, original, backup, io } = fixture({
        fs: {
          ...fs,
          readFileSync: ((target: fs.PathOrFileDescriptor, options?: unknown) => {
            if (armed && isBackup(target) && phase === "sync-read") {
              throw readError;
            }
            return fs.readFileSync(target, options as Parameters<typeof fs.readFileSync>[1]);
          }) as typeof fs.readFileSync,
          statSync: ((target: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
            if (armed && isBackup(target) && phase === "sync-stat") {
              throw readError;
            }
            return fs.statSync(target, options);
          }) as typeof fs.statSync,
          promises: {
            ...fs.promises,
            readFile: ((target: fs.PathLike, options?: unknown) =>
              armed && isBackup(target) && phase === "async-read"
                ? Promise.reject(readError)
                : fs.promises.readFile(
                    target,
                    options as Parameters<typeof fs.promises.readFile>[1],
                  )) as typeof fs.promises.readFile,
            stat: ((target: fs.PathLike) =>
              armed && isBackup(target) && phase === "async-stat"
                ? Promise.reject(readError)
                : fs.promises.stat(target)) as typeof fs.promises.stat,
          },
        },
      });
      const plan = await recovery(io);
      armed = true;
      await expect(plan.apply()).rejects.toBe(readError);
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backup);
      expect(clobberFiles(root)).toEqual([]);
    },
  );

  it("preserves unavailable full backup validation instead of dropping the recovery candidate", async () => {
    let validations = 0;
    const { root, configPath, original, backup, io } = fixture({
      measure: async (name, run) => {
        if (name === "config.snapshot.read.validate" && ++validations === 2) {
          throw Object.assign(new Error("backup validation storage unavailable"), { code: "EIO" });
        }
        return await run();
      },
    });
    await expect(prepare(io)).rejects.toMatchObject({ code: "CONFIG_READ_FAILED" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backup);
    expect(clobberFiles(root)).toEqual([]);
  });

  it.each(["live", "completed", "during-apply"] as const)(
    "preserves a newer %s observation when prepared recovery is applied",
    async (phase) => {
      const { root, configPath, original, env, io } = fixture();
      const plan = await recovery(io);
      const logger = { warn: vi.fn(), error: vi.fn() };
      const deps = normalizeConfigIoDeps({ env, homedir: () => root, logger });
      using newer = phase === "live" ? captureConfigHealthStateStore(deps, configPath) : undefined;
      const snapshot = await newer?.read();
      if (newer && !snapshot) {
        throw new Error("Expected the newer observation to be current");
      }
      if (phase === "completed") {
        observeConfigSnapshotSync(deps, await io.readConfigFileSnapshot());
      }
      const health = phase === "completed" ? readConfigHealthStateFromStore(deps) : undefined;
      if (phase === "completed") {
        expect(health?.entries?.[configPath]?.lastObservedSuspiciousSignature).toBeTruthy();
        expect(logger.warn).toHaveBeenCalledTimes(1);
      }
      await expect(
        plan.apply(
          phase === "during-apply"
            ? () => {
                patchConfigHealthEntryToStore(deps, configPath, {
                  lastObservedSuspiciousSignature: "newer-observation",
                });
              }
            : undefined,
        ),
      ).rejects.toMatchObject({
        name: "ConfigMutationConflictError",
        retryable: false,
      });
      expectUnchanged(root, configPath, original);
      if (newer && snapshot) {
        expect(newer.isCurrent()).toBe(true);
        await newer.update({ lastObservedSuspiciousSignature: "newer-observation" }, snapshot);
      }
      if (phase === "completed") {
        expect(readConfigHealthStateFromStore(deps)).toEqual(health);
        expect(logger.warn).toHaveBeenCalledTimes(1);
      } else {
        expect(
          readConfigHealthStateFromStore(deps).entries?.[configPath]
            ?.lastObservedSuspiciousSignature,
        ).toBe("newer-observation");
      }
    },
  );

  it.each(["async", "sync"] as const)(
    "%s recovery tolerates an unreadable backup stat",
    async (mode) => {
      const { root, configPath, backup, env } = fixture();
      const backupPath = `${configPath}.bak`;
      const statError = Object.assign(new Error("EACCES: stat denied"), { code: "EACCES" });
      const io = createConfigIO({
        env,
        configPath,
        homedir: () => root,
        logger: { warn: vi.fn(), error: vi.fn() },
        fs: {
          ...fs,
          promises: {
            ...fs.promises,
            stat: ((target: fs.PathLike) =>
              target === backupPath
                ? Promise.reject(statError)
                : fs.promises.stat(target)) as typeof fs.promises.stat,
          },
          statSync: ((target: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
            if (target === backupPath) {
              throw statError;
            }
            return fs.statSync(target, options);
          }) as typeof fs.statSync,
        },
      });

      const recovered =
        mode === "async"
          ? (await io.readConfigFileSnapshot({ recoverSuspicious: true })).config
          : io.loadConfig();

      expect(recovered.gateway?.mode).toBe("local");
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
    },
  );

  it("keeps backup-based prepared recovery available when health reads are unavailable", async () => {
    const capture = healthOwner.captureConfigHealthStateStore;
    const unavailable = (store: ReturnType<typeof capture>): ReturnType<typeof capture> => ({
      ...store,
      read: async () => ({ state: {}, basis: null }),
      captureContinuation: () => unavailable(store.captureContinuation()),
    });
    const spy = vi
      .spyOn(healthOwner, "captureConfigHealthStateStore")
      .mockImplementation((...args) => unavailable(capture(...args)));
    try {
      const { root, configPath, original, backup, env, io } = fixture();
      const plan = await recovery(io);
      await plan.apply();
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
      const clobbered = clobberFiles(root);
      expect(clobbered).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, clobbered[0]!), "utf8")).toBe(original);
      const health = readConfigHealthStateFromStore({
        env,
        homedir: () => root,
        logger: { warn: vi.fn() },
      });
      expect(health.entries?.[configPath]).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an unobserved best-effort config read free of source sidecars", async () => {
    const { root, databasePath, io } = fixture();
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
    const before = manifest(root);
    await io.readBestEffortConfig();
    expect(manifest(root)).toEqual(before);
  });

  it.each(["full", "core-only"] as const)(
    "previews %s recovery without writes, then restores the admitted bytes",
    async (pluginValidation) => {
      const { root, configPath, original, backup, databasePath, env, io } = fixture({
        pluginValidation,
      });
      // No sidecars are excluded: a read must not create even an empty WAL.
      expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
      const before = manifest(root);
      const plan = await recovery(io);
      expect(plan.snapshot.raw).toBe(backup);
      expect(plan.snapshot.path).toBe(configPath);
      expect(plan.snapshot.config.gateway).toMatchObject({ mode: "local", port: 18720 });
      expect(plan.snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(Boolean(plan.pluginMetadataSnapshot)).toBe(pluginValidation === "full");
      expect(env).not.toHaveProperty("RECOVERY_MARKER");
      expect(manifest(root)).toEqual(before);

      await plan.apply();
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
      const clobbered = clobberFiles(root);
      expect(clobbered).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, clobbered[0]!), "utf8")).toBe(original);
      const persisted = await io.readConfigFileSnapshotWithPluginMetadata();
      expect(persisted.snapshot).toEqual(plan.snapshot);
    },
  );

  it("refuses replaced-backup identity drift before any recovery write", async () => {
    const { root, configPath, backup, io } = fixture();
    const plan = await recovery(io);
    const replacement = path.join(root, "replacement");
    fs.writeFileSync(replacement, backup);
    fs.renameSync(replacement, `${configPath}.bak`);
    const beforeApply = manifest(root);
    await expect(plan.apply()).rejects.toThrow("config recovery source changed since preparation");
    expect(manifest(root)).toEqual(beforeApply);
  });

  it.each(["backup", "lease"] as const)(
    "refuses %s changes while archiving the clobbered config",
    async (changedSource) => {
      const { root, configPath, original, env } = fixture();
      const lease =
        changedSource === "lease"
          ? await acquireStartupMigrationLeaseWithWait({ env, timeoutMs: 0 })
          : undefined;
      const changedPath = `${configPath}.bak`;
      const concurrentRaw = '{ "gateway": { "mode": "local", "port": 18721 } }\n';
      const io = createConfigIO({
        configPath,
        env,
        observe: false,
        homedir: () => root,
        logger: { warn: vi.fn(), error: vi.fn() },
        fs: {
          ...fs,
          promises: {
            ...fs.promises,
            writeFile: async (pathname, data, options) => {
              await fs.promises.writeFile(pathname, data, options);
              if (typeof pathname === "string" && pathname.startsWith(`${configPath}.clobbered.`)) {
                if (lease) {
                  lease.release();
                } else {
                  await fs.promises.writeFile(changedPath, concurrentRaw);
                }
              }
            },
          },
        },
      });
      const plan = await recovery(io);
      await expect(plan.apply(lease?.heartbeat)).rejects.toThrow(
        lease
          ? "startup migration lease was lost"
          : "config recovery source changed since preparation",
      );
      if (!lease) {
        expect(fs.readFileSync(changedPath, "utf8")).toBe(concurrentRaw);
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      const clobbered = clobberFiles(root);
      expect(clobbered).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, clobbered[0]!), "utf8")).toBe(original);
    },
  );

  it("rejects failed replacement while retaining the original and its clobbered snapshot", async () => {
    const { root, configPath, original, env } = fixture();
    const io = createConfigIO({
      configPath,
      env,
      observe: false,
      homedir: () => root,
      logger: { warn: vi.fn(), error: vi.fn() },
      fs: {
        ...fs,
        promises: {
          ...fs.promises,
          rename: async (source, target) => {
            if (target === configPath) {
              throw Object.assign(new Error("recovery replacement denied"), { code: "EACCES" });
            }
            await fs.promises.rename(source, target);
          },
        },
      },
    });
    const plan = await recovery(io);
    await expect(plan.apply()).rejects.toThrow("recovery replacement denied");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(clobberFiles(root)).toHaveLength(1);
  });
});
