import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  getRpcSourceIdentity,
  getRpcSourceStartedAt,
  isRpcSourceActive,
  listRpcSourceEntries,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { projectInFlightRunSnapshot, type InFlightRunSnapshot } from "./chat-inflight-snapshot.js";
import type { ChatRunState } from "./server-chat-state.js";
import { captureRpcSourceScopeMatcher, type SessionRuntimeScope } from "./session-runtime-scope.js";

/** Restore the newest visible run for this Gateway's physical session store. */
export function resolveInFlightRunSnapshot(
  params: SessionRuntimeScope & {
    chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs">;
    requestedSessionKey: string;
    canonicalSessionKey: string;
    agentId?: string;
    defaultAgentId?: string;
  },
): InFlightRunSnapshot | undefined {
  const matchesScope = captureRpcSourceScopeMatcher(params);
  const matchesKey = (entry: RpcSourceRef, key: string): boolean => {
    const identity = getRpcSourceIdentity(entry);
    if (identity.sessionKey !== key) {
      return false;
    }
    if (key !== "global") {
      return true;
    }
    const requestedAgentId =
      normalizeOptionalLowercaseString(params.agentId) ??
      normalizeOptionalLowercaseString(params.defaultAgentId);
    if (!requestedAgentId) {
      return false;
    }
    const runAgentId =
      normalizeOptionalLowercaseString(identity.agentId) ??
      normalizeOptionalLowercaseString(params.defaultAgentId);
    return runAgentId === requestedAgentId;
  };
  let best: { runId: string; startedAtMs: number } | undefined;
  for (const [runId, entry] of listRpcSourceEntries()) {
    if (
      !matchesScope(entry) ||
      !isRpcSourceActive(entry) ||
      entry.adapter.controlUiVisible === false ||
      entry.input.abortSignal.aborted ||
      entry.adapter.kind === "agent" ||
      (!matchesKey(entry, params.requestedSessionKey) &&
        !matchesKey(entry, params.canonicalSessionKey))
    ) {
      continue;
    }
    const startedAtMs = getRpcSourceStartedAt(entry) ?? 0;
    // Timestamp wins over insertion order; runId breaks ties deterministically.
    if (
      best === undefined ||
      startedAtMs > best.startedAtMs ||
      (startedAtMs === best.startedAtMs && runId > best.runId)
    ) {
      best = { runId, startedAtMs };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  // Adopt an active run before its first text so clients can reconcile its reply.
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId: best.runId,
    startedAtMs: best.startedAtMs,
  });
}
