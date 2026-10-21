import type {
  SessionsRecoverParams,
  SessionsRecoverResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SessionsBranchesListResult,
  SessionsBranchesSwitchResult,
  SessionsForkResult,
  SessionsRewindResult,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
  SessionWorkspaceSetResult,
} from "../../api/types.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "./session-key.ts";
import { buildSessionRequestParams } from "./session-requests.ts";
import type {
  SessionCompactResult,
  SessionConnectionOwner,
  SessionMessageSubscription,
  SessionRefreshOutcome,
} from "./session-types.ts";

type SessionScopedOperationsHost = {
  connection: SessionConnectionOwner;
  reconcileMutation: (agentId?: string | null) => Promise<SessionRefreshOutcome>;
  notifyCreated: (key: string) => void;
  reportError: (error: unknown) => void;
};

function buildTranscriptMutationParams(sessionKey: string, agentId?: string | null) {
  const { key, ...owner } = buildSessionRequestParams(sessionKey, agentId);
  return { sessionKey: key, ...owner };
}

type SubscriptionRuntime = typeof import("./session-message-subscriptions.runtime.ts");
let subscriptionRuntime: SubscriptionRuntime | undefined;
let subscriptionRuntimeLoading: Promise<SubscriptionRuntime> | undefined;

export function preloadSessionMessageSubscriptions(): Promise<SubscriptionRuntime> {
  return (subscriptionRuntimeLoading ??= import("./session-message-subscriptions.runtime.ts").then(
    (runtime) => (subscriptionRuntime = runtime),
    (error: unknown) => {
      subscriptionRuntimeLoading = undefined;
      throw error;
    },
  ));
}

export function createSessionScopedOperations(host: SessionScopedOperationsHost) {
  const ownedSubscriptions = new Set<SessionMessageSubscription>();
  let disposed = false;

  const recover = async (params: SessionsRecoverParams): Promise<SessionsRecoverResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const result = await scope.client.request<SessionsRecoverResult>("sessions.recover", params);
      if (!result?.key?.trim() || !result?.sessionId?.trim()) {
        throw new Error("sessions.recover returned no session identity");
      }
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      if (!areUiSessionKeysEquivalent(result.key, params.key)) {
        host.notifyCreated(result.key);
      }
      await host.reconcileMutation(params.agentId);
      return host.connection.isCurrent(scope) ? result : null;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.reportError(error);
      }
      return null;
    }
  };

  const compact = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionCompactResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session compaction requires an active Gateway connection");
    }
    const result = await scope.client.request<SessionCompactResult>(
      "sessions.compact",
      buildSessionRequestParams(key, options.agentId),
    );
    if (!host.connection.isCurrent(scope)) {
      throw new Error("Session compaction completed on a replaced Gateway connection");
    }
    return result;
  };

  const requestCurrent = async <T>(method: string, params: unknown): Promise<T | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const result = await scope.client.request<T>(method, params);
    return host.connection.isCurrent(scope) ? result : null;
  };

  const listFiles = (
    key: string,
    options: { agentId?: string | null; path?: string; search?: string } = {},
  ) =>
    requestCurrent<SessionWorkspaceListResult>("sessions.files.list", {
      sessionKey: key,
      path: options.path ?? "",
      search: options.search ?? "",
      ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
    });

  const getFile = (key: string, path: string, options: { agentId?: string | null } = {}) =>
    requestCurrent<SessionWorkspaceGetResult>("sessions.files.get", {
      sessionKey: key,
      path,
      ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
    });

  const setFile = (
    key: string,
    path: string,
    content: string,
    options: {
      agentId?: string | null;
      expectedHash: string;
      expectedSource?: SessionWorkspaceGetResult["source"];
    },
  ) =>
    requestCurrent<SessionWorkspaceSetResult>("sessions.files.set", {
      sessionKey: key,
      path,
      content,
      expectedHash: options.expectedHash,
      ...(options.expectedSource !== undefined ? { expectedSource: options.expectedSource } : {}),
      ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
    });

  const unsubscribeMessages = async (subscription: SessionMessageSubscription): Promise<void> => {
    const runtime = subscriptionRuntime ?? (await preloadSessionMessageSubscriptions());
    await runtime.releaseGatewaySessionMessageSubscription(subscription);
    ownedSubscriptions.delete(subscription);
  };

  const subscribeMessages = async (
    key: string,
    options: { agentId?: string | null; includeApprovals?: boolean; mode?: "narration" } = {},
  ): Promise<SessionMessageSubscription> => {
    const scope = host.connection.capture();
    if (!scope || disposed) {
      throw new Error("Session message subscription requires an active Gateway connection");
    }
    const normalizedKey = key.trim();
    const agentId = options.agentId?.trim() ? normalizeAgentId(options.agentId) : null;
    const { mode, includeApprovals } = options;
    const runtime = subscriptionRuntime ?? (await preloadSessionMessageSubscriptions());
    if (disposed || !host.connection.isCurrent(scope)) {
      throw new Error("Session message subscription completed on a replaced Gateway connection");
    }
    const subscription = await runtime
      .getGatewaySessionMessageSubscriptionCoordinator(scope.client, {
        keysEquivalent: areUiSessionKeysEquivalent,
      })
      .acquire(normalizedKey, {
        agentId,
        ...(includeApprovals ? { includeApprovals: true } : {}),
        ...(mode ? { mode } : {}),
      });
    ownedSubscriptions.add(subscription);
    if (disposed || !host.connection.isCurrent(scope)) {
      await unsubscribeMessages(subscription).catch(() => undefined);
      throw new Error("Session message subscription completed on a replaced Gateway connection");
    }
    return subscription;
  };

  const requestCommittedMutation = async <T>(
    disconnectedError: string,
    method: string,
    params: unknown,
    agentId?: string | null,
  ): Promise<T> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error(disconnectedError);
    }
    const result = await scope.client.request<T>(method, params);
    // The gateway response commits destructive work; refresh is connection-scoped
    // best effort and must never turn that commit into uncertainty or a retry.
    if (host.connection.isCurrent(scope)) {
      await host.reconcileMutation(agentId).catch(() => {});
    }
    return result;
  };

  const rewind = (key: string, entryId: string, options: { agentId?: string | null } = {}) =>
    requestCommittedMutation<SessionsRewindResult>(
      "Session rewind requires an active Gateway connection",
      "sessions.rewind",
      { ...buildTranscriptMutationParams(key, options.agentId), entryId },
      options.agentId,
    );

  const forkAtMessage = (key: string, entryId: string, options: { agentId?: string | null } = {}) =>
    requestCommittedMutation<SessionsForkResult>(
      "Session fork requires an active Gateway connection",
      "sessions.fork",
      { ...buildTranscriptMutationParams(key, options.agentId), entryId },
      options.agentId,
    );

  const listBranches = async (key: string, options: { agentId?: string | null } = {}) =>
    (
      await requestCurrent<SessionsBranchesListResult>(
        "sessions.branches.list",
        buildTranscriptMutationParams(key, options.agentId),
      )
    )?.branches ?? [];

  const switchBranch = (
    key: string,
    leafEntryId: string,
    options: { agentId?: string | null } = {},
  ) =>
    requestCommittedMutation<SessionsBranchesSwitchResult>(
      "Session branch switch requires an active Gateway connection",
      "sessions.branches.switch",
      { ...buildTranscriptMutationParams(key, options.agentId), leafEntryId },
      options.agentId,
    );

  return {
    compact,
    forkAtMessage,
    getFile,
    listBranches,
    listFiles,
    recover,
    rewind,
    setFile,
    subscribeMessages,
    switchBranch,
    unsubscribeMessages,
    retireConnection: (previousClient: GatewayBrowserClient | null) => {
      if (previousClient) {
        // No observer can be acquired before the runtime is installed and its
        // captured connection revalidated, so a pending import needs no reset.
        subscriptionRuntime?.resetGatewaySessionMessageSubscriptionCoordinator(previousClient);
      }
      ownedSubscriptions.clear();
    },
    dispose: () => {
      disposed = true;
      for (const subscription of ownedSubscriptions) {
        void unsubscribeMessages(subscription).catch(() => undefined);
      }
    },
  };
}
