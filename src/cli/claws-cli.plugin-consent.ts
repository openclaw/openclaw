import type { ClawPluginInstallConsent } from "../claws/packages.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";

export function resolveClawPluginInstallConsent(
  runtime: RuntimeEnv,
  options: { acceptCapabilities?: boolean; approveClawHubRisk: boolean },
): ClawPluginInstallConsent {
  const onCapabilityConsent = resolvePluginCapabilityConsentCliOptions({
    action: "install",
    acceptCapabilities: options.acceptCapabilities,
    runtime,
  }).onCapabilityConsent;
  return {
    onCapabilityConsent: async (review) => await onCapabilityConsent?.(review),
    confirmInstall: async (_pluginId, warning) => !warning || options.approveClawHubRisk,
  };
}
