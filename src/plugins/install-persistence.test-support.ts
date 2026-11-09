import { vi } from "vitest";
import {
  applyExclusiveSlotSelectionMock,
  enablePluginInConfigMock,
  loadPluginManifestRegistryMock,
  loadPluginMetadataSnapshotMock,
} from "../cli/plugins-cli-test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export async function prepareRealInstallMetadata() {
  enablePluginInConfigMock.mockImplementation((...args: unknown[]) => {
    const [cfg, pluginId] = args as [OpenClawConfig, string];
    return {
      config: {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: { ...cfg.plugins?.entries, [pluginId]: { enabled: true } },
        },
      },
      enabled: true,
    };
  });
  const actualMetadata = await vi.importActual<typeof import("./plugin-metadata-snapshot.js")>(
    "./plugin-metadata-snapshot.js",
  );
  loadPluginMetadataSnapshotMock.mockImplementation(actualMetadata.loadPluginMetadataSnapshot);
  const actualSlots = await vi.importActual<typeof import("./slots.js")>("./slots.js");
  applyExclusiveSlotSelectionMock.mockImplementation((input) =>
    actualSlots.applyExclusiveSlotSelection(
      input as Parameters<typeof actualSlots.applyExclusiveSlotSelection>[0],
    ),
  );
  const actualManifest =
    await vi.importActual<typeof import("./manifest-registry.js")>("./manifest-registry.js");
  loadPluginManifestRegistryMock.mockImplementation((input) =>
    actualManifest.loadPluginManifestRegistryCore(
      input as Parameters<typeof actualManifest.loadPluginManifestRegistryCore>[0],
    ),
  );
}
