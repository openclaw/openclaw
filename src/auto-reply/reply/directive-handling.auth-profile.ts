import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

export function resolveProfileOverride(params: {
  rawProfile?: string;
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
}): { profileId?: string; error?: string } {
  const raw = params.rawProfile?.trim();
  if (!raw) {
    return {};
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profile = store.profiles[raw];
  if (!profile) {
    return { error: `Auth profile "${raw}" not found.` };
  }
  if (profile.provider !== params.provider) {
    return {
      error: `Auth profile "${raw}" is for ${profile.provider}, not ${params.provider}.`,
    };
  }
  return { profileId: raw };
}

function isProfileForProvider(params: {
  profileId: string;
  provider: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): boolean {
  const profile = params.store.profiles[params.profileId];
  if (!profile?.provider) {
    return false;
  }
  return normalizeProviderId(profile.provider) === normalizeProviderId(params.provider);
}

function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  const compact = token?.trim();
  if (!compact) {
    return null;
  }
  const parts = compact.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolveCodexChatGPTPlanType(profile: {
  type?: string;
  access?: string;
}): string | undefined {
  if (profile.type !== "oauth") {
    return undefined;
  }
  const payload = decodeJwtPayload(profile.access);
  const auth =
    payload && typeof payload["https://api.openai.com/auth"] === "object"
      ? (payload["https://api.openai.com/auth"] as Record<string, unknown>)
      : undefined;
  const plan = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
  return plan?.trim().toLowerCase() || undefined;
}

function formatSparkPlanError(profileId: string, planType: string): string {
  const formattedPlan = planType.slice(0, 1).toUpperCase() + planType.slice(1);
  return [
    `Spark is not supported on auth profile "${profileId}" (${formattedPlan} plan).`,
    "Model/auth unchanged.",
    "",
    "Use /model spark@openai-codex:default or another Spark-capable auth profile.",
  ].join("\n");
}

export function resolveModelAuthProfile(params: {
  rawProfile?: string;
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionEntry?: Pick<SessionEntry, "authProfileOverride" | "authProfileOverrideSource">;
}): { profileId?: string; profileOverrideSource?: "auto" | "user"; error?: string } {
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const explicit = params.rawProfile?.trim();
  if (explicit) {
    const resolved = resolveProfileOverride({
      rawProfile: explicit,
      provider: params.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    return resolved.profileId
      ? {
          profileId: resolved.profileId,
          profileOverrideSource: "user",
        }
      : { error: resolved.error };
  }

  const current = params.sessionEntry?.authProfileOverride?.trim();
  if (current && isProfileForProvider({ profileId: current, provider: params.provider, store })) {
    return {
      profileId: current,
      profileOverrideSource: params.sessionEntry?.authProfileOverrideSource ?? "user",
    };
  }

  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  const first = order[0]?.trim();
  return first ? { profileId: first, profileOverrideSource: "auto" } : {};
}

export function validateModelAuthProfileCompatibility(params: {
  provider: string;
  model: string;
  profileId?: string;
  agentDir?: string;
}): { error?: string } {
  const profileId = params.profileId?.trim();
  if (!profileId) {
    return {};
  }
  if (
    normalizeProviderId(params.provider) !== "openai-codex" ||
    params.model.trim() !== "gpt-5.3-codex-spark"
  ) {
    return {};
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profile = store.profiles[profileId];
  if (!profile) {
    return {};
  }
  const planType = resolveCodexChatGPTPlanType(profile);
  if (planType && ["free", "go", "plus"].includes(planType)) {
    return { error: formatSparkPlanError(profileId, planType) };
  }
  return {};
}
