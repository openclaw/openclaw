import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveAgentConfigEntryTarget } from "../config/config-state-model.ts";
import { isPluginEnabledInConfigSnapshot } from "../plugin-activation.ts";

/** Presentation only: the Gateway rechecks its live eligibility and authority per input. */
export function isChatAutoSteerAvailable(
  state: ApplicationContext["runtimeConfig"]["state"],
  agentId: string | null | undefined,
): boolean {
  if (
    !agentId ||
    !state.connected ||
    state.configLoading ||
    state.lastError ||
    state.configNeedsApply ||
    state.configSnapshot?.valid === false
  ) {
    return false;
  }
  const config = state.configSnapshot?.runtimeConfig;
  if (!isRecord(config) || !isRecord(config.agents) || !isRecord(config.agents.defaults)) {
    return false;
  }
  const plugins = asOptionalRecord(config.plugins);
  const adviser = asOptionalRecord(asOptionalRecord(plugins?.entries)?.["auto-steer"]);
  if (
    !isPluginEnabledInConfigSnapshot({ config }, "auto-steer") ||
    asOptionalRecord(adviser?.hooks)?.allowConversationAccess === false
  ) {
    return false;
  }
  const defaults = config.agents.defaults;
  if (!isRecord(defaults.experimental) || defaults.experimental.decisionAssistance !== true) {
    return false;
  }
  const selected =
    resolveAgentConfigEntryTarget(config, agentId)?.entry.decisionModel ?? defaults.decisionModel;
  return typeof selected === "string" && parseProviderModelRef(selected) !== null;
}
