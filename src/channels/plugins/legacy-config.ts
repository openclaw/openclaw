import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import { listBootstrapChannelPlugins } from "./bootstrap-registry.js";

export function collectChannelLegacyConfigRules(): LegacyConfigRule[] {
  return listBootstrapChannelPlugins().flatMap((plugin) => plugin.doctor?.legacyConfigRules ?? []);
}
