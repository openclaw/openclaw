import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as deferredMigrations from "../infra/deferred-plugin-migrations.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
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
  patchConfigHealthEntryToStore,
  readConfigHealthStateFromStore,
} from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import { createRecoveryConfigEnv } from "./io.observe-recovery.test-support.js";
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
  return listDirectoryTreeStrictSync(root)
    .map((walkEntry) => walkEntry.relativePath)
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

function expectUnchanged(root: string, configPath: string, original: string, backup?: string) {
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  expect(clobberFiles(root)).toEqual([]);
  if (backup !== undefined) {
    expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backup);
  }
}

function expectArchived(root: string, original: string) {
  const clobbered = clobberFiles(root);
  expect(clobbered).toHaveLength(1);
  expect(fs.readFileSync(path.join(root, clobbered[0]!), "utf8")).toBe(original);
}

const withPromises = (overrides: Partial<typeof fs.promises>) => ({
  fs: { ...fs, promises: { ...fs.promises, ...overrides } },
});

function fixture(
  options: ConfigIoFactoryOptions | ((configPath: string) => ConfigIoFactoryOptions) = {},
) {
  const root = tempDirs.make("openclaw-prepared-config-recovery-");
  const configPath = path.join(root, "openclaw.json");
  const original = '{ "update": { "channel": "beta" } }\n';
  const backup = JSON.stringify({
    gateway: { mode: "local", port: 18720 },
    env: { vars: { RECOVERY_MARKER: "backup" } },
  });
  fs.writeFileSync(configPath, original);
  fs.writeFileSync(`${configPath}.bak`, backup);
  const env = createRecoveryConfigEnv(root, configPath, root);
  const databasePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const io = createConfigIO({
    env,
    configPath,
    homedir: () => root,
    observe: false,
    logger: { warn: vi.fn(), error: vi.fn() },
    ...(typeof options === "function" ? options(configPath) : options),
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
    "prepares a canonical backup when migration metadata is unavailable (%s)",
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
      const readSync = vi
        .spyOn(deferredMigrations, "readDeferredPluginMigrations")
        .mockImplementation(() => {
          throw unavailable;
        });
      const readAsync = vi
        .spyOn(deferredMigrations, "readDeferredPluginMigrationsAsync")
        .mockRejectedValue(unavailable);
      try {
        const prepared =
          mode === "sync"
            ? context.prepareRecoveryBackupCandidate(candidate)
            : await context.prepareRecoveryBackupCandidateAsync(candidate);
        expect(prepared).toMatchObject({
          ok: true,
          candidate: {
            raw: '{"gateway":{"mode":"local"}}',
            parsed: { gateway: { mode: "local" } },
            config: { gateway: { mode: "local" } },
          },
        });
      } finally {
        readSync.mockRestore();
        readAsync.mockRestore();
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
      expectUnchanged(root, configPath, original);
      if (kind === "unparseable") {
        expect(fs.readFileSync(backupPath, "utf8")).toBe(bytes);
      }
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
      const guard = <F extends (...args: never[]) => unknown>(
        read: F,
        boundary: string,
        async = false,
      ): F =>
        new Proxy(read, {
          apply(target, self, args) {
            if (armed && String(args[0]).endsWith(".bak") && phase === boundary) {
              if (async) {
                return Promise.reject(readError);
              }
              throw readError;
            }
            return Reflect.apply(target, self, args);
          },
        });
      const { root, configPath, original, backup, io } = fixture({
        fs: {
          ...fs,
          readFileSync: guard(fs.readFileSync, "sync-read"),
          statSync: guard(fs.statSync, "sync-stat"),
          promises: {
            ...fs.promises,
            readFile: guard(fs.promises.readFile, "async-read", true),
            stat: guard(fs.promises.stat, "async-stat", true),
          },
        },
      });
      if (phase.startsWith("async")) {
        armed = true;
        await expect(prepare(io)).rejects.toBe(readError);
      } else {
        const plan = await recovery(io);
        armed = true;
        await expect(plan.apply()).rejects.toBe(readError);
      }
      expectUnchanged(root, configPath, original, backup);
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
    expectUnchanged(root, configPath, original, backup);
  });

  it.each(["completed", "during-apply"] as const)(
    "restores unchanged source bytes without replacing newer %s health metadata",
    async (phase) => {
      const { root, configPath, original, backup, env, io } = fixture();
      const plan = await recovery(io);
      const logger = { warn: vi.fn(), error: vi.fn() };
      const deps = normalizeConfigIoDeps({ env, homedir: () => root, logger });
      if (phase === "completed") {
        observeConfigSnapshotSync(deps, await io.readConfigFileSnapshot());
      }
      const previousHealth =
        phase === "completed" ? readConfigHealthStateFromStore(deps) : undefined;
      await plan.apply(
        phase === "during-apply"
          ? () => {
              patchConfigHealthEntryToStore(deps, configPath, {
                lastObservedSuspiciousSignature: "newer-observation",
              });
            }
          : undefined,
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
      expectArchived(root, original);
      if (previousHealth) {
        expect(readConfigHealthStateFromStore(deps)).toEqual(previousHealth);
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
      const statError = Object.assign(new Error("EACCES: stat denied"), { code: "EACCES" });
      const { configPath, backup, io } = fixture((targetPath) => ({
        observe: undefined,
        fs: {
          ...fs,
          promises: {
            ...fs.promises,
            stat: ((target: fs.PathLike) =>
              target === `${targetPath}.bak`
                ? Promise.reject(statError)
                : fs.promises.stat(target)) as typeof fs.promises.stat,
          },
          statSync: ((target: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
            if (target === `${targetPath}.bak`) {
              throw statError;
            }
            return fs.statSync(target, options);
          }) as typeof fs.statSync,
        },
      }));

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
    });
    const spy = vi
      .spyOn(healthOwner, "captureConfigHealthStateStore")
      .mockImplementation((...args) => unavailable(capture(...args)));
    try {
      const { root, configPath, original, backup, env, io } = fixture();
      const plan = await recovery(io);
      await plan.apply();
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
      expectArchived(root, original);
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
      expect(plan.snapshot).toMatchObject({
        raw: backup,
        path: configPath,
        valid: true,
        config: {
          gateway: { mode: "local", port: 18720 },
          agents: { defaults: { compaction: { mode: "safeguard" } } },
        },
      });
      expect(env).not.toHaveProperty("RECOVERY_MARKER");
      expect(manifest(root)).toEqual(before);

      await plan.apply();
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
      expectArchived(root, original);
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
        ...withPromises({
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
        }),
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
      expectArchived(root, original);
    },
  );

  it("defers prepared recovery when the forensic snapshot cannot be written", async () => {
    const warn = vi.fn();
    const { root, configPath, original, backup, io } = fixture({
      logger: { warn, error: vi.fn() },
      ...withPromises({
        writeFile: async (target, data, options) => {
          if (typeof target === "string" && target.includes(".clobbered.")) {
            throw Object.assign(new Error("snapshot disk full"), { code: "ENOSPC" });
          }
          return fs.promises.writeFile(target, data, options);
        },
      }),
    });
    const plan = await recovery(io);

    await expect(plan.apply()).rejects.toThrow("Config backup recovery deferred");

    expectUnchanged(root, configPath, original, backup);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("recovery deferred"));
  });

  it("rejects failed replacement while retaining the original and its clobbered snapshot", async () => {
    const { root, configPath, original, io } = fixture((targetPath) => ({
      ...withPromises({
        rename: async (source, target) => {
          if (target === targetPath) {
            throw Object.assign(new Error("recovery replacement denied"), { code: "EACCES" });
          }
          await fs.promises.rename(source, target);
        },
      }),
    }));
    const plan = await recovery(io);
    await expect(plan.apply()).rejects.toThrow("recovery replacement denied");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(clobberFiles(root)).toHaveLength(1);
  });
});
