// Coordinates paired-node reapproval requests before they enter pairing storage.
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { GatewayAuthRateLimitConfig } from "../config/types.gateway.js";
import {
  finalizeNodePairingCleanupClaim,
  requestNodePairing,
  reusePendingNodePairingForReconnect,
  type NodePairingCleanupClaim,
  type NodePairingRequestInput,
  type NodePairingSupersededRequest,
  type RequestNodePairingResult,
} from "../infra/device-pairing-node.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  AUTH_RATE_LIMIT_SCOPE_NODE_REAPPROVAL,
  buildRateLimitIdentityKey,
  createGatewayAuthRateLimiter,
  type RateLimitConfig,
} from "./auth-rate-limit.js";

const pendingNodeReapprovalAttempts = new KeyedAsyncQueue();

type ReapprovalRequestParams = {
  input: NodePairingRequestInput;
  cleanupClaim?: NodePairingCleanupClaim;
  baseDir?: string;
};

type QueuedRequest = {
  fingerprint: string;
  params: ReapprovalRequestParams;
  waiters: Deferred<RequestNodePairingResult | null>[];
};

type NodeRequestState = {
  queued?: QueuedRequest;
};

export type NodeReapprovalCoordinator = {
  request: (params: ReapprovalRequestParams) => Promise<RequestNodePairingResult | null>;
  finalizeCleanup: (claim: NodePairingCleanupClaim) => Promise<NodePairingSupersededRequest[]>;
  dispose: () => void;
};

function buildRequestFingerprint(input: NodePairingRequestInput): string {
  const permissions = input.permissions
    ? Object.fromEntries(
        Object.entries(input.permissions).toSorted(([left], [right]) => left.localeCompare(right)),
      )
    : undefined;
  return JSON.stringify({
    nodeId: input.nodeId.trim(),
    clientId: input.clientId,
    clientMode: input.clientMode,
    displayName: input.displayName,
    platform: input.platform,
    version: input.version,
    coreVersion: input.coreVersion,
    uiVersion: input.uiVersion,
    deviceFamily: input.deviceFamily,
    modelIdentifier: input.modelIdentifier,
    caps: input.caps && normalizeSortedUniqueTrimmedStringList(input.caps),
    commands: input.commands && normalizeSortedUniqueTrimmedStringList(input.commands),
    permissions,
    remoteIp: input.remoteIp,
    silent: Boolean(input.silent),
  });
}

/** Creates the gateway-lifetime owner for paired-node reapproval write limits. */
export function createNodeReapprovalCoordinator(
  config: RateLimitConfig | undefined,
  { scheduler }: { scheduler: GatewayScheduler },
): NodeReapprovalCoordinator & {
  updateConfig: (config?: GatewayAuthRateLimitConfig) => void;
} {
  const limiter = createGatewayAuthRateLimiter(
    { ...config, exemptLoopback: false },
    { scheduler, id: "auth/node-reapproval" },
  );
  const requestStates = new Map<string, NodeRequestState>();
  let disposed = false;

  const executeRequest = async ({
    input,
    cleanupClaim,
    baseDir,
  }: ReapprovalRequestParams): Promise<RequestNodePairingResult | null> => {
    if (disposed) {
      return null;
    }
    const reused = await reusePendingNodePairingForReconnect(input, cleanupClaim, baseDir);
    if (reused) {
      return reused;
    }

    const nodeId = input.nodeId.trim();
    const identityKey = buildRateLimitIdentityKey("node", nodeId);
    const rateCheck = limiter.check(identityKey, AUTH_RATE_LIMIT_SCOPE_NODE_REAPPROVAL);
    if (!rateCheck.allowed) {
      return null;
    }
    const result = await requestNodePairing(input, baseDir);
    limiter.recordFailure(identityKey, AUTH_RATE_LIMIT_SCOPE_NODE_REAPPROVAL);
    return result;
  };

  const enqueueRequest = (
    nodeId: string,
    state: NodeRequestState,
    initial?: QueuedRequest,
  ): void => {
    void pendingNodeReapprovalAttempts.enqueue(`node-reapproval:${nodeId}`, async () => {
      const queued = initial ?? state.queued;
      if (!initial) {
        state.queued = undefined;
      }
      if (!queued) {
        return;
      }
      try {
        const result = await executeRequest(queued.params);
        for (const [index, waiter] of queued.waiters.entries()) {
          waiter.resolve(index === 0 ? result : null);
        }
      } catch (error) {
        for (const waiter of queued.waiters) {
          waiter.reject(error);
        }
      } finally {
        if (requestStates.get(nodeId) === state && !state.queued) {
          requestStates.delete(nodeId);
        }
      }
    });
  };

  return {
    updateConfig: (next) => limiter.updateConfig({ ...next, exemptLoopback: false }),
    request(params) {
      if (disposed) {
        return Promise.resolve(null);
      }
      const nodeId = params.input.nodeId.trim();
      const fingerprint = buildRequestFingerprint(params.input);
      let state = requestStates.get(nodeId);
      const deferred = createDeferredCore<RequestNodePairingResult | null>();
      if (state?.queued?.fingerprint === fingerprint) {
        state.queued.params = params;
        state.queued.waiters.push(deferred);
      } else {
        const queued = { fingerprint, params, waiters: [deferred] };
        if (!state) {
          state = {};
          requestStates.set(nodeId, state);
          enqueueRequest(nodeId, state, queued);
        } else {
          const previous = state.queued;
          state.queued = queued;
          if (previous) {
            for (const waiter of previous.waiters) {
              waiter.resolve(null);
            }
          } else {
            enqueueRequest(nodeId, state);
          }
        }
      }
      return deferred.promise;
    },
    async finalizeCleanup(claim) {
      return await pendingNodeReapprovalAttempts.enqueue(
        `node-reapproval:${claim.nodeId}`,
        async () => await finalizeNodePairingCleanupClaim(claim),
      );
    },
    dispose() {
      disposed = true;
      for (const state of requestStates.values()) {
        for (const waiter of state.queued?.waiters ?? []) {
          waiter.resolve(null);
        }
      }
      requestStates.clear();
      limiter.dispose();
    },
  };
}
