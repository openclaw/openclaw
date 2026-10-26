import { expectDefined } from "@openclaw/normalization-core";
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
} from "./runtime-state.js";

const secretRef = { source: "env", provider: "default", id: "PREPARED_PLUGIN_KEY" } as const;
const pluginId = "loaded-prepared-secret-owner";

function configWithSecret(value: unknown): OpenClawConfig {
  return {
    plugins: { entries: { [pluginId]: { enabled: true, config: { apiKey: value } } } },
  } as OpenClawConfig;
}

function activate(value: string): void {
  activateSecretsRuntimeSnapshotState({
    snapshot: {
      sourceConfig: configWithSecret(secretRef),
      config: configWithSecret(value),
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    },
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

afterEach(clearSecretsRuntimeSnapshotState);

function loadedInstance(registry: ReturnType<typeof loadOpenClawPlugins>) {
  const record = registry.plugins.find((entry) => entry.id === pluginId);
  expect(record?.status).toBe("loaded");
  return expectDefined(record && getPluginInstance(record), "loaded plugin instance");
}

describe("prepared plugin secret input authority", () => {
  it("fences a loaded plugin instance from replacement credential reads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: pluginId,
      body: `module.exports = { id: "${pluginId}", register() {} };`,
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
    const instance = loadedInstance(registry);
    const readSecret = () => getPreparedPluginSecretInput(pluginId, "apiKey");

    const started = createDeferredCore();
    const release = createDeferredCore();
    let replacementRegistry: ReturnType<typeof loadOpenClawPlugins> | undefined;
    try {
      activate("old-key");
      const delayed = instance.run(async () => {
        started.resolve();
        await release.promise;
        return readSecret();
      });
      await started.promise;

      const disposal = instance.dispose();
      replacementRegistry = loadOpenClawPlugins({ config, activate: false, cache: false });
      const replacement = loadedInstance(replacementRegistry);
      activate("replacement-key");
      expect(replacement.run(readSecret)).toMatchObject({ value: "replacement-key" });
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
