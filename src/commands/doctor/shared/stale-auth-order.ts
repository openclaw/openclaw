// Repairs configured auth orders whose referenced profiles no longer exist.
import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
} from "../../../agents/agent-scope-config.js";
import { listRuntimeExternalAuthProfiles } from "../../../agents/auth-profiles/external-auth.js";
import { resolveAuthProfileOrder } from "../../../agents/auth-profiles/order.js";
import {
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "../../../agents/auth-profiles/paths.js";
import {
  coercePersistedAuthProfileStore,
  mergeAuthProfileStores,
} from "../../../agents/auth-profiles/persisted.js";
import { inspectPersistedAuthProfileStoreRaw } from "../../../agents/auth-profiles/sqlite.js";
import {
  coerceAuthProfileState,
  loadPersistedAuthProfileState,
  mergeAuthProfileState,
} from "../../../agents/auth-profiles/state.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../../../agents/provider-auth-aliases.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isRecord, resolveUserPath } from "../../../utils.js";

type StaleConfiguredAuthOrder = {
  provider: string;
  staleProfileCount: number;
};

type LoadedAuthStores =
  | {
      status: "ready";
      stores: AuthProfileStore[];
      activeStores: AuthProfileStore[];
      runtimeProfileIds: Set<string>;
    }
  | { status: "blocked"; warnings: string[] };

const AUTH_PROFILE_MODES = new Set(["api_key", "aws-sdk", "oauth", "token"]);
const INVALID_SQLITE_STORE_WARNING =
  "- Skipped auth.order repair because an active SQLite auth profile store is unreadable or contains invalid credentials; repair or re-import that agent's auth store, then rerun doctor.";

function isProfileIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((profileId) => typeof profileId === "string");
}

function readValidConfiguredAuthOrder(cfg: OpenClawConfig): Record<string, string[]> | undefined {
  const order: unknown = cfg.auth?.order;
  if (!isRecord(order)) {
    return undefined;
  }
  const result: Record<string, string[]> = {};
  for (const [provider, profileIds] of Object.entries(order)) {
    if (!isProfileIdList(profileIds)) {
      return undefined;
    }
    result[provider] = profileIds;
  }
  return result;
}

function hasValidConfiguredAuthProfiles(cfg: OpenClawConfig): boolean {
  const profiles: unknown = cfg.auth?.profiles;
  if (profiles === undefined) {
    return true;
  }
  return (
    isRecord(profiles) &&
    Object.values(profiles).every(
      (profile) =>
        isRecord(profile) &&
        typeof profile.provider === "string" &&
        typeof profile.mode === "string" &&
        AUTH_PROFILE_MODES.has(profile.mode),
    )
  );
}

function hasNonemptyConfiguredAuthOrder(cfg: OpenClawConfig): boolean {
  const order = readValidConfiguredAuthOrder(cfg);
  return Boolean(order && Object.values(order).some((profileIds) => profileIds.length > 0));
}

function hasUnmigratedAuthStoreSource(agentDir: string): boolean {
  return (
    fs.existsSync(resolveAuthStorePath(agentDir)) ||
    fs.existsSync(resolveAuthStatePath(agentDir)) ||
    fs.existsSync(resolveLegacyAuthStorePath(agentDir))
  );
}

function loadCompletePersistedStore(
  agentDir: string,
): { status: "ok"; store: AuthProfileStore | null } | { status: "invalid" } {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir);
  if (inspection.status === "missing") {
    return { status: "ok", store: null };
  }
  if (
    inspection.status === "unreadable" ||
    !isRecord(inspection.raw) ||
    !isRecord(inspection.raw.profiles)
  ) {
    return { status: "invalid" };
  }
  const store = coercePersistedAuthProfileStore(inspection.raw);
  const rawProfileIds = Object.keys(inspection.raw.profiles);
  if (
    !store ||
    rawProfileIds.length !== Object.keys(store.profiles).length ||
    rawProfileIds.some((profileId) => !Object.hasOwn(store.profiles, profileId))
  ) {
    // Coercion deliberately drops malformed credentials. A dropped id may be
    // the user's explicit selection, so doctor must not infer that it vanished.
    return { status: "invalid" };
  }
  return {
    status: "ok",
    store: {
      ...store,
      ...mergeAuthProfileState(
        coerceAuthProfileState(inspection.raw),
        loadPersistedAuthProfileState(agentDir),
      ),
    },
  };
}

function listRetainedStateAgentDirs(env: NodeJS.ProcessEnv): string[] | null {
  const agentsRoot = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : null;
  }

  const agentDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const agentDir = path.join(agentsRoot, entry.name, "agent");
    try {
      if (fs.statSync(agentDir).isDirectory()) {
        agentDirs.push(path.resolve(agentDir));
      } else {
        return null;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (entry.isSymbolicLink() || (code !== "ENOENT" && code !== "ENOTDIR")) {
        return null;
      }
      try {
        // A dangling `agents/<id>/agent` symlink is an unavailable store, not
        // proof that the retained agent has no credentials.
        fs.lstatSync(agentDir);
        return null;
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== "ENOENT" && lstatCode !== "ENOTDIR") {
          return null;
        }
      }
    }
  }
  return agentDirs;
}

function loadConfiguredAgentAuthStores(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): LoadedAuthStores | undefined {
  const order = readValidConfiguredAuthOrder(cfg);
  if (!order || !hasValidConfiguredAuthProfiles(cfg)) {
    return undefined;
  }
  // Every secondary agent inherits the legacy main store at runtime, even when
  // `agents.list` names a different default agent.
  const mainAgentDir = path.resolve(resolveDefaultAgentDir({}, env));
  const activeAgentDirs = new Set([
    mainAgentDir,
    ...listAgentIds(cfg).map((agentId) => path.resolve(resolveAgentDir(cfg, agentId, env))),
  ]);
  const envAgentDir =
    env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || undefined;
  if (envAgentDir) {
    activeAgentDirs.add(path.resolve(resolveUserPath(envAgentDir, env)));
  }
  const retainedAgentDirs = listRetainedStateAgentDirs(env);
  if (!retainedAgentDirs) {
    return undefined;
  }
  const agentDirs = new Set([...activeAgentDirs, ...retainedAgentDirs]);

  const entries: Array<{ agentDir: string; store: AuthProfileStore | null }> = [];
  for (const agentDir of agentDirs) {
    if (hasUnmigratedAuthStoreSource(agentDir)) {
      return undefined;
    }
    const loaded = loadCompletePersistedStore(agentDir);
    if (loaded.status === "invalid") {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    entries.push({ agentDir, store: loaded.store });
  }

  const emptyStore: AuthProfileStore = { version: 1, profiles: {} };
  const mainStore = entries.find((entry) => entry.agentDir === mainAgentDir)?.store ?? emptyStore;
  const stores = entries.map((entry) => {
    const localStore = entry.store ?? emptyStore;
    return entry.agentDir === mainAgentDir
      ? mainStore
      : mergeAuthProfileStores(mainStore, localStore, {
          preserveBaseRuntimeExternalProfiles: true,
        });
  });
  const activeStores = entries.flatMap((entry, index) =>
    activeAgentDirs.has(entry.agentDir) ? [stores[index] ?? emptyStore] : [],
  );

  const providerIds = Object.keys(order);
  const profileIds = Object.values(order).flat();
  const runtimeProfileIds = new Set<string>();
  try {
    for (const [index, entry] of entries.entries()) {
      const store = stores[index] ?? emptyStore;
      const externalProfiles = listRuntimeExternalAuthProfiles({
        store,
        agentDir: entry.agentDir,
        env,
        externalCli: {
          allowKeychainPrompt: false,
          config: cfg,
          externalCliProviderIds: providerIds,
          externalCliProfileIds: profileIds,
        },
      });
      for (const profile of externalProfiles) {
        runtimeProfileIds.add(profile.profileId);
      }
    }
  } catch {
    // Runtime discovery participates in the existence proof. Preserve explicit
    // config if it cannot be inspected without prompting.
    return undefined;
  }
  return { status: "ready", stores, activeStores, runtimeProfileIds };
}

function removeAuthOrderKeys(cfg: OpenClawConfig, providers: ReadonlySet<string>): OpenClawConfig {
  const order = Object.fromEntries(
    Object.entries(readValidConfiguredAuthOrder(cfg) ?? {}).filter(
      ([provider]) => !providers.has(provider),
    ),
  );
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      order,
    },
  };
}

/** Find nonempty config orders that only reference removed profiles. */
export function scanStaleConfiguredAuthOrders(params: {
  cfg: OpenClawConfig;
  stores: readonly AuthProfileStore[];
  activeStores?: readonly AuthProfileStore[];
  runtimeProfileIds?: ReadonlySet<string>;
}): StaleConfiguredAuthOrder[] {
  const order = readValidConfiguredAuthOrder(params.cfg);
  if (!order || !hasValidConfiguredAuthProfiles(params.cfg)) {
    return [];
  }

  const configuredProfileIds = new Set(Object.keys(params.cfg.auth?.profiles ?? {}));
  const storedProfileIds = new Set(params.stores.flatMap((store) => Object.keys(store.profiles)));
  const staleByCanonicalProvider = new Map<string, StaleConfiguredAuthOrder[]>();

  for (const [provider, profileIds] of Object.entries(order)) {
    // Empty order is an intentional provider disable. Any surviving profile is
    // authoritative even if its credential is currently unusable.
    if (
      profileIds.length === 0 ||
      profileIds.some(
        (profileId) =>
          configuredProfileIds.has(profileId) ||
          storedProfileIds.has(profileId) ||
          params.runtimeProfileIds?.has(profileId),
      )
    ) {
      continue;
    }
    const canonicalProvider = resolveProviderIdForAuth(provider, { config: params.cfg });
    const entries = staleByCanonicalProvider.get(canonicalProvider) ?? [];
    entries.push({ provider, staleProfileCount: profileIds.length });
    staleByCanonicalProvider.set(canonicalProvider, entries);
  }

  const hits: StaleConfiguredAuthOrder[] = [];
  for (const [canonicalProvider, staleEntries] of staleByCanonicalProvider) {
    // Remove every stale alias in the group for the proof. Otherwise deleting
    // the canonical key can merely expose another stale alias underneath it.
    const staleProviders = new Set(staleEntries.map((entry) => entry.provider));
    const cfgWithoutStaleOrder = removeAuthOrderKeys(params.cfg, staleProviders);
    const hasAutomaticFallback = (params.activeStores ?? params.stores).some((store) => {
      const selectionStore = structuredClone(store);
      return (
        resolveAuthProfileOrder({
          cfg: cfgWithoutStaleOrder,
          store: selectionStore,
          provider: canonicalProvider,
        }).length > 0
      );
    });
    if (hasAutomaticFallback) {
      hits.push(...staleEntries);
    }
  }
  return hits;
}

/** Remove provably stale config orders and restore per-agent automatic selection. */
export function repairStaleConfiguredAuthOrders(params: {
  cfg: OpenClawConfig;
  stores: readonly AuthProfileStore[];
  activeStores?: readonly AuthProfileStore[];
  runtimeProfileIds?: ReadonlySet<string>;
}): { config: OpenClawConfig; changes: string[] } {
  const hits = scanStaleConfiguredAuthOrders(params);
  if (hits.length === 0) {
    return { config: params.cfg, changes: [] };
  }
  return {
    config: removeAuthOrderKeys(params.cfg, new Set(hits.map((hit) => hit.provider))),
    changes: hits.map(
      (hit) =>
        `auth.order.${hit.provider}: removed ${hit.staleProfileCount} missing profile reference${hit.staleProfileCount === 1 ? "" : "s"} to restore automatic per-agent auth selection.`,
    ),
  };
}

/** Load configured agent stores and repair their stale config auth orders. */
export function maybeRepairStaleConfiguredAuthOrders(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  if (!hasNonemptyConfiguredAuthOrder(params.cfg)) {
    return { config: params.cfg, changes: [] };
  }
  const loaded = loadConfiguredAgentAuthStores(params.cfg, params.env ?? process.env);
  if (!loaded) {
    return { config: params.cfg, changes: [] };
  }
  if (loaded.status === "blocked") {
    return { config: params.cfg, changes: [], warnings: loaded.warnings };
  }
  return repairStaleConfiguredAuthOrders({ cfg: params.cfg, ...loaded });
}

/** Build preview warnings for stale config auth orders. */
export function collectStaleConfiguredAuthOrderWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (!hasNonemptyConfiguredAuthOrder(params.cfg)) {
    return [];
  }
  const loaded = loadConfiguredAgentAuthStores(params.cfg, params.env ?? process.env);
  if (!loaded) {
    return [];
  }
  if (loaded.status === "blocked") {
    return loaded.warnings;
  }
  return scanStaleConfiguredAuthOrders({ cfg: params.cfg, ...loaded }).map(
    (hit) =>
      `- auth.order.${hit.provider} references only missing profiles while compatible stored credentials exist; run ${params.doctorFixCommand} to remove the stale override and restore automatic selection.`,
  );
}
