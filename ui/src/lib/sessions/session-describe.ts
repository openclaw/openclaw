import type { GatewaySessionRow } from "../../api/types.ts";
import type {
  SessionCapability,
  SessionConnectionOwner,
  SessionConnectionScope,
} from "./session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";
import {
  parseSessionChangedEvent,
  readSessionChangedEvent,
  sessionChangedSnapshots,
} from "./session-row-reconcile.ts";

type Params = Parameters<SessionCapability["describe"]>[0];
type Result = Awaited<ReturnType<SessionCapability["describe"]>>;
type Read = {
  params: Params;
  scope: SessionConnectionScope;
  promise: Promise<Result>;
  result?: Result;
  issuedRow?: GatewaySessionRow;
  reusable: boolean;
};

const MAX_DESCRIBED_SESSIONS = 128;

/** Descriptor completeness belongs to the read owner, not to partial roster snapshots. */
export function createSessionDescribeReads(host: {
  connection: SessionConnectionOwner;
  canReuse: () => boolean;
  currentRow: (params: Params) => GatewaySessionRow | undefined;
}) {
  const reads = new Map<string, Read>();
  const trim = () => {
    // Pending requests keep their subscribers; only completed reads consume the reuse budget.
    for (const [key, read] of reads) {
      if (reads.size <= MAX_DESCRIBED_SESSIONS) {
        break;
      }
      if (read.result) {
        reads.delete(key);
      }
    }
  };
  const current = (read: Read) => {
    if (!host.connection.isCurrent(read.scope)) {
      return false;
    }
    const held = host.currentRow(read.params);
    const described = read.result ? read.result.session : read.issuedRow;
    return (
      !held ||
      Boolean(
        described &&
        held.sessionId === described.sessionId &&
        (held.updatedAt ?? 0) <= (described.updatedAt ?? 0),
      )
    );
  };
  const describe: SessionCapability["describe"] = async (params, options = {}) => {
    const scope = host.connection.capture();
    const requestOptions: [] | [{ timeoutMs: number }] =
      options.timeoutMs === undefined ? [] : [{ timeoutMs: options.timeoutMs }];
    if (!scope || (options.client && options.client !== scope.client)) {
      // Placement settlement retains its initiating client across a UI reconnect.
      // Its explicit fresh read must never enter the replacement connection's cache.
      if (options.refresh && options.client) {
        return options.client.request<Result>("sessions.describe", params, ...requestOptions);
      }
      throw new Error("gateway not connected");
    }
    const key = JSON.stringify([
      params.key,
      params.agentId,
      params.includeDerivedTitles,
      params.includeLastMessage,
      options.timeoutMs,
    ]);
    let read = reads.get(key);
    if (read && (!current(read) || options.refresh || (!host.canReuse() && read.result))) {
      reads.delete(key);
      read = undefined;
    }
    if (!read) {
      const request = scope.client.request<Result>("sessions.describe", params, ...requestOptions);
      const pending: Read = {
        params: { ...params },
        scope,
        promise: request,
        issuedRow: host.currentRow(params),
        reusable: host.canReuse(),
      };
      pending.promise = request.then(
        (response) => {
          const result =
            response.session?.runtimeMs === undefined
              ? response
              : {
                  ...response,
                  session: { ...response.session, runtimeSampledAt: Date.now() },
                };
          if (reads.get(key) === pending && host.connection.isCurrent(scope)) {
            pending.result = result;
            if (!pending.reusable || !host.canReuse() || !current(pending)) {
              reads.delete(key);
            }
            trim();
          }
          return result;
        },
        (error: unknown) => {
          if (reads.get(key) === pending) {
            reads.delete(key);
          }
          throw error;
        },
      );
      read = pending;
      reads.set(key, read);
      trim();
    }
    return read.promise;
  };

  return {
    describe,
    clear: () => reads.clear(),
    invalidateEvent(payload: unknown) {
      const completeAncestors = Array.isArray(
        parseSessionChangedEvent(payload)?.[1].ancestorSessions,
      );
      // An unlisted ancestor can belong to another agent or sit outside every
      // held roster. No descriptor from before an incomplete tree event is certified.
      if (!completeAncestors) {
        reads.clear();
        return;
      }
      const targets = sessionChangedSnapshots(payload).flatMap((snapshot) => {
        const target = readSessionChangedEvent(snapshot);
        return target ? [target] : [];
      });
      if (!targets.length) {
        reads.clear();
        return;
      }
      for (const [key, read] of reads) {
        const agentId = parseAgentSessionKey(read.params.key)?.agentId ?? read.params.agentId;
        if (
          targets.some((target) => {
            const targetAgentId = target.agentId ?? parseAgentSessionKey(target.key)?.agentId;
            return (
              areUiSessionKeysEquivalent(target.key, read.params.key) &&
              (!agentId ||
                !targetAgentId ||
                normalizeAgentId(targetAgentId) === normalizeAgentId(agentId))
            );
          })
        ) {
          reads.delete(key);
        }
      }
    },
  };
}
