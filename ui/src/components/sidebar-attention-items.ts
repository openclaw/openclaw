import type { ModelAuthStatusResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { clampText, formatTimeAgo } from "../lib/format.ts";
import {
  hasRoutineOAuthExpiry,
  isMonitoredAuthProvider,
  listEffectiveModelAuthProviders,
} from "../lib/model-auth.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";

registerSidebarAttentionEnglish();

const ALERT_QUESTION_MAX_LENGTH = 1_000;

export function buildSidebarAttentionEntries(params: {
  modelAuthStatus: ModelAuthStatusResult | null;
  modelAuthAgentId?: string | null;
  now: number;
}): SidebarAttentionItem[] {
  const entries: SidebarAttentionItem[] = [];
  const monitored = listEffectiveModelAuthProviders(params.modelAuthStatus?.providers ?? []).filter(
    isMonitoredAuthProvider,
  );
  const expired = monitored.filter(
    (provider) =>
      provider.status === "missing" ||
      (provider.status === "expired" && !hasRoutineOAuthExpiry("expired", provider.profiles)),
  );
  for (const provider of expired) {
    // Auth is agent-scoped; one agent's dismissal must not hide another's warning.
    const signature = params.modelAuthAgentId
      ? `agent:${params.modelAuthAgentId}\n${provider.provider}`
      : provider.provider;
    const fact = `${provider.displayName}: ${provider.status}`;
    const profiles = provider.profiles.filter((profile) => profile.reasonCode !== "setup_inactive");
    const failed = profiles.find(
      (candidate) => candidate.status === "expired" || candidate.status === "missing",
    );
    // Inventory includes excluded credentials; mixed types cannot identify the failing auth method.
    const profile =
      failed && profiles.every((candidate) => candidate.type === failed.type) ? failed : undefined;
    const scope = profile?.profileId ?? params.modelAuthAgentId?.trim();
    const status = t(
      profile?.type === "oauth"
        ? "attention.signInRequired"
        : profile?.type === "api_key"
          ? "attention.apiKeyRequired"
          : "attention.authExpired",
    );
    // Status snapshots refresh, so a known expiry keeps the row's arrival stable.
    const expiredAt = provider.expiry?.at;
    const arrivedAtMs =
      expiredAt !== undefined && expiredAt <= params.now
        ? expiredAt
        : (params.modelAuthStatus?.ts ?? params.now);
    const time = formatTimeAgo(Math.max(0, params.now - arrivedAtMs), { suffix: false });
    const detail = scope
      ? t("attention.modelAuthExpiredWithScope", { scope, status, time })
      : t("attention.modelAuthExpiredState", { status, time });
    const alertTitle = t("attention.modelAuthExpired", { providers: provider.displayName });
    entries.push({
      type: "attention",
      category: "system",
      kind: "modelAuthExpired",
      dismissal: { kind: "modelAuthExpired", signature },
      requiresAction: true,
      severity: "error",
      icon: "plug",
      label: provider.displayName,
      detail,
      meta: {
        ...(scope ? { context: scope } : {}),
        status,
      },
      arrivedAtMs,
      inlineAction: {
        label: t(
          profile?.type === "oauth"
            ? "attention.signIn"
            : profile?.type === "api_key"
              ? "attention.updateApiKey"
              : "attention.reconnect",
        ),
        routeId: "model-providers",
      },
      signature,
      action: {
        kind: "askCustodian",
        alert: {
          id: `modelAuthExpired:${signature}`,
          title: alertTitle,
          facts: [fact],
          question: clampText(
            t("attention.alerts.modelAuthExpiredQuestion", { facts: fact }),
            ALERT_QUESTION_MAX_LENGTH,
          ),
          action: {
            label: t("routeTitles.modelProviders"),
            target: { kind: "navigate", routeId: "model-providers" },
          },
        },
      },
    });
  }
  return entries;
}
