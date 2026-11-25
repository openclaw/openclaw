/** Tests SecretRef resolution from plugin-managed providers using prepared manifest metadata. */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginSecretProviderFixture } from "./plugin-secret-provider.test-support.js";
import { resolveSecretRefString } from "./resolve.js";
import { withSecureTestNodeExecPath } from "./test-node-command.test-support.js";

const mocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(() => {
    throw new Error("unexpected manifest registry rediscovery");
  }),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: mocks.loadPluginManifestRegistryCore,
}));

describe("resolveSecretRefString manifest registry reuse", () => {
  afterEach(() => {
    mocks.getCurrentPluginMetadataSnapshot.mockReset();
    mocks.loadPluginManifestRegistryCore.mockClear();
  });

  it("uses the current lifecycle metadata snapshot before falling back to manifest discovery", async () => {
    const { config, manifestRegistry, rootDir } = createPluginSecretProviderFixture();
    const env = { HOME: rootDir } as NodeJS.ProcessEnv;
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ manifestRegistry });
    try {
      await withSecureTestNodeExecPath(async () => {
        await expect(
          resolveSecretRefString(
            { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
            { config, env },
          ),
        ).resolves.toBe("value:providers/openrouter/apiKey");
      });
      expect(mocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
        config,
        env,
        allowWorkspaceScopedSnapshot: true,
      });
      expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
