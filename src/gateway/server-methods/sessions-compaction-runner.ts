import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { PreparedCompactionSession } from "../../agents/embedded-agent-runner/run/compaction-accounting-bridge.js";
import { compactEmbeddedAgentSession } from "../../agents/embedded-agent.js";
import { resolveManualCompactionCliTarget } from "../../agents/session-runtime-compat.js";
import { preflightManualSessionCompaction } from "../../agents/sessions/manual-compaction-preflight.js";
import { sessionManagerOpenCompaction } from "../../agents/sessions/session-manager-core.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveCurrentSessionPrimaryConversation } from "../../config/sessions/conversation-registry.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readTranscriptStatsAsync } from "../../config/sessions/session-transcript-stats.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionModelRef } from "../session-utils.js";

type GatewaySessionCompactionParams = {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  abortSignal?: AbortSignal;
  runId?: string;
  sessionId: string;
  sessionKey: string;
  sessionStoreKey: string;
  storePath: string;
};

/** Prepare the legacy transcript once while the manual lifecycle owner is held. */
export async function prepareGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
): Promise<{
  entry?: InternalSessionEntry;
  preparedSession?: PreparedCompactionSession;
  reason?: "no transcript" | "Already compacted" | "Nothing to compact (session too small)";
}> {
  const transcriptTarget = {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  };
  const usesLegacyRuntime = (entry: SessionEntry) => {
    const resolvedModel = resolveSessionModelRef(params.cfg, entry, params.agentId);
    const persistedRuntime = resolveManualCompactionCliTarget({
      provider: resolvedModel.provider,
      entry,
      cfg: params.cfg,
    }).agentHarnessId;
    const contextEngine = params.cfg.plugins?.slots?.contextEngine?.trim();
    return (
      (!persistedRuntime || persistedRuntime === "openclaw") &&
      (!contextEngine || contextEngine === "legacy")
    );
  };
  if (!usesLegacyRuntime(params.entry)) {
    const entry = await readSessionEntryReadOnlyInWorker(transcriptTarget);
    const stats = await readTranscriptStatsAsync(transcriptTarget);
    return { entry, reason: stats.eventCount === 0 ? "no transcript" : undefined };
  }
  const prepared = await SessionManager[sessionManagerOpenCompaction](transcriptTarget, {
    signal: params.abortSignal,
  });
  const { entry, runtimeEntry, sessionManager } = prepared;
  if (!entry || !runtimeEntry) {
    return { entry };
  }
  const preparedSession = usesLegacyRuntime(entry)
    ? { ...prepared, entry: runtimeEntry }
    : undefined;
  if (prepared.eventCount === 0) {
    return { entry, preparedSession, reason: "no transcript" };
  }
  if (!preparedSession) {
    return { entry };
  }
  try {
    const preflight = preflightManualSessionCompaction(sessionManager.getBranch(), {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 0,
    });
    return { entry, preparedSession, reason: preflight.compactable ? undefined : preflight.reason };
  } catch {
    // Preserve the existing compaction error path for malformed transcripts.
    return { entry, preparedSession };
  }
}

export async function runGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
  host: Parameters<typeof compactEmbeddedAgentSession>[1],
): Promise<Awaited<ReturnType<typeof compactEmbeddedAgentSession>>> {
  // The lifecycle owner already selected and revalidated this exact current window.
  const transcriptTarget = {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  };
  const resolvedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: params.entry.spawnedBy,
      workspaceDir: params.entry.spawnedWorkspaceDir,
      cwd: params.entry.spawnedCwd,
    }) ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const compactionCliTarget = resolveManualCompactionCliTarget({
    provider: resolvedModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const primaryConversation = host?.preparedSession
    ? host.preparedSession.primaryConversation
    : await resolveCurrentSessionPrimaryConversation(transcriptTarget);
  params.abortSignal?.throwIfAborted();
  return await compactEmbeddedAgentSession(
    {
      abortSignal: params.abortSignal,
      contextEngineAgentId: params.agentId,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      sessionTarget: transcriptTarget,
      allowGatewaySubagentBinding: true,
      sessionFile: transcriptTarget.sessionKey,
      workspaceDir,
      cwd: normalizeOptionalString(params.entry.spawnedCwd),
      config: params.cfg,
      // Current delivery owns the account; origin can retain historical identity.
      // Group session keys do not carry an account themselves.
      agentAccountId:
        params.entry.delivery?.kind === "external"
          ? params.entry.delivery.context?.accountId
          : undefined,
      conversationRoutePeerId: primaryConversation?.routeContext?.peerId,
      chatType: primaryConversation?.kind,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      authProfileId:
        compactionCliTarget.cliSessionBinding?.authProfileId ?? params.entry.authProfileOverride,
      authProfileIdSource: resolveCollapsedSessionAuthPinSource(params.entry),
      agentHarnessId: compactionCliTarget.agentHarnessId,
      cliSessionId: compactionCliTarget.cliSessionId,
      cliSessionBinding: compactionCliTarget.cliSessionBinding,
      sessionEntry: params.entry,
      modelSelectionLocked: params.entry.modelSelectionLocked === true,
      thinkLevel: normalizeThinkLevel(params.entry.thinkingLevel),
      reasoningLevel: normalizeReasoningLevel(params.entry.reasoningLevel),
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      trigger: "manual",
    },
    host,
  );
}
