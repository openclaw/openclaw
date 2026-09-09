import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../../../agents/agent-scope.js";
import {
  areOAuthCredentialsEquivalent,
  hasMatchingOAuthIdentity,
} from "../../../agents/auth-profiles/oauth-shared.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
  parseLegacyCredentialEntry,
} from "../../../agents/auth-profiles/persisted.js";
import { isLegacyCodexProviderId } from "../../../config/legacy-codex-provider.js";
import {
  applySessionEntryReplacements,
  iterateDoctorSessionKeyBatches,
  scanDoctorSessionEntriesStrict,
  scanDoctorSessionEntriesTolerant,
} from "../../../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadJsonFileThroughSymlink } from "../../../infra/json-file.js";
import {
  loadLegacySessionStore,
  updateLegacySessionStore,
} from "../../../infra/state-migrations.legacy-session-store.js";
import { isValidAgentHarnessSessionStoreEntry } from "../../../sessions/agent-harness-session-key.js";
import { resolveLegacyAuthProfilesPath } from "../../doctor-auth-legacy-paths.js";
import {
  isOpenAICodexAuthProfileRef,
  isBlockedLegacyCodexModelPair,
  isBlockedLegacyCodexModelRef,
  isOpenAICodexModelRef,
  isProviderlessModelRef,
  normalizeRuntimeString,
  toCanonicalOpenAIModelRef,
  toOpenAIModelId,
  resolveRuntimeModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import type {
  CodexSessionRouteRepairSummary,
  SessionRouteRepairResult,
} from "./codex-route-types.js";
import { migrateLegacyRuntimeModelRef } from "./legacy-runtime-model-providers.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredSessionModelRef,
  type ModelRefRepairResolver,
} from "./retired-model-ref-repair.js";

type SessionModelRetirement = {
  agentId: string;
  resolve: ModelRefRepairResolver;
  defaultModelRef?: string;
  warnings: string[];
};

function rewriteSessionModelPair(params: {
  entry: SessionEntry;
  providerKey: "modelProvider" | "providerOverride";
  modelKey: "model" | "modelOverride";
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): { changed: boolean; runtime?: string } {
  const provider = normalizeString(params.entry[params.providerKey]);
  const model =
    typeof params.entry[params.modelKey] === "string" ? params.entry[params.modelKey] : undefined;
  const legacyProviderModelRef =
    sessionProviderAllowsScopedModelRef(provider) && isOpenAICodexModelRef(model)
      ? model
      : undefined;
  const blockedIdentity =
    isBlockedLegacyCodexModelPair({
      providerId: provider,
      modelId: model,
      blockedModelIdentities: params.blockedModelIdentities,
    }) ||
    (legacyProviderModelRef
      ? isBlockedLegacyCodexModelRef({
          modelRef: legacyProviderModelRef,
          blockedModelIdentities: params.blockedModelIdentities,
        })
      : false);
  if (blockedIdentity) {
    return { changed: false };
  }
  if (isLegacyCodexProviderId(provider)) {
    params.entry[params.providerKey] = "openai";
    if (model) {
      const modelId = toOpenAIModelId(model);
      if (modelId) {
        params.entry[params.modelKey] = modelId;
      }
    }
    return { changed: true, runtime: "codex" };
  }
  const canonicalModel =
    legacyProviderModelRef && toCanonicalOpenAIModelRef(legacyProviderModelRef);
  if (canonicalModel) {
    params.entry[params.modelKey] = canonicalModel;
    return { changed: true, runtime: "codex" };
  }
  const scopedRuntimeRef =
    model && (!provider || ["claude-cli", "google-gemini-cli"].includes(provider))
      ? migrateLegacyRuntimeModelRef(model)
      : null;
  const rawRef = scopedRuntimeRef ? model : provider && model ? `${provider}/${model}` : model;
  const migrated = scopedRuntimeRef ?? (rawRef ? migrateLegacyRuntimeModelRef(rawRef) : null);
  if (
    !migrated ||
    (rawRef &&
      isBlockedLegacyCodexModelRef({
        modelRef: rawRef,
        blockedModelIdentities: params.blockedModelIdentities,
      }))
  ) {
    return { changed: false };
  }
  let changed = false;
  if (params.entry[params.providerKey] !== migrated.provider) {
    params.entry[params.providerKey] = migrated.provider;
    changed = true;
  }
  if (params.entry[params.modelKey] !== migrated.model) {
    params.entry[params.modelKey] = migrated.model;
    changed = true;
  }
  return { changed, runtime: migrated.runtime };
}

function isCodexSessionRoute(entry: SessionEntry): boolean {
  return (
    isLegacyCodexProviderId(entry.modelProvider) ||
    isLegacyCodexProviderId(entry.providerOverride) ||
    (sessionProviderAllowsScopedModelRef(normalizeString(entry.modelProvider)) &&
      isOpenAICodexModelRef(entry.model)) ||
    (sessionProviderAllowsScopedModelRef(normalizeString(entry.providerOverride)) &&
      isOpenAICodexModelRef(entry.modelOverride)) ||
    normalizeRuntimeString(entry.agentRuntimeOverride) === "codex"
  );
}

function normalizeCodexSessionHarness(
  entry: SessionEntry,
  legacyCodexHarness: boolean,
  wasCodexRoute: boolean,
): boolean {
  if (!legacyCodexHarness && !wasCodexRoute && !isCodexSessionRoute(entry)) {
    return false;
  }
  let changed = false;
  if (
    normalizeRuntimeString(entry.agentHarnessId) === "codex-cli" ||
    (legacyCodexHarness && entry.agentHarnessId === undefined)
  ) {
    entry.agentHarnessId = "codex";
    changed = true;
  }
  if (normalizeRuntimeString(entry.agentRuntimeOverride) === "codex-cli") {
    entry.agentRuntimeOverride = "codex";
    changed = true;
  }
  return changed;
}

function sessionProviderAllowsScopedModelRef(provider: string | undefined): boolean {
  // Canonical "openai" pairs keep raw model ids untouched: a configured
  // OpenAI-compatible model may legitimately be ID'd "codex/<x>". Only an
  // absent or legacy provider field marks the model string as a scoped ref.
  return !provider || isLegacyCodexProviderId(provider);
}

function clearStaleCodexFallbackNotice(
  entry: SessionEntry,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): boolean {
  const endpoints = [entry.fallbackNotice?.selectedModel, entry.fallbackNotice?.activeModel];
  const hasBlockedEndpoint = endpoints.some(
    (modelRef) =>
      isOpenAICodexModelRef(modelRef) &&
      isBlockedLegacyCodexModelRef({ modelRef, blockedModelIdentities }),
  );
  if (hasBlockedEndpoint || !endpoints.some(isOpenAICodexModelRef)) {
    return false;
  }
  delete entry.fallbackNotice;
  return true;
}

function clearRepairedCodexSessionHarness(entry: SessionEntry): boolean {
  const harnessRuntime = normalizeRuntimeString(entry.agentHarnessId);
  let changed = false;
  if (entry.agentHarnessId !== undefined && harnessRuntime !== "openclaw") {
    delete entry.agentHarnessId;
    changed = true;
  }
  return changed;
}

function repairProviderlessCodexSessionOverride(
  entry: SessionEntry,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): boolean {
  if (
    !isProviderlessModelRef(entry.modelOverride) ||
    !isOpenAICodexAuthProfileRef(entry.authProfileOverride) ||
    entry.authProfileOverrideSource !== "auto" ||
    entry.modelOverrideSource !== "auto" ||
    normalizeString(entry.providerOverride)
  ) {
    return false;
  }
  const authProvider = normalizeString(entry.authProfileOverride)?.split(":", 1)[0];
  if (
    isBlockedLegacyCodexModelPair({
      providerId: authProvider,
      modelId: entry.modelOverride,
      blockedModelIdentities,
    })
  ) {
    return false;
  }

  entry.providerOverride = "openai";
  entry.modelOverrideRouteResolution = "resolved";
  if (entry.model !== undefined || entry.modelProvider !== undefined) {
    delete entry.model;
    delete entry.modelProvider;
  }
  if (entry.contextTokens !== undefined || entry.contextTokensSource !== undefined) {
    delete entry.contextTokens;
    delete entry.contextTokensSource;
  }
  if (entry.contextBudgetStatus !== undefined) {
    delete entry.contextBudgetStatus;
  }
  return true;
}

/** Rewrite stale Codex model/provider/session runtime fields inside one session store object. */
function repairCodexSessionStoreRoutes(params: {
  store: Record<string, SessionEntry>;
  now?: number;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  authProfileIdMap?: ReadonlyMap<string, string>;
  retirement?: SessionModelRetirement;
}): SessionRouteRepairResult {
  const now = params.now ?? Date.now();
  const sessionKeys: string[] = [];
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry || isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      continue;
    }
    const legacyCodexHarness = normalizeRuntimeString(entry.agentHarnessId) === "codex-cli";
    const wasCodexRoute = isCodexSessionRoute(entry);
    const hasSelectedOverride = Boolean(entry.modelOverride?.trim());
    const runtimeWasExplicit =
      entry.agentRuntimeOverride !== undefined &&
      normalizeRuntimeString(entry.agentRuntimeOverride) !== "auto";
    const runtimeModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "modelProvider",
      modelKey: "model",
      blockedModelIdentities: params.blockedModelIdentities,
    });
    const overrideModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "providerOverride",
      modelKey: "modelOverride",
      blockedModelIdentities: params.blockedModelIdentities,
    });
    if (overrideModelRoute.changed) {
      entry.modelOverrideRouteResolution = "resolved";
    }
    const changedProviderlessOverride = repairProviderlessCodexSessionOverride(
      entry,
      params.blockedModelIdentities,
    );
    const changedModelRoute =
      runtimeModelRoute.changed || overrideModelRoute.changed || changedProviderlessOverride;
    const changedFallbackNotice = clearStaleCodexFallbackNotice(
      entry,
      params.blockedModelIdentities,
    );
    const selectedRuntime = changedProviderlessOverride
      ? "codex"
      : hasSelectedOverride
        ? overrideModelRoute.runtime
        : runtimeModelRoute.runtime;
    const changedRuntimePins =
      !runtimeWasExplicit &&
      selectedRuntime !== undefined &&
      entry.agentRuntimeOverride !== selectedRuntime;
    if (changedRuntimePins) {
      entry.agentRuntimeOverride = selectedRuntime;
    }
    const changedCodexRuntimeHarness =
      selectedRuntime === "codex" ? clearRepairedCodexSessionHarness(entry) : false;
    const changedCodexHarness = normalizeCodexSessionHarness(
      entry,
      legacyCodexHarness,
      wasCodexRoute,
    );
    // Providerless route repair first needs the legacy profile prefix; only the
    // auth migration owner's exact collision-aware map may rewrite its identity.
    const mappedAuthProfileId =
      typeof entry.authProfileOverride === "string"
        ? params.authProfileIdMap?.get(entry.authProfileOverride)
        : undefined;
    const changedAuthProfile =
      mappedAuthProfileId !== undefined && mappedAuthProfileId !== entry.authProfileOverride;
    if (changedAuthProfile) {
      entry.authProfileOverride = mappedAuthProfileId;
    }
    const changedRetiredModel = params.retirement
      ? repairRetiredSessionModelRef(
          entry,
          params.retirement.agentId,
          params.retirement.resolve,
          params.retirement.defaultModelRef,
          params.retirement.warnings,
        )
      : false;
    if (
      !changedModelRoute &&
      !changedFallbackNotice &&
      !changedRuntimePins &&
      !changedCodexRuntimeHarness &&
      !changedCodexHarness &&
      !changedAuthProfile &&
      !changedRetiredModel
    ) {
      continue;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.codexRouteSessionRepairTestApi")
  ] = { repairCodexSessionStoreRoutes };
}

function scanCodexSessionStoreRoutes(
  store: Record<string, SessionEntry>,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
  authProfileIdMap?: ReadonlyMap<string, string>,
  retirement?: SessionModelRetirement,
): string[] {
  // Preview executes the same repair against copies, so scanning and mutation
  // cannot disagree about a route, account pin, or retirement condition.
  return repairCodexSessionStoreRoutes({
    store: structuredClone(store),
    blockedModelIdentities,
    authProfileIdMap,
    retirement,
  }).sessionKeys;
}

function resolveVerifiedSessionAuthProfileIdMap(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authProfileIdMap: ReadonlyMap<string, string> | undefined;
}): ReadonlyMap<string, string> | undefined {
  if (!params.authProfileIdMap || params.authProfileIdMap.size === 0) {
    return params.authProfileIdMap;
  }
  const agentDir = resolveAgentDir(params.cfg, params.agentId, params.env);
  const localProfiles = loadPersistedAuthProfileStore(agentDir)?.profiles ?? {};
  const mainProfiles = loadPersistedSharedAuthProfileStore(params.env)?.profiles ?? {};
  const localLegacyAuthPath = resolveLegacyAuthProfilesPath(agentDir);
  const localLegacySourceExists = fs.existsSync(localLegacyAuthPath);
  const localLegacySource = localLegacySourceExists
    ? loadJsonFileThroughSymlink(localLegacyAuthPath)
    : null;
  const localLegacyProfiles =
    isRecord(localLegacySource) && isRecord(localLegacySource.profiles)
      ? localLegacySource.profiles
      : undefined;

  return new Map(
    [...params.authProfileIdMap].filter(([legacyProfileId, canonicalProfileId]) => {
      const localCredential = localProfiles[canonicalProfileId];
      if (localCredential) {
        return normalizeString(localCredential.provider) === "openai";
      }
      // A failed local import still owns its account. Never replace it with a
      // same-named main credential; inheritance is safe only without that source.
      const inheritedCredential = mainProfiles[canonicalProfileId];
      if (localLegacySourceExists) {
        if (!localLegacyProfiles) {
          return false;
        }
        const legacyCredential = localLegacyProfiles[legacyProfileId];
        if (legacyCredential !== undefined) {
          if (!isRecord(legacyCredential)) {
            return false;
          }
          const canonicalLegacyCredential = parseLegacyCredentialEntry(
            { ...legacyCredential, provider: "openai" },
            "openai",
          );
          // A retained mixed-sidecar source still contains successful entries.
          // Permit deduped main inheritance only when exact account identity matches.
          return (
            canonicalLegacyCredential?.type === "oauth" &&
            inheritedCredential?.type === "oauth" &&
            inheritedCredential.provider === "openai" &&
            (hasMatchingOAuthIdentity(canonicalLegacyCredential, inheritedCredential) ||
              areOAuthCredentialsEquivalent(canonicalLegacyCredential, inheritedCredential))
          );
        }
      }
      return normalizeString(inheritedCredential?.provider) === "openai";
    }),
  );
}

/** Scan or repair all configured agent session stores that still contain legacy Codex routes. */
export async function maybeRepairCodexSessionRoutes(params: {
  cfg: OpenClawConfig;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  authProfileIdMap?: ReadonlyMap<string, string>;
}): Promise<CodexSessionRouteRepairSummary> {
  const env = params.env ?? process.env;
  const warnings: string[] = [];
  const sessionTargets = resolveAllAgentSessionStoreTargetsSync(params.cfg, { env });
  const resolveRetired = createRetiredModelRefRepairResolver({
    cfg: params.cfg,
    checkModelPolicy: true,
    retiredModelRefConfig: params.retiredModelRefConfig,
    env,
    warnings,
    agentIds: [...new Set(sessionTargets.map((target) => target.agentId))],
  });
  const targets = sessionTargets.flatMap((target) => {
    const defaultModelRef = resolveAgentEffectiveModelPrimary(params.cfg, target.agentId);
    const retirement = {
      agentId: target.agentId,
      resolve: resolveRetired,
      warnings,
      defaultModelRef: defaultModelRef
        ? resolveRuntimeModelRef({
            cfg: params.cfg,
            modelRef: defaultModelRef,
            agentId: target.agentId,
          })
        : undefined,
    };
    const sessionScope = {
      storePath: target.storePath,
      agentId: target.agentId,
      env,
    };
    const authProfileIdMap = resolveVerifiedSessionAuthProfileIdMap({
      agentId: target.agentId,
      cfg: params.cfg,
      env,
      authProfileIdMap: params.authProfileIdMap,
    });
    const staleSqliteSessionKeys: string[] = [];
    const scanEntry = ({ entry, sessionKey }: { entry: SessionEntry; sessionKey: string }) => {
      if (
        scanCodexSessionStoreRoutes(
          { [sessionKey]: entry },
          params.blockedModelIdentities,
          authProfileIdMap,
          retirement,
        ).length > 0
      ) {
        staleSqliteSessionKeys.push(sessionKey);
      }
    };
    // Preview tolerates malformed legacy rows; repair mode uses strict canonical validation.
    const sqliteEntryCount = params.shouldRepair
      ? scanDoctorSessionEntriesStrict(sessionScope, scanEntry)
      : scanDoctorSessionEntriesTolerant(sessionScope, scanEntry);
    const hasLegacyStore = !target.storePath.endsWith(".sqlite") && fs.existsSync(target.storePath);
    return sqliteEntryCount > 0 || hasLegacyStore
      ? [
          {
            ...target,
            staleSqliteSessionKeys,
            hasLegacyStore,
            authProfileIdMap,
            retirement,
          },
        ]
      : [];
  });
  if (targets.length === 0) {
    return { ...emptyRepairSummary(), warnings };
  }
  if (!params.shouldRepair) {
    const stale = targets.flatMap((target) => {
      const sessionKeys = new Set(target.staleSqliteSessionKeys);
      if (target.hasLegacyStore) {
        for (const sessionKey of scanCodexSessionStoreRoutes(
          loadLegacySessionStore(target.storePath),
          params.blockedModelIdentities,
          target.authProfileIdMap,
          target.retirement,
        )) {
          sessionKeys.add(sessionKey);
        }
      }
      return Array.from(sessionKeys, (sessionKey) => `${target.agentId}:${sessionKey}`);
    });
    return {
      scannedStores: targets.length,
      repairedStores: 0,
      repairedSessions: 0,
      warnings: [
        ...warnings,
        ...(stale.length > 0
          ? [
              [
                "- Legacy or retired session model route state detected.",
                `- Affected sessions: ${stale.length}.`,
                "- Run `openclaw doctor --fix` to rewrite stale session model/provider pins across all agent session stores.",
              ].join("\n"),
            ]
          : []),
      ],
      changes: [],
    };
  }
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const repairedSessionKeys = new Set<string>();
    const { staleSqliteSessionKeys } = target;
    for (const sessionKeys of iterateDoctorSessionKeyBatches(staleSqliteSessionKeys)) {
      const result = await applySessionEntryReplacements({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKeys,
        skipMaintenance: true,
        update: (entries) => {
          const store = Object.fromEntries(
            entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
          );
          const repair = repairCodexSessionStoreRoutes({
            store,
            blockedModelIdentities: params.blockedModelIdentities,
            authProfileIdMap: target.authProfileIdMap,
            retirement: target.retirement,
          });
          return {
            result: repair,
            replacements: repair.sessionKeys.map((sessionKey) => ({
              sessionKey,
              entry: store[sessionKey]!,
            })),
          };
        },
      });
      for (const sessionKey of result.sessionKeys) {
        repairedSessionKeys.add(sessionKey);
      }
    }

    if (target.hasLegacyStore) {
      const staleLegacySessionKeys = scanCodexSessionStoreRoutes(
        loadLegacySessionStore(target.storePath),
        params.blockedModelIdentities,
        target.authProfileIdMap,
        target.retirement,
      );
      if (staleLegacySessionKeys.length > 0) {
        const result = await updateLegacySessionStore(
          target.storePath,
          (store) =>
            repairCodexSessionStoreRoutes({
              store,
              blockedModelIdentities: params.blockedModelIdentities,
              authProfileIdMap: target.authProfileIdMap,
              retirement: target.retirement,
            }),
          { skipMaintenance: true },
        );
        for (const sessionKey of result.sessionKeys) {
          repairedSessionKeys.add(sessionKey);
        }
      }
    }
    if (repairedSessionKeys.size > 0) {
      repairedStores += 1;
      repairedSessions += repairedSessionKeys.size;
    }
  }
  return {
    scannedStores: targets.length,
    repairedStores,
    repairedSessions,
    warnings,
    changes:
      repairedSessions > 0
        ? [
            `Repaired legacy or retired model routes in ${repairedSessions} session${
              repairedSessions === 1 ? "" : "s"
            } across ${repairedStores} store${repairedStores === 1 ? "" : "s"} while preserving auth-profile pins.`,
          ]
        : [],
  };
}

function emptyRepairSummary(): CodexSessionRouteRepairSummary {
  return {
    scannedStores: 0,
    repairedStores: 0,
    repairedSessions: 0,
    warnings: [],
    changes: [],
  };
}
