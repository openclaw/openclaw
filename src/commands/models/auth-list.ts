import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import {
  ensureAuthProfileStoreAsync,
  externalCliDiscoveryForProviderAuth,
  resolveAuthProfileDisplayLabel,
  resolveAuthStatePathForDisplay,
} from "../../agents/auth-profiles.js";
import { buildAuthProfileUnusableHint } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import {
  isActiveUnusableWindow,
  readAuthProfileUsageStats,
} from "../../agents/auth-profiles/usage-state.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

export async function modelsAuthListCommand(
  opts: { provider?: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const cfg = await loadModelsConfig({ commandName: "models auth list", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, { kind: "read" });
  const provider = opts.provider?.trim() ? resolveProviderIdForAuth(opts.provider) : undefined;
  const store = await ensureAuthProfileStoreAsync(
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
  const summaries = [];
  for (const [profileId, profile] of Object.entries(store.profiles)) {
    const usage = readAuthProfileUsageStats(store, profileId);
    const expiresAt =
      profile.type === "api_key" ? undefined : timestampMsToIsoString(profile.expires);
    const now = Date.now();
    const blockedActive = isActiveUnusableWindow(usage?.blockedUntil, now);
    const blockedUntil = blockedActive ? timestampMsToIsoString(usage?.blockedUntil) : undefined;
    const blockedModel = usage?.blockedScope === "model" ? usage.blockedModel : undefined;
    const cooldownUntil = isActiveUnusableWindow(usage?.cooldownUntil, now)
      ? timestampMsToIsoString(usage?.cooldownUntil)
      : undefined;
    const disabledUntil = isActiveUnusableWindow(usage?.disabledUntil, now)
      ? timestampMsToIsoString(usage?.disabledUntil)
      : undefined;
    const disabledActive = Boolean(disabledUntil);
    const reason = disabledActive
      ? usage?.disabledReason
      : cooldownUntil
        ? usage?.cooldownReason
        : undefined;
    const recoveryHint =
      disabledUntil || cooldownUntil
        ? buildAuthProfileUnusableHint({
            kind: disabledActive ? "disabled" : "cooldown",
            reason,
            provider: profile.provider,
            profileId,
          })
        : undefined;
    summaries.push({
      id: profileId,
      provider: resolveProviderIdForAuth(profile.provider),
      type: profile.type,
      label: resolveAuthProfileDisplayLabel({ cfg, store, profileId }),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(blockedUntil
        ? {
            blockedUntil,
            ...(usage?.blockedReason ? { blockedReason: usage.blockedReason } : {}),
            ...(usage?.blockedSource ? { blockedSource: usage.blockedSource } : {}),
            blockedScope: blockedModel ? "model" : "profile",
            ...(blockedModel ? { blockedModel } : {}),
          }
        : {}),
      ...(cooldownUntil ? { cooldownUntil } : {}),
      ...(disabledUntil ? { disabledUntil } : {}),
      ...(cooldownUntil && usage?.cooldownReason ? { cooldownReason: usage.cooldownReason } : {}),
      ...(cooldownUntil && usage?.cooldownClassification
        ? { cooldownClassification: usage.cooldownClassification }
        : {}),
      ...(disabledUntil && usage?.disabledReason ? { disabledReason: usage.disabledReason } : {}),
      ...(recoveryHint ? { recoveryHint } : {}),
    });
  }
  const profiles = summaries
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

  runtime.log(terminalText`Agent: ${agentId}`);
  runtime.log(
    terminalText`Auth state store: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`,
  );
  if (provider) {
    runtime.log(terminalText`Provider: ${provider}`);
  }
  if (profiles.length === 0) {
    runtime.log("Profiles: (none)");
    return;
  }
  runtime.log("Profiles:");
  for (const profile of profiles) {
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
    runtime.log(
      terminalText`- ${profile.label} [${details.join("; ")}]${profile.recoveryHint ? ` — ${profile.recoveryHint}` : ""}`,
    );
  }
}
