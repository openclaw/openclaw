import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installedRecords from "../plugins/installed-plugin-index-record-reader.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import * as schemaValidator from "../plugins/schema-validator.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
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
const validate = (raw: unknown, options: Partial<ValidateConfigWithPluginsAsyncParams> = {}) =>
  validateConfigObjectWithPluginsAsync(raw, {
    env,
    loadPluginMetadataSnapshotAsync: load,
    ...options,
  });
const workspace = (result: Awaited<ReturnType<typeof validate>>) =>
  expectDefined(
    result.ok ? result.config.plugins?.entries?.["validation-fixture"]?.config : undefined,
    "fixture plugin settings",
  );

describe("async config plugin validation", () => {
  it("revalidates edited settings and schemas while isolating reused plugin defaults", async () => {
    const raw = pluginConfig();
    const check = vi.spyOn(schemaValidator, "validatePluginSchemaValue");
    workspace(await validate(raw)).workspace = "caller-mutated";
    expect(workspace(await validate(raw)).workspace).toBe("prepared-workspace");
    expect(check).toHaveBeenCalledTimes(1);

    raw.plugins.entries["validation-fixture"].config = { workspace: 42 };
    expect(await validate(raw)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ path: "plugins.entries.validation-fixture.config.workspace" }),
      ],
    });
    raw.plugins.entries["validation-fixture"].config = {};
    expect(workspace(await validate(raw)).workspace).toBe("prepared-workspace");
    const schema = expectDefined(metadata.manifestRegistry.plugins[0]?.configSchema, "schema");
    schema.properties = { workspace: { type: "string", default: "edited-default" } };
    expect(workspace(await validate(raw)).workspace).toBe("edited-default");

    metadata = preparedMetadata();
    expect(workspace(await validate(raw)).workspace).toBe("prepared-workspace");
    for (const empty of [{ plugins: { enabled: false } }, { gateway: { mode: "local" } }]) {
      expect((await validate(empty)).ok).toBe(true);
      expect(workspace(await validate(raw)).workspace).toBe("prepared-workspace");
    }
    expect(check).toHaveBeenCalledTimes(6);
  });

  it.each(["runtime", "strict", "core-only"] as const)(
    "validates core-only settings in %s mode without plugin metadata",
    async (mode) => {
      const validateCore =
        mode === "strict"
          ? validateConfigObjectWithStrictFactsAsync
          : validateConfigObjectWithPluginsAsync;
      const raw = {
        gateway: { mode: "local" },
        agents: { defaults: { timeoutSeconds: 30 } },
        ...(mode === "core-only" ? pluginConfig() : {}),
      };
      const result = await validateCore(raw, {
        env,
        ...(mode === "core-only" ? { pluginValidation: "core-only" as const } : {}),
        loadPluginMetadataSnapshotAsync: async () => {
          throw new Error("Plugin metadata must not be needed for these settings");
        },
      });
      expect(result).toMatchObject({
        ok: true,
        config: raw,
        warnings: [],
        ...(mode === "strict" ? { strictIssues: [] } : {}),
      });
    },
  );

  it("returns core issues before requesting plugin metadata", async () => {
    const raw = { gateway: { port: 0 } };
    const result = await validate(raw);
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "gateway.port" })]),
      warnings: [],
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("awaits metadata before applying defaults without mixing in later raw mutations", async () => {
    const gate = createDeferredCore<PreparedConfigValidationPluginMetadata>();
    const raw = {
      gateway: { port: 18789 },
      ...pluginConfig(),
    };
    const pending = validate(raw, { loadPluginMetadataSnapshotAsync: () => gate.promise });
    let settled = false;
    const observed = pending.finally(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      raw.gateway.port = 0;
      raw.plugins.allow.push("not-in-the-prepared-input");
      gate.resolve(metadata);
      const result = await observed;
      expect(result).toMatchObject({
        ok: true,
        config: { gateway: { port: 18789 }, plugins: { allow: ["validation-fixture"] } },
      });
      expect(workspace(result).workspace).toBe("prepared-workspace");
    } finally {
      gate.resolve(metadata);
      await observed;
    }
  });

  it("preserves an unavailable channel's exact disabled marker with an actionable warning", async () => {
    const channels = { "missing-fixture": { enabled: false } };
    const result = await validate({ channels });
    expect(result.ok && result.config.channels).toEqual(channels);
    expect(result).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        {
          path: "channels.missing-fixture",
          message:
            "unknown channel id: missing-fixture (disabled channel marker preserved; install the plugin to validate it)",
        },
      ]),
    });
  });

  it.each([{ enabled: false, token: "synthetic" }, { enabled: true }, {}])(
    "rejects unknown channel settings that are not an exact disable marker: %j",
    async (settings) => {
      expect(await validate({ channels: { "missing-fixture": settings } })).toMatchObject({
        ok: false,
        issues: [
          { path: "channels.missing-fixture", message: "unknown channel id: missing-fixture" },
        ],
        warnings: [],
      });
    },
  );

  it.each([true, false])(
    "uses prepared installed evidence for stale channels (enabled: %s) without a synchronous store read",
    async (enabled) => {
      const read = vi.spyOn(installedRecords, "loadInstalledPluginIndexInstallRecordsSync");
      metadata.installedPluginRecordIds = new Set(["missing-fixture"]);
      const result = await validate({ channels: { "missing-fixture": { enabled } } });
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
    },
  );
});
