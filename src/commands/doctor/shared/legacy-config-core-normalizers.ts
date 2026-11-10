// Core legacy config normalizers for shipped keys retired outside the rule table.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
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
import { normalizeKnownModelRef } from "./legacy-model-ref-normalization.js";
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

type LegacyRuntimeRefMigration = NonNullable<ReturnType<typeof migrateLegacyRuntimeModelRef>>;
type LegacyRuntimeRefMigrator = (modelRef: string) => LegacyRuntimeRefMigration | null;

function migrateUnblockedLegacyRuntimeModelRef(
  modelRef: string,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
) {
  return isBlockedLegacyCodexModelRef({ modelRef, blockedModelIdentities })
    ? null
    : migrateLegacyRuntimeModelRef(modelRef);
}

function* agentScopes(
  agents: unknown,
): Generator<[path: string, agent: Record<string, unknown>, agentId?: string]> {
  if (!isRecord(agents)) {
    return;
  }
  if (isRecord(agents.defaults)) {
    yield ["agents.defaults", agents.defaults];
  }
  for (const [key, entry] of Array.isArray(agents.list) ? agents.list.entries() : []) {
    if (isRecord(entry)) {
      const id = normalizeOptionalString(entry.id);
      yield [id ? `agents.list.${sanitizeForLog(id)}` : `agents.list[${key}]`, entry, id];
    }
  }
  for (const [id, entry] of Object.entries(isRecord(agents.entries) ? agents.entries : {})) {
    if (isRecord(entry)) {
      yield [`agents.entries.${sanitizeForLog(id)}`, entry, id];
    }
  }
}

function* runtimePins(
  cfg: OpenClawConfig,
): Generator<{ path: string; provider: string | undefined; runtime: unknown }> {
  for (const [path, agent] of agentScopes(cfg.agents)) {
    for (const [ref, entry] of Object.entries(isRecord(agent.models) ? agent.models : {})) {
      yield {
        path: `${path}.models.${sanitizeForLog(ref)}`,
        provider: parseModelCatalogRef(ref.trim())?.provider,
        runtime:
          isRecord(entry) && isRecord(entry.agentRuntime) ? entry.agentRuntime.id : undefined,
      };
    }
  }
  for (const [providerId, provider] of modelProviders(cfg)) {
    const path = `models.providers.${sanitizeForLog(providerId)}`;
    const id = normalizeProviderId(providerId);
    yield {
      path,
      provider: id,
      runtime: isRecord(provider.agentRuntime) ? provider.agentRuntime.id : undefined,
    };
    for (const [index, model] of providerModels(provider)) {
      yield {
        path: `${path}.models[${index}]`,
        provider: id,
        runtime: isRecord(model.agentRuntime) ? model.agentRuntime.id : undefined,
      };
    }
  }
}

/**
 * Legacy CLI refs still select their CLI runtime as written. Migration moves them onto the
 * canonical provider with an exact runtime pin, which outranks provider-wide, wildcard, and bare
 * model pins. When config already routes that provider's models (or bare model keys) to another
 * runtime, the operator runs both routes side by side and the rewrite could silently move one
 * onto the other, changing billing. A scope that runs the same model both directly and through
 * the legacy CLI ref keeps both routes too (see routeGroups). Retain the authored refs and say why.
 */
function retainConflictingLegacyCliProviders(
  cfg: OpenClawConfig,
  blockedModelIdentities: ReadonlySet<LegacyCodexModelIdentity> | undefined,
  warnings: string[],
): ReadonlySet<string> {
  const migrate = (ref: string) =>
    migrateUnblockedLegacyRuntimeModelRef(ref, blockedModelIdentities);
  const legacy = new Map<string, { ref: string; migrated: LegacyRuntimeRefMigration }>();
  rewriteModelRefs(cfg, "config", [], (ref) => {
    const migrated = migrate(ref);
    if (migrated?.cli && !legacy.has(migrated.legacyProvider)) {
      legacy.set(migrated.legacyProvider, { ref, migrated });
    }
    return null;
  });
  const retained = new Set<string>();
  for (const { ref, migrated } of legacy.values()) {
    for (const pin of runtimePins(cfg)) {
      const runtime = normalizeOptionalLowercaseString(pin.runtime);
      if (
        runtime &&
        runtime !== "auto" &&
        runtime !== migrated.runtime &&
        (pin.provider === undefined || pin.provider === migrated.provider)
      ) {
        retained.add(migrated.legacyProvider);
        warnings.push(
          `Kept legacy ${migrated.legacyProvider}/* model refs: ${pin.path} routes models to the ${sanitizeForLog(runtime)} runtime, and rewriting ${sanitizeForLog(ref)} to ${sanitizeForLog(migrated.ref)} could switch a route between ${sanitizeForLog(runtime)} and ${migrated.runtime}. Both routes keep working as configured.`,
        );
        break;
      }
    }
  }
  for (const { path, agentId, groups } of routeGroups(cfg, migrate)) {
    for (const refs of groups) {
      for (const ref of refs) {
        const migrated = migrate(ref);
        if (!migrated?.cli || retained.has(migrated.legacyProvider)) {
          continue;
        }
        const canonicalRuntime = normalizeOptionalLowercaseString(
          resolveModelRuntimePolicy({
            config: cfg,
            provider: migrated.provider,
            modelId: migrated.model,
            agentId,
          }).policy?.id,
        );
        if (
          canonicalRuntime === migrated.runtime ||
          !refs.some((other) => !migrate(other) && canonicalModelRef(other) === migrated.ref)
        ) {
          continue;
        }
        retained.add(migrated.legacyProvider);
        warnings.push(
          `Kept legacy ${migrated.legacyProvider}/* model refs: ${path} selects ${sanitizeForLog(migrated.ref)} both directly and through ${migrated.runtime}; rewriting would move both routes onto ${migrated.runtime}. Both routes keep working as configured.`,
        );
      }
    }
  }
  return retained;
}

function canonicalModelRef(ref: string): string {
  const { model } = splitTrailingAuthProfile(ref.trim());
  return normalizeKnownModelRef(model) ?? model;
}

function stringRefs(values: unknown[]): string[] {
  return values.filter((ref): ref is string => typeof ref === "string");
}

/**
 * Refs whose runtime one migration pin decides. Migration pins a CLI ref's runtime on the
 * canonical ref in its scope's model map. That pin reaches every selection the scope runs
 * (primary, heartbeat, subagent, utility, media and other model keys), including selections
 * inherited from defaults, and a defaults pin reaches every agent. An allowlist naming both
 * spellings also requests both routes, as does a model map whose canonical key the scope
 * selects or allows; canonical map keys alone are metadata, and legacy entries alone are a
 * sign-in seed, so both still migrate.
 */
function* routeGroups(
  cfg: OpenClawConfig,
  migrate: LegacyRuntimeRefMigrator,
): Generator<{ path: string; agentId?: string; groups: string[][] }> {
  const agents: unknown = cfg.agents;
  const defaults = isRecord(agents) && isRecord(agents.defaults) ? agents.defaults : undefined;
  const inherited = selections(defaults);
  // Selections outside agent scopes take their pin from agents.defaults, so every agent runs them.
  const outside = [...[...inherited.values()].flat(), ...outsideAgentRefs(cfg)];
  const inheritedLegacy = outside.filter((ref) => migrate(ref));
  yield { path: "config", groups: [outside] };
  for (const [path, agent, agentId] of agentScopes(agents)) {
    const isDefaults = agent === defaults;
    const own = selections(agent);
    const effective = [...new Set([...inherited.keys(), ...own.keys()])].flatMap(
      (key) => own.get(key) ?? inherited.get(key)!,
    );
    const rawAllow = isRecord(agent.modelPolicy) ? agent.modelPolicy.allow : undefined;
    const allow = stringRefs(Array.isArray(rawAllow) ? rawAllow : []);
    const direct = new Set([...effective, ...allow].map(canonicalModelRef));
    yield {
      path,
      agentId,
      groups: [
        isDefaults ? effective : [...effective, ...inheritedLegacy],
        Object.keys(isRecord(agent.models) ? agent.models : {}).filter(
          (ref) => migrate(ref) || direct.has(canonicalModelRef(ref)),
        ),
        allow,
      ],
    };
  }
}

/** Model refs a scope selects, per top-level key; its model map and policy are grouped apart. */
function selections(scope: Record<string, unknown> | undefined): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const [key, value] of Object.entries(scope ?? {})) {
    const refs = key === "models" || key === "modelPolicy" ? [] : collectRefs(value, `.${key}`);
    if (refs.length) {
      byKey.set(key, refs);
    }
  }
  return byKey;
}

/** Model refs configured outside agent scopes: channel overrides, hook mappings, tools. */
function outsideAgentRefs(cfg: OpenClawConfig): string[] {
  return collectRefs({ ...cfg, agents: undefined }, "config");
}

function collectRefs(value: unknown, path: string): string[] {
  const refs: string[] = [];
  rewriteModelRefs(value, path, [], (ref) => {
    refs.push(ref);
    return null;
  });
  return refs;
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

function createRuntimeModelRefRewriter(migrate: LegacyRuntimeRefMigrator) {
  const selected: SelectedRuntimeRef[] = [];
  return {
    selected,
    rewrite: (ref: unknown) => {
      const migrated = typeof ref === "string" ? migrate(ref) : null;
      if (migrated) {
        selected.push({ ref: migrated.ref, runtime: migrated.runtime });
      }
      return migrated?.ref ?? ref;
    },
  };
}

function migrateRuntimeSelection(
  owner: Record<string, unknown>,
  migrate: LegacyRuntimeRefMigrator,
): SelectedRuntimeRef[] {
  const { rewrite, selected } = createRuntimeModelRefRewriter(migrate);
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
  migrate: LegacyRuntimeRefMigrator,
): void {
  const selected = migrateRuntimeSelection(agent, migrate);
  if (selected.length) {
    changes.push(
      `Moved ${path}.model legacy runtime primary refs to provider references and selected ${selected[0]!.runtime} runtime.`,
    );
  }
  const policy = isRecord(agent.modelPolicy) ? agent.modelPolicy : undefined;
  const { rewrite, selected: policyRefs } = createRuntimeModelRefRewriter(migrate);
  const allow = Array.isArray(policy?.allow) ? policy.allow.map(rewrite) : undefined;
  if (isRecord(agent.models)) {
    const models: Record<string, unknown> = {};
    const legacy: Array<SelectedRuntimeRef & { entry: unknown }> = [];
    for (const [ref, entry] of Object.entries(agent.models)) {
      const migrated = migrate(ref);
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
      changes.push(`Moved ${path}.models legacy runtime keys to provider keys.`);
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
    const refs = migrateRuntimeSelection(execution, migrate);
    if (refs.length) {
      ensureSelectedModelRuntimePolicies(agent, refs);
      changes.push(`Moved ${path}.${key}.model to provider references with model runtime policy.`);
    }
  }
  if (policy && policyRefs.length) {
    policy.allow = allow;
    changes.push(`Moved ${path}.modelPolicy.allow legacy runtime refs to provider references.`);
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
  warnings: string[],
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
  const retained = retainConflictingLegacyCliProviders(next, blockedModelIdentities, warnings);
  const migrate: LegacyRuntimeRefMigrator = (ref) => {
    const migrated = migrateUnblockedLegacyRuntimeModelRef(ref, blockedModelIdentities);
    return migrated && !retained.has(migrated.legacyProvider) ? migrated : null;
  };
  for (const [path, agent] of agentScopes(next.agents)) {
    migrateRuntimeAgent(agent, path, changes, migrate);
  }
  const migrateCliRef: LegacyRuntimeRefMigrator = (ref) => {
    const migrated = migrate(ref);
    return migrated &&
      ["codex-cli", "claude-cli", "google-gemini-cli"].includes(migrated.legacyProvider)
      ? migrated
      : null;
  };
  const outside = createRuntimeModelRefRewriter(migrateCliRef);
  outsideAgentRefs(next).forEach(outside.rewrite);
  if (
    outside.selected.length &&
    ensureSelectedModelRuntimePolicies(((next.agents ??= {}).defaults ??= {}), outside.selected)
  ) {
    changes.push("Selected agents.defaults.models runtime for legacy refs outside agents.");
  }
  const rewritten = rewriteModelRefs(
    next,
    "config",
    changes,
    (ref) => migrateCliRef(ref)?.ref ?? null,
  ).value as OpenClawConfigWithLegacyRoster; // SAFETY: The ref rewriter preserves config containers and value types.
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
      skills.allowBundled = filtered;
      changes.push(`Removed ${key} from skills.allowBundled.`);
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
