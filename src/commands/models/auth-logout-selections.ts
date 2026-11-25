import { isDeepStrictEqual } from "node:util";
import {
  listAgentIds,
  resolveAgentDir,
  resolveMutableAgentEntry,
} from "../../agents/agent-scope-config.js";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { listCandidateAuthProfileStores } from "../../agents/auth-profiles/candidate-stores.js";
import { resolveNativeSharedAuthStorePath as resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.native.js";
import type { AuthProfileRemovalScope } from "../../agents/auth-profiles/profiles.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import {
  findPersistedAuthProfileCredentialAsync,
  resolvePersistedAuthProfileOwnerAgentDirAsync,
} from "../../agents/auth-profiles/store-runtime.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { readUtilityModelSetting } from "../../agents/utility-model-setting.js";
import { resolveAgentModelFallbackValues, toAgentModelListLike } from "../../config/model-input.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";

export type ModelAuthProfileRemoval = {
  shared: ReadonlySet<string>;
  agents: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Capture logical consumers while the selected credential still has its physical owner. */
export async function resolveModelAuthProfileRemoval(
  cfg: OpenClawConfig,
  scopes: readonly AuthProfileRemovalScope[],
): Promise<ModelAuthProfileRemoval> {
  const owners = new Map<string, Set<string>>();
  for (const scope of scopes) {
    const ids = owners.get(scope.databasePath) ?? new Set<string>();
    for (const id of scope.profileIds) {
      ids.add(id);
    }
    owners.set(scope.databasePath, ids);
  }
  const sharedPath = resolvePathViaExistingAncestorSync(resolveSharedAuthStorePath());
  const shared = owners.get(sharedPath) ?? new Set<string>();
  const agents = new Map<string, Set<string>>();
  if (owners.size === 0) {
    return { shared, agents };
  }
  const agentDirs = new Map(listAgentIds(cfg).map((id) => [id, resolveAgentDir(cfg, id)]));
  for (const candidate of await listCandidateAuthProfileStores({ cfg })) {
    if (!agentDirs.has(candidate.agentId)) {
      agentDirs.set(candidate.agentId, candidate.agentDir);
    }
  }
  const profileIds = new Set(scopes.flatMap((scope) => [...scope.profileIds]));
  for (const [agentId, agentDir] of agentDirs) {
    const removed = new Set<string>();
    for (const profileId of profileIds) {
      if (!(await findPersistedAuthProfileCredentialAsync({ agentDir, profileId }))) {
        continue;
      }
      const owner = await resolvePersistedAuthProfileOwnerAgentDirAsync({ agentDir, profileId });
      const databasePath = owner
        ? resolvePathViaExistingAncestorSync(resolveAuthProfileDatabasePath(owner))
        : sharedPath;
      if (owners.get(databasePath)?.has(profileId)) {
        removed.add(profileId);
      }
    }
    if (removed.size > 0) {
      agents.set(agentId, removed);
    }
  }
  return { shared, agents };
}

/** Release only deleted account selections; model choices and unrelated accounts survive. */
export function removeModelAuthProfileSelections(
  cfg: OpenClawConfig,
  removed: ModelAuthProfileRemoval,
): OpenClawConfig {
  if (!cfg.agents) {
    return cfg;
  }
  const strip = (ref: string | undefined, ids: ReadonlySet<string> | undefined) => {
    if (!ref || !ids?.size) {
      return ref;
    }
    const { model, profile } = splitTrailingAuthProfile(ref);
    return profile && ids.has(profile) ? model : ref;
  };
  const stripModel = (
    model: AgentModelConfig | undefined,
    ids: ReadonlySet<string> | undefined,
  ) => {
    if (typeof model === "string" || model === undefined) {
      return strip(model, ids);
    }
    return {
      ...model,
      ...(model.primary !== undefined ? { primary: strip(model.primary, ids) } : {}),
      ...(model.fallbacks ? { fallbacks: model.fallbacks.map((ref) => strip(ref, ids)!) } : {}),
    };
  };
  const next = structuredClone(cfg);
  const beforeDefaults = cfg.agents.defaults;
  const defaults = next.agents?.defaults;
  if (defaults) {
    if (defaults.model !== undefined) {
      defaults.model = stripModel(defaults.model, removed.shared);
    }
    if (defaults.utilityModel !== undefined) {
      defaults.utilityModel = stripModel(defaults.utilityModel, removed.shared);
    }
  }
  for (const agentId of listAgentIds(cfg)) {
    let entry = resolveMutableAgentEntry(next, agentId);
    const implicitAgent = !entry;
    if (!entry && next.agents) {
      next.agents.entries = { [agentId]: {} };
      entry = next.agents.entries[agentId]!;
    }
    if (!entry) {
      continue;
    }
    const ids = removed.agents.get(agentId);
    const resolveFallbacks = (config: OpenClawConfig, key: "model" | "utilityModel") => {
      if (key === "model") {
        return (
          resolveAgentModelFallbacksOverride(config, agentId) ??
          resolveAgentModelFallbackValues(config.agents?.defaults?.model)
        );
      }
      const utility = readUtilityModelSetting(config, agentId);
      return utility.kind === "disabled" ? [] : utility.fallbacks;
    };
    for (const key of ["model", "utilityModel"] as const) {
      const originalModel = entry[key];
      if (key === "utilityModel" && typeof originalModel === "string" && !originalModel.trim()) {
        continue;
      }
      const own = toAgentModelListLike(originalModel);
      const inherited = toAgentModelListLike(beforeDefaults?.[key]);
      const nextInherited = toAgentModelListLike(defaults?.[key]);
      const model = toAgentModelListLike(stripModel(originalModel, ids)) ?? {};
      // A shared default can name an independent local credential in another agent.
      // Preserve that effective choice when the shared pin is removed.
      if (own?.primary === undefined && inherited?.primary !== undefined) {
        const primary = strip(inherited.primary, ids);
        if (primary !== nextInherited?.primary) {
          model.primary = primary;
        }
      }
      if (Object.keys(model).length > 0) {
        const source =
          originalModel ?? (key === "utilityModel" ? beforeDefaults?.utilityModel : undefined);
        entry[key] =
          typeof source === "string" && model.fallbacks === undefined ? model.primary : model;
      }
      // An explicit primary disables inherited fallbacks. Materializing one must
      // retain the prior effective fallback list, not silently change routing.
      const fallbacks = resolveFallbacks(cfg, key).map((ref) => strip(ref, ids)!);
      if (!isDeepStrictEqual(fallbacks, resolveFallbacks(next, key))) {
        entry[key] = { ...toAgentModelListLike(entry[key]), fallbacks };
      }
    }
    if (implicitAgent && Object.keys(entry).length === 0 && next.agents) {
      delete next.agents.entries;
    }
  }
  return isDeepStrictEqual(cfg, next) ? cfg : next;
}
