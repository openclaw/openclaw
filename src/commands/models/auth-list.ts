import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth,
  resolveAuthProfileDisplayLabel,
  resolveAuthStatePathForDisplay,
  type AuthProfileCredential,
  type AuthProfileStore,
  type ProfileUsageStats,
} from "../../agents/auth-profiles.js";
import { buildAuthProfileUnusableHint } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { isActiveUnusableWindow } from "../../agents/auth-profiles/usage-state.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

function summarizeProfile(params: {
  cfg: Awaited<ReturnType<typeof loadModelsConfig>>;
  store: AuthProfileStore;
  profileId: string;
  profile: AuthProfileCredential;
  usage?: ProfileUsageStats;
}) {
  const expiresAt =
    params.profile.type === "api_key" ? undefined : timestampMsToIsoString(params.profile.expires);
  const blockedActive = isActiveUnusableWindow(params.usage?.blockedUntil, Date.now());
  const blockedUntil = blockedActive
    ? timestampMsToIsoString(params.usage?.blockedUntil)
    : undefined;
  const blockedModel =
    params.usage?.blockedScope === "model" ? params.usage.blockedModel : undefined;
  const cooldownUntil = timestampMsToIsoString(params.usage?.cooldownUntil);
  const disabledUntil = timestampMsToIsoString(params.usage?.disabledUntil);
  const disabledActive = Boolean(disabledUntil);
  const reason = disabledActive
    ? params.usage?.disabledReason
    : cooldownUntil
      ? params.usage?.cooldownReason
      : undefined;
  const recoveryHint =
    disabledUntil || cooldownUntil
      ? buildAuthProfileUnusableHint({
          kind: disabledActive ? "disabled" : "cooldown",
          reason,
          provider: params.profile.provider,
          profileId: params.profileId,
        })
      : undefined;
  return {
    id: params.profileId,
    provider: resolveProviderIdForAuth(params.profile.provider),
    type: params.profile.type,
    label: resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store: params.store,
      profileId: params.profileId,
    }),
    ...(params.profile.email ? { email: params.profile.email } : {}),
    ...(params.profile.displayName ? { displayName: params.profile.displayName } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(blockedUntil
      ? {
          blockedUntil,
          ...(params.usage?.blockedReason ? { blockedReason: params.usage.blockedReason } : {}),
          ...(params.usage?.blockedSource ? { blockedSource: params.usage.blockedSource } : {}),
          blockedScope: blockedModel ? "model" : "profile",
          ...(blockedModel ? { blockedModel } : {}),
        }
      : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(disabledUntil ? { disabledUntil } : {}),
    ...(params.usage?.cooldownReason ? { cooldownReason: params.usage.cooldownReason } : {}),
    ...(params.usage?.cooldownClassification
      ? { cooldownClassification: params.usage.cooldownClassification }
      : {}),
    ...(params.usage?.disabledReason ? { disabledReason: params.usage.disabledReason } : {}),
    ...(recoveryHint ? { recoveryHint } : {}),
  };
}

function formatProfileLine(profile: ReturnType<typeof summarizeProfile>): string {
  const details = [`${profile.provider}/${profile.type}`];
  if (profile.expiresAt) {
    details.push(`expires ${profile.expiresAt}`);
  }
  if (profile.blockedUntil) {
    const reason = profile.blockedReason ? `:${profile.blockedReason}` : "";
    const source = profile.blockedSource ? ` via ${profile.blockedSource}` : "";
    const scope =
      profile.blockedScope === "model"
        ? ` for model${profile.blockedModel ? ` ${profile.blockedModel}` : ""}`
        : " for profile";
    details.push(`blocked${reason}${source}${scope} until ${profile.blockedUntil}`);
  }
  if (profile.cooldownUntil) {
    const diagnostic = profile.cooldownClassification ?? profile.cooldownReason;
    details.push(`cooldown${diagnostic ? `:${diagnostic}` : ""} until ${profile.cooldownUntil}`);
  }
  if (profile.disabledUntil) {
    details.push(
      `disabled${profile.disabledReason ? `:${profile.disabledReason}` : ""} until ${profile.disabledUntil}`,
    );
  }
  return `- ${profile.label} [${details.join("; ")}]${profile.recoveryHint ? ` — ${profile.recoveryHint}` : ""}`;
}

export async function modelsAuthListCommand(
  opts: { provider?: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const cfg = await loadModelsConfig({ commandName: "models auth list", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, { kind: "read" });
  const provider = opts.provider?.trim() ? resolveProviderIdForAuth(opts.provider) : undefined;
  const store = ensureAuthProfileStore(
    agentDir,
    provider
      ? {
          externalCli: externalCliDiscoveryForProviderAuth({
            cfg,
            provider,
          }),
        }
      : undefined,
  );
  const profiles = Object.entries(store.profiles)
    .map(([profileId, profile]) =>
      summarizeProfile({
        cfg,
        store,
        profileId,
        profile,
        usage: store.usageStats?.[profileId],
      }),
    )
    .filter((profile) => !provider || profile.provider === provider)
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

  if (opts.json) {
    writeRuntimeJson(runtime, {
      agentId,
      agentDir: shortenHomePath(agentDir),
      authStatePath: shortenHomePath(resolveAuthStatePathForDisplay(agentDir)),
      provider: provider || null,
      profiles,
    });
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Auth state store: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
  if (provider) {
    runtime.log(`Provider: ${provider}`);
  }
  if (profiles.length === 0) {
    runtime.log("Profiles: (none)");
    return;
  }
  runtime.log("Profiles:");
  for (const profile of profiles) {
    runtime.log(formatProfileLine(profile));
  }
}
