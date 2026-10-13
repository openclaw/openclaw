import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { finishConfigValidationForCli } from "../cli/config-cli-validation.js";
import {
  DeferredPluginMigrationConflictError,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { resolveDeferredPluginMigrationConfigPaths } from "./deferred-plugin-migration-config.js";
import { createConfigIO } from "./io.factory.js";
import { readCurrentConfigForPolicyCheck } from "./io.runtime.js";
import { resolveSessionStoreCompatibilityAgentId } from "./legacy.default-agent-owner.js";
import { replaceConfigFile } from "./mutate.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

describe("config IO with deferred plugin migrations", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });
  const pendingPlugin = {
    pluginId: "sample",
    reason: "The configured plugin is not installed.",
    command: "openclaw plugins install @example/sample",
  };
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
    const ioOptions = {
      env,
      configPath,
      observe: false,
      pluginValidation: "skip" as const,
      shellEnvFallback: "defer" as const,
    };
    return { root, configPath, env, ioOptions };
  }

  it.each(["new", "stronger"])(
    "protects a %s migration obligation recorded after config write planning",
    async (change) => {
      const { configPath, env, ioOptions } = fixture();
      const source = {
        gateway: { mode: "local", port: 18789 },
        session: { store: "/srv/synthetic-session-state/sessions.json" },
      };
      const original = JSON.stringify(source);
      fs.writeFileSync(configPath, original);
      if (change === "stronger") {
        await recordDeferredPluginMigrations({ env, pending: [pendingPlugin] });
      }
      const stronger = { ...pendingPlugin, configPaths: [["session", "store"]] };
      const io = createConfigIO(ioOptions);
      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 18790 } },
          {
            ...repairOptions,
            beforeCommit: async () => {
              await recordDeferredPluginMigrations({ env, pending: [stronger] });
            },
          },
        ),
      ).rejects.toBeInstanceOf(DeferredPluginMigrationConflictError);
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
      expect(readDeferredPluginMigrations({ env })).toEqual([stronger]);

      using contender = new DatabaseSync(openOpenClawStateDatabase({ env }).path);
      contender.exec("PRAGMA busy_timeout = 0");
      let publicationChecked = false;
      const resumedIo = createConfigIO({
        ...ioOptions,
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
      await resumedIo.writeConfigFile(
        { gateway: { mode: "local", port: 18790 } },
        {
          ...repairOptions,
          beforeCommit: async () => {
            await recordDeferredPluginMigrations({ env, pending: [stronger] });
          },
        },
      );
      expect(publicationChecked).toBe(true);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
        ...source,
        gateway: { mode: "local", port: 18790 },
      });
    },
  );

  it("protects include-owned inputs claimed after mutation planning", async () => {
    const { root, configPath, env, ioOptions } = fixture();
    const includePath = path.join(root, "session.json");
    const rootRaw = JSON.stringify({
      gateway: { mode: "local" },
      session: { $include: "./session.json" },
    });
    const included = { store: "/srv/synthetic-session-state/sessions.json", dmScope: "main" };
    const includeRaw = JSON.stringify(included);
    fs.writeFileSync(configPath, rootRaw);
    fs.writeFileSync(includePath, includeRaw);
    await recordDeferredPluginMigrations({ env, pending: [pendingPlugin] });
    const stronger = { ...pendingPlugin, configPaths: [["session", "store"]] };
    const io = createConfigIO(ioOptions);
    const prepared = await io.readConfigFileSnapshotForWrite();
    await expect(
      replaceConfigFile({
        ...prepared,
        io,
        sourceConfig: { ...prepared.snapshot.sourceConfig, session: { dmScope: "per-peer" } },
        writeOptions: {
          ...prepared.writeOptions,
          ...repairOptions,
          preCommitRuntimePreflight: async () => {
            await recordDeferredPluginMigrations({ env, pending: [stronger] });
          },
        },
      }),
    ).rejects.toBeInstanceOf(DeferredPluginMigrationConflictError);
    expect(fs.readFileSync(includePath, "utf8")).toBe(includeRaw);
    expect(fs.readFileSync(configPath, "utf8")).toBe(rootRaw);
    expect(fs.existsSync(`${includePath}.bak`)).toBe(false);
    expect(readDeferredPluginMigrations({ env })).toEqual([stronger]);

    const refreshed = await io.readConfigFileSnapshotForWrite();
    await replaceConfigFile({
      ...refreshed,
      io,
      sourceConfig: { ...refreshed.snapshot.sourceConfig, session: { dmScope: "per-peer" } },
      writeOptions: {
        ...refreshed.writeOptions,
        ...repairOptions,
      },
    });
    expect(JSON.parse(fs.readFileSync(includePath, "utf8"))).toEqual({
      ...included,
      dmScope: "per-peer",
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(rootRaw);
  });

  it("serves valid config while preserving pending inputs through repair writes and restart", async () => {
    const { configPath, env, ioOptions } = fixture({
      SESSION_ROOT: "/srv/synthetic-session-state",
    });
    const source = {
      gateway: { mode: "local", port: 18789 },
      session: { store: "${SESSION_ROOT}/sessions.json" },
      plugins: {
        entries: { sample: { config: { legacyRoot: "${SESSION_ROOT}/plugin" } } },
      },
      legacySample: { root: "${SESSION_ROOT}/legacy" },
    };
    fs.writeFileSync(configPath, JSON.stringify(source));
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
    expect(admitted.valid).toBe(true);
    expect(admitted.raw).toBe(JSON.stringify(source));
    expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
    await recordDeferredPluginMigrations({ env, pending: [pending] });
    closeOpenClawStateDatabaseForTest();
    const io = createConfigIO(ioOptions);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    const validation = await io.readConfigFileSnapshotWithPluginMetadata({
      prepareValidation: "strict",
    });
    expect((await finishConfigValidationForCli(validation)).valid).toBe(true);
    expect(snapshot.config.gateway?.port).toBe(18789);
    expect(snapshot.config).not.toHaveProperty("legacySample");
    expect(snapshot.sourceConfig).toHaveProperty(
      "legacySample.root",
      "/srv/synthetic-session-state/legacy",
    );
    expect(io.loadConfig().gateway?.port).toBe(18789);
    const policyConfig = readCurrentConfigForPolicyCheck({ env, configPath });
    expect(policyConfig.gateway?.port).toBe(18789);
    expect(policyConfig).not.toHaveProperty("legacySample");

    const replacement = structuredClone(snapshot.sourceConfig);
    replacement.plugins = { entries: { sample: { config: { legacyRoot: "/srv/replacement" } } } };
    await expect(
      io.writeConfigFile(replacement, {
        explicitSetPaths: [["plugins", "entries", "sample", "config", "legacyRoot"]],
        ...writeOptions,
      }),
    ).rejects.toThrow('Plugin "sample" data/settings upgrade is unfinished');
    await expect(
      io.writeConfigFile(replacement, {
        auditOrigin: "config-rpc",
        ...writeOptions,
      }),
    ).rejects.toThrow('Plugin "sample" data/settings upgrade is unfinished');
    await expect(
      io.writeConfigFile(snapshot.sourceConfig, {
        unsetPaths: [["plugins", "entries", "sample", "config"]],
        ...writeOptions,
      }),
    ).rejects.toThrow('Plugin "sample" data/settings upgrade is unfinished');
    expect(fs.readFileSync(configPath, "utf8")).toBe(JSON.stringify(source));

    await io.writeConfigFile({ gateway: { mode: "local", port: 18790 } }, repairOptions);
    const retained: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(retained).toMatchObject({
      ...source,
      gateway: { mode: "local", port: 18790 },
    });

    await recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["sample"] });
    closeOpenClawStateDatabaseForTest();
    expect((await io.readConfigFileSnapshot()).valid).toBe(false);
    await io.writeConfigFile(
      {
        gateway: { mode: "local", port: 18791 },
        session: source.session,
        plugins: { entries: { sample: { config: { root: "${SESSION_ROOT}/legacy" } } } },
      },
      repairOptions,
    );
    const migrated: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(migrated).not.toHaveProperty("legacySample");
    expect(migrated).not.toHaveProperty("plugins.entries.sample.config.legacyRoot");
    expect(migrated).toHaveProperty("plugins.entries.sample.config.root", "${SESSION_ROOT}/legacy");
    expect((await io.readConfigFileSnapshot()).valid).toBe(true);
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
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).not.toHaveProperty("legacySample");
      expect(result.config.session?.store).toBe(source.session?.store);
      expect(resolveSessionStoreCompatibilityAgentId(result.config)).toBe("operator");
    }
  });

  it.each(["missing", "stale"])(
    "defers only the unavailable plugin's %s schema and still validates healthy plugins",
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
      expect(unrelatedInvalid.ok).toBe(false);
      if (!unrelatedInvalid.ok) {
        expect(unrelatedInvalid.issues).toContainEqual(
          expect.objectContaining({ path: "plugins.entries.healthy.config.root" }),
        );
        expect(unrelatedInvalid.issues.every((issue) => !issue.path.includes("sample"))).toBe(true);
      }
      expect(
        validateConfigObjectRawWithPlugins(config, { pluginMetadataSnapshot: { manifestRegistry } })
          .ok,
      ).toBe(false);
    },
  );
});
