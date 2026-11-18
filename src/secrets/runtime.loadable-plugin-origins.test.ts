/** Tests secrets runtime loadable plugin origin detection. */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginSecretProviderFixture } from "./plugin-secret-provider.test-support.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { withSecureTestNodeExecPath } from "./test-node-command.test-support.js";

type RegistrySubset = { plugins: Array<{ id: string; origin: string }> };

const manifestMocks = vi.hoisted(() => ({
  listPluginOriginsFromMetadataSnapshot: vi.fn(
    (snapshot: { plugins: Array<{ id: string; origin: string }> }) =>
      new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
  ),
  loadPluginMetadataSnapshotAsync: vi.fn<
    () => Promise<RegistrySubset & { manifestRegistry: RegistrySubset }>
  >(async () => ({ plugins: [], manifestRegistry: { plugins: [] } })),
  readPluginStateMigrationReadinessAsync: vi.fn(async () => []),
  loadPluginMetadataSnapshot: vi.fn<() => { plugins: Array<{ id: string; origin: string }> }>(
    () => ({
      plugins: [],
    }),
  ),
}));

vi.mock("./runtime-manifest.runtime.js", () => ({
  listPluginOriginsFromMetadataSnapshot: manifestMocks.listPluginOriginsFromMetadataSnapshot,
  resolveConfigWidePluginManifestRegistry: manifestMocks.loadPluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync: manifestMocks.loadPluginMetadataSnapshotAsync,
  readPluginStateMigrationReadinessAsync: manifestMocks.readPluginStateMigrationReadinessAsync,
}));

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("prepareSecretsRuntimeSnapshot loadable plugin origins", () => {
  afterEach(() => {
    manifestMocks.listPluginOriginsFromMetadataSnapshot.mockClear();
    manifestMocks.loadPluginMetadataSnapshot.mockReset();
    manifestMocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
    manifestMocks.loadPluginMetadataSnapshotAsync.mockReset();
    manifestMocks.loadPluginMetadataSnapshotAsync.mockResolvedValue({
      plugins: [],
      manifestRegistry: { plugins: [] },
    });
    manifestMocks.readPluginStateMigrationReadinessAsync.mockReset();
    manifestMocks.readPluginStateMigrationReadinessAsync.mockResolvedValue([]);
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
      expect(manifestMocks.loadPluginMetadataSnapshotAsync).not.toHaveBeenCalled();
      expect(manifestMocks.readPluginStateMigrationReadinessAsync).toHaveBeenCalledWith({
        env: expect.objectContaining({ HOME: rootDir }),
      });
      expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).toHaveBeenCalledWith(
        pluginMetadataSnapshot.manifestRegistry,
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  it.each(["ready", "metadata-error", "readiness-error"] as const)(
    "prepares cold plugin metadata asynchronously and fails closed: %s",
    async (outcome) => {
      const {
        config: providerConfig,
        rootDir,
        manifestRegistry,
      } = createPluginSecretProviderFixture();
      const config = asConfig({
        plugins: { entries: { "vault-secrets": { enabled: true } } },
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
      manifestMocks.loadPluginMetadataSnapshotAsync.mockResolvedValue({
        plugins: manifestRegistry.plugins,
        manifestRegistry,
      });
      if (outcome === "metadata-error") {
        manifestMocks.loadPluginMetadataSnapshotAsync.mockRejectedValue(
          new Error("synthetic metadata read failure"),
        );
      }
      if (outcome === "readiness-error") {
        manifestMocks.readPluginStateMigrationReadinessAsync.mockRejectedValue(
          new Error("synthetic readiness read failure"),
        );
      }
      try {
        const prepare = () =>
          prepareSecretsRuntimeSnapshot({
            config,
            assignmentConfig: asConfig({ models: config.models, secrets: config.secrets }),
            env: { HOME: rootDir },
            includeAuthStoreRefs: false,
          });
        if (outcome === "ready") {
          const snapshot = await withSecureTestNodeExecPath(prepare);
          expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("value:models/openai");
          expect(manifestMocks.readPluginStateMigrationReadinessAsync).toHaveBeenCalledWith({
            env: expect.objectContaining({ HOME: rootDir }),
          });
          const readinessOrder =
            manifestMocks.readPluginStateMigrationReadinessAsync.mock.invocationCallOrder[0];
          const originsOrder =
            manifestMocks.listPluginOriginsFromMetadataSnapshot.mock.invocationCallOrder[0];
          if (readinessOrder === undefined || originsOrder === undefined) {
            throw new Error("Expected readiness and origin discovery to run");
          }
          expect(readinessOrder).toBeLessThan(originsOrder);
        } else {
          await expect(withSecureTestNodeExecPath(prepare)).rejects.toThrow(
            outcome === "metadata-error"
              ? "synthetic metadata read failure"
              : "synthetic readiness read failure",
          );
          expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).not.toHaveBeenCalled();
          if (outcome === "metadata-error") {
            expect(manifestMocks.readPluginStateMigrationReadinessAsync).not.toHaveBeenCalled();
          }
        }
        expect(manifestMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
        expect(manifestMocks.loadPluginMetadataSnapshotAsync).toHaveBeenCalledTimes(1);
        expect(config.models?.providers?.openai?.apiKey).toEqual({
          source: "exec",
          provider: "vault",
          id: "models/openai",
        });
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    },
  );
});
