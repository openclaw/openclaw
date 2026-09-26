import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getPreparedPluginSecretInput } from "./prepared-plugin-input.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

const pluginId = "prepared-secret-owner";
const secretRef = { source: "env", provider: "default", id: "PREPARED_PLUGIN_KEY" } as const;

function configWithSecret(value: unknown, id = pluginId): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [id]: {
          enabled: true,
          config: { apiKey: value },
        },
      },
    },
  } as OpenClawConfig;
}

function snapshot(value: string, id = pluginId): PreparedSecretsRuntimeSnapshot {
  const sourceConfig = configWithSecret(secretRef, id);
  const config = configWithSecret(value, id);
  return {
    sourceConfig,
    config,
    authStores: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  };
}

function activate(value: string, id = pluginId): void {
  activateSecretsRuntimeSnapshotState({
    snapshot: snapshot(value, id),
    refreshContext: {
      env: {},
      explicitAgentDirs: null,
      includeConfigRefs: true,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    },
    refreshHandler: null,
  });
}

function createOwnedInstance(): PluginInstance {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: pluginId,
    source: "/synthetic/prepared-secret-owner.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  registry.plugins.push(record);
  return new PluginInstance(pluginId, { record, registry });
}

afterEach(() => {
  clearSecretsRuntimeSnapshotState();
});

describe("prepared plugin secret input authority", () => {
  it("allows an admitted instance to read the prepared credential", async () => {
    activate("old-key");
    const instance = createOwnedInstance();
    try {
      expect(instance.run(() => getPreparedPluginSecretInput(pluginId, "apiKey"))).toMatchObject({
        value: "old-key",
      });
    } finally {
      await instance.dispose();
    }
  });

  it("rejects a retired callback while a replacement instance reads its credential", async () => {
    activate("old-key");
    const instance = createOwnedInstance();
    let replacement: PluginInstance | undefined;
    const started = createDeferredCore();
    const release = createDeferredCore();
    try {
      const delayed = instance.run(async () => {
        started.resolve();
        await release.promise;
        return getPreparedPluginSecretInput(pluginId, "apiKey");
      });
      await started.promise;

      const disposal = instance.dispose();
      replacement = createOwnedInstance();
      activate("replacement-key");
      expect(replacement.run(() => getPreparedPluginSecretInput(pluginId, "apiKey"))).toMatchObject(
        { value: "replacement-key" },
      );
      release.resolve();

      const stale = await delayed;
      expect(stale.value).toBeUndefined();
      await expect(disposal).resolves.toEqual({ errors: [] });
    } finally {
      release.resolve();
      await instance.dispose();
      await replacement?.dispose();
    }
  });

  it("fences a loaded plugin instance from replacement credential reads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "loaded-prepared-secret-owner",
      body: `module.exports = { id: "loaded-prepared-secret-owner", register() {} };`,
    });
    const config = {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        entries: { [plugin.id]: { enabled: true } },
        slots: { memory: "none" },
      },
    } satisfies OpenClawConfig;
    const registry = loadOpenClawPlugins({ config, activate: false, cache: false });
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    const instance = record ? getPluginInstance(record) : undefined;
    expect(record?.status).toBe("loaded");
    expect(instance).toBeDefined();
    if (!instance) {
      throw new Error("loaded plugin instance missing");
    }

    const started = createDeferredCore();
    const release = createDeferredCore();
    let replacementRegistry: ReturnType<typeof loadOpenClawPlugins> | undefined;
    try {
      activate("old-key", plugin.id);
      const delayed = instance.run(async () => {
        started.resolve();
        await release.promise;
        return getPreparedPluginSecretInput(plugin.id, "apiKey");
      });
      await started.promise;

      const disposal = instance.dispose();
      replacementRegistry = loadOpenClawPlugins({ config, activate: false, cache: false });
      const replacementRecord = replacementRegistry.plugins.find((entry) => entry.id === plugin.id);
      const replacement = replacementRecord ? getPluginInstance(replacementRecord) : undefined;
      expect(replacementRecord?.status).toBe("loaded");
      expect(replacement).toBeDefined();
      if (!replacement) {
        throw new Error("replacement plugin instance missing");
      }
      activate("replacement-key", plugin.id);
      expect(
        replacement.run(() => getPreparedPluginSecretInput(plugin.id, "apiKey")),
      ).toMatchObject({ value: "replacement-key" });
      release.resolve();

      expect((await delayed).value).toBeUndefined();
      await expect(disposal).resolves.toEqual({ errors: [] });
    } finally {
      release.resolve();
      await disposePluginRegistryInstances(registry);
      if (replacementRegistry) {
        await disposePluginRegistryInstances(replacementRegistry);
      }
      resetPluginLoaderTestStateForTest();
    }
  });
});
