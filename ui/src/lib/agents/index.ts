import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsListResult,
  GatewayAgentRow,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorReadAccess, hasOperatorSelfReadAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../format-error.ts";
import type { GatewayConnectionSnapshot } from "../gateway-connection-lifecycle.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import { createAgentCreationRecovery, type AgentCreationResult } from "./creation-recovery.ts";
import type { AgentsPanel } from "./panels.ts";
import type { ToolsEffectiveModelState } from "./tools-effective.ts";

export type { AgentsPanel } from "./panels.ts";
export { watchAgentScope } from "./watch-agent-scope.ts";
export { watchSelectedAgent } from "./watch-selected-agent.ts";

export type AgentsState = ToolsEffectiveModelState &
  AgentCapabilityState & {
    requestGeneration: number;
    agentsSelectedId: string | null;
    sessionKey?: string;
    agentsPanel?: AgentsPanel;
  };

type AgentGateway = {
  readonly snapshot: GatewayConnectionSnapshot &
    Partial<Pick<ApplicationGatewaySnapshot, "hello" | "selfUser">>;
  readonly connectionRevision?: number;
  subscribe: (listener: (snapshot: AgentGateway["snapshot"]) => void) => () => void;
};

export type AgentReadOutcome<T> =
  | { result: T | null; error?: never }
  | { error: string; result?: never };

type AgentRead<T> = ReturnType<typeof Promise.withResolvers<AgentReadOutcome<T> | null>>;

type AgentFilesStatus = {
  list: AgentsFilesListResult | null;
  readonly loading: boolean;
  read: Promise<AgentReadOutcome<AgentsFilesListResult> | null> | null;
};

type AgentFilesRequestStatus = AgentFilesStatus & {
  request: AgentRead<AgentsFilesListResult> | null;
};

type AgentCapabilityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
  pendingAgent?: GatewayAgentRow;
  recentlyCreatedAgentId?: string;
};

export type AgentCapability = ReturnType<typeof createAgentCapability>;

function resolveAgentReadErrorMessage(
  err: unknown,
  target: "agent list" | "effective tools",
): string {
  return isMissingOperatorReadScopeError(err)
    ? formatMissingOperatorReadScopeMessage(target)
    : formatUiError(err);
}

export { buildToolsEffectiveRequestKey } from "./tools-effective.ts";

export async function readToolsEffective(
  client: GatewayBrowserClient,
  params: { agentId: string; sessionKey: string },
) {
  try {
    return await client.request<ToolsEffectiveResult>("tools.effective", params);
  } catch (error) {
    throw new Error(resolveAgentReadErrorMessage(error, "effective tools"), { cause: error });
  }
}

function emptyAgentFilesStatus(): AgentFilesRequestStatus {
  return {
    list: null,
    get loading() {
      return this.request !== null;
    },
    read: null,
    request: null,
  };
}

export function createAgentCapability(gateway: AgentGateway) {
  let presentationKey = gatewayPresentationScope(gateway).key;
  let agentsRequest: AgentRead<AgentsListResult> | null = null;
  let listRead: Promise<AgentReadOutcome<AgentsListResult> | null> | null = null;
  const state: AgentCapabilityState = {
    client: gateway.snapshot.client,
    connected: gateway.snapshot.phase === "connected",
    get agentsLoading() {
      return agentsRequest !== null;
    },
    agentsError: null,
    agentsList: null,
  };
  const files = new Map<string, AgentFilesRequestStatus>();
  const listeners = new Set<(state: AgentCapabilityState) => void>();
  let disposed = false;
  const creations = createAgentCreationRecovery();

  const retireAgentsRequest = () => {
    // A closed connection can leave its transport pending; release native readers immediately.
    agentsRequest?.resolve(null);
    agentsRequest = null;
  };
  const retireFileRequests = () => {
    for (const status of files.values()) {
      status.request?.resolve(null);
      status.request = null;
      status.read = null;
    }
  };

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const fileStatus = (agentId: string): AgentFilesRequestStatus => {
    const existing = files.get(agentId);
    if (existing) {
      return existing;
    }
    const next = emptyAgentFilesStatus();
    files.set(agentId, next);
    return next;
  };

  const loadList = async (force: boolean): Promise<AgentsListResult | null> => {
    const client = state.client;
    if (!client || !state.connected || disposed) {
      return state.agentsList;
    }
    if (agentsRequest && !force) {
      return (await agentsRequest.promise)?.result ?? null;
    }
    if (state.agentsList && !state.agentsError && !force) {
      return state.agentsList;
    }
    const createdWhenRequested = state.recentlyCreatedAgentId;
    retireAgentsRequest();
    const request = Promise.withResolvers<AgentReadOutcome<AgentsListResult> | null>();
    agentsRequest = request;
    listRead = request.promise;
    state.agentsError = null;
    const complete = (outcome: AgentReadOutcome<AgentsListResult>) => {
      agentsRequest = null;
      request.resolve(outcome);
      publish();
    };
    publish();
    void client
      // New Session reads the placement policy from this roster instead of a second request.
      .request<AgentsListResult>("agents.list", { includeSessionPlacement: true })
      .then(
        (result) => {
          if (agentsRequest === request) {
            if (
              state.recentlyCreatedAgentId &&
              state.recentlyCreatedAgentId !== createdWhenRequested &&
              !result.agents.some((agent) => agent.id === state.recentlyCreatedAgentId)
            ) {
              // Keep the original caller awaiting the roster that includes the confirmed creation.
              agentsRequest = null;
              void loadList(true).then((refreshed) => request.resolve({ result: refreshed }));
              return;
            }
            state.agentsList = result;
            complete({ result });
          }
        },
        (err: unknown) => {
          if (agentsRequest === request) {
            if (isMissingOperatorReadScopeError(err)) {
              state.agentsList = null;
              retireFileRequests();
              files.clear();
            }
            state.agentsError = resolveAgentReadErrorMessage(err, "agent list");
            complete({ error: state.agentsError });
          }
        },
      );
    return (await request.promise)?.result ?? null;
  };

  const loadFiles = async (
    rawAgentId: string,
    force: boolean,
  ): Promise<AgentsFilesListResult | null> => {
    const agentId = normalizeOptionalString(rawAgentId);
    const client = state.client;
    if (!agentId || !client || !state.connected || disposed) {
      return agentId ? (files.get(agentId)?.list ?? null) : null;
    }
    const status = fileStatus(agentId);
    if (status.list && !force) {
      return status.list;
    }
    if (status.request && !force) {
      return (await status.request.promise)?.result ?? null;
    }
    status.request?.resolve(null);
    const request = Promise.withResolvers<AgentReadOutcome<AgentsFilesListResult> | null>();
    status.request = request;
    status.read = request.promise;
    const complete = (outcome: AgentReadOutcome<AgentsFilesListResult>) => {
      status.request = null;
      request.resolve(outcome);
      publish();
    };
    publish();
    void client.request<AgentsFilesListResult | null>("agents.files.list", { agentId }).then(
      (result) => {
        if (status.request === request) {
          if (result) {
            status.list = result;
          }
          complete({ result: status.list });
        }
      },
      (err: unknown) => {
        if (status.request === request) {
          complete({ error: formatUiError(err) });
        }
      },
    );
    return (await request.promise)?.result ?? null;
  };

  // Retire cached agent and file reads when connection or access authority changes.
  const stopGateway = gateway.subscribe((snapshot) => {
    const hadList = state.agentsList !== null;
    const clientChanged = state.client !== snapshot.client;
    const nextPresentationKey = gatewayPresentationScope(gateway).key;
    const identityChanged = clientChanged || presentationKey !== nextPresentationKey;
    presentationKey = nextPresentationKey;
    const connected = snapshot.phase === "connected";
    const connectionChanged = identityChanged || state.connected !== connected;
    const accessLost = connected && !hasOperatorSelfReadAccess(snapshot.hello?.auth ?? null);
    const filesAccessLost =
      connected && files.size > 0 && !hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    state.client = snapshot.client;
    state.connected = connected;
    if ((connectionChanged && (identityChanged || !connected)) || accessLost) {
      state.pendingAgent = undefined;
      state.recentlyCreatedAgentId = undefined;
      retireAgentsRequest();
      retireFileRequests();
      if (identityChanged || accessLost) {
        files.clear();
        state.agentsList = null;
        state.agentsError = null;
        listRead = null;
      }
    }
    if (filesAccessLost) {
      retireFileRequests();
      files.clear();
    }
    if (connectionChanged || accessLost || filesAccessLost) {
      publish();
      if (connectionChanged && connected && !accessLost) {
        if (!agentsRequest && (hadList || (identityChanged && listeners.size > 0))) {
          void loadList(true);
        }
        if (!identityChanged) {
          for (const [agentId, status] of files) {
            if (status.list && !status.request) {
              void loadFiles(agentId, true);
            }
          }
        }
      }
    }
  });

  return {
    get state() {
      return state;
    },
    get listRead() {
      return listRead;
    },
    ensureList: () => loadList(false),
    refreshList: () => loadList(true),
    async create(
      name: string,
      onStarted?: (agentId: string) => void,
      identity?: { avatar?: string },
    ): Promise<AgentCreationResult | null> {
      const client = state.client;
      if (!client || !state.connected || disposed || state.pendingAgent) {
        return null;
      }
      const attempt = creations.prepare(client, name, identity?.avatar);
      const { agentId } = attempt;
      const pendingAgent = { id: agentId, name: attempt.name };
      const isCurrent = () =>
        !disposed &&
        state.client === client &&
        state.connected &&
        state.pendingAgent === pendingAgent;
      state.pendingAgent = pendingAgent;
      publish();
      try {
        // The UI can open a display-only chat immediately. Persistence still waits
        // for the new agent's own inference route to pass verification.
        onStarted?.(agentId);
        const { createAgentInRoster } = await import("./creation-recovery.runtime.ts");
        return await createAgentInRoster(state, () => loadList(false), attempt, isCurrent);
      } finally {
        if (state.pendingAgent === pendingAgent) {
          state.pendingAgent = undefined;
          publish();
        }
      }
    },
    files(agentId: string | null | undefined): AgentFilesStatus {
      const normalized = normalizeOptionalString(agentId);
      return normalized
        ? (files.get(normalized) ?? emptyAgentFilesStatus())
        : emptyAgentFilesStatus();
    },
    invalidateFiles(agentIds: readonly (string | null | undefined)[]) {
      let changed = false;
      for (const agentId of normalizeUniqueTrimmedStringList(agentIds)) {
        const status = files.get(agentId);
        if (status) {
          status.request?.resolve(null);
          status.request = null;
          files.delete(agentId);
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
    ensureFiles: (agentId: string) => loadFiles(agentId, false),
    refreshFiles: (agentId: string) => loadFiles(agentId, true),
    recordFile({ agentId, file }: AgentsFilesGetResult) {
      const status = fileStatus(agentId);
      if (!status.list) {
        // Reconnect/config invalidation can clear the list while an editor
        // remains open. Rebuild the full list after the confirmed operation.
        void loadFiles(agentId, true);
        return;
      }
      // A confirmed file result supersedes lists already in flight. Retain the
      // full canonical list so their awaiting callers can still read it.
      const entry = { ...file };
      delete entry.content;
      const entries = status.list.files;
      status.list = {
        ...status.list,
        files: entries.some((existing) => existing.name === entry.name)
          ? entries.map((existing) => (existing.name === entry.name ? entry : existing))
          : [...entries, entry],
      };
      status.request?.resolve({ result: status.list });
      status.request = null;
      status.read = null;
      publish();
    },
    subscribe(listener: (state: AgentCapabilityState) => void) {
      return registerListener(listeners, listener);
    },
    dispose() {
      disposed = true;
      stopGateway();
      listeners.clear();
      retireFileRequests();
      files.clear();
      creations.dispose();
      retireAgentsRequest();
    },
  };
}
