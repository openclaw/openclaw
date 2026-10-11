import { resolveAgentDir } from "../agents/agent-scope.js";
import { resetRegisteredAgentHarnessSessions } from "../agents/harness/registry.js";
import { acquireAgentRuntimeCleanupRegistries } from "../agents/prepared-model-runtime.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPluginHostCleanup } from "../plugins/host-hook-cleanup.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { closeAcpRuntimeForSession, closeChildAcpRuntimesForParent } from "./session-reset-acp.js";
import { ensureSessionRuntimeCleanup } from "./session-reset-runtime-cleanup.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export async function resetSessionAgentHarnesses(params: {
  cfg: OpenClawConfig;
  target: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey">;
  entry: SessionEntry;
  reason: "reset" | "deleted";
  assertCurrent?: () => void;
}): Promise<void> {
  const { agentId, canonicalKey: sessionKey } = params.target;
  params.assertCurrent?.();
  await using owners = await acquireAgentRuntimeCleanupRegistries(
    resolveAgentDir(params.cfg, agentId),
  );
  params.assertCurrent?.();
  await resetRegisteredAgentHarnessSessions(
    {
      agentId,
      sessionId: params.entry.sessionId,
      sessionKey,
      sessionFile: sessionKey,
      reason: params.reason,
    },
    owners.registries,
  );
  params.assertCurrent?.();
}

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  await getSessionBindingService().unbind({
    targetSessionKey: params.targetSessionKey,
    reason: params.reason,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

export async function cleanupSessionBeforeMutation(params: {
  cfg: OpenClawConfig;
  key: string;
  target: GatewaySessionStoreTarget;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
  assertCurrent?: () => void;
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    target: params.target,
    sessionId: params.entry?.sessionId,
    sessionLifecycleRevision: params.entry?.lifecycleRevision,
    assertCurrent: params.assertCurrent,
  });
  if (cleanupError) {
    return cleanupError;
  }
  const pluginCleanup = await runPluginHostCleanup({
    cfg: params.cfg,
    registry: getActivePluginRegistry(),
    reason: params.reason === "session-reset" ? "reset" : "delete",
    sessionKey: params.target.canonicalKey,
    // Unscoped keys can exist in several agent stores; this lifecycle owns only its target.
    sessionStoreTargets: [params.target],
    shouldCleanup: () => {
      params.assertCurrent?.();
      return true;
    },
  });
  params.assertCurrent?.();
  for (const failure of pluginCleanup.failures) {
    logVerbose(
      `plugin host cleanup failed for ${failure.pluginId}/${failure.hookId}: ${String(failure.error)}`,
    );
  }
  const parentSessionKey = params.target.canonicalKey;
  const parentAcpError = await closeAcpRuntimeForSession({
    cfg: params.cfg,
    sessionKey: parentSessionKey,
    agentId: params.target.agentId,
    fallbackSessionKeys: [params.canonicalKey, params.legacyKey, params.key],
    reason: params.reason,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  await closeChildAcpRuntimesForParent({
    cfg: params.cfg,
    parentKey: parentSessionKey,
    parentAgentId: params.target.agentId,
    reason: params.reason,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  if (parentAcpError) {
    return parentAcpError;
  }
  if (params.entry?.sessionId) {
    // Clear physical harness ownership after the old run drains but before the
    // store can expose a successor generation to a new turn.
    await resetSessionAgentHarnesses({
      cfg: params.cfg,
      target: params.target,
      entry: params.entry,
      reason: params.reason === "session-reset" ? "reset" : "deleted",
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
  }
  return undefined;
}
