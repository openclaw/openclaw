import { createHash } from "node:crypto";
import { resolveOAuthRefreshCoordinationKey } from "../agents/auth-profiles/oauth-refresh-coordination.js";
import type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";

const CODEX_PROVIDER_ID = "openai-codex";

type CodexOAuthPlanProfile = {
  storeLabel: string;
  profileId: string;
  provider: string;
  type: "oauth";
  accountId?: string;
  email?: string;
  expires?: number;
  status: "expired" | "usable";
  accessHash?: string;
  refreshHash?: string;
};

type CodexOAuthPlanGroup = {
  kind: "account" | "email" | "refresh_hash" | "profile";
  key: string;
  profileCount: number;
  profiles: CodexOAuthPlanProfile[];
  action: "none" | "approval_required_reauth_or_repair";
};

export type CodexOAuthPlan = {
  mode: "plan";
  provider: typeof CODEX_PROVIDER_ID;
  groups: CodexOAuthPlanGroup[];
};

function shortHash(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return `sha256-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)}`;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function redactCoordinationKey(value: string): string {
  const parts = value.split("\u0000");
  const last = parts.at(-1) ?? value;
  if (last.startsWith("sha256-")) {
    return [...parts.slice(0, -1), `${last.slice(0, 19)}…`].join("\u0000");
  }
  return value;
}

function profileStatus(credential: OAuthCredential): "expired" | "usable" {
  return Number.isFinite(credential.expires) && credential.expires > Date.now()
    ? "usable"
    : "expired";
}

export function buildCodexOAuthPlan(params: {
  stores: Array<{ label: string; store: AuthProfileStore }>;
}): CodexOAuthPlan {
  const groups = new Map<string, CodexOAuthPlanGroup>();

  for (const { label, store } of params.stores) {
    for (const [profileId, credential] of Object.entries(store.profiles)) {
      if (credential.type !== "oauth" || credential.provider !== CODEX_PROVIDER_ID) {
        continue;
      }
      const coordination = resolveOAuthRefreshCoordinationKey({
        provider: CODEX_PROVIDER_ID,
        profileId,
        credential,
      });
      const groupKey = coordination.value;
      const group =
        groups.get(groupKey) ??
        ({
          kind: coordination.kind,
          key: redactCoordinationKey(coordination.value),
          profileCount: 0,
          profiles: [],
          action: "none",
        } satisfies CodexOAuthPlanGroup);
      group.profiles.push({
        storeLabel: label,
        profileId,
        provider: credential.provider,
        type: "oauth",
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
        ...(normalizeEmail(credential.email) ? { email: normalizeEmail(credential.email) } : {}),
        expires: credential.expires,
        status: profileStatus(credential),
        ...(shortHash(credential.access) ? { accessHash: shortHash(credential.access) } : {}),
        ...(shortHash(credential.refresh) ? { refreshHash: shortHash(credential.refresh) } : {}),
      });
      group.profileCount = group.profiles.length;
      group.action = group.profileCount > 1 ? "approval_required_reauth_or_repair" : "none";
      groups.set(groupKey, group);
    }
  }

  return {
    mode: "plan",
    provider: CODEX_PROVIDER_ID,
    groups: [...groups.values()].filter((group) => group.profileCount > 0),
  };
}
