// Agent config mutation and summary builders used by `openclaw agents` commands.
import {
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import pMap from "p-map";
import {
  listAgentEntries,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope.js";
import { resolveAgentAvatarUrlFromSource } from "../agents/identity-avatar-file.js";
import { loadAgentIdentityFromWorkspaceAsync } from "../agents/identity-file.js";
import { pinLegacyInheritedAuthOwnerForRosterTransition } from "../agents/legacy-inherited-auth-dir.js";
import { pinSurvivorWorkspaceForRosterCollapse } from "../config/agent-workspace-roster-transition.js";
import { listRouteBindings } from "../config/bindings.js";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import type { IdentityConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import {
  readAgentDatabaseAdmissionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";

export type AgentSummary = {
  id: string;
  status?: "degraded";
  admissionRefusal?: AgentDatabaseAdmissionRefusal;
  name?: string;
  identityName?: string;
  identityEmoji?: string;
  identityAvatarUrl?: string;
  identitySource?: "identity" | "config";
  workspace: string;
  agentDir: string;
  model?: string;
  bindings: number;
  bindingDetails?: string[];
  routes?: string[];
  providers?: string[];
  createdVia?: "operator" | "agent" | "claw";
  creatorAgentId?: string | null;
  createdAt?: number;
  isDefault: boolean;
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

export { listAgentEntries };

/** Find a configured agent entry by normalized id. */
export function findAgentEntryIndex(list: AgentEntry[], agentId: string): number {
  const id = normalizeAgentId(agentId);
  return list.findIndex((entry) => normalizeAgentId(entry.id) === id);
}

/** Build config-derived summaries for text/JSON agent listing. */
export async function buildAgentSummaries(cfg: OpenClawConfig): Promise<AgentSummary[]> {
  const defaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const configuredAgents = listAgentEntries(cfg);
  const orderedIds =
    configuredAgents.length > 0
      ? configuredAgents.map((agent) => normalizeAgentId(agent.id))
      : defaultAgentId
        ? [defaultAgentId]
        : [];
  const bindingCounts = new Map<string, number>();
  for (const binding of listRouteBindings(cfg)) {
    const agentId = normalizeAgentId(binding.agentId);
    bindingCounts.set(agentId, (bindingCounts.get(agentId) ?? 0) + 1);
  }

  const ordered = uniqueStrings(orderedIds);

  return pMap(
    ordered,
    async (id) => {
      const workspace = resolveAgentWorkspaceDir(cfg, id);
      const identity = await loadAgentIdentityFromWorkspaceAsync(workspace);
      const agentConfig = resolveAgentConfig(cfg, id);
      const configName = normalizeOptionalString(agentConfig?.identity?.name);
      const configEmoji = normalizeOptionalString(agentConfig?.identity?.emoji);
      const configAvatarUrl = await resolveAgentAvatarUrlFromSource(
        cfg,
        id,
        agentConfig?.identity?.avatar,
      );
      // Validate each avatar before choosing so a stale path cannot hide the workspace image.
      const identityAvatarUrl =
        configAvatarUrl ?? (await resolveAgentAvatarUrlFromSource(cfg, id, identity?.avatar));
      const identitySource =
        configName || configEmoji || configAvatarUrl ? "config" : identity ? "identity" : undefined;
      const summary: AgentSummary = {
        id,
        name: normalizeOptionalString(agentConfig?.name),
        identityName: configName ?? identity?.name,
        identityEmoji: configEmoji ?? identity?.emoji,
        identitySource,
        workspace,
        agentDir: resolveAgentDir(cfg, id),
        model:
          resolvePrimaryStringValue(agentConfig?.model) ??
          resolvePrimaryStringValue(cfg.agents?.defaults?.model),
        bindings: bindingCounts.get(id) ?? 0,
        isDefault: defaultAgentId !== undefined && id === normalizeAgentId(defaultAgentId),
      };
      if (identityAvatarUrl) {
        summary.identityAvatarUrl = identityAvatarUrl;
      }
      const admissionRefusal = readAgentDatabaseAdmissionRefusal(id);
      if (admissionRefusal) {
        summary.status = "degraded";
        summary.admissionRefusal = admissionRefusal;
      }
      return summary;
    },
    { concurrency: 4 },
  );
}

export function applyAgentConfig(
  cfg: OpenClawConfig,
  params: {
    agentId: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string | null;
    identity?: IdentityConfig;
  },
): OpenClawConfig {
  const agentId = normalizeAgentId(params.agentId);
  const name = params.name?.trim();
  const list = listAgentEntries(cfg);
  const index = findAgentEntryIndex(list, agentId);
  const base = (index >= 0 ? list[index] : undefined) ?? { id: agentId };
  const mergedIdentity = params.identity ? { ...base.identity, ...params.identity } : undefined;
  const nextEntry: AgentEntry = {
    ...base,
    ...(name ? { name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(mergedIdentity ? { identity: mergedIdentity } : {}),
  };
  // Model is tri-state: omission preserves the override, null restores inheritance.
  if (params.model === null) {
    delete nextEntry.model;
  } else if (params.model !== undefined) {
    nextEntry.model = params.model;
  }
  const nextList = [...list];
  if (index >= 0) {
    nextList[index] = nextEntry;
  } else {
    nextList.push(nextEntry);
  }
  const { list: _legacyList, ownership: _ownership, ...agentsConfig } = cfg.agents ?? {};
  const nextConfig: OpenClawConfig = {
    ...cfg,
    agents: {
      ...agentsConfig,
      ...(nextList.length > 1 ? { ownership: "explicit" as const } : {}),
      entries: toAgentEntriesRecord(nextList),
    },
  };
  if (list.length !== 1 || nextList.length <= 1) {
    return nextConfig;
  }
  const priorSystemAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const transitionedConfig =
    priorSystemAgentId &&
    !normalizeOptionalString(nextConfig.agents?.defaults?.systemAgent?.agentId)
      ? {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents?.defaults,
              systemAgent: { agentId: priorSystemAgentId },
            },
          },
        }
      : nextConfig;
  return pinLegacyInheritedAuthOwnerForRosterTransition(cfg, transitionedConfig);
}

/** Remove an agent and any config references that route or allow traffic to it. */
export function pruneAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): {
  config: OpenClawConfig;
  removedBindings: number;
  removedAllow: number;
  clearedOwnerRefs: string[];
  removedReferences: string[];
  removedReferenceValues: Array<{ path: string; value: unknown }>;
  removedConfig: string[];
  insertedConfig: Array<{ path: string; value: unknown }>;
} {
  const id = normalizeAgentId(agentId);
  const clearedOwnerRefs: string[] = [];
  const removedReferences: string[] = [];
  const removedReferenceValues: Array<{ path: string; value: unknown }> = [];
  const targetsDeletedAgent = (candidate: string) => {
    const normalized = normalizeAgentIdStrict(candidate);
    return normalized.ok && normalized.value === id;
  };
  const clearOwnerRef = <T extends { agentId?: string }>(value: T | undefined, path: string) => {
    const owner = normalizeOptionalString(value?.agentId);
    if (!value || !owner || normalizeAgentId(owner) !== id) {
      return value;
    }
    clearedOwnerRefs.push(path);
    removedReferenceValues.push({ path, value: value.agentId });
    const { agentId: _agentId, ...rest } = value;
    return Object.keys(rest).length > 0 ? (rest as T) : undefined;
  };
  // Shared by every reference-array prune site below: drop matching entries and record their
  // config path (with original index) so adopted-agent removal can name every path it touches.
  const pruneReferences = <T>(
    items: T[] | undefined,
    pathPrefix: string,
    isReference: (item: T) => boolean,
  ) =>
    items?.filter((item, index) => {
      if (!isReference(item)) {
        return true;
      }
      const path = `${pathPrefix}[${index}]`;
      removedReferences.push(path);
      removedReferenceValues.push({ path, value: item });
      return false;
    });
  const matchesAllowAgentsEntry = (candidate: string) => {
    const trimmed = candidate.trim();
    return trimmed !== "" && targetsDeletedAgent(trimmed);
  };
  const agents = listAgentEntries(cfg);
  const nextAgentsList = [];
  for (const entry of agents) {
    if (normalizeAgentId(entry.id) === id) {
      continue;
    }
    nextAgentsList.push(
      entry.subagents?.allowAgents
        ? {
            ...entry,
            subagents: {
              ...entry.subagents,
              allowAgents: pruneReferences(
                entry.subagents.allowAgents,
                `agents.entries.${entry.id}.subagents.allowAgents`,
                matchesAllowAgentsEntry,
              ),
            },
          }
        : entry,
    );
  }
  const nextAgents = nextAgentsList.length > 0 ? toAgentEntriesRecord(nextAgentsList) : undefined;

  const bindings = cfg.bindings ?? [];
  const filteredBindings =
    pruneReferences(bindings, "bindings", (binding) => normalizeAgentId(binding.agentId) === id) ??
    [];

  const allow = cfg.tools?.agentToAgent?.allow ?? [];
  const filteredAllow =
    pruneReferences(allow, "tools.agentToAgent.allow", targetsDeletedAgent) ?? [];

  const prunedDefaults = cfg.agents?.defaults?.subagents?.allowAgents
    ? {
        ...cfg.agents.defaults,
        subagents: {
          ...cfg.agents.defaults.subagents,
          allowAgents: pruneReferences(
            cfg.agents.defaults.subagents.allowAgents,
            "agents.defaults.subagents.allowAgents",
            matchesAllowAgentsEntry,
          ),
        },
      }
    : cfg.agents?.defaults;
  const deletedAgentOwnedHeartbeat =
    normalizeOptionalString(prunedDefaults?.heartbeat?.agentId) !== undefined &&
    normalizeAgentId(prunedDefaults?.heartbeat?.agentId) === id;
  const nextHeartbeat =
    deletedAgentOwnedHeartbeat && nextAgentsList.length > 1
      ? undefined
      : clearOwnerRef(prunedDefaults?.heartbeat, "agents.defaults.heartbeat.agentId");
  if (deletedAgentOwnedHeartbeat && nextAgentsList.length > 1) {
    clearedOwnerRefs.push("agents.defaults.heartbeat");
    removedReferenceValues.push({
      path: "agents.defaults.heartbeat",
      value: prunedDefaults?.heartbeat,
    });
  }
  const nextDefaults = prunedDefaults
    ? {
        ...prunedDefaults,
        heartbeat: nextHeartbeat,
        systemAgent: clearOwnerRef(
          prunedDefaults.systemAgent,
          "agents.defaults.systemAgent.agentId",
        ),
      }
    : undefined;
  const nextTalk = clearOwnerRef(cfg.talk, "talk.agentId");
  const nextBroadcast = cfg.broadcast
    ? Object.fromEntries(
        Object.entries(cfg.broadcast).map(([peerId, value]) => [
          peerId,
          Array.isArray(value)
            ? pruneReferences(value, `broadcast.${peerId}`, targetsDeletedAgent)
            : value && typeof value === "object"
              ? {
                  ...value,
                  agents:
                    pruneReferences(
                      value.agents,
                      `broadcast.${peerId}.agents`,
                      targetsDeletedAgent,
                    ) ?? value.agents,
                }
              : value,
        ]),
      )
    : undefined;
  const nextHooks = cfg.hooks
    ? {
        ...cfg.hooks,
        allowedAgentIds: pruneReferences(
          cfg.hooks.allowedAgentIds,
          "hooks.allowedAgentIds",
          targetsDeletedAgent,
        ),
        mappings: pruneReferences(cfg.hooks.mappings, "hooks.mappings", (mapping) =>
          mapping.agentId ? targetsDeletedAgent(mapping.agentId) : false,
        ),
      }
    : undefined;
  const { list: _legacyList, ownership: _ownership, ...agentsConfig } = cfg.agents ?? {};
  // Roster writes canonicalize a migrated legacy default marker into explicit ownership. The
  // preview must expose the same topology that the config writer will persist, including 2 -> 1
  // and 1 -> 0 removals.
  const persistOwnership =
    nextAgentsList.length > 1 || tryGetLegacyDefaultAgentId(cfg) !== undefined;
  const nextAgentsConfig = cfg.agents
    ? {
        ...agentsConfig,
        ...(persistOwnership ? { ownership: "explicit" as const } : {}),
        defaults: nextDefaults,
        entries: nextAgents,
      }
    : nextAgents
      ? {
          ...(persistOwnership ? { ownership: "explicit" as const } : {}),
          entries: nextAgents,
        }
      : undefined;
  const nextTools = cfg.tools?.agentToAgent
    ? {
        ...cfg.tools,
        agentToAgent: {
          ...cfg.tools.agentToAgent,
          allow: filteredAllow.length > 0 ? filteredAllow : undefined,
        },
      }
    : cfg.tools;

  const preliminaryConfig: OpenClawConfig = {
    ...cfg,
    agents: nextAgentsConfig,
    bindings: filteredBindings.length > 0 ? filteredBindings : undefined,
    broadcast: nextBroadcast,
    hooks: nextHooks,
    talk: nextTalk,
    tools: nextTools,
  };
  const workspacePin = pinSurvivorWorkspaceForRosterCollapse(cfg, preliminaryConfig);
  const workspacePinnedConfig = workspacePin.config;
  const transitionPinnedConfig =
    agents.length > 1 && nextAgentsList.length === 1
      ? pinLegacyInheritedAuthOwnerForRosterTransition(cfg, workspacePinnedConfig)
      : workspacePinnedConfig;
  const previousSoleAgentId = tryResolveDefaultAgentId(cfg);
  const nextSessionStore = transitionPinnedConfig.agents?.defaults?.sessionStore;
  const sessionStorePinnedConfig =
    agents.length === 1 &&
    nextAgentsList.length === 0 &&
    previousSoleAgentId &&
    normalizeAgentId(previousSoleAgentId) === id &&
    !isPerAgentSessionStoreConfig(cfg.session?.store) &&
    (nextSessionStore === undefined || !Object.hasOwn(nextSessionStore, "agentId"))
      ? {
          ...transitionPinnedConfig,
          agents: {
            ...transitionPinnedConfig.agents,
            defaults: {
              ...transitionPinnedConfig.agents?.defaults,
              sessionStore: {
                ...nextSessionStore,
                agentId: normalizeAgentId(previousSoleAgentId),
              },
            },
          },
        }
      : transitionPinnedConfig;
  const insertedConfig = workspacePin.insertedPaths.map((path) => {
    const value = path.reduce<unknown>(
      (current, segment) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[segment]
          : undefined,
      workspacePinnedConfig,
    );
    return { path: path.join("."), value };
  });
  const removedConfig: string[] = [];
  if (cfg.agents?.ownership !== undefined && nextAgentsConfig?.ownership === undefined) {
    removedConfig.push("agents.ownership");
  } else if (cfg.agents?.ownership === undefined && nextAgentsConfig?.ownership !== undefined) {
    insertedConfig.push({ path: "agents.ownership", value: nextAgentsConfig.ownership });
  }
  if (transitionPinnedConfig !== workspacePinnedConfig) {
    insertedConfig.push({
      path: "agents.defaults.authInheritance.agentId",
      value: transitionPinnedConfig.agents?.defaults?.authInheritance?.agentId,
    });
  }
  if (sessionStorePinnedConfig !== transitionPinnedConfig) {
    insertedConfig.push({
      path: "agents.defaults.sessionStore.agentId",
      value: sessionStorePinnedConfig.agents?.defaults?.sessionStore?.agentId,
    });
  }
  insertedConfig.sort((left, right) => left.path.localeCompare(right.path));

  // Owner refs are cleared above, not filtered; fold them in so removedReferences is the complete
  // sorted list of everything this prune deleted for the agent (callers digest and block on it).
  removedReferences.push(...clearedOwnerRefs);
  removedReferences.sort();
  removedReferenceValues.sort((left, right) => left.path.localeCompare(right.path));

  return {
    config: sessionStorePinnedConfig,
    removedBindings: bindings.length - filteredBindings.length,
    removedAllow: allow.length - filteredAllow.length,
    clearedOwnerRefs,
    removedReferences,
    removedReferenceValues,
    removedConfig,
    insertedConfig,
  };
}
