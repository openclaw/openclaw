import type { ModelAuthStatusProvider } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export type ModelProviderAuthLabel = {
  kind: "subscription" | "api" | "missing";
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
    // A provider-wide plan remains ambiguous when an unusable second login exists.
    const subscriptionCount = provider.profiles.filter(
      (p) => p.type === "oauth" || p.type === "token",
    ).length;
    return {
      kind: "subscription",
      label:
        (subscriptionCount === 1 ? provider.usage?.plan : undefined) ||
        t("chat.modelControls.subscription"),
      detail: subscriptions.length > 1 || showCredentials ? account?.email : undefined,
    };
  }
  return hasApiKey ? { kind: "api", label: t("chat.modelControls.api") } : undefined;
}
