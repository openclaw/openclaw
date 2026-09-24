import { describe, expect, it, vi } from "vitest";
import * as installedRecords from "../plugins/installed-plugin-index-record-reader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { computeModelPolicyAllowlist } from "./model-policy-allowlist-migration.js";
import type { OpenClawConfig } from "./types.js";
import { hasUtilityModelSeparationMigrationMarker } from "./utility-model-separation-migration.js";
import {
  validateConfigObjectWithPlugins,
  validateConfigObjectWithPluginsAsync,
  validateConfigObjectWithStrictFactsAsync,
  validateConfigObjectRawWithPlugins,
} from "./validation.js";
import type { PreparedConfigValidationPluginMetadata } from "./validation.types.js";

const env = {
  HOME: "/fixture/home",
  OPENCLAW_STATE_DIR: "/fixture/state",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};

function preparedMetadata(): PreparedConfigValidationPluginMetadata {
  const manifestRegistry: PluginManifestRegistry = {
    diagnostics: [],
    plugins: [
      {
        id: "validation-fixture",
        channels: [],
        cliBackends: [],
        hooks: [],
        providers: [],
        skills: [],
        origin: "bundled",
        rootDir: "/fixture/plugin",
        source: "/fixture/plugin/index.js",
        manifestPath: "/fixture/plugin/openclaw.plugin.json",
        configSchema: {
          type: "object",
          properties: { workspace: { type: "string", default: "prepared-workspace" } },
          required: ["workspace"],
          additionalProperties: false,
        },
      },
    ],
  };
  return { manifestRegistry, installedPluginRecordIds: new Set() };
}

describe("async config plugin validation", () => {
  it("reports ignored source paths while retaining strict authoring diagnostics", async () => {
    const raw = {
      future: true,
      plugins: { entries: { "validation-fixture": { config: { extra: 1 } } } },
    };
    const result = await validateConfigObjectWithStrictFactsAsync(raw, {
      env,
      schemaValidation: "runtime",
      loadPluginMetadataSnapshotAsync: async () => preparedMetadata(),
    });
    expect(result).toMatchObject({
      ok: true,
      config: {
        plugins: {
          entries: { "validation-fixture": { config: { workspace: "prepared-workspace" } } },
        },
      },
      ignoredPaths: [["future"], ["plugins", "entries", "validation-fixture", "config", "extra"]],
      strictIssues: [expect.objectContaining({ path: "" })],
    });
    expect(raw).toEqual({
      future: true,
      plugins: { entries: { "validation-fixture": { config: { extra: 1 } } } },
    });
  });

  it.each([false, true])(
    "ignores future markers without changing known migration semantics (%s)",
    (marked) => {
      const raw = {
        meta: {
          migrations: {
            futureMarker: true,
            ...(marked ? { modelPolicyAllowlist: true, utilityModelSeparation: true } : {}),
          },
        },
        agents: { defaults: { models: { "example/model": {} } } },
      };
      const result = validateConfigObjectRawWithPlugins(raw, {
        env,
        schemaValidation: "runtime",
        pluginValidation: "core-only",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("runtime marker projection failed");
      }
      expect(
        computeModelPolicyAllowlist({
          root: result.config,
          defaults: result.config.agents?.defaults,
        }),
      ).toEqual(marked ? null : ["example/model"]);
      expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(marked);
      expect(result.config.meta?.migrations).not.toHaveProperty("futureMarker");
      expect(raw.meta.migrations.futureMarker).toBe(true);
    },
  );

  it.each([
    ...["security", "roles"].map((id) => ({
      name: `agent ${id}`,
      raw: { agents: { entries: { [id]: { identity: { name: "Fixture", extra: true } } } } },
      ignoredPath: ["agents", "entries", id, "identity", "extra"],
    })),
    ...["auth", "security"].map((id) => ({
      name: `provider ${id}`,
      raw: {
        models: {
          providers: { [id]: { baseUrl: "https://fixture.invalid", models: [], extra: true } },
        },
      },
      ignoredPath: ["models", "providers", id, "extra"],
    })),
    {
      name: "nested human delay",
      raw: { agents: { defaults: { humanDelay: { mode: "off", extra: true } } } },
      ignoredPath: ["agents", "defaults", "humanDelay", "extra"],
    },
  ])("classifies structural owners independently of record IDs: $name", ({ raw, ignoredPath }) => {
    const options = { env, pluginValidation: "core-only" as const };
    const result = validateConfigObjectRawWithPlugins(raw, {
      ...options,
      schemaValidation: "runtime",
    });
    expect(result).toMatchObject({ ok: true, ignoredPaths: [ignoredPath] });
    if (!result.ok) {
      throw new Error("runtime structural owner projection failed");
    }
    expect(result.config).not.toHaveProperty(ignoredPath);
    expect(raw).toHaveProperty(ignoredPath, true);
    expect(validateConfigObjectRawWithPlugins(raw, options).ok).toBe(false);
  });

  it.each([
    { meta: { migrations: { modelPolicyAllowlist: false } } },
    { meta: { migrations: { utilityModelSeparation: false } } },
    { meta: { migrations: [] } },
    { gateway: { auth: { mode: "token", token: "test", extraPolicy: true } } },
    { gateway: { auth: { mode: "invalid" } } },
    { routing: { allowFrom: ["123"] } },
    { tools: { agentToAgent: { enabld: false } } },
    { agents: { defaults: { sandbx: { mode: "all" } } } },
    { agents: { entries: { main: { sandbx: { mode: "all" } } } } },
    { agents: { defaults: { sandbox: { perSession: true } } } },
    { agents: { entries: { security: { sandbox: { extraPolicy: true } } } } },
    { secrets: { providers: { default: { source: "exec", command: "/test", args: "invalid" } } } },
    {
      models: {
        providers: { custom: { baseUrl: "http://localhost", models: [], api: "invalid" } },
      },
    },
  ])("preserves essential rejection for %j", async (raw) => {
    const result = await validateConfigObjectWithPluginsAsync(raw, {
      env,
      schemaValidation: "runtime",
      loadPluginMetadataSnapshotAsync: async () => preparedMetadata(),
    });
    expect(result.ok).toBe(false);
  });

  it("retains the validated agent list projection for raw validation consumers", () => {
    const result = validateConfigObjectRawWithPlugins(
      { agents: { entries: { main: {} } } },
      { env, pluginValidation: "core-only" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.agents?.list).toEqual([{ id: "main" }]);
    }
  });

  it("returns core issues before requesting plugin metadata", async () => {
    const raw = { gateway: { port: 0 } };
    const load = vi.fn(async () => preparedMetadata());
    const result = await validateConfigObjectWithPluginsAsync(raw, {
      env,
      loadPluginMetadataSnapshotAsync: load,
    });
    expect(result).toEqual(validateConfigObjectWithPlugins(raw, { env }));
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "gateway.port" })]),
      warnings: [],
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("awaits metadata before applying defaults without mixing in later raw mutations", async () => {
    const metadata = preparedMetadata();
    const gate = createDeferredCore<PreparedConfigValidationPluginMetadata>();
    const load = vi.fn((_config: OpenClawConfig) => gate.promise);
    const raw = {
      gateway: { port: 18789 },
      plugins: {
        allow: ["validation-fixture"],
        entries: { "validation-fixture": { enabled: true, config: {} } },
      },
    };
    const expected = validateConfigObjectWithPlugins(raw, {
      env,
      pluginMetadataSnapshot: metadata,
    });
    const pending = validateConfigObjectWithPluginsAsync(raw, {
      env,
      loadPluginMetadataSnapshotAsync: load,
    });
    let settled = false;
    const observed = pending.finally(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(load).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      raw.gateway.port = 0;
      raw.plugins.allow.push("not-in-the-prepared-input");
      gate.resolve(metadata);
      const result = await observed;
      expect(result).toEqual(expected);
      expect(result).toMatchObject({
        ok: true,
        config: {
          gateway: { port: 18789 },
          plugins: {
            entries: { "validation-fixture": { config: { workspace: "prepared-workspace" } } },
          },
        },
      });
    } finally {
      gate.resolve(metadata);
      await observed;
    }
  });

  it.each(["full", "skip", "core-only"] as const)(
    "keeps synchronous %s policy and legacy ownership results",
    async (pluginValidation) => {
      const metadata = preparedMetadata();
      const raw = {
        agents: { entries: { main: { default: true }, ops: {} } },
        plugins: {
          allow: ["validation-fixture"],
          entries: { "validation-fixture": { enabled: true, config: {} } },
        },
      };
      const load = vi.fn(async () => metadata);
      const result = await validateConfigObjectWithPluginsAsync(raw, {
        env,
        pluginValidation,
        loadPluginMetadataSnapshotAsync: load,
      });
      expect(result).toEqual(
        validateConfigObjectWithPlugins(raw, {
          env,
          pluginValidation,
          pluginMetadataSnapshot: metadata,
        }),
      );
      expect(result.ok).toBe(true);
      expect(load).toHaveBeenCalledTimes(pluginValidation === "core-only" ? 0 : 1);
    },
  );

  it("uses prepared installed evidence for stale channels without a synchronous store read", async () => {
    const read = vi.spyOn(installedRecords, "loadInstalledPluginIndexInstallRecordsSync");
    const metadata = preparedMetadata();
    metadata.installedPluginRecordIds = new Set(["missing-fixture"]);
    try {
      const result = await validateConfigObjectWithPluginsAsync(
        {
          channels: { "missing-fixture": { enabled: true } },
        },
        {
          env,
          loadPluginMetadataSnapshotAsync: async () => metadata,
        },
      );
      expect(result).toMatchObject({
        ok: true,
        warnings: expect.arrayContaining([
          expect.objectContaining({
            path: "channels.missing-fixture",
            message: expect.stringContaining("stale channel plugin config ignored"),
          }),
        ]),
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
