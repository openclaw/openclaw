import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BundledChannelSetupEntryContract } from "../plugin-sdk/channel-entry-contract.js";
import type { BundledChannelLegacyStateMigrationDetector } from "../plugin-sdk/channel-entry-contract.types.js";
import {
  channelPluginIdBelongsToManifest,
  resolveSetupChannelRegistration,
} from "./loader-channel-setup.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";

const log = createSubsystemLogger("plugins/doctor-contracts");

export function loadLegacyChannelStateMigrationDetector(
  record: PluginManifestRecord,
  onInspectedStatelessPlugin?: (pluginId: string) => void,
): BundledChannelLegacyStateMigrationDetector | null {
  const source = record.setupSource;
  if (!source) {
    return null;
  }
  try {
    const moduleLoader = getPluginSetupModuleLoader(record, source, record.rootDir);
    return moduleLoader.initialize(() => {
      const entry = unwrapDefaultModuleExport(
        moduleLoader(source),
      ) as Partial<BundledChannelSetupEntryContract> | null; // SAFETY: Shapes are checked below before invoking callbacks.
      if (entry?.kind !== "bundled-channel-setup-entry") {
        const { plugin } = resolveSetupChannelRegistration(entry);
        if (
          !plugin?.id ||
          !channelPluginIdBelongsToManifest({
            channelId: plugin.id,
            pluginId: record.id,
            manifestChannels: record.channels,
          })
        ) {
          return null;
        }
        const detector = plugin.lifecycle?.detectLegacyStateMigrations;
        if (detector === undefined) {
          return null;
        }
        if (typeof detector !== "function") {
          throw new Error(`Plugin ${record.id} legacy migration detector is not a function.`);
        }
        return detector;
      }
      if (typeof entry.loadSetupPlugin !== "function") {
        return null;
      }
      if (typeof entry.loadLegacyStateMigrationDetector === "function") {
        const directDetector = entry.loadLegacyStateMigrationDetector();
        if (typeof directDetector !== "function") {
          throw new Error(`Plugin ${record.id} legacy migration loader did not return a detector.`);
        }
        return directDetector;
      }
      if (entry.features?.legacyStateMigrations !== true) {
        onInspectedStatelessPlugin?.(record.id);
        return null;
      }
      const lifecycleDetector = entry.loadSetupPlugin().lifecycle?.detectLegacyStateMigrations;
      return typeof lifecycleDetector === "function" ? lifecycleDetector : null;
    });
  } catch (error) {
    log.warn(
      `failed to load legacy state migration for ${record.id} from ${record.setupSource}: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}
