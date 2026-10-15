import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { retireSessionMcpRuntime } from "../agents/agent-bundle-mcp-tools.js";
import { clearFinishedSessionsForScopes } from "../agents/bash-process-registry.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../agents/embedded-agent-runner/runs.js";
import type { ReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import {
  clearSessionResetRuntimeState,
  prepareSessionResetCleanupGuard,
  SessionResetCleanupError,
  stopSessionResetSubagents,
} from "../auto-reply/reply/session-reset-cleanup.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { toAgentStoreSessionKey } from "../routing/session-key.js";
import { watchSessionResetMcpRetirement } from "./session-reset-mcp-retirement.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export async function ensureSessionRuntimeCleanup(params: {
  cfg: OpenClawConfig;
  key: string;
  target: GatewaySessionStoreTarget;
  sessionId?: string;
  sessionLifecycleRevision?: string;
  preserveReplyRun?: ReplyOperation;
  assertCurrent?: () => void;
}) {
  let cleanup: Awaited<ReturnType<typeof prepareSessionResetCleanupGuard>>;
  try {
    cleanup = await prepareSessionResetCleanupGuard({
      agentId: params.target.agentId,
      storePath: params.target.storePath,
      sessionKey: params.target.canonicalKey,
      expectedSession: params.sessionId
        ? { sessionId: params.sessionId, lifecycleRevision: params.sessionLifecycleRevision }
        : undefined,
      assertCurrent: params.assertCurrent,
    });
  } catch (error) {
    if (error instanceof SessionResetCleanupError) {
      return errorShape(ErrorCodes.UNAVAILABLE, error.message);
    }
    throw error;
  }
  const assertCurrent = cleanup.assertCurrent;
  using _ = { [Symbol.dispose]: cleanup.release };
  const queueKeys = [
    ...params.target.storeKeys,
    params.target.canonicalKey,
    params.sessionId,
  ].filter((key) => key !== undefined);
  const closeTrackedBrowserTabs = async () => {
    assertCurrent();
    await cleanupBrowserSessionsForLifecycleEnd({
      cfg: params.cfg,
      sessionKeys: [...queueKeys, params.key].map((requestKey) =>
        toAgentStoreSessionKey({ agentId: params.target.agentId, requestKey }),
      ),
      onWarn: (message) => logVerbose(message),
    });
    assertCurrent();
  };

  try {
    assertCurrent();
    await stopSessionResetSubagents({
      cfg: params.cfg,
      sessionKey: params.target.canonicalKey,
      agentId: params.target.agentId,
      assertCurrent,
    });
  } catch (error) {
    if (error instanceof SessionResetCleanupError) {
      return errorShape(ErrorCodes.UNAVAILABLE, error.message);
    }
    throw error;
  }
  // Parent admissions are already drained. Reject stale or incomplete child cleanup
  // before discarding queues or interrupting a newly accepted reply operation.
  assertCurrent();
  // Process scopes may use the requested alias, canonical key, or session id.
  // Clear only completed records so reset/delete cannot erase another scope's
  // output or hide a background process whose owner has not confirmed exit.
  clearFinishedSessionsForScopes([...queueKeys, params.key]);
  clearSessionResetRuntimeState(queueKeys, {
    activeReplySessionId: params.sessionId,
    preserveReplyRun: params.preserveReplyRun,
    agentId: params.target.agentId,
    sessionKey: params.target.canonicalKey,
    assertCurrent,
  });
  if (!params.sessionId) {
    assertCurrent();
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  const sessionId = params.sessionId;
  assertCurrent();
  const cleanupProviderResources = () => {
    try {
      cleanupSessionResources(sessionId);
    } catch (error) {
      logVerbose(
        `sessions cleanup: failed to dispose provider resources for ${sessionId}: ${String(error)}`,
      );
    }
  };
  const retireMcpRuntime = async (retainAcrossReuse: boolean) => {
    await retireSessionMcpRuntime({
      sessionId,
      reason: "gateway-session-cleanup",
      preserveActiveLeases: true,
      retainAcrossReuse,
      onError: (error, retiredSessionId) => {
        logVerbose(
          `sessions cleanup: failed to dispose bundle MCP runtime for ${retiredSessionId}: ${String(error)}`,
        );
      },
    });
  };
  // Register against the run being stopped before abort or any await allows a
  // later embedded or reply-backed run to replace it in the active registry.
  const mcpRetirementWatcher = watchSessionResetMcpRetirement({
    sessionId,
    embeddedAgent: { waitForEmbeddedAgentRunEnd, isEmbeddedAgentRunActive },
    retireMcpRuntime,
    cleanupProviderResources,
  });
  abortEmbeddedAgentRun(sessionId, { preserveReplyRun: params.preserveReplyRun });
  // Mark cleanup before waiting so the timeout path cannot strand MCP children.
  // Active tool/app leases keep in-flight work alive until their final release.
  await retireMcpRuntime(true);
  const ended = await waitForEmbeddedAgentRunEnd(sessionId, 15_000, params.preserveReplyRun);
  assertCurrent();
  // A stopping run can create or reuse its runtime while we wait. Retire again
  // after a clean stop; otherwise keep the required marker armed for late work.
  await retireMcpRuntime(!ended);
  assertCurrent();
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (ended && !isEmbeddedAgentRunActive(sessionId, params.preserveReplyRun)) {
    assertCurrent();
    if (!isEmbeddedAgentRunActive(sessionId)) {
      await mcpRetirementWatcher.cancel();
    }
    assertCurrent();
    cleanupProviderResources();
    await closeTrackedBrowserTabs();
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}
