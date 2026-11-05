/** Tests secrets runtime loadable plugin origin detection. */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginSecretProviderFixture } from "./plugin-secret-provider.test-support.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { withSecureTestNodeExecPath } from "./test-node-command.test-support.js";

const manifestMocks = vi.hoisted(() => ({
  listPluginOriginsFromMetadataSnapshot: vi.fn(
    (snapshot: { plugins: Array<{ id: string; origin: string }> }) =>
      new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
  ),
  loadPluginMetadataSnapshot: vi.fn<() => { plugins: Array<{ id: string; origin: string }> }>(
    () => ({
      plugins: [],
    }),
  ),
}));

vi.mock("./runtime-manifest.runtime.js", () => ({
  listPluginOriginsFromMetadataSnapshot: manifestMocks.listPluginOriginsFromMetadataSnapshot,
  resolveConfigWidePluginManifestRegistry: manifestMocks.loadPluginMetadataSnapshot,
}));

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("prepareSecretsRuntimeSnapshot loadable plugin origins", () => {
  afterEach(() => {
    manifestMocks.listPluginOriginsFromMetadataSnapshot.mockClear();
    manifestMocks.loadPluginMetadataSnapshot.mockReset();
    manifestMocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
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
