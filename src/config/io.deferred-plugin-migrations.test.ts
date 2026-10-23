import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { finishConfigValidationForCli } from "../cli/config-cli-validation.js";
import {
  DeferredPluginMigrationConflictError,
  type DeferredPluginMigration,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  recordDeferredPluginMigrationsInTransaction,
  withDeferredPluginConfigCompletion,
} from "../infra/deferred-plugin-migrations.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import {
  hasDeferredPluginMigrationConfig,
  preserveDeferredPluginMigrationConfig,
  resolveDeferredPluginMigrationConfigPaths,
} from "./deferred-plugin-migration-config.js";
import { createConfigIO } from "./io.factory.js";
import { readCurrentConfigForPolicyCheck, withCurrentConfigPolicyReader } from "./io.runtime.js";
import type { ConfigWriteOptions, ConfigIoFactoryOptions } from "./io.types.js";
import { resolveSessionStoreCompatibilityAgentId } from "./legacy.default-agent-owner.js";
import { replaceConfigFile } from "./mutate.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

const ledger = vi.hoisted(() => ({ pendingReadsOutsideWrites: 0 }));
vi.mock("../infra/kysely-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/kysely-sync.js")>();
  return {
    ...actual,
    executeSqliteQuerySync: ((db, query) => {
      const { sql, parameters } = query.compile();
      // Publication reads pending rows inside its write transaction; other reads repeat that check.
      if (
        !("isTransaction" in db && db.isTransaction) &&
        sql.includes('"migration_runs"') &&
        parameters.includes("pending")
      ) {
        ledger.pendingReadsOutsideWrites += 1;
      }
      return actual.executeSqliteQuerySync(db, query);
    }) satisfies typeof actual.executeSqliteQuerySync,
  };
});

it("retains the authored canonical config key for a mixed-case migration owner", () => {
  const sourceConfig = {
    plugins: {
      entries: { "mixed-upgrade-proof": { enabled: true, config: { token: "retained" } } },
    },
  };
  const pending = {
    pluginId: "MiXeD-upgrade-proof",
    reason: "Package pending",
    command: "openclaw doctor --fix",
    ...resolveDeferredPluginMigrationConfigPaths({
      config: sourceConfig,
      pluginId: "MiXeD-upgrade-proof",
    }),
  };
  expect(pending.configPaths).toContainEqual([
    "plugins",
    "entries",
    "mixed-upgrade-proof",
    "config",
  ]);
  expect(hasDeferredPluginMigrationConfig(sourceConfig, pending)).toBe(true);
  expect(
    preserveDeferredPluginMigrationConfig({
      sourceConfig,
      nextConfig: { plugins: { entries: { "mixed-upgrade-proof": { enabled: true } } } },
      pending: [pending],
    }),
  ).toEqual(sourceConfig);
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const pendingMigration = (
  pluginId = "sample",
  configPaths?: string[][],
): DeferredPluginMigration => ({
  pluginId,
  ...(configPaths ? { configPaths } : {}),
  reason: "The configured plugin is not installed.",
  command: `openclaw plugins install @example/${pluginId}`,
});
const pendingPlugin = pendingMigration();
const sessionPath = [["session", "store"]];
const pluginPath = ["plugins", "entries", "sample", "config"];
const gateway = (port: number) => ({ gateway: { mode: "local" as const, port } });
const writeOptions = { skipPluginValidation: true, skipRuntimeSnapshotRefresh: true };
const repairOptions = { ...writeOptions, auditOrigin: "doctor" as const };

function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = tempDirs.make("openclaw-deferred-plugin-config-");
  const configPath = path.join(root, "openclaw.json");
  const env = {
    ...process.env,
    ...extraEnv,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: configPath,
  };
  return {
    root,
    configPath,
    env,
    readRaw: () => fs.readFileSync(configPath, "utf8"),
    readConfig: (): unknown => JSON.parse(fs.readFileSync(configPath, "utf8")),
    writeSource: (source: unknown) => {
      const raw = JSON.stringify(source);
      fs.writeFileSync(configPath, raw);
      return raw;
    },
    recordPending: async (pending: readonly DeferredPluginMigration[]) => {
      await recordDeferredPluginMigrations({ env, pending });
    },
    ioFor: (
      pending?: ConfigIoFactoryOptions["deferredPluginMigrations"],
      extra: ConfigIoFactoryOptions = {},
    ) =>
      createConfigIO({
        env,
        configPath,
        observe: false,
        pluginValidation: "skip",
        shellEnvFallback: "defer",
        ...(pending ? { deferredPluginMigrations: pending } : {}),
        ...extra,
      }),
  };
}

it("rereads policy after a config write while migration rows stay pinned", async () => {
  const { configPath, env, writeSource } = fixture();
  writeSource(gateway(18789));

  await withPluginLifecycleLease({ env }, async (lease) =>
    withCurrentConfigPolicyReader({ configPath, env, lease }, async (getCurrentConfig) => {
      expect(getCurrentConfig().gateway?.port).toBe(18789);
      writeSource(gateway(18790));
      expect(getCurrentConfig().gateway?.port).toBe(18790);
    }),
  );
});

it.each(["worker", "transaction"] as const)(
  "invalidates pinned policy before a nested %s migration write",
  async (writer) => {
    const { configPath, env, writeSource, recordPending } = fixture();
    writeSource({ gateway: { mode: "local" } });
    if (writer === "transaction") {
      await recordPending([pendingPlugin]);
    }

    await withPluginLifecycleLease({ env }, async (lease) =>
      withCurrentConfigPolicyReader({ configPath, env, lease }, async (getCurrentConfig) => {
        expect(getCurrentConfig().gateway?.mode).toBe("local");
        if (writer === "worker") {
          await recordPending([pendingPlugin]);
        } else {
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              recordDeferredPluginMigrationsInTransaction(db, {
                pending: [],
                resolvedPluginIds: [pendingPlugin.pluginId],
              }),
            { env },
          );
        }
        expect(() => getCurrentConfig()).toThrow(
          "Deferred plugin migration policy changed since review.",
        );
      }),
    );
  },
);
it("normal reads and writes never inspect deferred migration records", async () => {
  const { configPath, env, readConfig, writeSource, recordPending, ioFor } = fixture();
  writeSource(gateway(18789));
  await recordPending([pendingPlugin]);
  const databasePath = openOpenClawStateDatabase({ env }).path;
  await closeOpenClawStateDatabaseAsync();
  {
    using db = new DatabaseSync(databasePath);
    // A pending-record read must fail even though canonical config remains usable.
    db.prepare("UPDATE migration_runs SET report_json = ? WHERE id = ?").run(
      "invalid migration report",
      "deferred-plugin-migration:sample",
    );
  }
  const io = ioFor();
  expect(io.loadConfig().gateway?.port).toBe(18789);
  expect((await io.loadConfigAsync()).gateway?.port).toBe(18789);
  expect((await io.readConfigFileSnapshot()).valid).toBe(true);
  expect(
    (await io.readConfigFileSnapshotWithPluginMetadata({ prepareValidation: "strict" })).snapshot
      .valid,
  ).toBe(true);
  expect(readCurrentConfigForPolicyCheck({ env, configPath }).gateway?.port).toBe(18789);
  await io.writeConfigFile(gateway(18790), writeOptions);
  expect(readConfig()).toMatchObject({ gateway: { port: 18790 } });
  const prepared = await io.readConfigFileSnapshotForWrite();
  await replaceConfigFile({
    ...prepared,
    io,
    nextConfig: { ...prepared.snapshot.sourceConfig, gateway: { mode: "local", port: 18791 } },
    writeOptions: { ...prepared.writeOptions, ...writeOptions },
  });
  expect(readConfig()).toMatchObject({ gateway: { port: 18791 } });
  expect(() => readDeferredPluginMigrations({ env })).toThrow();
});

it.each(["new", "stronger"])(
  "protects %s migration obligations after write planning",
  async (change) => {
    const { configPath, env, readRaw, readConfig, writeSource, recordPending, ioFor } = fixture();
    const source = {
      ...gateway(18789),
      session: { store: "/srv/synthetic-session-state/sessions.json" },
    };
    const original = writeSource(source);
    if (change === "stronger") {
      await recordPending([pendingPlugin]);
    }
    const stronger = pendingMigration("sample", sessionPath);
    const io = ioFor(change === "stronger" ? [pendingPlugin] : []);
    const commit = (writer: ReturnType<typeof createConfigIO>) =>
      writer.writeConfigFile(gateway(18790), {
        ...repairOptions,
        beforeCommit: () => recordPending([stronger]),
      });
    await expect(commit(io)).rejects.toBeInstanceOf(DeferredPluginMigrationConflictError);
    expect(readRaw()).toBe(original);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
    expect(readDeferredPluginMigrations({ env })).toEqual([stronger]);

    const databasePath = openOpenClawStateDatabase({ env }).path;
    await closeOpenClawStateDatabaseAsync();
    using contender = new DatabaseSync(databasePath);
    contender.exec("PRAGMA busy_timeout = 0");
    let publicationChecked = false;
    const resumedIo = ioFor([stronger], {
      fs: {
        ...fs,
        renameSync: (from, to) => {
          if (to === configPath) {
            try {
              expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
              publicationChecked = true;
            } finally {
              if (contender.isTransaction) {
                contender.exec("ROLLBACK");
              }
            }
          }
          fs.renameSync(from, to);
        },
      },
    });
    await commit(resumedIo);
    expect(publicationChecked).toBe(true);
    expect(readConfig()).toMatchObject({ ...source, ...gateway(18790) });
  },
);

it("protects include-owned inputs claimed after mutation planning", async () => {
  const { root, configPath, env, readRaw, recordPending, ioFor } = fixture();
  const includePath = path.join(root, "session.json");
  const rootRaw = JSON.stringify({
    gateway: { mode: "local" },
    session: { $include: "./session.json" },
  });
  const included = { store: "/srv/synthetic-session-state/sessions.json", dmScope: "main" };
  const includeRaw = JSON.stringify(included);
  fs.writeFileSync(configPath, rootRaw);
  fs.writeFileSync(includePath, includeRaw);
  await recordPending([pendingPlugin]);
  const stronger = pendingMigration("sample", sessionPath);
  const writeSession = async (
    io: ReturnType<typeof createConfigIO>,
    preCommitRuntimePreflight?: () => Promise<void>,
  ) => {
    const prepared = await io.readConfigFileSnapshotForWrite();
    return replaceConfigFile({
      ...prepared,
      io,
      sourceConfig: { ...prepared.snapshot.sourceConfig, session: { dmScope: "per-peer" } },
      writeOptions: { ...prepared.writeOptions, ...repairOptions, preCommitRuntimePreflight },
    });
  };
  await expect(
    writeSession(ioFor([pendingPlugin]), () => recordPending([stronger])),
  ).rejects.toBeInstanceOf(DeferredPluginMigrationConflictError);
  expect(fs.readFileSync(includePath, "utf8")).toBe(includeRaw);
  expect(readRaw()).toBe(rootRaw);
  expect(fs.existsSync(`${includePath}.bak`)).toBe(false);
  expect(readDeferredPluginMigrations({ env })).toEqual([stronger]);

  await writeSession(ioFor([stronger]));
  expect(JSON.parse(fs.readFileSync(includePath, "utf8"))).toEqual({
    ...included,
    dmScope: "per-peer",
  });
  expect(readRaw()).toBe(rootRaw);
});

it("Doctor supplies pending facts to preserve legacy inputs through repair writes", async () => {
  const { configPath, env, readRaw, readConfig, writeSource, recordPending, ioFor } = fixture({
    SESSION_ROOT: "/srv/synthetic-session-state",
  });
  const source = {
    ...gateway(18789),
    session: { store: "${SESSION_ROOT}/sessions.json" },
    plugins: {
      entries: { sample: { config: { legacyRoot: "${SESSION_ROOT}/plugin" } } },
    },
    legacySample: { root: "${SESSION_ROOT}/legacy" },
  };
  writeSource(source);
  const pending = {
    ...pendingPlugin,
    ...resolveDeferredPluginMigrationConfigPaths({
      config: source,
      pluginId: "sample",
      compatibilityMigrationPaths: ["legacySample"],
    }),
  };
  const admitted = await createConfigIO({
    env,
    configPath,
    observe: false,
    pluginValidation: "core-only",
    deferredPluginMigrations: [pending],
  }).readConfigFileSnapshot();
  expect(admitted).toMatchObject({ valid: true, raw: JSON.stringify(source) });
  expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
  await recordPending([pending]);
  closeOpenClawStateDatabaseForTest();
  const io = ioFor([pending]);
  const runtimeIo = ioFor();
  const snapshot = await io.readConfigFileSnapshot();
  const validation = await io.readConfigFileSnapshotWithPluginMetadata({
    prepareValidation: "strict",
  });
  expect((await finishConfigValidationForCli(validation)).valid).toBe(true);
  expect(snapshot).toMatchObject({ valid: true, config: { gateway: { port: 18789 } } });
  expect(snapshot.config).not.toHaveProperty("legacySample");
  expect(snapshot.sourceConfig).toHaveProperty(
    "legacySample.root",
    "/srv/synthetic-session-state/legacy",
  );
  expect(io.loadConfig().gateway?.port).toBe(18789);
  expect(() => readCurrentConfigForPolicyCheck({ env, configPath })).toThrow();
  expect((await runtimeIo.readConfigFileSnapshot()).valid).toBe(false);

  const replacement = structuredClone(snapshot.sourceConfig);
  replacement.plugins = { entries: { sample: { config: { legacyRoot: "/srv/replacement" } } } };
  for (const [config, options] of [
    [replacement, { explicitSetPaths: [[...pluginPath, "legacyRoot"]] }],
    [replacement, { auditOrigin: "config-rpc" }],
    [snapshot.sourceConfig, { unsetPaths: [pluginPath] }],
  ] satisfies [OpenClawConfig, ConfigWriteOptions][]) {
    await expect(io.writeConfigFile(config, { ...options, ...writeOptions })).rejects.toThrow(
      'Plugin "sample" data/settings upgrade is unfinished',
    );
  }
  expect(readRaw()).toBe(JSON.stringify(source));

  await io.writeConfigFile(gateway(18790), repairOptions);
  expect(readConfig()).toMatchObject({ ...source, ...gateway(18790) });

  await recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["sample"] });
  closeOpenClawStateDatabaseForTest();
  expect((await runtimeIo.readConfigFileSnapshot()).valid).toBe(false);
  await runtimeIo.writeConfigFile(
    {
      gateway: { mode: "local", port: 18791 },
      session: source.session,
      plugins: { entries: { sample: { config: { root: "${SESSION_ROOT}/legacy" } } } },
    },
    repairOptions,
  );
  const migrated: unknown = readConfig();
  expect(migrated).not.toHaveProperty("legacySample");
  expect(migrated).not.toHaveProperty("plugins.entries.sample.config.legacyRoot");
  expect(migrated).toHaveProperty("plugins.entries.sample.config.root", "${SESSION_ROOT}/legacy");
  expect((await runtimeIo.readConfigFileSnapshot()).valid).toBe(true);
});

it("checks completion obligations only inside replace-then-write publication", async () => {
  const { env, readRaw, readConfig, writeSource, recordPending, ioFor } = fixture();
  const source = {
    ...gateway(18789),
    session: { store: "/srv/synthetic-session-state/sessions.json" },
    plugins: { entries: { sample: { config: { legacyRoot: "/srv/synthetic-sample" } } } },
  };
  const original = writeSource(source);
  const resolved = pendingMigration("sample", [pluginPath]);
  const retained = pendingMigration("other", sessionPath);
  const late = pendingMigration("late", sessionPath);
  await recordPending([retained, resolved]);
  const complete = async (beforeCommit?: () => Promise<void>) => {
    const expectedPending = readDeferredPluginMigrations({ env });
    const io = ioFor(expectedPending);
    const prepared = await io.readConfigFileSnapshotForWrite();
    ledger.pendingReadsOutsideWrites = 0;
    await withDeferredPluginConfigCompletion(
      {
        configPath: prepared.snapshot.path,
        expectedPending,
        resolvedPluginIds: ["sample"],
        assertCurrent: () => {},
      },
      () =>
        replaceConfigFile({
          ...prepared,
          io,
          nextConfig: gateway(18790),
          writeOptions: {
            ...prepared.writeOptions,
            ...writeOptions,
            auditOrigin: "plugin-install",
            beforeCommit,
          },
        }),
    );
  };

  await expect(complete(() => recordPending([late]))).rejects.toBeInstanceOf(
    DeferredPluginMigrationConflictError,
  );
  expect(ledger.pendingReadsOutsideWrites).toBe(0);
  expect(readRaw()).toBe(original);

  await complete();
  expect(ledger.pendingReadsOutsideWrites).toBe(0);
  const written: unknown = readConfig();
  expect(written).toMatchObject({
    gateway: { mode: "local", port: 18790 },
    session: source.session,
  });
  expect(written).not.toHaveProperty("plugins.entries.sample");
  expect(readDeferredPluginMigrations({ env })).toEqual([late, retained]);
});

it("keeps the migrated fixed-store owner while excluding a pending plugin field", () => {
  const source = createCanonicalAgentConfigFixture({
    agents: { list: [{ id: "operator", default: true }, { id: "worker" }] },
    session: { store: "/srv/shared/sessions.json" },
    legacySample: { root: "/srv/sample" },
  }).config;
  expect(source.agents?.defaults?.sessionStore?.agentId).toBe("operator");
  const result = validateConfigObjectWithPlugins(source, {
    pluginValidation: "core-only",
    deferredPluginMigrations: [
      {
        ...pendingPlugin,
        configPaths: [["legacySample"]],
        validationExcludedPaths: [["legacySample"]],
      },
    ],
  });
  assert(result.ok);
  expect(result.config).not.toHaveProperty("legacySample");
  expect(result.config.session?.store).toBe(source.session?.store);
  expect(resolveSessionStoreCompatibilityAgentId(result.config)).toBe("operator");
});

it.each(["missing", "stale"])(
  "defers %s plugin schema but still validates healthy plugins",
  (schemaState) => {
    const schema = {
      type: "object",
      properties: { root: { type: "string" } },
      required: ["root"],
      additionalProperties: false,
    };
    const manifestRegistry = {
      diagnostics: [
        {
          level: "error" as const,
          pluginId: "sample",
          message: "Selected payload is unavailable.",
        },
      ],
      plugins: [
        createPluginManifestRecordFixture({
          id: "sample",
          ...(schemaState === "stale" ? { configSchema: schema } : {}),
          channels: ["sample-channel"],
          channelConfigs: { "sample-channel": { schema } },
        }),
        createPluginManifestRecordFixture({ id: "healthy", configSchema: schema }),
      ],
    };
    const config = {
      plugins: {
        entries: {
          sample: { config: { legacyRoot: "/srv/sample" } },
          healthy: { config: { root: "/srv/healthy" } },
        },
      },
      channels: { "sample-channel": { legacyRoot: "/srv/sample-channel" } },
    };
    const pending = {
      pluginId: "sample",
      reason: "The selected plugin payload has not converged.",
      command: "openclaw doctor --fix",
    };
    const options = {
      pluginMetadataSnapshot: { manifestRegistry },
      deferredPluginMigrations: [pending],
    };
    const result = validateConfigObjectRawWithPlugins(config, options);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Plugin "sample"') }),
    );
    const unrelatedInvalid = validateConfigObjectRawWithPlugins(
      {
        ...config,
        plugins: {
          entries: { ...config.plugins.entries, healthy: { config: { root: 123 } } },
        },
      },
      options,
    );
    assert(!unrelatedInvalid.ok);
    expect(unrelatedInvalid.issues).toContainEqual(
      expect.objectContaining({ path: "plugins.entries.healthy.config.root" }),
    );
    expect(unrelatedInvalid.issues.every((issue) => !issue.path.includes("sample"))).toBe(true);
    expect(
      validateConfigObjectRawWithPlugins(config, { pluginMetadataSnapshot: { manifestRegistry } })
        .ok,
    ).toBe(false);
  },
);
