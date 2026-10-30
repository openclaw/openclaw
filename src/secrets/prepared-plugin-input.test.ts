import { afterEach, expect, it } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getPreparedPluginSecretInput } from "./prepared-plugin-input.js";
import { createEmptyRuntimeWebToolsMetadata } from "./runtime-fast-path.js";
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
      webTools: createEmptyRuntimeWebToolsMetadata(),
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

function createInstance() {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: pluginId });
  registry.plugins.push(record);
  return new PluginInstance(pluginId, { record, registry });
}

it("fences a retiring plugin instance from replacement credential reads", async () => {
  const instance = createInstance();
  const readSecret = () => getPreparedPluginSecretInput(pluginId, "apiKey");

  const started = createDeferredCore();
  const release = createDeferredCore();
  let replacement: PluginInstance | undefined;
  try {
    activate("old-key");
    const delayed = instance.run(async () => {
      started.resolve();
      await release.promise;
      return readSecret();
    });
    await started.promise;

    const disposal = instance.dispose();
    replacement = createInstance();
    activate("replacement-key");
    expect(replacement.run(readSecret)).toMatchObject({ value: "replacement-key" });
    release.resolve();

    expect((await delayed).value).toBeUndefined();
    await expect(disposal).resolves.toEqual({ errors: [] });
  } finally {
    release.resolve();
    await instance.dispose();
    await replacement?.dispose();
  }
});
