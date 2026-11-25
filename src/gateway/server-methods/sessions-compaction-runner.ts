import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import type { PreparedCompactionSession } from "../../agents/embedded-agent-runner/run/compaction-accounting-bridge.js";
import { compactEmbeddedAgentSession } from "../../agents/embedded-agent.js";
import { NO_MODEL_CONFIGURED_MESSAGE } from "../../agents/model-selection-config.js";
import { resolveManualCompactionCliTarget } from "../../agents/session-runtime-compat.js";
import { preflightManualSessionCompaction } from "../../agents/sessions/manual-compaction-preflight.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveCurrentSessionPrimaryConversation } from "../../config/sessions/conversation-registry.js";
import { captureSessionActorTranscriptRead } from "../../config/sessions/session-actor-transcript-read.js";
import { readPreparedSessionCompactionInWorker } from "../../config/sessions/session-compaction-prepared.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readTranscriptStatsAsync } from "../../config/sessions/session-transcript-stats.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { resolveSessionSelectedModelRefAsync } from "../session-utils-model-selection.js";
import { prepareGatewaySessionEntryReader } from "../session-utils-store-lineage.js";

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

/** Select the model ordinary turns use, including one inherited from a parent session. */
async function resolveCompactionSessionModel(params: GatewaySessionCompactionParams) {
  const readSourceEntry = await prepareGatewaySessionEntryReader({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    entry: params.entry,
    store: {},
  });
  params.abortSignal?.throwIfAborted();
  return await resolveSessionSelectedModelRefAsync({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    source: { entry: params.entry, readSourceEntry },
    manifestPlugins: getGatewayPluginMetadataSnapshot() ?? [],
  });
}

/** Prepare eligibility and owner metadata without materializing a host transcript. */
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
  const resolvedModel = await resolveCompactionSessionModel(params);
  const usesLegacyRuntime = (entry: SessionEntry) => {
    const persistedRuntime = resolveManualCompactionCliTarget({
      provider: resolvedModel?.provider,
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
  const memory = captureSessionActorTranscriptRead(transcriptTarget, params.abortSignal);
  if (memory) {
    const sessionManager = await SessionManager.openAsync(
      memory.target,
      undefined,
      undefined,
      params.abortSignal,
    );
    const primaryConversation = await resolveCurrentSessionPrimaryConversation(memory.target);
    memory.assertCurrent();
    const entry = memory.currentEntry();
    if (!entry) {
      return { entry };
    }
    const preparedSession = usesLegacyRuntime(entry)
      ? {
          sessionTarget: memory.target,
          entry,
          primaryConversation,
          memoryTranscript: {
            sessionManager,
            sessionTarget: memory.target,
            assertActive: memory.assertCurrent,
          },
        }
      : undefined;
    let reason:
      | "no transcript"
      | "Already compacted"
      | "Nothing to compact (session too small)"
      | undefined;
    if (sessionManager.getPersistedEntries().length === 0) {
      reason = "no transcript";
    } else if (preparedSession) {
      try {
        const preflight = preflightManualSessionCompaction(sessionManager.getBranch(), {
          enabled: true,
          reserveTokens: 0,
          keepRecentTokens: 0,
        });
        if (!preflight.compactable) {
          reason = preflight.reason;
        }
      } catch {
        // Malformed preparation reaches the normal execution error owner.
      }
    }
    return { entry, preparedSession, reason };
  }
  const prepared = await readPreparedSessionCompactionInWorker(
    transcriptTarget,
    { kind: "preflight" },
    params.abortSignal,
  );
  if (prepared.status !== "preflight") {
    throw new Error("Expected compaction preflight facts");
  }
  const { entry, runtimeEntry, primaryConversation } = prepared;
  if (!entry || !runtimeEntry) {
    return { entry };
  }
  const preparedSession = usesLegacyRuntime(entry)
    ? {
        sessionTarget: prepared.sessionTarget,
        entry: runtimeEntry,
        primaryConversation,
        source: prepared.source,
      }
    : undefined;
  return {
    entry,
    preparedSession,
    reason:
      prepared.eventCount === 0 ? "no transcript" : preparedSession ? prepared.reason : undefined,
  };
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
  const resolvedModel = await resolveCompactionSessionModel(params);
  if (!resolvedModel) {
    return { ok: false, compacted: false, reason: NO_MODEL_CONFIGURED_MESSAGE };
  }
  // Capture the foreground window before a separate compaction.model is selected.
  const configuredWindow = floorPositiveFiniteNumber(
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      allowAsyncLoad: false,
    }),
  );
  const sessionWindow = floorPositiveFiniteNumber(params.entry.contextTokens);
  const contextTokenBudget =
    configuredWindow !== undefined && sessionWindow !== undefined
      ? Math.min(configuredWindow, sessionWindow)
      : (configuredWindow ?? sessionWindow);
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
      messageChannel: primaryConversation?.channel,
      skillsSnapshot: params.entry.skillsSnapshot,
      toolOverrides: params.entry.toolOverrides,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      contextTokenBudget,
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
