import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { retireSessionMcpRuntime } from "../agents/agent-bundle-mcp-tools.js";
import { clearFinishedSessionsForScopes } from "../agents/bash-process-registry.js";
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
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export async function ensureSessionRuntimeCleanup(params: {
  cfg: OpenClawConfig;
  key: string;
  target: GatewaySessionStoreTarget;
  sessionId?: string;
  sessionLifecycleRevision?: string;
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
    controllerTarget: captureSessionTarget({
      storeScope: params.target.storePath,
      sessionKey: params.target.canonicalKey,
      aliases: params.target.storeKeys,
      agentId: params.target.agentId,
      incarnation: params.sessionId,
    }),
    activeReplySessionId: params.sessionId,
    agentId: params.target.agentId,
    sessionKey: params.target.canonicalKey,
    assertCurrent,
  });
  if (!params.sessionId) {
    assertCurrent();
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
  // The controller mutation already joined the actual turn and effect producers.
  // Retire resources only after that settlement, before admitting a successor.
  await retireSessionMcpRuntime({
    sessionId,
    reason: "gateway-session-cleanup",
    preserveActiveLeases: true,
    retainAcrossReuse: false,
    onError: (error, retiredSessionId) => {
      logVerbose(
        `sessions cleanup: failed to dispose bundle MCP runtime for ${retiredSessionId}: ${String(error)}`,
      );
    },
  });
  assertCurrent();
  cleanupProviderResources();
  await closeTrackedBrowserTabs();
  return undefined;
}
