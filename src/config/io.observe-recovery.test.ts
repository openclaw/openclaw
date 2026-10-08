// Covers config IO recovery observation after corrupt or missing files.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareLegacyConfigMigrationRuntime } from "../commands/doctor/shared/legacy-config-migrate.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import * as configAudit from "./io.audit.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import {
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import { createConfigIO } from "./io.js";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
  promoteConfigSnapshotToLastKnownGoodCore,
  recoverConfigFromLastKnownGoodCore,
} from "./io.observe-recovery.js";
import {
  clobberedUpdateChannelConfig,
  clobberedUpdateChannelRaw,
  largeRecoverableCoreConfig,
  recoverableCoreConfig,
  recoverableTelegramConfig,
} from "./io.observe-recovery.test-support.js";
import * as configObserveState from "./io.observe-state.js";
import { createConfigIoWorkerFixture } from "./io.worker.test-support.js";
import type { ConfigFileSnapshot } from "./types.js";

type ObserveRecoveryDeps = Parameters<typeof maybeRecoverSuspiciousConfigRead>[0]["deps"];
const approveRecoveryCandidate = <T extends { raw: string; parsed: unknown }>(candidate: T) => ({
  ok: true as const,
  candidate,
});

function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

describe("config observe recovery", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;
  let restoreMigrationRuntime: (() => void) | undefined;
  const workerFixture = createConfigIoWorkerFixture();

  let home = "";
  beforeEach(async () => {
    home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fsp.mkdir(home, { recursive: true });
  });

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-observe-recovery-"));
    await workerFixture.setup(fixtureRoot);
    restoreMigrationRuntime = await prepareLegacyConfigMigrationRuntime();
  });

  afterAll(async () => {
    restoreMigrationRuntime?.();
    await workerFixture.close();
    closeOpenClawStateDatabaseForTest();
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  async function seedConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  async function seedConfigBackup(configPath: string, config: Record<string, unknown>) {
    await seedConfig(configPath, config);
    await fsp.copyFile(configPath, `${configPath}.bak`);
  }

  async function writeConfigRaw(configPath: string, config: Record<string, unknown>) {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    await fsp.writeFile(configPath, raw, "utf-8");
    return { raw, parsed: config };
  }

  async function writeClobberedUpdateChannel(configPath: string) {
    await fsp.writeFile(configPath, clobberedUpdateChannelRaw, "utf-8");
    return {
      raw: clobberedUpdateChannelRaw,
      parsed: clobberedUpdateChannelConfig,
    };
  }

  async function readObserveEvents(auditPath: string): Promise<Record<string, unknown>[]> {
    const stateDir = path.dirname(path.dirname(auditPath));
    return listConfigAuditRecordsForTests({
      env: { OPENCLAW_STATE_DIR: stateDir },
      homedir: () => stateDir,
    }).filter((event) => event.event === "config.observe");
  }

  async function listClobberFiles(configPath: string) {
    const prefix = `${path.basename(configPath)}.clobbered.`;
    return (await fsp.readdir(path.dirname(configPath))).filter((entry) =>
      entry.startsWith(prefix),
    );
  }

  async function expectPathMissing(targetPath: string) {
    await expect(fsp.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  }

  function warnMessages(warn: ReturnType<typeof vi.fn>): string[] {
    return warn.mock.calls.map(([message]) => String(message));
  }

  function expectWarnContaining(warn: ReturnType<typeof vi.fn>, expected: string) {
    expect(warnMessages(warn).join("\n")).toContain(expected);
  }

  function expectWarnNotContaining(warn: ReturnType<typeof vi.fn>, expected: string) {
    expect(warnMessages(warn).join("\n")).not.toContain(expected);
  }

  async function readLastObserveEvent(
    auditPath: string,
  ): Promise<Record<string, unknown> | undefined> {
    return (await readObserveEvents(auditPath)).at(-1);
  }

  function createTestConfigIO(
    fixtureHome: string,
    warn = vi.fn(),
    options: { env?: NodeJS.ProcessEnv; observe?: boolean } = {},
  ) {
    const configPath = path.join(fixtureHome, ".openclaw", "openclaw.json");
    const error = vi.fn();
    // Keep recovery validation out of host/workspace plugin state. Preserve the
    // caller's env identity because rollback tests inspect that exact object.
    const env = options.env ?? ({} as NodeJS.ProcessEnv);
    env.HOME ??= fixtureHome;
    env.USERPROFILE ??= fixtureHome;
    env.OPENCLAW_CONFIG_PATH ??= configPath;
    env.OPENCLAW_STATE_DIR ??= path.join(fixtureHome, ".openclaw");
    env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ??= "1";
    env.VITEST ??= "true";
    return {
      configPath,
      warn,
      error,
      io: createConfigIO({
        fs,
        json5: JSON5,
        env,
        homedir: () => fixtureHome,
        configPath,
        logger: { warn, error },
        ...(options.observe === false ? { observe: false } : {}),
      }),
    };
  }

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

  function invalidSnapshot(snapshot: ConfigFileSnapshot, raw: string): ConfigFileSnapshot {
    return {
      ...snapshot,
      raw,
      parsed: { gateway: { mode: 123 } },
      valid: false,
      issues: [{ path: "gateway.mode", message: "Expected string" }],
    };
  }

  function makeDeps(
    fixtureHome: string,
    warn = vi.fn(),
  ): {
    deps: ObserveRecoveryDeps;
    configPath: string;
    auditPath: string;
    warn: ReturnType<typeof vi.fn>;
  } {
    const configPath = path.join(fixtureHome, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => fixtureHome,
        logger: { warn },
      },
      configPath,
      auditPath: path.join(fixtureHome, ".openclaw", "logs", "config-audit.jsonl"),
      warn,
    };
  }

  it.each(["async", "sync"] as const)(
    "warns when %s backup restore cannot tighten config permissions",
    async (mode) => {
      const { deps, configPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);
      const error = Object.assign(new Error("EPERM: chmod denied"), { code: "EPERM" });
      const failingFs: ObserveRecoveryDeps["fs"] =
        mode === "async"
          ? {
              ...fs,
              promises: {
                ...fs.promises,
                chmod: async (target, permissions) => {
                  if (target === configPath) {
                    throw error;
                  }
                  await fs.promises.chmod(target, permissions);
                },
              },
            }
          : {
              ...fs,
              chmodSync: (target, permissions) => {
                if (target === configPath) {
                  throw error;
                }
                fs.chmodSync(target, permissions);
              },
            };
      const input = {
        deps: { ...deps, fs: failingFs },
        configPath,
        ...clobbered,
        prepareBackup: approveRecoveryCandidate,
      };
      const recovered = await (mode === "async"
        ? maybeRecoverSuspiciousConfigRead(input)
        : maybeRecoverSuspiciousConfigReadSync(input));
      expect(recovered.parsed).toEqual(recoverableTelegramConfig);
      expectWarnContaining(
        warn,
        `Config permission hardening failed (backup restore): ${configPath}: EPERM: chmod denied`,
      );
      expectWarnContaining(warn, `Config auto-restored from backup: ${configPath}`);
    },
  );

  it("rereads a committed backup after its audit closes health admission", async () => {
    const { io, configPath, warn } = createTestConfigIO(home);
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    await seedConfigBackup(configPath, largeRecoverableCoreConfig);
    const backupRaw = await fsp.readFile(`${configPath}.bak`, "utf-8");
    await writeConfigRaw(configPath, { meta: { lastTouchedVersion: "2026.5.28" } });
    const captureAppender = configAudit.captureConfigAuditAppender;
    let closedAfterRestore = false;
    const audit = vi
      .spyOn(configAudit, "captureConfigAuditAppender")
      .mockImplementation((...params) => {
        const append = captureAppender(...params);
        return async (record) => {
          await append(record);
          if (
            !closedAfterRestore &&
            record.event === "config.observe" &&
            record.restoredFromBackup
          ) {
            expect(await fsp.readFile(configPath, "utf-8")).toBe(backupRaw);
            closedAfterRestore = true;
            await closeOpenClawStateDatabaseAsync();
          }
        };
      });
    try {
      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });
      expect(closedAfterRestore).toBe(true);
      expect(snapshot.valid).toBe(true);
      expect(snapshot.raw).toBe(backupRaw);
      expect(snapshot.config.gateway?.mode).toBe("local");
      expect(snapshot.config.gateway?.trustedProxies).toEqual(
        largeRecoverableCoreConfig.gateway.trustedProxies,
      );
      expect(await fsp.readFile(configPath, "utf-8")).toBe(backupRaw);
      expectWarnContaining(warn, "Config health-state write failed:");
      const events = await readObserveEvents(auditPath);
      expect(events).toHaveLength(1);
      expect(events[0]?.restoredFromBackup).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      expect((await io.readConfigFileSnapshot({ recoverSuspicious: true })).raw).toBe(backupRaw);
    } finally {
      audit.mockRestore();
    }
  });

  it("loadConfig clears env vars from the discarded clobbered config before rereading backup", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { io, configPath } = createTestConfigIO(home, vi.fn(), { env });
    await seedConfigBackup(configPath, recoverableCoreConfig);
    await writeConfigRaw(configPath, {
      meta: { lastTouchedVersion: "2026.5.28" },
      env: { vars: { OPENCLAW_CLOBBER_ONLY: "bad" } },
    });

    const config = io.loadConfig();

    expect(config.gateway?.mode).toBe("local");
    expect(env.OPENCLAW_CLOBBER_ONLY).toBeUndefined();
  });

  it("read snapshot recovery clears env vars from the discarded clobbered config", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { io, configPath } = createTestConfigIO(home, vi.fn(), { env });
    await seedConfigBackup(configPath, recoverableCoreConfig);
    await writeConfigRaw(configPath, {
      meta: { lastTouchedVersion: "2026.5.28" },
      env: { vars: { OPENCLAW_CLOBBER_ONLY: "bad" } },
    });

    const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

    expect(snapshot.config.gateway?.mode).toBe("local");
    expect(env.OPENCLAW_CLOBBER_ONLY).toBeUndefined();
  });

  it("does not auto-restore read snapshots when observation is disabled", async () => {
    const { io, configPath } = createTestConfigIO(home, vi.fn(), { observe: false });
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    await seedConfigBackup(configPath, recoverableCoreConfig);
    const clobbered = await writeConfigRaw(configPath, {
      meta: { lastTouchedVersion: "2026.5.28" },
    });

    const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

    expect(snapshot.valid).toBe(true);
    expect(snapshot.config.gateway?.mode).toBeUndefined();
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
    await expectPathMissing(auditPath);
  });

  it("does not auto-restore include-authored roots from stale full-file backups", async () => {
    const { io, configPath } = createTestConfigIO(home);
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    const includedConfig = largeRecoverableCoreConfig;
    await seedConfigBackup(configPath, includedConfig);
    await fsp.writeFile(
      path.join(path.dirname(configPath), "base.json5"),
      `${JSON.stringify(includedConfig, null, 2)}\n`,
      "utf-8",
    );
    const includeRootRaw = `{\n  "$include": "./base.json5"\n}\n`;
    await fsp.writeFile(configPath, includeRootRaw, "utf-8");

    const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

    expect(snapshot.valid).toBe(true);
    expect(snapshot.config.gateway?.mode).toBe("local");
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(includeRootRaw);
    const observe = await readLastObserveEvent(auditPath);
    expect(observe?.restoredFromBackup).toBe(false);
  });

  it("leaves backup gateway bind aliases for Doctor", async () => {
    const bind = "localhost";
    const { io, configPath, warn } = createTestConfigIO(home);
    await seedConfigBackup(configPath, {
      gateway: { mode: "local", bind },
    });
    const backupRaw = `{\n  // historical bind alias\n  gateway: { mode: "local", bind: "${bind}" }\n}\n`;
    await fsp.writeFile(`${configPath}.bak`, backupRaw, "utf-8");
    const clobbered = await writeConfigRaw(configPath, {
      meta: { lastTouchedVersion: "2026.5.28" },
    });

    const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

    expect(snapshot.valid).toBe(true);
    expect(snapshot.config.gateway?.mode).toBeUndefined();
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
    await expect(fsp.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(backupRaw);
    await expect(listClobberFiles(configPath)).resolves.toHaveLength(0);
    expectWarnNotContaining(warn, "Config auto-restored");
  });

  it("async load leaves directly authored OTel grpc backup repair to Doctor", async () => {
    const { io, configPath } = createTestConfigIO(home);
    await seedConfigBackup(configPath, {
      gateway: { mode: "local" },
      diagnostics: { otel: { enabled: true, protocol: "grpc", traces: true } },
    });
    const backupRaw = await fsp.readFile(`${configPath}.bak`, "utf-8");
    const clobbered = await writeConfigRaw(configPath, {
      meta: { lastTouchedVersion: "2026.5.28" },
    });

    const config = await io.loadConfigAsync();

    expect(config.gateway?.mode).toBeUndefined();
    expect(config.diagnostics?.otel).toBeUndefined();
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
    await expect(fsp.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(backupRaw);
    await expect(listClobberFiles(configPath)).resolves.toHaveLength(0);
  });

  it("passes the resolved backup candidate to caller recovery policy", async () => {
    const { io, configPath } = createTestConfigIO(home);
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(
      path.join(path.dirname(configPath), "future-meta.json5"),
      '{ meta: { lastTouchedVersion: "9999.1.1" } }\n',
      "utf-8",
    );
    await seedConfigBackup(configPath, {
      $include: "./future-meta.json5",
      gateway: { mode: "local" },
    });
    const clobbered = await writeConfigRaw(configPath, {});
    let candidateVersion: string | undefined;
    let currentConfig: Record<string, unknown> | undefined;

    const allowSuspiciousRecovery = vi.fn(
      (candidate: ConfigFileSnapshot["config"], current: ConfigFileSnapshot["config"]) => {
        candidateVersion = candidate.meta?.lastTouchedVersion;
        currentConfig = current;
        return false;
      },
    );
    await io.readConfigFileSnapshot({ recoverSuspicious: true, allowSuspiciousRecovery });
    await io.readConfigFileSnapshot({ recoverSuspicious: true, allowSuspiciousRecovery });
    expect(allowSuspiciousRecovery).toHaveBeenCalledTimes(2);
    expect(await listClobberFiles(configPath)).toHaveLength(0);

    expect(candidateVersion).toBe("9999.1.1");
    expect(currentConfig).toBeDefined();
    expect(currentConfig?.meta).toBeUndefined();
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
  });

  it("validates backup candidates without leaking their env into live state", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { io, configPath } = createTestConfigIO(home, vi.fn(), { env });
    await seedConfigBackup(configPath, {
      gateway: { mode: "local" },
      env: { vars: { OPENCLAW_BACKUP_ONLY: "stale" } },
      agents: { defaults: { model: 123 } },
    });
    const clobbered = await writeConfigRaw(configPath, {
      meta: { lastTouchedVersion: "2026.5.28" },
    });
    const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });
    expect(snapshot.valid).toBe(true);
    expect(snapshot.config.gateway?.mode).toBeUndefined();
    expect(await fsp.readFile(configPath, "utf-8")).toBe(clobbered.raw);
    expect(await listClobberFiles(configPath)).toHaveLength(0);
    expect(env.OPENCLAW_BACKUP_ONLY).toBeUndefined();
  });

  it("recovery refuses a backup without gateway mode despite a stale healthy fingerprint", async () => {
    const { deps, configPath, auditPath } = makeDeps(home);
    const snapshot = await makeSnapshot(configPath, recoverableTelegramConfig);
    await promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot, logger: deps.logger });
    await fsp.writeFile(
      `${configPath}.bak`,
      `${JSON.stringify({ meta: { lastTouchedVersion: "2026.4.22" } })}\n`,
      "utf-8",
    );
    const clobbered = await writeClobberedUpdateChannel(configPath);
    const prepareBackup = vi.fn(approveRecoveryCandidate);
    const input = { deps, configPath, ...clobbered, prepareBackup };

    const recovered = await maybeRecoverSuspiciousConfigRead(input);

    expect(prepareBackup).not.toHaveBeenCalled();
    expect(recovered).toEqual(clobbered);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
    await expect(readObserveEvents(auditPath)).resolves.toEqual([]);
  });

  it("recovery uses canonical metadata fingerprints", async () => {
    const { deps, configPath } = makeDeps(home);
    const backup = { meta: { authoredBy: "operator" }, gateway: { mode: "local" } };
    await seedConfigBackup(configPath, backup);
    const clobbered = await writeConfigRaw(configPath, { gateway: { mode: "local" } });
    const input = { deps, configPath, ...clobbered, prepareBackup: approveRecoveryCandidate };

    const recovered = await maybeRecoverSuspiciousConfigRead(input);

    expect(recovered.parsed).toEqual(backup);
  });

  it.each([
    {
      name: "retries recovery on next launch after a failed atomic replace",
      mode: "async",
    },
    {
      name: "sync recovery retries on next launch after a failed atomic replace",
      mode: "sync",
    },
  ] as const)("$name", async ({ mode }) => {
    const { deps, configPath, auditPath, warn } = makeDeps(home);
    await seedConfigBackup(configPath, recoverableTelegramConfig);
    const clobbered = await writeClobberedUpdateChannel(configPath);
    if (process.platform !== "win32") {
      await fsp.chmod(configPath, 0o644);
    }
    const copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const failingFs: ObserveRecoveryDeps["fs"] =
      mode === "async"
        ? {
            ...deps.fs,
            promises: {
              ...deps.fs.promises,
              rename: (source, target) =>
                target === configPath
                  ? Promise.reject(copyError)
                  : deps.fs.promises.rename(source, target),
            },
          }
        : {
            ...deps.fs,
            renameSync: (source, target) => {
              if (target === configPath) {
                throw copyError;
              }
              return deps.fs.renameSync(source, target);
            },
          };
    const recover = (recoveryDeps: ObserveRecoveryDeps) => {
      const input = {
        deps: recoveryDeps,
        configPath,
        ...clobbered,
        prepareBackup: approveRecoveryCandidate,
      };
      return mode === "async"
        ? maybeRecoverSuspiciousConfigRead(input)
        : maybeRecoverSuspiciousConfigReadSync(input);
    };
    const recovered = await recover({ ...deps, fs: failingFs });

    expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
    expectWarnContaining(warn, "Config auto-restore from backup failed:");
    expectWarnNotContaining(warn, "Config auto-restored from backup:");
    if (mode === "sync") {
      expectWarnContaining(warn, "EACCES: permission denied");
    }

    const firstEvents = await readObserveEvents(auditPath);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]).toMatchObject({
      restoredFromBackup: false,
      valid: false,
      restoreErrorCode: "EACCES",
      restoreErrorMessage: "EACCES: permission denied",
    });
    const retryResult = await recover(deps);
    expect((retryResult.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
    await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobbered.raw);
    const retryEvents = await readObserveEvents(auditPath);
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[1]?.restoredFromBackup).toBe(true);
    if (process.platform !== "win32") {
      expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("restores the exact backup bytes approved by preparation", async () => {
    const { deps, configPath } = makeDeps(home);
    await seedConfigBackup(configPath, recoverableTelegramConfig);
    const backupPath = `${configPath}.bak`;
    const approvedRaw = await fsp.readFile(backupPath, "utf-8");
    const replacementRaw = `${JSON.stringify({ gateway: { mode: "remote" } }, null, 2)}\n`;
    const clobbered = await writeClobberedUpdateChannel(configPath);
    const input = { deps, configPath, ...clobbered, prepareBackup: approveRecoveryCandidate };

    await maybeRecoverSuspiciousConfigRead({
      ...input,
      prepareBackup: (candidate) => {
        fs.writeFileSync(backupPath, replacementRaw, "utf-8");
        return { ok: true, candidate };
      },
    });

    await expect(fsp.readFile(backupPath, "utf-8")).resolves.toBe(replacementRaw);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(approvedRaw);
  });

  it.each([
    { mode: "OPENCLAW_CONFIG_READONLY", operation: "promotion" },
    { mode: "OPENCLAW_NIX_MODE", operation: "restoration" },
  ])(
    "$mode skips last-known-good $operation without source writes",
    async ({ mode, operation }) => {
      const { deps, configPath } = makeDeps(home);
      const snapshot = await makeSnapshot(configPath, recoverableCoreConfig);
      if (operation === "restoration") {
        await expect(promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot })).resolves.toBe(
          true,
        );
      }
      deps.env[mode] = "1";
      if (operation === "promotion") {
        await expect(promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot })).resolves.toBe(
          false,
        );
        await expectPathMissing(resolveLastKnownGoodConfigPath(configPath));
        expect(await fsp.readFile(configPath, "utf-8")).toBe(snapshot.raw);
      } else {
        const brokenRaw = "{ gateway: { mode: 123 } }\n";
        await fsp.writeFile(configPath, brokenRaw, "utf-8");
        await expect(
          recoverConfigFromLastKnownGoodCore({
            deps,
            snapshot: invalidSnapshot(snapshot, brokenRaw),
            reason: "test-readonly-config",
            prepareCandidate: approveRecoveryCandidate,
          }),
        ).resolves.toBe(false);
        expect(await fsp.readFile(configPath, "utf-8")).toBe(brokenRaw);
        expect(await fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).toBe(
          snapshot.raw,
        );
      }
      await expect(listClobberFiles(configPath)).resolves.toHaveLength(0);
    },
  );

  it("promotes a valid startup config and restores it after an invalid direct edit", async () => {
    const { deps, configPath, auditPath, warn } = makeDeps(home);
    const snapshot = await makeSnapshot(configPath, {
      gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
      channels: { discord: { enabled: true, dmPolicy: "pairing" } },
    });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot, logger: deps.logger }),
    ).resolves.toBe(true);
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      snapshot.raw,
    );

    const brokenRaw = "{ gateway: { mode: 123 } }\n";
    await fsp.writeFile(configPath, brokenRaw, "utf-8");
    const restored = await recoverConfigFromLastKnownGoodCore({
      deps,
      snapshot: invalidSnapshot(snapshot, brokenRaw),
      reason: "test-invalid-config",
      prepareCandidate: approveRecoveryCandidate,
    });

    expect(restored).toBe(true);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(snapshot.raw);
    expectWarnContaining(warn, "Config auto-restored from last-known-good:");
    expectWarnContaining(warn, "Rejected validation details: gateway.mode: Expected string.");
    const observe = await readLastObserveEvent(auditPath);
    expect(observe?.restoredFromBackup).toBe(true);
    expect(observe?.restoredBackupPath).toBe(resolveLastKnownGoodConfigPath(configPath));
  });

  it("leaves the active config untouched when its owner rejects last-known-good recovery", async () => {
    const { deps, configPath, warn } = makeDeps(home);
    const snapshot = await makeSnapshot(configPath, {
      gateway: { mode: "local" },
    });
    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot, logger: deps.logger }),
    ).resolves.toBe(true);

    const brokenRaw = "{ gateway: { mode: 123 } }\n";
    await fsp.writeFile(configPath, brokenRaw, "utf-8");
    const restored = await recoverConfigFromLastKnownGoodCore({
      deps,
      snapshot: invalidSnapshot(snapshot, brokenRaw),
      reason: "test-invalid-config",
      prepareCandidate: () => ({
        ok: false,
        reason: "candidate cannot converge under the current schema",
      }),
    });

    expect(restored).toBe(false);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(brokenRaw);
    await expect(listClobberFiles(configPath)).resolves.toHaveLength(0);
    expectWarnContaining(warn, "candidate cannot converge under the current schema");
  });

  it("does not restore stale last-known-good for plugin schema evolution issues", async () => {
    const { deps, configPath, warn } = makeDeps(home);
    const staleSnapshot = await makeSnapshot(configPath, recoverableCoreConfig);
    expect(await promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: staleSnapshot })).toBe(
      true,
    );
    const active = await writeConfigRaw(configPath, {
      gateway: { mode: "local" },
      plugins: { entries: { "lossless-claw": { config: { cacheAwareCompaction: true } } } },
    });
    expect(
      await recoverConfigFromLastKnownGoodCore({
        deps,
        snapshot: {
          ...staleSnapshot,
          ...active,
          valid: false,
          issues: [
            {
              path: "plugins.entries.lossless-claw.config.cacheAwareCompaction",
              message: "invalid config: must NOT have additional properties",
            },
          ],
        },
        reason: "reload-invalid-config",
        prepareCandidate: approveRecoveryCandidate,
      }),
    ).toBe(false);
    expect(await fsp.readFile(configPath, "utf-8")).toBe(active.raw);
    expectWarnContaining(warn, "Config last-known-good recovery skipped");
  });

  it("refuses to promote redacted secret placeholders", async () => {
    const warn = vi.fn();
    const { deps, configPath } = makeDeps(home, warn);
    const snapshot = await makeSnapshot(configPath, {
      gateway: { mode: "local", auth: { mode: "token", token: "***" } },
    });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot, logger: deps.logger }),
    ).resolves.toBe(false);
    await expectPathMissing(resolveLastKnownGoodConfigPath(configPath));
    expectWarnContaining(warn, "Config last-known-good promotion skipped");
  });
  it("preserves another config and a later promotion while an async observation is pending", async () => {
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    };
    const first = createTestConfigIO(home, vi.fn(), { env });
    const secondPath = path.join(home, ".openclaw", "second.json");
    const options = {
      fs,
      json5: JSON5,
      env,
      homedir: () => home,
      logger: { warn: vi.fn(), error: vi.fn() },
    };
    await fsp.mkdir(path.dirname(first.configPath), { recursive: true });
    const raw = JSON.stringify({
      meta: { lastTouchedVersion: "2026.9.4" },
      gateway: { mode: "local" },
    });
    await fsp.writeFile(first.configPath, raw);
    await fsp.writeFile(secondPath, raw);
    const snapshotA = await createConfigIO({
      ...options,
      configPath: first.configPath,
      observe: false,
    }).readConfigFileSnapshot();
    const snapshotB = await createConfigIO({
      ...options,
      configPath: secondPath,
      observe: false,
    }).readConfigFileSnapshot();
    const old = configObserveState.createConfigHealthFingerprint({
      raw,
      parsed: snapshotA.parsed,
      stat: fs.statSync(first.configPath),
      observedAt: "2000-01-01T00:00:00.000Z",
    });
    patchConfigHealthEntryToStore(options, first.configPath, { lastPromotedGood: old });
    patchConfigHealthEntryToStore(options, secondPath, {
      lastKnownGood: old,
      lastPromotedGood: old,
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const readFingerprint = configObserveState.readConfigFingerprintForPath;
    const spy = vi
      .spyOn(configObserveState, "readConfigFingerprintForPath")
      .mockImplementation(async (deps, candidatePath) => {
        const result = await readFingerprint(deps, candidatePath);
        if (candidatePath === `${first.configPath}.bak`) {
          entered.resolve();
          await release.promise;
        }
        return result;
      });
    const pending = first.io.readConfigFileSnapshot();
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Observation completed before its backup read");
        }),
      ]);
      expect(await first.io.promoteConfigSnapshotToLastKnownGood(snapshotA)).toBe(true);
      expect(
        await createConfigIO({
          ...options,
          configPath: secondPath,
        }).promoteConfigSnapshotToLastKnownGood(snapshotB),
      ).toBe(true);
      const promoted = readConfigHealthStateFromStore(options);
      expect(promoted.entries?.[first.configPath]?.lastPromotedGood).not.toEqual(old);
      release.resolve();
      expect((await pending).valid).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      const settled = readConfigHealthStateFromStore(options);
      expect(settled.entries?.[first.configPath]?.lastPromotedGood).toEqual(
        promoted.entries?.[first.configPath]?.lastPromotedGood,
      );
      expect(settled.entries?.[secondPath]).toEqual(promoted.entries?.[secondPath]);
      expect(settled.entries?.[first.configPath]?.lastObservedSuspiciousSignature).toBeNull();
    } finally {
      release.resolve();
      await pending;
      spy.mockRestore();
    }
  });
});
