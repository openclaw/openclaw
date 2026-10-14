import { describe, expect, it, vi } from "vitest";
import * as installedRecords from "../plugins/installed-plugin-index-record-reader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import * as schemaValidator from "../plugins/schema-validator.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawConfig } from "./types.js";
import {
  validateConfigObjectWithPlugins,
  validateConfigObjectWithPluginsAsync,
  validateConfigObjectWithStrictFactsAsync,
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
  it("revalidates edited settings and schemas while isolating reused plugin defaults", async () => {
    let metadata = preparedMetadata();
    const raw = {
      plugins: {
        allow: ["validation-fixture"],
        entries: { "validation-fixture": { enabled: true, config: {} } },
      },
    };
    const validate = () =>
      validateConfigObjectWithPluginsAsync(raw, {
        env,
        loadPluginMetadataSnapshotAsync: async () => metadata,
      });
    const readWorkspace = (result: Awaited<ReturnType<typeof validate>>) => {
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected valid fixture");
      }
      const config = result.config.plugins?.entries?.["validation-fixture"]?.config;
      if (!config) {
        throw new Error("Expected fixture plugin settings");
      }
      return config;
    };
    const check = vi.spyOn(schemaValidator, "validatePluginSchemaValue");
    try {
      readWorkspace(await validate()).workspace = "caller-mutated";
      expect(readWorkspace(await validate()).workspace).toBe("prepared-workspace");
      expect(check).toHaveBeenCalledTimes(1);

      raw.plugins.entries["validation-fixture"].config = { workspace: 42 };
      expect(await validate()).toMatchObject({
        ok: false,
        issues: [
          expect.objectContaining({ path: "plugins.entries.validation-fixture.config.workspace" }),
        ],
      });
      raw.plugins.entries["validation-fixture"].config = {};
      expect(readWorkspace(await validate()).workspace).toBe("prepared-workspace");
      expect(check).toHaveBeenCalledTimes(2);
      const schema = metadata.manifestRegistry.plugins[0]?.configSchema;
      if (!schema) {
        throw new Error("Expected fixture plugin schema");
      }
      schema.properties = { workspace: { type: "string", default: "edited-default" } };
      expect(readWorkspace(await validate()).workspace).toBe("edited-default");
      expect(check).toHaveBeenCalledTimes(3);

      metadata = preparedMetadata();
      expect(readWorkspace(await validate()).workspace).toBe("prepared-workspace");
      expect(check).toHaveBeenCalledTimes(4);
    } finally {
      check.mockRestore();
    }
  });

  it("retires removed schema inputs without discovering metadata for an empty revision", async () => {
    const metadata = preparedMetadata();
    const raw = {
      plugins: {
        allow: ["validation-fixture"],
        entries: { "validation-fixture": { enabled: true, config: {} } },
      },
    };
    const load = vi.fn(async () => metadata);
    const validate = (config: unknown) =>
      validateConfigObjectWithPluginsAsync(config, {
        env,
        loadPluginMetadataSnapshotAsync: load,
      });
    const check = vi.spyOn(schemaValidator, "validatePluginSchemaValue");
    try {
      expect((await validate(raw)).ok).toBe(true);
      expect(check).toHaveBeenCalledTimes(1);
      expect((await validate({ plugins: { enabled: false } })).ok).toBe(true);
      expect((await validate(raw)).ok).toBe(true);
      expect(check).toHaveBeenCalledTimes(2);

      load.mockClear();
      expect((await validate({ gateway: { mode: "local" } })).ok).toBe(true);
      expect(load).not.toHaveBeenCalled();
      expect((await validate(raw)).ok).toBe(true);
      expect(check).toHaveBeenCalledTimes(3);
    } finally {
      check.mockRestore();
    }
  });

  it.each(["runtime", "strict"] as const)(
    "validates core-only settings in %s mode without plugin metadata",
    async (mode) => {
      const validate =
        mode === "strict"
          ? validateConfigObjectWithStrictFactsAsync
          : validateConfigObjectWithPluginsAsync;
      const result = await validate(
        { gateway: { mode: "local" }, agents: { defaults: { heartbeat: { target: "none" } } } },
        {
          env,
          loadPluginMetadataSnapshotAsync: async () => {
            throw new Error("Plugin metadata must not be needed for these settings");
          },
        },
      );
      expect(result).toMatchObject({
        ok: true,
        config: { gateway: { mode: "local" } },
        warnings: [],
        ...(mode === "strict" ? { strictIssues: [] } : {}),
      });
    },
  );

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

  it.each(["full", "core-only"] as const)(
    "keeps synchronous %s policy and explicit ownership results",
    async (pluginValidation) => {
      const metadata = preparedMetadata();
      const raw = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
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
