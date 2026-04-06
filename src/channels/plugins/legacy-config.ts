import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import { iterateBootstrapChannelPlugins } from "./bootstrap-registry.js";

export function collectChannelLegacyConfigRules(): LegacyConfigRule[] {
  const rules: LegacyConfigRule[] = [];
  for (const plugin of iterateBootstrapChannelPlugins()) {
    rules.push(...(plugin.doctor?.legacyConfigRules ?? []));
  }
  return rules;
}
