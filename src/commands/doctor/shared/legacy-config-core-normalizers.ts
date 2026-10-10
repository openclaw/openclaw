// Core legacy config normalizers for shipped keys retired outside the rule table.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveDiscoveredChannelSetupPromotionSurface } from "../../../channels/plugins/setup-promotion-discovery.js";
import { resolveSingleAccountPromotion } from "../../../channels/plugins/setup-promotion-helpers.js";
import { resolveNormalizedProviderModelMaxTokens } from "../../../config/defaults.js";
import { inheritLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import {
  cloneConfigWithResolutionFacts,
  copyConfigResolutionFactsThroughRewrite,
} from "../../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { DEFAULT_GOOGLE_API_BASE_URL } from "../../../infra/google-api-base-url.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import {
  isBlockedLegacyCodexModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import {
  mergeModelRefMapEntries,
  rewriteModelRefs,
} from "./legacy-config-migrations.runtime.models.refs.js";
import { isRecord } from "./legacy-config-record-shared.js";
import { normalizeLegacyMistralModelCost } from "./legacy-mistral-model-cost.js";
import { isLegacyModelsAddCodexMetadataModel } from "./legacy-models-add-metadata.js";
import { modelEntryWithRuntimePolicy } from "./legacy-runtime-model-policy.js";
import { migrateLegacyRuntimeModelRef } from "./legacy-runtime-model-providers.js";
export { normalizeLegacyTalkConfig } from "./legacy-talk-config-normalizer.js";

const log = createSubsystemLogger("doctor");

/** Seed an empty account map without changing an existing account set or route. */
export function seedMissingDefaultAccountsFromSingleAccountBase(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const next = cloneConfigWithResolutionFacts(cfg);
  const before = changes.length;
  for (const [channelId, channel] of Object.entries(next.channels ?? {})) {
    if (!isRecord(channel) || !isRecord(channel.accounts) || Object.keys(channel.accounts).length) {
      continue;
    }
    // Shared root policy is not evidence of another identity. Adding a default
    // beside named accounts changes unqualified routing even if policy is copied.
    const promotion = resolveSingleAccountPromotion({
      channelKey: channelId,
      channel,
      resolveBundledSurface: (key) => resolveDiscoveredChannelSetupPromotionSurface(key, cfg),
    });
    if (promotion.kind === "preserve-root") {
      continue;
    }
    // A partial default account would strand uncovered keys at root on later runs.
    if (promotion.shouldDeferPromotion) {
      log.debug(
        `Deferring channels.${channelId} single-account promotion until its plugin declares uncovered root keys.`,
      );
      continue;
    }
    if (promotion.keysToMove.length === 0) {
      continue;
    }
    const defaultAccount: Record<string, unknown> = {};
    for (const key of promotion.keysToMove) {
      defaultAccount[key] = channel[key];
      delete channel[key];
    }
    channel.accounts = { [DEFAULT_ACCOUNT_ID]: defaultAccount };
    changes.push(
      `Moved channels.${channelId} single-account top-level values into channels.${channelId}.accounts.default.`,
    );
  }
  if (changes.length > before && Array.isArray(next.channels)) {
    next.channels = Object.fromEntries(Object.entries(next.channels));
  }
  copyConfigResolutionFactsThroughRewrite(cfg, next);
  return inheritLegacyDefaultAgentId(cfg, next);
}

type SelectedRuntimeRef = { ref: string; runtime: string };
type ModelDefinitionEntry = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["models"]
>[number];

function migrateUnblockedLegacyRuntimeModelRef(
  modelRef: string,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
) {
  return isBlockedLegacyCodexModelRef({ modelRef, blockedModelIdentities })
    ? null
    : migrateLegacyRuntimeModelRef(modelRef);
}

function mergeModelEntry(legacyEntry: unknown, currentEntry: unknown): unknown {
  return isRecord(legacyEntry) && isRecord(currentEntry)
    ? mergeModelRefMapEntries(currentEntry, legacyEntry, "models").value
    : (currentEntry ?? legacyEntry);
}

function migrateCodexCliRuntimePolicy(raw: unknown): boolean {
  if (!isRecord(raw) || normalizeOptionalLowercaseString(raw.id) !== "codex-cli") {
    return false;
  }
  raw.id = "codex";
  return true;
}

function createRuntimeModelRefRewriter(
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
) {
  const selected: SelectedRuntimeRef[] = [];
  return {
    selected,
    rewrite: (ref: unknown) => {
      const migrated =
        typeof ref === "string"
          ? migrateUnblockedLegacyRuntimeModelRef(ref, blockedModelIdentities)
          : null;
      if (migrated) {
        selected.push({ ref: migrated.ref, runtime: migrated.runtime });
      }
      return migrated?.ref ?? ref;
    },
  };
}

function migrateRuntimeSelection(
  owner: Record<string, unknown>,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): SelectedRuntimeRef[] {
  const { rewrite, selected } = createRuntimeModelRefRewriter(blockedModelIdentities);
  const model = owner.model;
  if (typeof model === "string") {
    owner.model = rewrite(model);
  } else if (isRecord(model)) {
    if (typeof model.primary === "string") {
      model.primary = rewrite(model.primary);
    }
    if (Array.isArray(model.fallbacks)) {
      model.fallbacks = model.fallbacks.map(rewrite);
    }
  }
  return selected;
}

function ensureSelectedModelRuntimePolicies(
  agent: Record<string, unknown>,
  selected: readonly SelectedRuntimeRef[],
): boolean {
  if (selected.length === 0) {
    return false;
  }
  const models = isRecord(agent.models) ? agent.models : {};
  let changed = false;
  for (const { ref, runtime } of selected) {
    const updated = modelEntryWithRuntimePolicy(models[ref], runtime);
    if (updated.changed) {
      models[ref] = updated.entry;
      changed = true;
    }
  }
  if (changed) {
    agent.models = models;
  }
  return changed;
}

function migrateRuntimeAgent(
  agent: Record<string, unknown>,
  path: string,
  changes: string[],
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): void {
  const selected = migrateRuntimeSelection(agent, blockedModelIdentities);
  if (selected.length) {
    changes.push(
      `Moved ${path}.model legacy runtime primary refs to canonical provider refs and selected ${selected[0]!.runtime} runtime.`,
    );
  }
  const policy = isRecord(agent.modelPolicy) ? agent.modelPolicy : undefined;
  const { rewrite, selected: policyRefs } = createRuntimeModelRefRewriter(blockedModelIdentities);
  const allow = Array.isArray(policy?.allow) ? policy.allow.map(rewrite) : undefined;
  if (isRecord(agent.models)) {
    const models: Record<string, unknown> = {};
    const legacy: Array<SelectedRuntimeRef & { entry: unknown }> = [];
    for (const [ref, entry] of Object.entries(agent.models)) {
      const migrated = migrateUnblockedLegacyRuntimeModelRef(ref, blockedModelIdentities);
      if (migrated) {
        legacy.push({ ref: migrated.ref, runtime: migrated.runtime, entry });
      } else {
        models[ref] = mergeModelEntry(entry, models[ref]);
      }
    }
    // Canonical values win regardless of where aliases appeared in the source map.
    for (const { ref, runtime, entry } of legacy) {
      models[ref] = modelEntryWithRuntimePolicy(mergeModelEntry(entry, models[ref]), runtime).entry;
    }
    if (legacy.length) {
      agent.models = models;
      changes.push(`Moved ${path}.models legacy runtime keys to canonical provider keys.`);
    }
  }
  if (ensureSelectedModelRuntimePolicies(agent, policyRefs)) {
    changes.push(`Preserved runtime policy for ${path}.modelPolicy.allow entries.`);
  }
  if (ensureSelectedModelRuntimePolicies(agent, selected)) {
    changes.push(`Selected ${selected[0]!.runtime} runtime for ${path}.models entries.`);
  }
  for (const key of ["heartbeat", "subagents"]) {
    const execution = agent[key];
    if (!isRecord(execution)) {
      continue;
    }
    const refs = migrateRuntimeSelection(execution, blockedModelIdentities);
    if (refs.length) {
      ensureSelectedModelRuntimePolicies(agent, refs);
      changes.push(`Moved ${path}.${key}.model to canonical refs with model runtime policy.`);
    }
  }
  if (policy && policyRefs.length) {
    policy.allow = allow;
    changes.push(`Moved ${path}.modelPolicy.allow legacy runtime refs to canonical provider refs.`);
  }
  for (const [ref, entry] of Object.entries(isRecord(agent.models) ? agent.models : {})) {
    if (isRecord(entry) && migrateCodexCliRuntimePolicy(entry.agentRuntime)) {
      changes.push(
        `Moved ${path}.models.${sanitizeForLog(ref)} agentRuntime.id from codex-cli to codex.`,
      );
    }
  }
}

/** Move legacy runtime-tagged refs on a private copy, preserving the caller's source. */
export function normalizeLegacyRuntimeModelRefs(
  cfg: OpenClawConfigWithLegacyRoster,
  changes: string[],
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): OpenClawConfigWithLegacyRoster {
  const next = cloneConfigWithResolutionFacts(cfg);
  for (const [providerId, provider] of modelProviders(next)) {
    if (migrateCodexCliRuntimePolicy(provider.agentRuntime)) {
      changes.push(
        `Moved models.providers.${sanitizeForLog(providerId)} agentRuntime.id from codex-cli to codex.`,
      );
    }
    for (const [index, model] of providerModels(provider)) {
      if (migrateCodexCliRuntimePolicy(model.agentRuntime)) {
        const modelId = normalizeOptionalString(model.id) ?? `[${index}]`;
        changes.push(
          `Moved models.providers.${sanitizeForLog(providerId)}.models.${sanitizeForLog(modelId)} agentRuntime.id from codex-cli to codex.`,
        );
      }
    }
  }
  const agents = next.agents;
  if (isRecord(agents)) {
    if (isRecord(agents.defaults)) {
      migrateRuntimeAgent(agents.defaults, "agents.defaults", changes, blockedModelIdentities);
    }
    for (const [key, entry] of Array.isArray(agents.list) ? agents.list.entries() : []) {
      if (isRecord(entry)) {
        const id = normalizeOptionalString(entry.id);
        migrateRuntimeAgent(
          entry,
          id ? `agents.list.${sanitizeForLog(id)}` : `agents.list[${key}]`,
          changes,
          blockedModelIdentities,
        );
      }
    }
    for (const [id, entry] of Object.entries(isRecord(agents.entries) ? agents.entries : {})) {
      if (isRecord(entry)) {
        migrateRuntimeAgent(
          entry,
          `agents.entries.${sanitizeForLog(id)}`,
          changes,
          blockedModelIdentities,
        );
      }
    }
  }
  const rewritten = rewriteModelRefs(next, "config", changes, (ref) => {
    const migrated = migrateUnblockedLegacyRuntimeModelRef(ref, blockedModelIdentities);
    return migrated &&
      ["codex-cli", "claude-cli", "google-gemini-cli"].includes(migrated.legacyProvider)
      ? migrated.ref
      : null;
  }).value as OpenClawConfigWithLegacyRoster; // SAFETY: The ref rewriter preserves config containers and value types.
  copyConfigResolutionFactsThroughRewrite(cfg, rewritten);
  return inheritLegacyDefaultAgentId(cfg, rewritten);
}

function* modelProviders(cfg: OpenClawConfig): Generator<[string, Record<string, unknown>]> {
  const providers = cfg.models?.providers;
  if (!isRecord(providers)) {
    return;
  }
  for (const [id, provider] of Object.entries(providers)) {
    if (isRecord(provider)) {
      yield [id, provider];
    }
  }
}

function* providerModels(
  provider: Record<string, unknown>,
): Generator<[number, Record<string, unknown>]> {
  if (Array.isArray(provider.models)) {
    for (const [index, model] of provider.models.entries()) {
      if (isRecord(model)) {
        yield [index, model];
      }
    }
  }
}

/** Mutate the Doctor-owned private candidate; plugin hooks retain their own rollback copies. */
export function normalizeLegacyOpenAICodexModelsAddMetadata(
  cfg: OpenClawConfig,
  changes: string[],
): void {
  for (const [providerId, provider] of modelProviders(cfg)) {
    if (normalizeProviderId(providerId) !== "openai-codex") {
      continue;
    }
    for (const [, model] of providerModels(provider)) {
      if (
        !("metadataSource" in model) &&
        isLegacyModelsAddCodexMetadataModel({
          provider: providerId,
          model: model as Partial<ModelDefinitionEntry>,
        })
      ) {
        model.metadataSource = "models-add";
        changes.push(
          `Marked models.providers.${sanitizeForLog(providerId)}.models.${sanitizeForLog(normalizeOptionalString(model.id) ?? "unknown")} as /models add metadata so official OpenAI Codex metadata can override it.`,
        );
      }
    }
  }
}

export function normalizeLegacyOpenAIModelProviderApi(
  cfg: OpenClawConfig,
  changes: string[],
): void {
  const migrateApi = (owner: Record<string, unknown>, path: string) => {
    if (owner.api === "openai") {
      owner.api = "openai-completions";
      changes.push(`Moved ${path}.api "openai" → "openai-completions".`);
    }
  };
  for (const [providerId, provider] of modelProviders(cfg)) {
    const path = `models.providers.${sanitizeForLog(providerId)}`;
    migrateApi(provider, path);
    for (const [index, model] of providerModels(provider)) {
      migrateApi(model, `${path}.models[${index}]`);
    }
  }
}

/** Remove retired bundled skill config after migrating its image model and credentials. */
export function normalizeLegacyNanoBananaSkill(cfg: OpenClawConfig, changes: string[]): void {
  const key = "nano-banana-pro";
  const model = "google/gemini-3-pro-image-preview";
  const skills = cfg.skills;
  if (!isRecord(skills)) {
    return;
  }
  if (Array.isArray(skills.allowBundled)) {
    const filtered = skills.allowBundled.filter(
      (value) => typeof value !== "string" || value.trim() !== key,
    );
    if (filtered.length !== skills.allowBundled.length) {
      if (filtered.length) {
        skills.allowBundled = filtered;
        changes.push(`Removed ${key} from skills.allowBundled.`);
      } else {
        delete skills.allowBundled;
        changes.push(`Removed skills.allowBundled entry for ${key}.`);
      }
    }
  }
  const entries = skills.entries;
  if (!isRecord(entries) || !isRecord(entries[key])) {
    return;
  }
  const legacy = entries[key];
  if (cfg.agents?.defaults?.mediaModels?.image === undefined) {
    cfg.agents = {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        mediaModels: { ...cfg.agents?.defaults?.mediaModels, image: { primary: model } },
      },
    };
    changes.push(
      `Moved skills.entries.${key} → agents.defaults.mediaModels.image.primary (${model}).`,
    );
  }
  const legacyEnvKey =
    normalizeOptionalString(isRecord(legacy.env) ? legacy.env.GEMINI_API_KEY : undefined) ?? "";
  const apiKey =
    legacyEnvKey ||
    (typeof legacy.apiKey === "string"
      ? normalizeOptionalString(legacy.apiKey)
      : isRecord(legacy.apiKey)
        ? legacy.apiKey
        : undefined);
  const models: NonNullable<OpenClawConfig["models"]> = isRecord(cfg.models) ? cfg.models : {};
  const providers: NonNullable<typeof models.providers> = isRecord(models.providers)
    ? models.providers
    : {};
  const google = isRecord(providers.google)
    ? providers.google
    : { baseUrl: DEFAULT_GOOGLE_API_BASE_URL, models: [] };
  if (google.apiKey === undefined && apiKey) {
    google.apiKey = apiKey;
    google.baseUrl ||= DEFAULT_GOOGLE_API_BASE_URL;
    if (!Array.isArray(google.models)) {
      google.models = [];
    }
    providers.google = google;
    models.providers = providers;
    cfg.models = models;
    changes.push(
      `Moved skills.entries.${key}.${legacyEnvKey ? "env.GEMINI_API_KEY" : "apiKey"} → models.providers.google.apiKey.`,
    );
  }
  delete entries[key];
  if (Object.keys(entries).length === 0) {
    delete skills.entries;
  }
  changes.push(`Removed legacy skills.entries.${key}.`);
  if (Object.keys(skills).length === 0) {
    delete cfg.skills;
  }
}

function normalizeConfiguredPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolveConfiguredOllamaModelNumCtxBudget(
  model: Record<string, unknown>,
  provider: Record<string, unknown>,
  providerNumCtxApplies: boolean,
): number | undefined {
  // Explicit runtime caps must continue following cap changes rather than acquiring a pin.
  if (normalizeConfiguredPositiveInteger(model.contextTokens) !== undefined) {
    return undefined;
  }
  const contextWindow = normalizeConfiguredPositiveInteger(model.contextWindow);
  const providerWindow = normalizeConfiguredPositiveInteger(provider.contextWindow);
  if (contextWindow !== undefined || providerWindow !== undefined) {
    return contextWindow ?? (providerNumCtxApplies ? undefined : providerWindow);
  }
  return (
    normalizeConfiguredPositiveInteger(model.maxTokens) ??
    (providerNumCtxApplies ? undefined : normalizeConfiguredPositiveInteger(provider.maxTokens))
  );
}

export function normalizeLegacyOllamaNativeNumCtxParams(
  cfg: OpenClawConfig,
  changes: string[],
): void {
  for (const [providerId, provider] of modelProviders(cfg)) {
    if (!Array.isArray(provider.models)) {
      continue;
    }
    const models = [...providerModels(provider)];
    const nativeProvider = normalizeOptionalLowercaseString(provider.api) === "ollama";
    const providerParams = provider.params;
    // Scan all siblings before choosing a provider pin: it also affects API-overridden rows.
    if (
      nativeProvider &&
      (providerParams === undefined || isRecord(providerParams)) &&
      !Object.hasOwn(providerParams ?? {}, "num_ctx") &&
      !models.some(
        ([, entry]) => normalizeConfiguredPositiveInteger(entry.contextTokens) !== undefined,
      )
    ) {
      const numCtx =
        normalizeConfiguredPositiveInteger(provider.contextWindow) ??
        normalizeConfiguredPositiveInteger(provider.maxTokens);
      if (numCtx !== undefined) {
        provider.params = { ...providerParams, num_ctx: numCtx };
        changes.push(
          `Set models.providers.${sanitizeForLog(providerId)}.params.num_ctx to ${numCtx} for native Ollama compatibility.`,
        );
      }
    }
    const providerNumCtxApplies =
      nativeProvider && isRecord(provider.params) && Object.hasOwn(provider.params, "num_ctx");
    for (const [index, model] of models) {
      const api =
        normalizeOptionalLowercaseString(model.api) ||
        normalizeOptionalLowercaseString(provider.api);
      const params = model.params;
      if (
        api !== "ollama" ||
        (params !== undefined && !isRecord(params)) ||
        Object.hasOwn(params ?? {}, "num_ctx")
      ) {
        continue;
      }
      const numCtx = resolveConfiguredOllamaModelNumCtxBudget(
        model,
        provider,
        providerNumCtxApplies,
      );
      if (numCtx !== undefined) {
        model.params = { ...params, num_ctx: numCtx };
        changes.push(
          `Set models.providers.${sanitizeForLog(providerId)}.models[${index}].params.num_ctx to ${numCtx} for native Ollama compatibility.`,
        );
      }
    }
  }
}

export function normalizeLegacyMistralModelDefaults(cfg: OpenClawConfig, changes: string[]): void {
  for (const [providerId, provider] of modelProviders(cfg)) {
    if (normalizeProviderId(providerId) !== "mistral") {
      continue;
    }
    for (const [index, model] of providerModels(provider)) {
      const modelId = normalizeOptionalString(model.id) ?? "";
      if (!modelId) {
        continue;
      }
      const contextWindow = asFiniteNumber(model.contextWindow) ?? null;
      const maxTokens = asFiniteNumber(model.maxTokens) ?? null;
      if (contextWindow !== null && maxTokens !== null) {
        const normalizedMaxTokens = resolveNormalizedProviderModelMaxTokens({
          providerId,
          modelId,
          contextWindow,
          rawMaxTokens: maxTokens,
        });
        if (normalizedMaxTokens !== maxTokens) {
          model.maxTokens = normalizedMaxTokens;
          changes.push(
            `Normalized models.providers.${providerId}.models[${index}].maxTokens (${maxTokens} → ${normalizedMaxTokens}) to avoid Mistral context-window rejects.`,
          );
        }
      }
      Object.assign(
        model,
        normalizeLegacyMistralModelCost({ providerId, model, modelId, index, changes }),
      );
    }
  }
}
