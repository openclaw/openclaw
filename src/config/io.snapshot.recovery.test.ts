import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.factory.js";
import {
  captureConfigHealthStateStore,
  patchConfigHealthEntryToStore,
  readConfigHealthStateFromStore,
} from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import {
  promoteConfigSnapshotToLastKnownGoodCore,
  recoverConfigFromLastKnownGoodCore,
} from "./io.observe-recovery.js";
import { observeConfigSnapshot, observeConfigSnapshotSync } from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";
import type { ConfigIoFactoryOptions } from "./io.types.js";
import type { ConfigFileSnapshot } from "./types.js";

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
      const lease = changedSource === "lease" ? acquireStartupMigrationLease({ env }) : undefined;
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

// Covers last-known-good promotion admission for suspicious snapshots (#152509).
type ObserveRecoveryDeps = Parameters<typeof promoteConfigSnapshotToLastKnownGoodCore>[0]["deps"];

const approveRecoveryCandidate = <T extends { raw: string; parsed: unknown }>(candidate: T) => ({
  ok: true as const,
  candidate,
});

function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

describe("config observe recovery promotion", () => {
  async function makeSnapshot(configPath: string, config: Record<string, unknown>) {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, raw, "utf-8");
    return {
      path: configPath,
      exists: true,
      raw,
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    } satisfies ConfigFileSnapshot;
  }

  function makeDeps(home: string, warn = vi.fn()) {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn },
      } as unknown as ObserveRecoveryDeps,
      configPath,
      warn,
    };
  }

  it("refuses to promote a suspicious snapshot over last-known-good", async () => {
    const home = tempDirs.make("openclaw-config-lgg-promotion-");
    const { deps, configPath, warn } = makeDeps(home);
    const healthyConfig = {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
      },
    };
    const healthy = await makeSnapshot(configPath, healthyConfig);

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: deps.logger }),
    ).resolves.toBe(true);
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      healthy.raw,
    );

    const truncated = await makeSnapshot(configPath, { gateway: { mode: "local", port: 19187 } });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: truncated,
        logger: deps.logger,
      }),
    ).resolves.toBe(false);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "Config last-known-good promotion skipped",
    );
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "size-drop-vs-last-good",
    );
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "missing-meta-vs-last-good",
    );
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      healthy.raw,
    );

    const brokenRaw = "{ gateway: { mode: 123 } }\n";
    await fsp.writeFile(configPath, brokenRaw, "utf-8");
    const restored = await recoverConfigFromLastKnownGoodCore({
      deps,
      snapshot: {
        ...truncated,
        raw: brokenRaw,
        parsed: { gateway: { mode: 123 } },
        valid: false,
        issues: [{ path: "gateway.mode", message: "Expected string" }],
      },
      reason: "test-suspicious-promotion",
      prepareCandidate: approveRecoveryCandidate,
    });

    expect(restored).toBe(true);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(healthy.raw);
  });

  it("promotes a non-suspicious snapshot whose shape matches the baseline", async () => {
    const home = tempDirs.make("openclaw-config-lgg-promotion-");
    const { deps, configPath, warn } = makeDeps(home);
    const healthy = await makeSnapshot(configPath, {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: { mode: "local" as const },
    });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: deps.logger }),
    ).resolves.toBe(true);

    const edited = await makeSnapshot(configPath, {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: { mode: "local" as const, port: 19187 },
    });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: edited,
        logger: deps.logger,
      }),
    ).resolves.toBe(true);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
      "Config last-known-good promotion skipped",
    );
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      edited.raw,
    );
  });
});

describe("last-known-good promotion after accepted writes", () => {
  function acceptedWriteFixture() {
    const root = tempDirs.make("openclaw-config-lgg-accepted-write-");
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const env = {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    const io = createConfigIO({
      env,
      configPath,
      homedir: () => root,
      observe: false,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    return { configPath, io };
  }

  function seedConfig(configPath: string, config: Record<string, unknown>): string {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(configPath, raw, "utf8");
    return raw;
  }

  it("advances last-known-good after an accepted intentional size-drop write", async () => {
    const { configPath, io } = acceptedWriteFixture();
    const lastGoodPath = `${configPath}.last-good`;
    seedConfig(configPath, {
      meta: { lastTouchedVersion: "2026.4.22" },
      gateway: { mode: "local" as const },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
        },
      },
    });

    const healthySnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(healthySnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(healthySnapshot.raw);

    const acceptedWrite = await io.writeConfigFile(
      { meta: { lastTouchedVersion: "2026.4.22" }, gateway: { mode: "local" } },
      { allowConfigSizeDrop: true, baseSnapshot: healthySnapshot },
    );
    expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });

    const reducedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(reducedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);

    seedConfig(configPath, { gateway: { mode: "local", port: 19187 } });
    const truncatedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(truncatedSnapshot)).resolves.toBe(false);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);
  });

  it("promotes an accepted formatting normalization over the verbose baseline", async () => {
    const { configPath, io } = acceptedWriteFixture();
    const lastGoodPath = `${configPath}.last-good`;
    const original = {
      meta: { lastTouchedVersion: "2026.4.23" },
      gateway: { mode: "local" },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
        },
      },
    };
    // Verbose PowerShell formatting (BOM + 12-space indent): canonical writes
    // shrink raw bytes by more than half through serialization alone.
    const powerShellRaw = `\uFEFF${JSON.stringify(original, null, 12)}\n`;
    fs.writeFileSync(configPath, powerShellRaw, "utf8");

    const verboseSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(verboseSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(powerShellRaw);

    // An ordinary accepted edit without allowConfigSizeDrop: the writer's
    // canonicalized size baseline records no drop, so the raw-byte shrink comes
    // purely from formatting normalization.
    await io.writeConfigFile(
      { ...original, gateway: { mode: "local", port: 18789 } },
      { baseSnapshot: verboseSnapshot },
    );
    const canonicalRaw = fs.readFileSync(configPath, "utf8");
    expect(Buffer.byteLength(powerShellRaw, "utf8")).toBeGreaterThan(
      Buffer.byteLength(canonicalRaw, "utf8") * 2,
    );

    // The accepted write advanced the last-known-good baseline, so the next
    // startup promotes the edited canonical config instead of freezing the
    // verbose one as the recovery target.
    const editedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(editedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);

    // An external truncation afterwards never advances the baseline: promotion
    // keeps refusing it, and recovery restores the edited canonical config.
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
      "utf8",
    );
    const truncatedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(truncatedSnapshot)).resolves.toBe(false);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);

    fs.writeFileSync(configPath, "{ gateway: { mode: 123 } }\n", "utf8");
    const brokenSnapshot = await io.readConfigFileSnapshot();
    await expect(
      io.recoverConfigFromLastKnownGood({
        snapshot: brokenSnapshot,
        reason: "test-formatting-baseline",
      }),
    ).resolves.toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(canonicalRaw);
  });
});
