import type { AgentsListResult } from "../../api/types.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { formatUiError } from "../format-error.ts";
import { isGatewayMethodAdvertised } from "../gateway-methods.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import {
  readSessionCustomGroups,
  readSidebarSectionOrder,
  mergeSessionGroupDefaults,
  type SessionGroupSettings,
} from "./custom-groups.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionGateway,
  SessionGroupDefaultsStatus,
  SessionGroupMutationResult,
  SessionState,
} from "./session-capability.ts";

type SessionGroupCatalogHost = {
  connection: SessionConnectionOwner;
  agentId: () => string;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshRows: () => Promise<void>;
  retryDelayMs: (error: unknown) => number | null;
};

const LEGACY_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";
const GROUPS_LIST_METHOD = "sessions.groups.list";
const GROUPS_DEFAULTS_METHOD = "sessions.groups.defaults";

function readLegacyStoredGroups(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      getSafeLocalStorage()?.getItem(LEGACY_GROUPS_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((name): name is string => typeof name === "string")
              .map((name) => name.trim())
              .filter(Boolean),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function createSessionGroupCatalog(host: SessionGroupCatalogHost) {
  let agentRevision = 0;
  let loadedEpoch = -1;
  let loadGeneration = 0;
  let catalogGeneration = 0;
  let defaultsStatus: SessionGroupDefaultsStatus = "idle";
  let pendingLoad: Promise<readonly SessionGroupSettings[] | null> | null = null;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const invalidate = () => {
    loadedEpoch = -1;
    loadGeneration += 1;
    catalogGeneration += 1;
    pendingLoad = null;
    clearRetry();
    defaultsStatus = "loading";
    // Every invalidation publishes its generation, including back-to-back
    // events while the previous reload is still pending.
    host.publish({ ...host.readState() });
  };

  const reset = () => {
    agentRevision += 1;
    invalidate();
    publishCatalog([], [], "loading");
  };

  const dispose = () => {
    agentRevision += 1;
    loadedEpoch = -1;
    loadGeneration += 1;
    pendingLoad = null;
    clearRetry();
  };

  const publishCatalog = (
    groupSettings: readonly SessionGroupSettings[],
    sectionOrder: readonly string[],
    status: SessionGroupDefaultsStatus,
  ) => {
    const state = host.readState();
    const groups = groupSettings.map((group) => group.name);
    const groupsUnchanged =
      groups.length === state.groups.length &&
      groups.every((group, i) => group === state.groups[i]);
    const orderUnchanged =
      sectionOrder.length === state.sectionOrder.length &&
      sectionOrder.every((sectionId, i) => sectionId === state.sectionOrder[i]);
    const settingsUnchanged =
      groupSettings.length === state.groupSettings.length &&
      groupSettings.every((group, index) => {
        const current = state.groupSettings[index];
        return (
          current?.name === group.name &&
          current.position === group.position &&
          current.cwd === group.cwd &&
          current.worktree === group.worktree
        );
      });
    const statusChanged = defaultsStatus !== status;
    defaultsStatus = status;
    if (
      state.groupsAgentId !== host.agentId() ||
      !groupsUnchanged ||
      !settingsUnchanged ||
      !orderUnchanged ||
      statusChanged
    ) {
      host.publish({
        ...state,
        groupsAgentId: host.agentId(),
        groups: [...groups],
        groupSettings: [...groupSettings],
        sectionOrder: [...sectionOrder],
      });
    }
  };

  const finishMutationFailure = (current: boolean, error: unknown): SessionGroupMutationResult => {
    if (!current) {
      return "stale";
    }
    host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
    throw error;
  };

  const finishLoadFailure = (
    scope: SessionConnectionScope,
    generation: number,
    error: unknown,
    retry: boolean,
  ) => {
    if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
      return null;
    }
    if (defaultsStatus !== "unavailable") {
      defaultsStatus = "unavailable";
      host.publish({ ...host.readState() });
    }
    if (!retry) {
      return null;
    }
    loadedEpoch = -1;
    const delay = host.retryDelayMs(error);
    if (delay !== null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (host.connection.isCurrent(scope) && generation === loadGeneration) {
          void load();
        }
      }, delay);
    }
    return null;
  };

  const loadAttempt = async (
    scope: SessionConnectionScope,
    generation: number,
    advertised: boolean | null,
    agentId: string,
  ) => {
    try {
      const listed = await scope.client.request(GROUPS_LIST_METHOD, { agentId });
      if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
        return null;
      }
      let settings = readSessionCustomGroups(listed);
      let sectionOrder = readSidebarSectionOrder(listed);
      // Browser-local catalogs predate the gateway store and migrate exactly once.
      const legacy = readLegacyStoredGroups();
      if (
        legacy.length > 0 &&
        readSessionMethodAccess(host.snapshot(), {
          method: "sessions.groups.put",
          requiredScope: "operator.write",
        }).allowed
      ) {
        // Selection defaults can name the first agent even when system ownership
        // points elsewhere. Only the Gateway can identify the legacy destination.
        const ambient = await scope.client
          .request<{ agentId?: string }>(GROUPS_LIST_METHOD, {})
          .catch(() => null);
        if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
          return null;
        }
        if (ambient?.agentId === agentId) {
          // Doctor assigns names with members to those agents. Import only
          // orphan names after a complete scan of the current Gateway roster.
          const roster = await scope.client
            .request<AgentsListResult>("agents.list", {})
            .catch(() => null);
          if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
            return null;
          }
          let complete =
            roster !== null &&
            roster.agents.length <= 1000 &&
            roster.agents.some((agent) => agent.id === agentId);
          const assigned = new Set(settings.map((group) => group.name));
          if (complete && roster) {
            for (const agent of roster.agents) {
              if (agent.id === agentId) {
                continue;
              }
              const catalog = await scope.client
                .request(GROUPS_LIST_METHOD, { agentId: agent.id })
                .catch(() => null);
              if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
                return null;
              }
              if (catalog === null) {
                complete = false;
                break;
              }
              for (const group of readSessionCustomGroups(catalog)) {
                assigned.add(group.name);
              }
            }
          }
          if (complete) {
            const names = [
              ...settings.map((group) => group.name),
              ...legacy.filter((name) => !assigned.has(name)),
            ];
            if (names.length !== settings.length) {
              const put = await scope.client.request("sessions.groups.put", { agentId, names });
              if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
                return null;
              }
              settings = readSessionCustomGroups(put);
              sectionOrder = readSidebarSectionOrder(put);
            }
            try {
              getSafeLocalStorage()?.removeItem(LEGACY_GROUPS_STORAGE_KEY);
            } catch {
              // The gateway catalog is canonical even when browser cleanup fails.
            }
          }
        }
      }
      const defaultsAllowed =
        isGatewayMethodAdvertised(host.snapshot(), GROUPS_DEFAULTS_METHOD) === true &&
        readSessionMethodAccess(host.snapshot(), {
          method: GROUPS_DEFAULTS_METHOD,
          requiredScope: "operator.write",
        }).allowed;
      if (!defaultsAllowed) {
        publishCatalog(settings, sectionOrder, "ready");
        return settings;
      }
      // The path-free catalog is independently useful to the sidebar. Defaults
      // readiness only gates group-target routes and must not erase those names.
      publishCatalog(settings, sectionOrder, "loading");
      try {
        const defaults = await scope.client.request(GROUPS_DEFAULTS_METHOD, { agentId });
        if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
          return null;
        }
        settings = mergeSessionGroupDefaults(settings, defaults);
      } catch (error) {
        return finishLoadFailure(scope, generation, error, true);
      }
      publishCatalog(settings, sectionOrder, "ready");
      return settings;
    } catch (error) {
      // Gateways without feature metadata retain the legacy one-shot probe.
      return finishLoadFailure(scope, generation, error, advertised === true);
    }
  };

  /** Load once per selected agent and connection; explicitly absent features never probe. */
  const load = async () => {
    const agentId = host.agentId();
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    if (loadedEpoch === scope.epoch) {
      return pendingLoad ?? host.readState().groupSettings;
    }
    const advertised = isGatewayMethodAdvertised(host.snapshot(), GROUPS_LIST_METHOD);
    clearRetry();
    const generation = ++loadGeneration;
    loadedEpoch = scope.epoch;
    if (defaultsStatus !== "loading") {
      defaultsStatus = "loading";
      host.publish({ ...host.readState() });
    }
    if (advertised === false) {
      publishCatalog([], [], "ready");
      return [];
    }
    const promise = loadAttempt(scope, generation, advertised, agentId).finally(() => {
      if (pendingLoad === promise) {
        pendingLoad = null;
      }
    });
    pendingLoad = promise;
    return promise;
  };

  const publishPathFreeMutation = (
    groupSettings: readonly SessionGroupSettings[],
    sectionOrder: readonly string[],
  ) => {
    // Catalog mutations do not carry authoritative defaults. Retire any older
    // defaults read and keep group routes blocked until a fresh read completes.
    invalidate();
    publishCatalog(groupSettings, sectionOrder, "loading");
    void load();
  };

  const captureMutation = () => {
    const agentId = host.agentId();
    const issuedAgentRevision = agentRevision;
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    return {
      agentId,
      scope,
      isCurrent: () =>
        host.connection.isCurrent(scope) &&
        issuedAgentRevision === agentRevision &&
        agentId === host.agentId(),
    };
  };

  const put = async (
    names: readonly string[],
    sectionOrder?: readonly string[],
  ): Promise<SessionGroupMutationResult> => {
    const mutation = captureMutation();
    if (!mutation) {
      return "stale";
    }
    const { agentId, scope, isCurrent } = mutation;
    try {
      const result = await scope.client.request("sessions.groups.put", {
        agentId,
        names: [...names],
        ...(sectionOrder === undefined ? {} : { sectionOrder: [...sectionOrder] }),
      });
      if (!isCurrent()) {
        return "stale";
      }
      publishPathFreeMutation(
        mergeSessionGroupDefaults(readSessionCustomGroups(result), {
          defaults: host.readState().groupSettings,
        }),
        readSidebarSectionOrder(result),
      );
      return "completed";
    } catch (error) {
      return finishMutationFailure(isCurrent(), error);
    }
  };

  const rename = async (from: string, to: string): Promise<SessionGroupMutationResult> => {
    const mutation = captureMutation();
    if (!mutation) {
      return "stale";
    }
    const { agentId, scope, isCurrent } = mutation;
    try {
      const result = await scope.client.request("sessions.groups.rename", {
        agentId,
        name: from,
        to,
      });
      if (!isCurrent()) {
        return "stale";
      }
      const current = host.readState().groupSettings;
      const targetExists = current.some((group) => group.name === to);
      const renamedDefaults = current.flatMap((group) =>
        group.name === from ? (targetExists ? [] : [{ ...group, name: to }]) : [group],
      );
      publishPathFreeMutation(
        mergeSessionGroupDefaults(readSessionCustomGroups(result), { defaults: renamedDefaults }),
        readSidebarSectionOrder(result),
      );
      // Mutation response commits before a background member-row reconciliation.
      void host.refreshRows();
      return "completed";
    } catch (error) {
      return finishMutationFailure(isCurrent(), error);
    }
  };

  const remove = async (name: string): Promise<SessionGroupMutationResult> => {
    const mutation = captureMutation();
    if (!mutation) {
      return "stale";
    }
    const { agentId, scope, isCurrent } = mutation;
    try {
      const result = await scope.client.request("sessions.groups.delete", { agentId, name });
      if (!isCurrent()) {
        return "stale";
      }
      publishPathFreeMutation(
        mergeSessionGroupDefaults(readSessionCustomGroups(result), {
          defaults: host.readState().groupSettings,
        }),
        readSidebarSectionOrder(result),
      );
      void host.refreshRows();
      return "completed";
    } catch (error) {
      return finishMutationFailure(isCurrent(), error);
    }
  };

  const update = async (
    name: string,
    defaults: { cwd: string | null; worktree: boolean },
  ): Promise<SessionGroupMutationResult> => {
    const mutation = captureMutation();
    if (!mutation) {
      return "stale";
    }
    const { agentId, scope, isCurrent } = mutation;
    try {
      const result = await scope.client.request("sessions.groups.update", {
        agentId,
        name,
        ...defaults,
      });
      if (!isCurrent()) {
        return "stale";
      }
      const state = host.readState();
      const pathFreeGroups = state.groupSettings.map(({ name: groupName, position }) => ({
        name: groupName,
        position,
      }));
      publishCatalog(
        mergeSessionGroupDefaults(pathFreeGroups, result),
        state.sectionOrder,
        "ready",
      );
      return "completed";
    } catch (error) {
      return finishMutationFailure(isCurrent(), error);
    }
  };

  return {
    delete: remove,
    dispose,
    generation: () => catalogGeneration,
    agentGeneration: () => agentRevision,
    invalidate,
    load,
    put,
    rename,
    reset,
    status: () => defaultsStatus,
    update,
  };
}
