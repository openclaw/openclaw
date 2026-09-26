// Covers accepted hand-authored config baselines: reads that recovery must not
// revert, the accepted baselines they record, and the promoted last-good copies
// that later recognized clobbers are measured against.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareLegacyConfigMigrationRuntime } from "../commands/doctor/shared/legacy-config-migrate.test-support.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import { createConfigIO } from "./io.js";
import {
  promoteConfigSnapshotToLastKnownGoodCore,
  type maybeRecoverSuspiciousConfigRead,
} from "./io.observe-recovery.js";
import {
  clobberedUpdateChannelConfig,
  clobberedUpdateChannelRaw,
  recoverableCoreConfig,
} from "./io.observe-recovery.test-support.js";
import { createConfigIoWorkerFixture } from "./io.worker.test-support.js";
import type { ConfigFileSnapshot } from "./types.js";

type ObserveRecoveryDeps = Parameters<typeof maybeRecoverSuspiciousConfigRead>[0]["deps"];
type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

describe("config observe recovery accepted baselines", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;
  let restoreMigrationRuntime: (() => void) | undefined;
  const workerFixture = createConfigIoWorkerFixture();

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fsp.mkdir(home, { recursive: true });
    return await fn(home);
  }

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

  function readConfigHealthRow(home: string, configPath: string) {
    const { db } = openOpenClawStateDatabase({ env: { HOME: home } as NodeJS.ProcessEnv });
    const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
    return executeSqliteQueryTakeFirstSync(
      db,
      healthDb
        .selectFrom("config_health_entries")
        .select([
          "config_path",
          "last_known_good_json",
          "last_promoted_good_json",
          "last_observed_suspicious_signature",
        ])
        .where("config_path", "=", configPath),
    );
  }

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

  async function expectPathMissing(targetPath: string): Promise<void> {
    try {
      await fsp.stat(targetPath);
      throw new Error(`Expected ${targetPath} to be missing`);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
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

  function observeSuspicious(observe: Record<string, unknown> | undefined): string[] {
    const suspicious = observe?.suspicious;
    expect(Array.isArray(suspicious)).toBe(true);
    return suspicious as string[];
  }

  function expectSuspiciousIncludes(
    observe: Record<string, unknown> | undefined,
    expected: string,
  ) {
    expect(observeSuspicious(observe)).toContain(expected);
  }

  async function readLastObserveEvent(
    auditPath: string,
  ): Promise<Record<string, unknown> | undefined> {
    return (await readObserveEvents(auditPath)).at(-1);
  }

  function createTestConfigIO(
    home: string,
    warn = vi.fn(),
    options: { env?: NodeJS.ProcessEnv; observe?: boolean } = {},
  ) {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const error = vi.fn();
    // Keep recovery validation out of host/workspace plugin state. Preserve the
    // caller's env identity because rollback tests inspect that exact object.
    const env = options.env ?? ({} as NodeJS.ProcessEnv);
    env.HOME ??= home;
    env.USERPROFILE ??= home;
    env.OPENCLAW_CONFIG_PATH ??= configPath;
    env.OPENCLAW_STATE_DIR ??= path.join(home, ".openclaw");
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
        homedir: () => home,
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

  function makeDeps(
    home: string,
    warn = vi.fn(),
  ): {
    deps: ObserveRecoveryDeps;
    configPath: string;
    auditPath: string;
    warn: ReturnType<typeof vi.fn>;
  } {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn },
      },
      configPath,
      auditPath: path.join(home, ".openclaw", "logs", "config-audit.jsonl"),
      warn,
    };
  }

  it("loadConfig auto-restores tiny valid clobbers before using defaults", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, warn } = createTestConfigIO(home);
      await seedConfigBackup(configPath, recoverableCoreConfig);
      await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
      });

      const config = io.loadConfig();

      expect(config.gateway?.mode).toBe("local");
      expectWarnContaining(warn, "Config auto-restored from backup:");
    });
  });

  it("loadConfig leaves a valid hand-authored config without meta untouched (#126806)", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, warn } = createTestConfigIO(home);
      await seedConfigBackup(configPath, recoverableCoreConfig);
      // A hand-authored valid config without a `meta` block — exactly the file a
      // silent revert destroyed on a read-only command. The .bak generation is the
      // same content plus `meta`, so a restore would only re-add the `meta` block.
      const handAuthored = await writeConfigRaw(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
      });

      io.loadConfig();

      // No restore: the operator's file is the source of truth on a read-only load.
      expect(await fsp.readFile(configPath, "utf-8")).toBe(handAuthored.raw);
      expectWarnNotContaining(warn, "Config auto-restored from backup:");
      // The missing-meta signal is still observed as a warning, not silently acted on.
      expectWarnContaining(warn, "Config observe anomaly");
      expectWarnContaining(warn, "missing-meta-vs-last-good");
    });
  });

  it("loadConfig keeps a later clobber from reverting an accepted hand-authored baseline", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, warn } = createTestConfigIO(home);
      // Read 1: a fresh hand-authored config is accepted and recorded as the
      // last-known-good baseline. Product writers always stamp `meta`, so a
      // metadata-free fingerprint can only come from an operator-authored file.
      const handAuthoredRaw = `${JSON.stringify(
        { update: { channel: "beta" }, gateway: { mode: "local" } },
        null,
        2,
      )}\n`;
      await seedConfig(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
      });
      io.loadConfig();
      const lastKnownGood = readConfigHealthRow(home, configPath)?.last_known_good_json;
      expect(lastKnownGood).toBeTruthy();
      expect(JSON.parse(String(lastKnownGood)).hasMeta).toBe(false);

      // Read 2: an older update-channel `.bak` predates the accepted baseline,
      // so restoring it would silently revert the operator's hand-authored file.
      await fsp.writeFile(
        `${configPath}.bak`,
        `${JSON.stringify(recoverableCoreConfig, null, 2)}\n`,
        "utf-8",
      );
      const clobbered = await writeClobberedUpdateChannel(configPath);
      expect(clobbered.raw).not.toBe(handAuthoredRaw);

      io.loadConfig();

      // The stale `.bak` is not restored; recovery for this state stays explicit.
      expect(await fsp.readFile(configPath, "utf-8")).toBe(clobberedUpdateChannelRaw);
      expectWarnContaining(warn, "accepted baseline is hand-authored");
      expectWarnNotContaining(warn, "Config auto-restored from backup:");
    });
  });

  it("loadConfig restores a promoted accepted baseline over a recognized clobber", async () => {
    await withSuiteHome(async (home) => {
      const { deps } = makeDeps(home);
      const { io, configPath, warn } = createTestConfigIO(home);
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      // Read 1: the operator's hand-authored config is accepted, and a later
      // Gateway startup promotes those exact bytes to the retained `.last-good`.
      const handAuthoredRaw = `${JSON.stringify(
        { update: { channel: "beta" }, gateway: { mode: "local" } },
        null,
        2,
      )}\n`;
      await seedConfig(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
      });
      io.loadConfig();
      await promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: await makeSnapshot(configPath, {
          update: { channel: "beta" },
          gateway: { mode: "local" },
        }),
        logger: deps.logger,
      });
      expect(await fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).toBe(
        handAuthoredRaw,
      );

      // Read 2: a recognized clobber plus a `.bak` predating the accepted file.
      // The retained `.last-good` is the only copy of the operator's config.
      await fsp.writeFile(
        `${configPath}.bak`,
        `${JSON.stringify(recoverableCoreConfig, null, 2)}\n`,
        "utf-8",
      );
      await writeClobberedUpdateChannel(configPath);

      const config = io.loadConfig();

      expect(config.gateway?.mode).toBe("local");
      expect(await fsp.readFile(configPath, "utf-8")).toBe(handAuthoredRaw);
      expectWarnContaining(warn, `Config auto-restored from last-good: ${configPath}`);
      const observe = (await readObserveEvents(auditPath)).at(-1);
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.restoredBackupPath).toBe(resolveLastKnownGoodConfigPath(configPath));
    });
  });

  it("read snapshots keep a recognized clobber when the retained baseline diverged", async () => {
    await withSuiteHome(async (home) => {
      const { deps } = makeDeps(home);
      const { io, configPath, warn } = createTestConfigIO(home);
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      await seedConfig(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
      });
      io.loadConfig();
      await promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: await makeSnapshot(configPath, {
          update: { channel: "beta" },
          gateway: { mode: "local" },
        }),
        logger: deps.logger,
      });
      // The retained copy no longer matches the recorded baseline hash, so
      // restoring it would write unverified bytes over the active config.
      await fsp.writeFile(
        resolveLastKnownGoodConfigPath(configPath),
        "{ broken: true }\n",
        "utf-8",
      );
      await fsp.writeFile(
        `${configPath}.bak`,
        `${JSON.stringify(recoverableCoreConfig, null, 2)}\n`,
        "utf-8",
      );
      await writeClobberedUpdateChannel(configPath);

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.config.gateway?.mode).toBeUndefined();
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobberedUpdateChannelRaw);
      expectWarnContaining(warn, "accepted baseline is hand-authored");
      expectWarnContaining(warn, "no verified last-good copy exists");
      expectWarnNotContaining(warn, "Config auto-restored from");
      // Only the accepted-baseline anomaly is observed; no restore is recorded.
      const observeEvents = await readObserveEvents(auditPath);
      expect(observeEvents.filter((event) => event.restoredFromBackup === true)).toEqual([]);
    });
  });

  it("loadConfig records accepted hand-authored edits so a later clobber keeps them", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, warn } = createTestConfigIO(home);
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      // Read 1: the product wrote the baseline (meta stamped) and its backup.
      await seedConfigBackup(configPath, recoverableCoreConfig);
      io.loadConfig();
      expect(
        JSON.parse(String(readConfigHealthRow(home, configPath)?.last_known_good_json)).hasMeta,
      ).toBe(true);

      // Read 2: the operator hand-edits the file (drops `meta`, adds channels).
      // The edit stays live with only a warning and must still advance the
      // accepted baseline; otherwise the next clobber compares against the
      // stale product fingerprint and can restore pre-edit bytes.
      await writeConfigRaw(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });
      io.loadConfig();
      const baseline = JSON.parse(
        String(readConfigHealthRow(home, configPath)?.last_known_good_json),
      );
      expect(baseline.hasMeta).toBe(false);
      expectWarnContaining(warn, "missing-meta-vs-last-good");
      expectSuspiciousIncludes(await readLastObserveEvent(auditPath), "missing-meta-vs-last-good");

      // Read 3: a recognized clobber must not restore the pre-edit `.bak`.
      await writeClobberedUpdateChannel(configPath);
      io.loadConfig();

      expect(await fsp.readFile(configPath, "utf-8")).toBe(clobberedUpdateChannelRaw);
      expectWarnContaining(warn, "accepted baseline is hand-authored");
      expectWarnNotContaining(warn, "Config auto-restored from");
    });
  });

  it("read snapshots record accepted hand-authored edits so a later clobber keeps them", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, warn } = createTestConfigIO(home);
      await seedConfigBackup(configPath, recoverableCoreConfig);
      await io.readConfigFileSnapshot({ recoverSuspicious: true });
      expect(
        JSON.parse(String(readConfigHealthRow(home, configPath)?.last_known_good_json)).hasMeta,
      ).toBe(true);

      await writeConfigRaw(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });
      await io.readConfigFileSnapshot({ recoverSuspicious: true });
      expect(
        JSON.parse(String(readConfigHealthRow(home, configPath)?.last_known_good_json)).hasMeta,
      ).toBe(false);
      expectWarnContaining(warn, "missing-meta-vs-last-good");

      await writeClobberedUpdateChannel(configPath);
      await io.readConfigFileSnapshot({ recoverSuspicious: true });

      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobberedUpdateChannelRaw);
      expectWarnContaining(warn, "accepted baseline is hand-authored");
      expectWarnNotContaining(warn, "Config auto-restored from");
    });
  });

  it("loadConfig restores a promoted accepted baseline when no backup exists", async () => {
    await withSuiteHome(async (home) => {
      const { deps } = makeDeps(home);
      const { io, configPath, warn } = createTestConfigIO(home);
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      const handAuthored = { update: { channel: "beta" }, gateway: { mode: "local" } };
      // Read 1: a fresh hand-authored config is accepted, and Gateway promotes
      // those exact bytes to the retained `.last-good`. No `.bak` ever exists.
      await seedConfig(configPath, handAuthored);
      io.loadConfig();
      await promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: await makeSnapshot(configPath, handAuthored),
        logger: deps.logger,
      });
      expect(await fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).toBe(
        `${JSON.stringify(handAuthored, null, 2)}\n`,
      );
      await expectPathMissing(`${configPath}.bak`);

      // Read 2: a recognized clobber with no `.bak` — the retained `.last-good`
      // is the only verified copy of the operator's config.
      await writeClobberedUpdateChannel(configPath);

      const config = io.loadConfig();

      expect(config.gateway?.mode).toBe("local");
      expect(await fsp.readFile(configPath, "utf-8")).toBe(
        `${JSON.stringify(handAuthored, null, 2)}\n`,
      );
      expectWarnContaining(warn, `Config auto-restored from last-good: ${configPath}`);
      const observe = (await readObserveEvents(auditPath)).at(-1);
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.restoredBackupPath).toBe(resolveLastKnownGoodConfigPath(configPath));
    });
  });

  it("read snapshots restore a promoted accepted baseline when no backup exists", async () => {
    await withSuiteHome(async (home) => {
      const { deps } = makeDeps(home);
      const { io, configPath, warn } = createTestConfigIO(home);
      const handAuthored = { update: { channel: "beta" }, gateway: { mode: "local" } };
      await seedConfig(configPath, handAuthored);
      await io.readConfigFileSnapshot({ recoverSuspicious: true });
      await promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: await makeSnapshot(configPath, handAuthored),
        logger: deps.logger,
      });
      await writeClobberedUpdateChannel(configPath);

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.config.gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(
        `${JSON.stringify(handAuthored, null, 2)}\n`,
      );
      expectWarnContaining(warn, `Config auto-restored from last-good: ${configPath}`);
    });
  });

  it("loadConfig restores a promoted accepted baseline when the backup is unparsable", async () => {
    await withSuiteHome(async (home) => {
      const { deps } = makeDeps(home);
      const { io, configPath, warn } = createTestConfigIO(home);
      const handAuthored = { update: { channel: "beta" }, gateway: { mode: "local" } };
      await seedConfig(configPath, handAuthored);
      io.loadConfig();
      await promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: await makeSnapshot(configPath, handAuthored),
        logger: deps.logger,
      });
      // The backup predates the hand-authored baseline and is not even
      // parsable; it must not gate recovery from the verified `.last-good`.
      await fsp.writeFile(`${configPath}.bak`, "{ broken", "utf-8");
      await writeClobberedUpdateChannel(configPath);

      const config = io.loadConfig();

      expect(config.gateway?.mode).toBe("local");
      expect(await fsp.readFile(configPath, "utf-8")).toBe(
        `${JSON.stringify(handAuthored, null, 2)}\n`,
      );
      expectWarnContaining(warn, `Config auto-restored from last-good: ${configPath}`);
    });
  });

  it("read snapshots restore a promoted accepted baseline when the backup is unparsable", async () => {
    await withSuiteHome(async (home) => {
      const { deps } = makeDeps(home);
      const { io, configPath, warn } = createTestConfigIO(home);
      const handAuthored = { update: { channel: "beta" }, gateway: { mode: "local" } };
      await seedConfig(configPath, handAuthored);
      await io.readConfigFileSnapshot({ recoverSuspicious: true });
      await promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: await makeSnapshot(configPath, handAuthored),
        logger: deps.logger,
      });
      await fsp.writeFile(`${configPath}.bak`, "{ broken", "utf-8");
      await writeClobberedUpdateChannel(configPath);

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.config.gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(
        `${JSON.stringify(handAuthored, null, 2)}\n`,
      );
      expectWarnContaining(warn, `Config auto-restored from last-good: ${configPath}`);
    });
  });
});
