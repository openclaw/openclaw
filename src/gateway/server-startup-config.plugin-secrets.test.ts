import { expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger as mockLogSecretsForTest } from "../../test/helpers/mock-logger.js";
import type { PluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import { makePreparedSecretsSnapshot as preparedSnapshot } from "./server-startup-config.test-support.js";

it("passes validated candidate plugin metadata on reload instead of reusing stale startup metadata", async () => {
  const seenParams: Array<{
    manifestRegistry?: unknown;
    pluginMetadataSnapshot?: unknown;
  }> = [];
  const startupManifestRegistry = { plugins: [] };
  const startupPluginMetadataSnapshot = {
    plugins: [],
    manifestRegistry: startupManifestRegistry,
  } as unknown as PluginMetadataSnapshot;
  const replacementManifestRegistry = {
    plugins: [
      {
        id: "updated-plugin",
        secretInputs: [{ path: "channels.updated-plugin.appPassword" }],
      },
    ],
  };
  const replacementPluginMetadataSnapshot = {
    plugins: [],
    manifestRegistry: replacementManifestRegistry,
  } as unknown as PluginMetadataSnapshot;

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
  await activator(
    {},
    { reason: "reload", activate: true, pluginMetadataSnapshot: replacementPluginMetadataSnapshot },
  );
  await activator({}, { reason: "reload", activate: true });

  expect(seenParams).toEqual([
    {
      manifestRegistry: startupManifestRegistry,
      pluginMetadataSnapshot: startupPluginMetadataSnapshot,
    },
    {
      manifestRegistry: replacementManifestRegistry,
      pluginMetadataSnapshot: replacementPluginMetadataSnapshot,
    },
    {
      manifestRegistry: undefined,
      pluginMetadataSnapshot: undefined,
    },
  ]);
});
