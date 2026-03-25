// Registry of channel plugin contract test entries.
// Add entries here to exercise each plugin's contract suites.
import type { ChannelPlugin } from "../types.js";

export type ActionContractEntry = {
  id: string;
  plugin: ChannelPlugin;
  cases: unknown[];
  unsupportedAction?: unknown;
};

export type PluginContractEntry = {
  id: string;
  plugin: ChannelPlugin;
};

export type SetupContractEntry = {
  id: string;
  plugin: ChannelPlugin;
  cases: unknown[];
};

export type StatusContractEntry = {
  id: string;
  plugin: ChannelPlugin;
  cases: unknown[];
};

/** Registry for channel actions contract suites. Add entries to exercise. */
export const actionContractRegistry: ActionContractEntry[] = [];

/** Registry for channel plugin contract suites. Add entries to exercise. */
export const pluginContractRegistry: PluginContractEntry[] = [];

/** Registry for channel setup contract suites. Add entries to exercise. */
export const setupContractRegistry: SetupContractEntry[] = [];

/** Registry for channel status contract suites. Add entries to exercise. */
export const statusContractRegistry: StatusContractEntry[] = [];
