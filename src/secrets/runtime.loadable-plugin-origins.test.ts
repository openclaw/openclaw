/** Tests secrets runtime loadable plugin origin detection. */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createPluginSecretProviderFixture } from "./plugin-secret-provider.test-support.js";
import { getActiveSecretsRuntimeSnapshotState } from "./runtime-state.js";
import {
  activateSecretsRuntimeSnapshot,
  refreshActiveSecretsRuntimeSnapshotForConfig,
} from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { withSecureTestNodeExecPath } from "./test-node-command.test-support.js";

const manifestMocks = vi.hoisted(() => ({
  listPluginOriginsFromMetadataSnapshot: vi.fn(
    (snapshot: { plugins: Array<{ id: string; origin: string }> }) =>
      new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
  ),
  loadPluginMetadataSnapshot: vi.fn(async () => createPluginMetadataSnapshotFixture()),
}));

// mock-isolation: manifest discovery is stubbed so each case controls the plugin origins it sees.
vi.mock("./runtime-manifest.runtime.js", () => ({
  listPluginOriginsFromMetadataSnapshot: manifestMocks.listPluginOriginsFromMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync: manifestMocks.loadPluginMetadataSnapshot,
}));

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("prepareSecretsRuntimeSnapshot loadable plugin origins", () => {
  afterEach(() => {
    manifestMocks.listPluginOriginsFromMetadataSnapshot.mockClear();
    manifestMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("discovers plugin origins on the first refresh with a plugin config value", async () => {
    const ref = { source: "env", provider: "default", id: "FIXTURE_TOKEN" } as const;
    const config = asConfig({
      plugins: { entries: { example: { enabled: true } } },
      gateway: { auth: { mode: "token", token: ref } },
    });
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: { FIXTURE_TOKEN: "resolved" },
      includeAuthStoreRefs: false,
    });
    expect(snapshot.config.gateway?.auth?.token).toBe("resolved");
    expect(manifestMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).not.toHaveBeenCalled();

    activateSecretsRuntimeSnapshot(snapshot);
    manifestMocks.loadPluginMetadataSnapshot.mockResolvedValueOnce(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "example",
            origin: "config",
            configContracts: { secretInputs: { paths: [{ path: "token" }] } },
          },
        ],
      }),
    );
    const changed = {
      ...config,
      plugins: { entries: { example: { enabled: true, config: { token: ref } } } },
    };
    await expect(
      refreshActiveSecretsRuntimeSnapshotForConfig({ sourceConfig: changed }),
    ).resolves.toBe(true);
    expect(manifestMocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(
      getActiveSecretsRuntimeSnapshotState()?.config.plugins?.entries?.example?.config?.token,
    ).toBe("resolved");
  });

  it("keeps full plugin policy while projecting provider-auth assignments", async () => {
    const {
      config: providerConfig,
      rootDir,
      manifestRegistry,
    } = createPluginSecretProviderFixture();
    const pluginMetadataSnapshot = { plugins: manifestRegistry.plugins, manifestRegistry };

    try {
      const config = asConfig({
        plugins: {
          entries: {
            "vault-secrets": { enabled: true },
          },
        },
        gateway: {
          auth: {
            mode: "token",
            token: { source: "exec", provider: "vault", id: "gateway/token" },
          },
        },
        models: {
          providers: {
            openai: {
              apiKey: { source: "exec", provider: "vault", id: "models/openai" },
              models: [],
            },
          },
        },
        secrets: providerConfig.secrets,
      });
      const snapshot = await withSecureTestNodeExecPath(async () =>
        prepareSecretsRuntimeSnapshot({
          config,
          assignmentConfig: asConfig({
            models: config.models,
            secrets: config.secrets,
          }),
          env: { HOME: rootDir },
          includeAuthStoreRefs: false,
          pluginMetadataSnapshot,
        }),
      );

      expect(snapshot.config.gateway).toBeUndefined();
      expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("value:models/openai");
      expect(manifestMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
      expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).toHaveBeenCalledWith(
        pluginMetadataSnapshot.manifestRegistry,
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
