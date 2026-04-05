import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential, ProfileUsageStats } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileConfig } from "../config/types.auth.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const ANTHROPIC_PROVIDER_ID = "anthropic";
const CLAUDE_CLI_PROVIDER_ID = "claude-cli";
const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
type AgentDefaultsConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isClaudeCliProviderId(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === CLAUDE_CLI_PROVIDER_ID;
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  return credential.type;
}

function resolveTargetProfileId(params: {
  credential?: AuthProfileCredential;
  profileConfig?: AuthProfileConfig;
}): string | undefined {
  const email =
    trimOptionalString(params.profileConfig?.email) ??
    trimOptionalString("email" in (params.credential ?? {}) ? params.credential?.email : undefined);
  return buildAuthProfileId({
    providerId: ANTHROPIC_PROVIDER_ID,
    profileName: email,
  });
}

function buildConvertedCredential(
  credential: AuthProfileCredential | undefined,
): AuthProfileCredential | undefined {
  if (!credential || !isClaudeCliProviderId(credential.provider)) {
    return undefined;
  }
  if (credential.type === "oauth") {
    return {
      ...credential,
      provider: ANTHROPIC_PROVIDER_ID,
    };
  }
  if (credential.type === "token") {
    return {
      ...credential,
      provider: ANTHROPIC_PROVIDER_ID,
    };
  }
  return undefined;
}

function buildConvertedProfileConfig(params: {
  credential?: AuthProfileCredential;
  profileConfig?: AuthProfileConfig;
}): AuthProfileConfig | undefined {
  if (!params.credential) {
    return undefined;
  }
  const mode = credentialMode(params.credential);
  if (mode === "api_key") {
    return undefined;
  }
  const email =
    trimOptionalString(params.profileConfig?.email) ??
    trimOptionalString("email" in params.credential ? params.credential.email : undefined);
  const displayName =
    trimOptionalString(params.profileConfig?.displayName) ??
    trimOptionalString(
      "displayName" in params.credential ? params.credential.displayName : undefined,
    );
  return {
    provider: ANTHROPIC_PROVIDER_ID,
    mode,
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function toAnthropicModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(`${CLAUDE_CLI_PROVIDER_ID}/`)) {
    return null;
  }
  const modelId = trimmed.slice(`${CLAUDE_CLI_PROVIDER_ID}/`.length).trim();
  if (!modelId.toLowerCase().startsWith("claude-")) {
    return null;
  }
  return `${ANTHROPIC_PROVIDER_ID}/${modelId}`;
}

function rewriteModelSelection(model: unknown): { value: unknown; changed: boolean } {
  if (typeof model === "string") {
    const converted = toAnthropicModelRef(model);
    return converted ? { value: converted, changed: true } : { value: model, changed: false };
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return { value: model, changed: false };
  }

  const current = model as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  let changed = false;

  if (typeof current.primary === "string") {
    const converted = toAnthropicModelRef(current.primary);
    if (converted) {
      next.primary = converted;
      changed = true;
    }
  }

  if (Array.isArray(current.fallbacks)) {
    const currentFallbacks = current.fallbacks as unknown[];
    const nextFallbacks = current.fallbacks.map((entry) =>
      typeof entry === "string" ? (toAnthropicModelRef(entry) ?? entry) : entry,
    );
    if (nextFallbacks.some((entry, index) => entry !== currentFallbacks[index])) {
      next.fallbacks = nextFallbacks;
      changed = true;
    }
  }

  return { value: changed ? next : model, changed };
}

function rewriteModelMap(models: Record<string, unknown> | undefined): {
  value: Record<string, unknown> | undefined;
  changed: boolean;
} {
  if (!models) {
    return { value: models, changed: false };
  }
  const next = { ...models };
  let changed = false;
  for (const [rawKey, value] of Object.entries(models)) {
    const converted = toAnthropicModelRef(rawKey);
    if (!converted) {
      continue;
    }
    if (!(converted in next)) {
      next[converted] = value;
    }
    delete next[rawKey];
    changed = true;
  }
  return { value: changed ? next : models, changed };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function rewriteOrderMap(
  order: Record<string, string[]> | undefined,
  replacementProfileId?: string,
): { value: Record<string, string[]> | undefined; changed: boolean } {
  if (!order) {
    return { value: order, changed: false };
  }
  const next: Record<string, string[]> = {};
  let changed = false;

  for (const [provider, profileIds] of Object.entries(order)) {
    const nextProvider = isClaudeCliProviderId(provider) ? ANTHROPIC_PROVIDER_ID : provider;
    if (nextProvider !== provider) {
      changed = true;
    }
    const rewritten = dedupeStrings(
      profileIds.flatMap((profileId) => {
        if (profileId !== CLAUDE_CLI_PROFILE_ID) {
          return [profileId];
        }
        changed = true;
        return replacementProfileId ? [replacementProfileId] : [];
      }),
    );
    if (rewritten.length === 0) {
      if (profileIds.length > 0) {
        changed = true;
      }
      continue;
    }
    if (
      rewritten.length !== profileIds.length ||
      rewritten.some((id, index) => id !== profileIds[index])
    ) {
      changed = true;
    }
    next[nextProvider] = next[nextProvider]
      ? dedupeStrings([...next[nextProvider], ...rewritten])
      : rewritten;
  }

  return {
    value: Object.keys(next).length > 0 ? next : undefined,
    changed,
  };
}

function rewriteLastGoodMap(
  lastGood: Record<string, string> | undefined,
  replacementProfileId?: string,
): { value: Record<string, string> | undefined; changed: boolean } {
  if (!lastGood) {
    return { value: lastGood, changed: false };
  }
  const next: Record<string, string> = {};
  let changed = false;

  for (const [provider, profileId] of Object.entries(lastGood)) {
    const nextProvider = isClaudeCliProviderId(provider) ? ANTHROPIC_PROVIDER_ID : provider;
    const nextProfileId = profileId === CLAUDE_CLI_PROFILE_ID ? replacementProfileId : profileId;
    if (nextProvider !== provider || nextProfileId !== profileId) {
      changed = true;
    }
    if (!nextProfileId) {
      continue;
    }
    next[nextProvider] ??= nextProfileId;
  }

  return {
    value: Object.keys(next).length > 0 ? next : undefined,
    changed,
  };
}

function rewriteUsageStatsMap(
  usageStats: Record<string, ProfileUsageStats> | undefined,
  replacementProfileId?: string,
): { value: Record<string, ProfileUsageStats> | undefined; changed: boolean } {
  if (!usageStats) {
    return { value: usageStats, changed: false };
  }
  const next = { ...usageStats };
  const stale = next[CLAUDE_CLI_PROFILE_ID];
  if (!stale) {
    return { value: usageStats, changed: false };
  }
  delete next[CLAUDE_CLI_PROFILE_ID];
  if (replacementProfileId && !next[replacementProfileId]) {
    next[replacementProfileId] = stale;
  }
  return {
    value: Object.keys(next).length > 0 ? next : undefined,
    changed: true,
  };
}

function rewriteAuthProfilesConfig(
  profiles: Record<string, AuthProfileConfig> | undefined,
  replacementProfileId?: string,
  replacementProfileConfig?: AuthProfileConfig,
): { value: Record<string, AuthProfileConfig> | undefined; changed: boolean } {
  if (!profiles) {
    return { value: profiles, changed: false };
  }
  const next: Record<string, AuthProfileConfig> = {};
  let changed = false;

  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profileId === CLAUDE_CLI_PROFILE_ID || isClaudeCliProviderId(profile.provider)) {
      changed = true;
      continue;
    }
    next[profileId] = profile;
  }

  if (replacementProfileId && replacementProfileConfig && !next[replacementProfileId]) {
    next[replacementProfileId] = replacementProfileConfig;
    changed = true;
  }

  return {
    value: Object.keys(next).length > 0 ? next : undefined,
    changed,
  };
}

function rewriteAnthropicClaudeCliConfig(params: {
  cfg: OpenClawConfig;
  replacementProfileId?: string;
  replacementProfileConfig?: AuthProfileConfig;
}): { next: OpenClawConfig; changes: string[] } {
  const changes: string[] = [];
  const rewrittenProfiles = rewriteAuthProfilesConfig(
    params.cfg.auth?.profiles,
    params.replacementProfileId,
    params.replacementProfileConfig,
  );
  const rewrittenOrder = rewriteOrderMap(params.cfg.auth?.order, params.replacementProfileId);

  const defaults = params.cfg.agents?.defaults;
  const rewrittenModel = rewriteModelSelection(defaults?.model);
  const rewrittenModels = rewriteModelMap(defaults?.models);

  let nextCliBackends = defaults?.cliBackends;
  let cliBackendsChanged = false;
  if (nextCliBackends?.[CLAUDE_CLI_PROVIDER_ID]) {
    const clone = { ...nextCliBackends };
    delete clone[CLAUDE_CLI_PROVIDER_ID];
    nextCliBackends = Object.keys(clone).length > 0 ? clone : undefined;
    cliBackendsChanged = true;
  }

  if (rewrittenProfiles.changed) {
    changes.push("removed stale Anthropic Claude CLI auth-profile config");
  }
  if (rewrittenOrder.changed) {
    changes.push("rewrote auth-order references away from Claude CLI");
  }
  if (rewrittenModel.changed || rewrittenModels.changed) {
    changes.push("rewrote claude-cli model refs back to anthropic/*");
  }
  if (cliBackendsChanged) {
    changes.push("removed agents.defaults.cliBackends.claude-cli");
  }

  if (changes.length === 0) {
    return { next: params.cfg, changes };
  }

  const nextProfiles = rewrittenProfiles.value;
  const nextOrder = rewrittenOrder.value;
  const nextModel = rewrittenModel.value as AgentDefaultsConfig["model"];
  const nextModels = rewrittenModels.value as AgentDefaultsConfig["models"];
  const nextCliBackendsTyped: AgentDefaultsConfig["cliBackends"] = nextCliBackends;

  const nextAuth =
    nextProfiles || nextOrder || params.cfg.auth?.cooldowns
      ? {
          ...params.cfg.auth,
          ...(nextProfiles ? { profiles: nextProfiles } : {}),
          ...(nextProfiles === undefined ? { profiles: undefined } : {}),
          ...(nextOrder ? { order: nextOrder } : {}),
          ...(nextOrder === undefined ? { order: undefined } : {}),
        }
      : undefined;

  const nextDefaults =
    rewrittenModel.changed || rewrittenModels.changed || cliBackendsChanged
      ? {
          ...defaults,
          ...(rewrittenModel.changed ? { model: nextModel } : {}),
          ...(rewrittenModels.changed ? { models: nextModels } : {}),
          ...(cliBackendsChanged ? { cliBackends: nextCliBackendsTyped } : {}),
        }
      : defaults;

  const nextAgents =
    nextDefaults && nextDefaults !== defaults
      ? {
          ...params.cfg.agents,
          defaults: nextDefaults,
        }
      : params.cfg.agents;

  return {
    next: {
      ...params.cfg,
      ...(nextAuth ? { auth: nextAuth } : { auth: undefined }),
      ...(nextAgents ? { agents: nextAgents } : { agents: params.cfg.agents }),
    },
    changes,
  };
}

type StoreRepairResult = {
  changed: boolean;
  converted: boolean;
  keptExistingTarget: boolean;
  replacementProfileId?: string;
};

async function maybeRepairAnthropicClaudeCliStore(params: {
  replacementProfileId?: string;
  replacementCredential?: AuthProfileCredential;
}): Promise<StoreRepairResult> {
  let changed = false;
  let converted = false;
  let keptExistingTarget = false;

  await updateAuthProfileStoreWithLock({
    updater: (nextStore) => {
      let mutated = false;
      const staleCredential = nextStore.profiles[CLAUDE_CLI_PROFILE_ID];
      if (staleCredential && isClaudeCliProviderId(staleCredential.provider)) {
        if (params.replacementProfileId && params.replacementCredential) {
          if (nextStore.profiles[params.replacementProfileId]) {
            keptExistingTarget = true;
          } else {
            nextStore.profiles[params.replacementProfileId] = params.replacementCredential;
            converted = true;
            mutated = true;
          }
        }
        delete nextStore.profiles[CLAUDE_CLI_PROFILE_ID];
        mutated = true;
      }

      const rewrittenOrder = rewriteOrderMap(nextStore.order, params.replacementProfileId);
      if (rewrittenOrder.changed) {
        nextStore.order = rewrittenOrder.value;
        mutated = true;
      }

      const rewrittenLastGood = rewriteLastGoodMap(nextStore.lastGood, params.replacementProfileId);
      if (rewrittenLastGood.changed) {
        nextStore.lastGood = rewrittenLastGood.value;
        mutated = true;
      }

      const rewrittenUsageStats = rewriteUsageStatsMap(
        nextStore.usageStats,
        params.replacementProfileId,
      );
      if (rewrittenUsageStats.changed) {
        nextStore.usageStats = rewrittenUsageStats.value;
        mutated = true;
      }

      if (mutated) {
        changed = true;
      }
      return mutated;
    },
  });

  return {
    changed,
    converted,
    keptExistingTarget,
    replacementProfileId: params.replacementProfileId,
  };
}

function hasStaleAnthropicClaudeCliConfig(cfg: OpenClawConfig): boolean {
  if (cfg.auth?.profiles) {
    for (const [profileId, profile] of Object.entries(cfg.auth.profiles)) {
      if (profileId === CLAUDE_CLI_PROFILE_ID || isClaudeCliProviderId(profile.provider)) {
        return true;
      }
    }
  }
  if (
    Object.values(cfg.auth?.order ?? {}).some((profileIds) =>
      profileIds.includes(CLAUDE_CLI_PROFILE_ID),
    )
  ) {
    return true;
  }
  const defaults = cfg.agents?.defaults;
  if (
    (typeof defaults?.model === "string" &&
      defaults.model.startsWith(`${CLAUDE_CLI_PROVIDER_ID}/`)) ||
    (defaults?.model &&
      typeof defaults.model === "object" &&
      !Array.isArray(defaults.model) &&
      ((typeof defaults.model.primary === "string" &&
        defaults.model.primary.startsWith(`${CLAUDE_CLI_PROVIDER_ID}/`)) ||
        defaults.model.fallbacks?.some(
          (entry) => typeof entry === "string" && entry.startsWith(`${CLAUDE_CLI_PROVIDER_ID}/`),
        )))
  ) {
    return true;
  }
  if (
    Object.keys(defaults?.models ?? {}).some((modelId) =>
      modelId.startsWith(`${CLAUDE_CLI_PROVIDER_ID}/`),
    )
  ) {
    return true;
  }
  return Boolean(defaults?.cliBackends?.[CLAUDE_CLI_PROVIDER_ID]);
}

export async function maybeRepairRemovedAnthropicClaudeCliState(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  const staleCredential = store.profiles[CLAUDE_CLI_PROFILE_ID];
  const staleProfileConfig =
    cfg.auth?.profiles?.[CLAUDE_CLI_PROFILE_ID] ??
    Object.values(cfg.auth?.profiles ?? {}).find((profile) =>
      isClaudeCliProviderId(profile.provider),
    );
  const replacementCredential = buildConvertedCredential(staleCredential);
  const replacementProfileId = replacementCredential
    ? resolveTargetProfileId({
        credential: replacementCredential,
        profileConfig: staleProfileConfig,
      })
    : undefined;
  const replacementProfileConfig = buildConvertedProfileConfig({
    credential: replacementCredential,
    profileConfig: staleProfileConfig,
  });

  const staleConfigDetected = hasStaleAnthropicClaudeCliConfig(cfg);
  const staleStoreDetected = Boolean(replacementCredential);
  if (!staleConfigDetected && !staleStoreDetected) {
    return cfg;
  }

  const summaryLines = [
    "Stale Anthropic Claude CLI state detected.",
    staleStoreDetected
      ? `- stored credential bytes found under ${CLAUDE_CLI_PROFILE_ID}`
      : `- no stored credential bytes found for ${CLAUDE_CLI_PROFILE_ID}`,
    "- Claude CLI Anthropic auth is no longer a supported OpenClaw path",
    staleStoreDetected && replacementProfileId
      ? `- doctor can convert the stored credential to ${replacementProfileId}`
      : "- doctor can only remove stale config; use an Anthropic API key or setup-token afterward",
  ];
  note(summaryLines.join("\n"), "Auth profiles");

  const shouldRepair = await prompter.confirmAutoFix({
    message: staleStoreDetected
      ? "Convert stale Anthropic Claude CLI auth back to Anthropic profiles and remove Claude CLI config now?"
      : "Remove stale Anthropic Claude CLI config now? No stored credential bytes were found to convert.",
    initialValue: true,
  });
  if (!shouldRepair) {
    return cfg;
  }

  const storeRepair = await maybeRepairAnthropicClaudeCliStore({
    replacementProfileId,
    replacementCredential,
  });
  const rewrittenConfig = rewriteAnthropicClaudeCliConfig({
    cfg,
    replacementProfileId:
      storeRepair.converted || storeRepair.keptExistingTarget ? replacementProfileId : undefined,
    replacementProfileConfig:
      storeRepair.converted || storeRepair.keptExistingTarget
        ? replacementProfileConfig
        : undefined,
  });

  const changes: string[] = [];
  if (storeRepair.converted && replacementProfileId) {
    changes.push(`converted ${CLAUDE_CLI_PROFILE_ID} -> ${replacementProfileId}`);
  } else if (storeRepair.keptExistingTarget && replacementProfileId) {
    changes.push(`removed ${CLAUDE_CLI_PROFILE_ID} and kept existing ${replacementProfileId}`);
  } else if (staleStoreDetected) {
    changes.push(`removed stale stored profile ${CLAUDE_CLI_PROFILE_ID}`);
  }
  changes.push(...rewrittenConfig.changes);

  if (changes.length > 0) {
    note(changes.map((line) => `- ${line}`).join("\n"), "Doctor changes");
  }
  if (!storeRepair.converted) {
    note(
      [
        "Anthropic Claude CLI state was removed, but no subscription credential was reconstructed.",
        "Next step: openclaw models auth login --provider anthropic --method api-key --set-default",
        "Fallback: openclaw models auth setup-token --provider anthropic",
      ].join("\n"),
      "Auth profiles",
    );
  }

  return rewrittenConfig.next;
}
