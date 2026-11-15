import { expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger as mockLogSecretsForTest } from "../../test/helpers/mock-logger.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import { makePreparedSecretsSnapshot as preparedSnapshot } from "./server-startup-config.test-support.js";

it("uses startup plugin metadata only for startup and omits stale metadata on reload", async () => {
  const seenParams: Array<{
    manifestRegistry?: unknown;
    pluginMetadataSnapshot?: unknown;
  }> = [];
  const startupManifestRegistry = { plugins: [] };
  const startupPluginMetadataSnapshot = {
    plugins: [],
    manifestRegistry: startupManifestRegistry,
  };
  const activator = createRuntimeSecretsActivator({
    logSecrets: mockLogSecretsForTest(),
    emitStateEvent: vi.fn(),
    manifestRegistry: startupManifestRegistry,
    pluginMetadataSnapshot: startupPluginMetadataSnapshot,
    prepareRuntimeSecretsSnapshot: async (prepareParams) => {
      seenParams.push({
        manifestRegistry: prepareParams.manifestRegistry,
        pluginMetadataSnapshot: prepareParams.pluginMetadataSnapshot,
      });
      return preparedSnapshot(prepareParams.config);
    },
    activateRuntimeSecretsSnapshot: async () => {},
  });

  await activator({}, { reason: "startup", activate: true });
  await activator({}, { reason: "manual", activate: true });
  await activator({}, { reason: "reload", activate: true });

  expect(seenParams).toEqual([
    {
      manifestRegistry: startupManifestRegistry,
      pluginMetadataSnapshot: startupPluginMetadataSnapshot,
    },
    {
      manifestRegistry: undefined,
      pluginMetadataSnapshot: undefined,
    },
    {
      manifestRegistry: undefined,
      pluginMetadataSnapshot: undefined,
    },
  ]);
});
