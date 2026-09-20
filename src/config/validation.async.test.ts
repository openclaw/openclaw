import { describe, expect, it, vi } from "vitest";
import * as installedRecords from "../plugins/installed-plugin-index-record-reader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawConfig } from "./types.js";
import {
  validateConfigObjectWithPlugins,
  validateConfigObjectWithPluginsAsync,
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
