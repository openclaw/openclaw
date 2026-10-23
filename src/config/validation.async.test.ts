import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installedRecords from "../plugins/installed-plugin-index-record-reader.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import * as schemaValidator from "../plugins/schema-validator.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  validateConfigObjectWithPlugins,
  validateConfigObjectWithPluginsAsync,
  validateConfigObjectWithStrictFactsAsync,
  type ValidateConfigWithPluginsAsyncParams,
} from "./validation.js";
import type { PreparedConfigValidationPluginMetadata } from "./validation.types.js";

const env = {
  HOME: "/fixture/home",
  OPENCLAW_STATE_DIR: "/fixture/state",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
afterEach(() => vi.restoreAllMocks());

function pluginConfig() {
  return {
    plugins: {
      allow: ["validation-fixture"],
      entries: { "validation-fixture": { enabled: true, config: {} } },
    },
  };
}

function preparedMetadata(): PreparedConfigValidationPluginMetadata {
  const plugin = createPluginManifestRecordFixture({
    id: "validation-fixture",
    rootDir: "/fixture/plugin",
    source: "/fixture/plugin/index.js",
    manifestPath: "/fixture/plugin/openclaw.plugin.json",
    configSchema: {
      type: "object",
      properties: { workspace: { type: "string", default: "prepared-workspace" } },
      required: ["workspace"],
      additionalProperties: false,
    },
  });
  return {
    manifestRegistry: { diagnostics: [], plugins: [plugin] },
    installedPluginRecordIds: new Set(),
  };
}

let metadata: PreparedConfigValidationPluginMetadata;
let load = vi.fn(async () => preparedMetadata());
beforeEach(() => {
  metadata = preparedMetadata();
  load = vi.fn(async () => metadata);
});
const validate = (
  raw: unknown,
  options: Pick<ValidateConfigWithPluginsAsyncParams, "pluginValidation"> = {},
) =>
  validateConfigObjectWithPluginsAsync(raw, {
    env,
    loadPluginMetadataSnapshotAsync: load,
    ...options,
  });

describe("async config plugin validation", () => {
  it("revalidates edited settings and schemas while isolating reused plugin defaults", async () => {
    const raw = pluginConfig();
    const readWorkspace = (result: Awaited<ReturnType<typeof validate>>) => {
      return expectDefined(
        result.ok ? result.config.plugins?.entries?.["validation-fixture"]?.config : undefined,
        "fixture plugin settings",
      );
    };
    const check = vi.spyOn(schemaValidator, "validatePluginSchemaValue");
    readWorkspace(await validate(raw)).workspace = "caller-mutated";
    expect(readWorkspace(await validate(raw)).workspace).toBe("prepared-workspace");
    expect(check).toHaveBeenCalledTimes(1);

    raw.plugins.entries["validation-fixture"].config = { workspace: 42 };
    expect(await validate(raw)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ path: "plugins.entries.validation-fixture.config.workspace" }),
      ],
    });
    raw.plugins.entries["validation-fixture"].config = {};
    expect(readWorkspace(await validate(raw)).workspace).toBe("prepared-workspace");
    expect(check).toHaveBeenCalledTimes(2);
    const schema = expectDefined(metadata.manifestRegistry.plugins[0]?.configSchema, "schema");
    schema.properties = { workspace: { type: "string", default: "edited-default" } };
    expect(readWorkspace(await validate(raw)).workspace).toBe("edited-default");
    expect(check).toHaveBeenCalledTimes(3);

    metadata = preparedMetadata();
    expect(readWorkspace(await validate(raw)).workspace).toBe("prepared-workspace");
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("retires removed schema inputs without discovering metadata for an empty revision", async () => {
    const raw = pluginConfig();
    const check = vi.spyOn(schemaValidator, "validatePluginSchemaValue");
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
  });

  it.each(["runtime", "strict"] as const)(
    "validates core-only settings in %s mode without plugin metadata",
    async (mode) => {
      const validateCore =
        mode === "strict"
          ? validateConfigObjectWithStrictFactsAsync
          : validateConfigObjectWithPluginsAsync;
      const result = await validateCore(
        { gateway: { mode: "local" }, agents: { defaults: { timeoutSeconds: 30 } } },
        {
          env,
          loadPluginMetadataSnapshotAsync: async () => {
            throw new Error("Plugin metadata must not be needed for these settings");
          },
        },
      );
      expect(result).toMatchObject({
        ok: true,
        config: { gateway: { mode: "local" }, agents: { defaults: { timeoutSeconds: 30 } } },
        warnings: [],
        ...(mode === "strict" ? { strictIssues: [] } : {}),
      });
    },
  );

  it("returns core issues before requesting plugin metadata", async () => {
    const raw = { gateway: { port: 0 } };
    const result = await validate(raw);
    expect(result).toEqual(validateConfigObjectWithPlugins(raw, { env }));
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "gateway.port" })]),
      warnings: [],
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("awaits metadata before applying defaults without mixing in later raw mutations", async () => {
    const gate = createDeferredCore<PreparedConfigValidationPluginMetadata>();
    const loadPending = vi.fn(() => gate.promise);
    const raw = {
      gateway: { port: 18789 },
      ...pluginConfig(),
    };
    const expected = validateConfigObjectWithPlugins(raw, {
      env,
      pluginMetadataSnapshot: metadata,
    });
    const pending = validateConfigObjectWithPluginsAsync(raw, {
      env,
      loadPluginMetadataSnapshotAsync: loadPending,
    });
    let settled = false;
    const observed = pending.finally(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(loadPending).toHaveBeenCalledOnce();
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
      const raw = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
        ...pluginConfig(),
      };
      const result = await validate(raw, { pluginValidation });
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
    metadata.installedPluginRecordIds = new Set(["missing-fixture"]);
    const result = await validate({ channels: { "missing-fixture": { enabled: true } } });
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
  });
});
