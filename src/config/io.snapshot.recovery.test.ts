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
import { observeConfigSnapshot, observeConfigSnapshotSync } from "./io.observe.js";
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

  it.each(["absent", "unparseable", "invalid"] as const)(
    "does not prepare recovery from an unusable %s backup",
    async (kind) => {
      const { root, configPath, original, io } = fixture();
      const backupPath = `${configPath}.bak`;
      const bytes =
        kind === "unparseable" ? "{ not JSON5" : '{"gateway":{"mode":"local","port":"bad"}}';
      if (kind === "absent") {
        fs.unlinkSync(backupPath);
      } else {
        fs.writeFileSync(backupPath, bytes);
      }
      await expect(prepare(io)).resolves.toBeNull();
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      if (kind !== "absent") {
        expect(fs.readFileSync(backupPath, "utf8")).toBe(bytes);
      }
      expect(fs.readdirSync(root).filter((name) => name.includes(".clobbered."))).toEqual([]);
    },
  );

  it.each(["discovery", "sync-read", "sync-stat", "async-read", "async-stat"] as const)(
    "preserves unavailable backup I/O during %s instead of reporting recovery drift",
    async (phase) => {
      const readError = Object.assign(new Error("backup device unavailable"), { code: "EIO" });
      let armed = phase === "discovery";
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
              armed && isBackup(target) && (phase === "discovery" || phase === "async-read")
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
      if (phase === "discovery") {
        await expect(prepare(io)).rejects.toBe(readError);
      } else {
        const plan = await prepare(io);
        expect(plan).not.toBeNull();
        armed = true;
        await expect(plan!.apply()).rejects.toBe(readError);
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backup);
      expect(fs.readdirSync(root).filter((name) => name.includes(".clobbered."))).toEqual([]);
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
    expect(fs.readdirSync(root).filter((name) => name.includes(".clobbered."))).toEqual([]);
  });

  it("leaves a newer live observation current when an older prepared recovery is applied", async () => {
    const { root, configPath, original, env, io } = fixture();
    const plan = await prepare(io);
    if (!plan) {
      throw new Error("Expected a prepared recovery");
    }
    const deps = normalizeConfigIoDeps({
      env,
      homedir: () => root,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    using newer = captureConfigHealthStateStore(deps, configPath);
    const snapshot = await newer.read();
    if (!snapshot) {
      throw new Error("Expected the newer observation to be current");
    }

    await expect(plan.apply()).rejects.toMatchObject({
      name: "ConfigMutationConflictError",
      retryable: false,
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith("openclaw.json.clobbered.")),
    ).toEqual([]);
    expect(newer.isCurrent()).toBe(true);
    await newer.update({ lastObservedSuspiciousSignature: "newer-observation" }, snapshot);
    expect(
      readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
    ).toBe("newer-observation");
  });

  it.each(["sync", "async"] as const)(
    "refuses recovery declined after a completed %s observation between prepare and apply",
    async (mode) => {
      const { root, configPath, original, env, io } = fixture();
      const plan = await prepare(io);
      if (!plan) {
        throw new Error("Expected a prepared recovery");
      }
      const logger = { warn: vi.fn(), error: vi.fn() };
      const deps = normalizeConfigIoDeps({ env, homedir: () => root, logger });
      const current = await io.readConfigFileSnapshot();
      if (mode === "sync") {
        observeConfigSnapshotSync(deps, current);
      } else {
        await observeConfigSnapshot(deps, current);
      }
      const health = readConfigHealthStateFromStore(deps);
      expect(health.entries?.[configPath]?.lastObservedSuspiciousSignature).toBeTruthy();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      await expect(plan.apply()).rejects.toMatchObject({
        name: "ConfigMutationConflictError",
        retryable: false,
      });
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      expect(
        fs.readdirSync(root).filter((name) => name.startsWith("openclaw.json.clobbered.")),
      ).toEqual([]);
      expect(readConfigHealthStateFromStore(deps)).toEqual(health);
      expect(logger.warn).toHaveBeenCalledTimes(1);
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
      const plan = await prepare(io);
      if (!plan) {
        throw new Error("Expected recovery from the readable backup");
      }
      await plan.apply();
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
      const clobbered = fs
        .readdirSync(root)
        .filter((name) => name.startsWith("openclaw.json.clobbered."));
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

  it("rejects a superseded explicit apply without claiming a file commit", async () => {
    const { root, configPath, original, env, io } = fixture();
    const plan = await prepare(io);
    if (!plan) {
      throw new Error("Expected a prepared recovery");
    }
    const deps = { env, homedir: () => root, logger: { warn: vi.fn() } };
    await expect(
      plan.apply(() => {
        patchConfigHealthEntryToStore(deps, configPath, {
          lastObservedSuspiciousSignature: "newer-observation",
        });
      }),
    ).rejects.toMatchObject({ name: "ConfigMutationConflictError", retryable: false });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith("openclaw.json.clobbered.")),
    ).toEqual([]);
    expect(
      readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
    ).toBe("newer-observation");
  });

  it.each(["OPENCLAW_CONFIG_READONLY", "OPENCLAW_NIX_MODE"])(
    "%s does not prepare a recovery that would replace externally owned config",
    async (mode) => {
      const { root, io } = fixture();
      io.env[mode] = "1";
      const before = manifest(root);
      await expect(prepare(io)).resolves.toBeNull();
      expect(manifest(root)).toEqual(before);
    },
  );

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
      const plan = await prepare(io);
      expect(plan).not.toBeNull();
      expect(plan!.snapshot.raw).toBe(backup);
      expect(plan!.snapshot.path).toBe(configPath);
      expect(plan!.snapshot.config.gateway).toMatchObject({ mode: "local", port: 18720 });
      expect(plan!.snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(Boolean(plan!.pluginMetadataSnapshot)).toBe(pluginValidation === "full");
      expect(env).not.toHaveProperty("RECOVERY_MARKER");
      expect(manifest(root)).toEqual(before);

      await plan!.apply();
      expect(fs.readFileSync(configPath, "utf8")).toBe(backup);
      const clobbered = fs
        .readdirSync(root)
        .filter((name) => name.startsWith("openclaw.json.clobbered."));
      expect(clobbered).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, clobbered[0]!), "utf8")).toBe(original);
      const persisted = await io.readConfigFileSnapshotWithPluginMetadata();
      expect(persisted.snapshot).toEqual(plan!.snapshot);
    },
  );

  it.each(["config", "backup", "replaced-backup"] as const)(
    "refuses %s drift before any recovery write",
    async (drift) => {
      const { root, configPath, backup, io } = fixture();
      const plan = await prepare(io);
      expect(plan).not.toBeNull();
      if (drift === "replaced-backup") {
        const replacement = path.join(root, "replacement");
        fs.writeFileSync(replacement, backup);
        fs.renameSync(replacement, `${configPath}.bak`);
      } else {
        fs.writeFileSync(
          drift === "config" ? configPath : `${configPath}.bak`,
          '{ "gateway": { "mode": "remote" } }\n',
        );
      }
      const beforeApply = manifest(root);
      await expect(plan!.apply()).rejects.toThrow(
        "config recovery source changed since preparation",
      );
      expect(manifest(root)).toEqual(beforeApply);
    },
  );

  it.each(["config", "backup", "lease"] as const)(
    "refuses %s changes while archiving the clobbered config",
    async (changedSource) => {
      const { root, configPath, original, env } = fixture();
      const lease =
        changedSource === "lease"
          ? await acquireStartupMigrationLeaseWithWait({ env, timeoutMs: 0 })
          : undefined;
      const changedPath = changedSource === "config" ? configPath : `${configPath}.bak`;
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
      const plan = await prepare(io);
      expect(plan).not.toBeNull();
      await expect(plan!.apply(lease?.heartbeat)).rejects.toThrow(
        lease
          ? "startup migration lease was lost"
          : "config recovery source changed since preparation",
      );
      if (!lease) {
        expect(fs.readFileSync(changedPath, "utf8")).toBe(concurrentRaw);
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe(
        changedSource === "config" ? concurrentRaw : original,
      );
      const clobbered = fs
        .readdirSync(root)
        .filter((name) => name.startsWith("openclaw.json.clobbered."));
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
    const plan = await prepare(io);
    expect(plan).not.toBeNull();
    await expect(plan!.apply()).rejects.toThrow("recovery replacement denied");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith("openclaw.json.clobbered.")),
    ).toHaveLength(1);
  });
});
