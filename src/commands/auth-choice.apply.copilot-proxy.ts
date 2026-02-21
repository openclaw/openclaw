import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";

export async function applyAuthChoiceCopilotProxy(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  return await applyAuthChoicePluginProvider(params, {
    authChoice: "copilot-proxy",
    pluginId: "copilot-proxy",
    providerId: "copilot-proxy",
    methodId: "local",
    label: "Copilot Proxy",
  });
}
