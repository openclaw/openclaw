import {
  GatewayProtocolRequestTimeoutError,
  getGatewaySessionMessageSubscriptionCoordinator,
  releaseGatewaySessionMessageSubscription,
  resetGatewaySessionMessageSubscriptionCoordinator,
} from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestSessionRecovery } from "./recover.ts";
import type {
  SessionCompactResult,
  SessionCapability,
  SessionConnectionOwner,
  SessionMessageSubscription,
  SessionRefreshOutcome,
} from "./session-capability.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "./session-key.ts";
import {
  requestSessionBranchSwitch,
  requestSessionBranches,
  requestSessionCompact,
  requestSessionFile,
  requestSessionFilesList,
  requestSessionFileSet,
  requestSessionFork,
  requestSessionRewind,
} from "./session-requests.ts";

type SessionScopedOperationsHost = {
  connection: SessionConnectionOwner;
  reconcileMutation: (agentId?: string | null) => Promise<SessionRefreshOutcome>;
  notifyCreated: (key: string) => void;
  reportError: (error: unknown) => void;
};

const retiredFailedSubscriptionRecoveries = new WeakSet<AggregateError>();

export function createSessionScopedOperations(host: SessionScopedOperationsHost) {
  const ownedSubscriptions = new Set<SessionMessageSubscription>();

  const recover = async (params: { key: string; agentId?: string }) => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const result = await requestSessionRecovery(scope.client, params);
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      host.notifyCreated(result.key);
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
    const result = await requestSessionCompact(scope.client, key, options);
    if (!host.connection.isCurrent(scope)) {
      throw new Error("Session compaction completed on a replaced Gateway connection");
    }
    return result;
  };

  const requestCurrent = async <T>(
    request: (client: GatewayBrowserClient) => Promise<T>,
  ): Promise<T | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const result = await request(scope.client);
    return host.connection.isCurrent(scope) ? result : null;
  };

  const listFiles: SessionCapability["listFiles"] = (key, options = {}) =>
    requestCurrent((client) => requestSessionFilesList(client, key, options));

  const getFile: SessionCapability["getFile"] = (key, path, options = {}) =>
    requestCurrent((client) => requestSessionFile(client, key, path, options));

  const setFile: SessionCapability["setFile"] = (key, path, content, options) =>
    requestCurrent((client) => requestSessionFileSet(client, key, path, content, options));

  const unsubscribeMessages = async (subscription: SessionMessageSubscription): Promise<void> => {
    await releaseGatewaySessionMessageSubscription(subscription);
    ownedSubscriptions.delete(subscription);
  };

  const subscribeMessages = async (
    key: string,
    options: { agentId?: string | null; includeApprovals?: boolean } = {},
  ): Promise<SessionMessageSubscription> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session message subscription requires an active Gateway connection");
    }
    const normalizedKey = key.trim();
    const agentId = options.agentId?.trim() ? normalizeAgentId(options.agentId) : null;
    const subscription = await getGatewaySessionMessageSubscriptionCoordinator(scope.client, {
      keysEquivalent: areUiSessionKeysEquivalent,
    })
      .acquire(normalizedKey, {
        agentId,
        ...(options.includeApprovals ? { includeApprovals: true } : {}),
      })
      .catch((error: unknown) => {
        if (
          error instanceof AggregateError &&
          error.errors[0] instanceof GatewayProtocolRequestTimeoutError &&
          error.errors[0].requestSent &&
          host.connection.isCurrent(scope) &&
          !retiredFailedSubscriptionRecoveries.has(error)
        ) {
          // Failed compensation cannot prove privileged observers were removed;
          // closing their owning socket invokes authoritative Gateway cleanup.
          retiredFailedSubscriptionRecoveries.add(error);
          scope.client.forceReconnect("session subscription recovery failed");
        }
        throw error;
      });
    ownedSubscriptions.add(subscription);
    if (!host.connection.isCurrent(scope)) {
      await unsubscribeMessages(subscription).catch(() => undefined);
      throw new Error("Session message subscription completed on a replaced Gateway connection");
    }
    return subscription;
  };

  const requestCommittedMutation = async <T>(
    disconnectedError: string,
    request: (client: GatewayBrowserClient) => Promise<T>,
    agentId?: string | null,
  ): Promise<T> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error(disconnectedError);
    }
    const result = await request(scope.client);
    // The gateway response commits destructive work; refresh is connection-scoped
    // best effort and must never turn that commit into uncertainty or a retry.
    if (host.connection.isCurrent(scope)) {
      await host.reconcileMutation(agentId).catch(() => {});
    }
    return result;
  };

  const rewind: SessionCapability["rewind"] = (key, entryId, options = {}) =>
    requestCommittedMutation(
      "Session rewind requires an active Gateway connection",
      (client) => requestSessionRewind(client, key, entryId, options),
      options.agentId,
    );

  const forkAtMessage: SessionCapability["forkAtMessage"] = (key, entryId, options = {}) =>
    requestCommittedMutation(
      "Session fork requires an active Gateway connection",
      (client) => requestSessionFork(client, key, entryId, options),
      options.agentId,
    );

  const listBranches: SessionCapability["listBranches"] = async (key, options = {}) =>
    (await requestCurrent((client) => requestSessionBranches(client, key, options))) ?? [];

  const switchBranch: SessionCapability["switchBranch"] = (key, leafEntryId, options = {}) =>
    requestCommittedMutation(
      "Session branch switch requires an active Gateway connection",
      (client) => requestSessionBranchSwitch(client, key, leafEntryId, options),
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
        resetGatewaySessionMessageSubscriptionCoordinator(previousClient);
      }
      ownedSubscriptions.clear();
    },
    dispose: () => {
      for (const subscription of ownedSubscriptions) {
        void unsubscribeMessages(subscription).catch(() => undefined);
      }
    },
  };
}
