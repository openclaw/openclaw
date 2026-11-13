import type { ModelAuthStatusProvider } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerModelControlsEnglish } from "../i18n/locales/en-model-controls.ts";
import { providerUsageForAccount } from "./model-auth.ts";

registerModelControlsEnglish();

export type ModelProviderAuthLabel = {
  kind: "subscription" | "api" | "native" | "missing";
  label: string;
  detail?: string;
};

export function describeModelProviderAuth(
  provider: ModelAuthStatusProvider,
  options: {
    authProfileId?: string;
    projection?: "provider-summary" | "available-credentials";
  } = {},
): ModelProviderAuthLabel | undefined {
  const showCredentials = options.projection === "available-credentials";
  const usableProfiles = provider.profiles.filter((p) =>
    ["ok", "expiring", "static"].includes(p.status),
  );
  const profiles = showCredentials ? usableProfiles : provider.profiles;
  const subscriptions = profiles.filter((p) => p.type === "oauth" || p.type === "token");
  const active = profiles.find((p) => p.profileId === options.authProfileId);
  const hasApiKey = Boolean(provider.apiKey || profiles.some((p) => p.type === "api_key"));
  const missing =
    (showCredentials && Boolean(options.authProfileId) && !active) ||
    ((["missing", "expired"].includes(provider.status) ||
      (showCredentials && provider.profiles.length > 0)) &&
      !provider.apiKey &&
      usableProfiles.length === 0);
  if (!active && provider.nativeAuth && !(showCredentials && options.authProfileId)) {
    const { kind, plan } = provider.nativeAuth;
    return {
      kind,
      label:
        kind === "subscription"
          ? plan || t("chat.modelControls.subscription")
          : t(kind === "api" ? "chat.modelControls.api" : "chat.modelControls.nativeLogin"),
    };
  }
  if (missing) {
    return { kind: "missing", label: t("modelSetup.candidates.signInNeeded") };
  }
  if (subscriptions.length && active?.type !== "api_key") {
    if (showCredentials && hasApiKey && !active) {
      return {
        kind: "subscription",
        label: `${t("chat.modelControls.api")} / ${t("chat.modelControls.subscription")}`,
      };
    }
    // Inventory order does not identify the runtime account. An unpinned email
    // is only unambiguous when there is one subscription and no API credential.
    const account =
      active ??
      (showCredentials && subscriptions.length === 1 && !hasApiKey ? subscriptions[0] : undefined);
    return {
      kind: "subscription",
      label:
        active?.displayName ||
        providerUsageForAccount(provider, account?.profileId)?.plan ||
        t("chat.modelControls.subscription"),
      detail: account?.email,
    };
  }
  return hasApiKey ? { kind: "api", label: t("chat.modelControls.api") } : undefined;
}
