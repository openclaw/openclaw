import type { SessionsDescribeParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";
import {
  parseSessionChangedEvent,
  reconcileParsedSessionChangedRow,
  sessionChangedSnapshots,
} from "./session-row-reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRequestClient,
} from "./session-types.ts";

type Params = SessionsDescribeParams;
type Result = { session?: GatewaySessionRow | null };
type Read = {
  params: Params;
  scope: SessionConnectionScope;
  promise: Promise<Result>;
  result?: Result;
  issuedRow?: GatewaySessionRow;
  reusable: boolean;
};

const MAX_DESCRIBED_SESSIONS = 128;

function sampleRuntime(result: Result, previous?: GatewaySessionRow | null): Result {
  const session = result.session;
  if (session?.runtimeMs === undefined) {
    return result;
  }
  const sameSample =
    previous &&
    session.runtimeMs === previous.runtimeMs &&
    session.status === previous.status &&
    session.hasActiveRun === previous.hasActiveRun &&
    session.lastRunId === previous.lastRunId &&
    session.activeRunIds?.length === previous.activeRunIds?.length &&
    (session.activeRunIds?.every((runId, index) => runId === previous.activeRunIds?.[index]) ??
      true);
  return {
    ...result,
    session: {
      ...session,
      runtimeSampledAt: sameSample ? (previous.runtimeSampledAt ?? Date.now()) : Date.now(),
    },
  };
}

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
  // Certified event snapshots advance completed reads on the same connection.
  const describe = async (
    params: Params,
    options: { refresh?: boolean; timeoutMs?: number; client?: SessionRequestClient } = {},
  ): Promise<Result> => {
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
    const impliedAgentId = parseAgentSessionKey(params.key)?.agentId;
    const key = JSON.stringify([
      params.key,
      impliedAgentId && normalizeAgentId(impliedAgentId) === normalizeAgentId(params.agentId)
        ? undefined
        : params.agentId,
      params.includeDerivedTitles,
      params.includeLastMessage,
      options.timeoutMs,
    ]);
    const read = reads.get(key);
    if (read && current(read) && !options.refresh && (!read.result || host.canReuse())) {
      return read.result ?? read.promise;
    }
    reads.delete(key);
    const request = scope.client.request<Result>("sessions.describe", params, ...requestOptions);
    const pending: Read = {
      params,
      scope,
      promise: request,
      issuedRow: host.currentRow(params),
      reusable: host.canReuse(),
    };
    pending.promise = request.then(
      (response) => {
        const result = sampleRuntime(response);
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
    reads.set(key, pending);
    trim();
    return pending.promise;
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
        const target = parseSessionChangedEvent(snapshot);
        // References repeat content already received in the preceding full snapshot.
        return target && !target[0].isAncestorReference ? [target] : [];
      });
      if (!targets.length) {
        reads.clear();
        return;
      }
      for (const [key, read] of reads) {
        const agentId = parseAgentSessionKey(read.params.key)?.agentId ?? read.params.agentId;
        const target = targets.find(([info]) => {
          const targetAgentId = info.agentId ?? parseAgentSessionKey(info.key)?.agentId;
          return (
            areUiSessionKeysEquivalent(info.key, read.params.key) &&
            (!agentId ||
              !targetAgentId ||
              normalizeAgentId(targetAgentId) === normalizeAgentId(agentId))
          );
        });
        if (!target) {
          continue;
        }
        const previous = read.result?.session;
        const next =
          previous &&
          target[1].session &&
          target[0].sessionId === previous.sessionId &&
          !target[2].rowMode
            ? reconcileParsedSessionChangedRow(previous, target, { archivedFilter: "all" })
                .admittedRow
            : undefined;
        if (next) {
          // Full events include previews; omission clears them despite roster preservation.
          if (!read.params.includeDerivedTitles || target[2].derivedTitle === undefined) {
            delete next.derivedTitle;
          }
          if (!read.params.includeLastMessage || target[2].lastMessagePreview === undefined) {
            delete next.lastMessagePreview;
          }
          if (!read.params.includeLastMessage || target[2].lastAssistantMessage === undefined) {
            delete next.lastAssistantMessage;
          }
          read.result = sampleRuntime({ session: next }, previous);
        } else {
          reads.delete(key);
        }
      }
    },
  };
}
