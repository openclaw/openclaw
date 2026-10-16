import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getPreparedPluginSecretInput } from "./prepared-plugin-input.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

const secretRef = { source: "env", provider: "default", id: "PREPARED_PLUGIN_KEY" } as const;

function configWithSecret(value: unknown, id: string): OpenClawConfig {
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

function snapshot(value: string, id: string): PreparedSecretsRuntimeSnapshot {
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

function activate(value: string, id: string): void {
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

afterEach(() => {
  clearSecretsRuntimeSnapshotState();
});

describe("prepared plugin secret input authority", () => {
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
