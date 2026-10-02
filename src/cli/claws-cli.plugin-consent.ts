import type { ClawPluginInstallConsent } from "../claws/packages.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveClawHubInstallConfirmation } from "./clawhub-install-confirmation.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";

export function resolveClawPluginInstallConsent(runtime: RuntimeEnv): ClawPluginInstallConsent {
  const onCapabilityConsent = resolvePluginCapabilityConsentCliOptions({
    action: "install",
    acceptCapabilities: true,
    runtime,
  }).onCapabilityConsent;
  const confirmInstall = resolveClawHubInstallConfirmation();
  return {
    onCapabilityConsent: async (review) => await onCapabilityConsent?.(review),
    ...(confirmInstall ? { confirmInstall } : {}),
  };
}
