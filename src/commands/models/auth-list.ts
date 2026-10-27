import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
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
    const blockedActive = isActiveUnusableWindow(usage?.blockedUntil, Date.now());
    const blockedUntil = blockedActive ? timestampMsToIsoString(usage?.blockedUntil) : undefined;
    const blockedModel = usage?.blockedScope === "model" ? usage.blockedModel : undefined;
    const cooldownUntil = timestampMsToIsoString(usage?.cooldownUntil);
    const disabledUntil = timestampMsToIsoString(usage?.disabledUntil);
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
      ...(usage?.cooldownReason ? { cooldownReason: usage.cooldownReason } : {}),
      ...(usage?.cooldownClassification
        ? { cooldownClassification: usage.cooldownClassification }
        : {}),
      ...(usage?.disabledReason ? { disabledReason: usage.disabledReason } : {}),
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

  const logLine = (line: string) => runtime.log(sanitizeTerminalText(line));
  logLine(`Agent: ${agentId}`);
  logLine(`Auth state store: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
  if (provider) {
    logLine(`Provider: ${provider}`);
  }
  if (profiles.length === 0) {
    logLine("Profiles: (none)");
    return;
  }
  logLine("Profiles:");
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
    logLine(
      `- ${profile.label} [${details.join("; ")}]${profile.recoveryHint ? ` — ${profile.recoveryHint}` : ""}`,
    );
  }
}
