import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveChannelResetConfig, resolveSessionResetType } from "../../config/sessions.js";
import {
  resolvePreparedSessionEntryResetFreshness,
  resolveSessionEntryResetFreshness,
} from "../../config/sessions/entry-freshness.js";
import type { SessionLifecycleTimestamps } from "../../config/sessions/lifecycle.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  isSubagentSessionKey,
  isCronSessionKey,
  isIncognitoSessionKey,
} from "../../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../../sessions/agent-harness-session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";
import { isDirectGatewayUserClient } from "./cron-creator-authority-admission.js";

/** Placement input stays pending until setup and the native writer admit it. */
export function isWorkerGoalChatAdmission(
  params: ChatSendAdmissionParams,
  current: { entry?: SessionEntry; canonicalKey: string },
  placement: WorkerSessionPlacementRecord | undefined,
  acpMeta: SessionEntry["acp"] | null,
): boolean {
  const { session, request, context, client } = params;
  return Boolean(
    request.goalOperation &&
    current.entry &&
    isDirectGatewayUserClient(client) &&
    placement?.executionMode === "remote-exec" &&
    placement.state !== "local" &&
    isDirectChatGoalSession({
      entry: current.entry,
      allowAborted:
        request.goalOperation?.action === "resume" && request.goalOperation.preserveBudget === true,
      acpMeta,
      requestedSessionId: session.requestedSessionId,
      sessionKey: current.canonicalKey,
    }) &&
    resolveEffectiveAgentRuntime({
      cfg: context.getRuntimeConfig(),
      agentId: session.agentId,
      sessionKey: current.canonicalKey,
      sessionEntry: current.entry,
      provider: session.resolvedSessionModel.provider,
      modelId: session.resolvedSessionModel.model,
    }) === "codex" &&
    getRegisteredAgentHarness("codex")?.harness.cloudPlacement?.mode === "remote-exec",
  );
}

export function isDirectChatGoalSession(params: {
  allowAborted?: boolean;
  entry?: SessionEntry;
  acpMeta: SessionEntry["acp"] | null;
  requestedSessionId?: string;
  sessionKey: string;
}): boolean {
  const entry = params.entry;
  return Boolean(
    entry?.sessionId &&
    params.sessionKey !== "global" &&
    (entry.abortedLastRun !== true || params.allowAborted === true) &&
    entry.archivedAt === undefined &&
    entry.initializationPending !== true &&
    entry.pendingFinalDelivery === undefined &&
    entry.pluginOwnerId === undefined &&
    entry.spawnedBy === undefined &&
    entry.subagentRole === undefined &&
    (entry.spawnDepth ?? 0) === 0 &&
    params.acpMeta == null &&
    entry.cronRunContinuation === undefined &&
    !isSubagentSessionKey(params.sessionKey) &&
    !isCronSessionKey(params.sessionKey) &&
    !isAcpSessionKey(params.sessionKey) &&
    !isAgentHarnessSessionKey(params.sessionKey) &&
    (params.requestedSessionId === undefined || params.requestedSessionId === entry.sessionId),
  );
}

/** Fresh local input commits before execution; other runtimes retain pending custody. */
export function isLocalChatInputAdmission(
  params: ChatSendAdmissionParams,
  current: {
    entry?: SessionEntry;
    canonicalKey: string;
    storePath: string;
    lifecycleTimestamps?: SessionLifecycleTimestamps;
  },
  initialEntry: SessionEntry | undefined,
  placement: WorkerSessionPlacementRecord | undefined,
  acpMeta: SessionEntry["acp"] | null,
): boolean {
  const { session, request, context } = params;
  const cfg = context.getRuntimeConfig();
  const entry = current.entry ?? initialEntry;
  if (
    cfg.cloudWorkers?.requiredProfile ||
    (placement && placement.state !== "local") ||
    !entry ||
    !isDirectChatGoalSession({
      entry,
      acpMeta,
      sessionKey: current.canonicalKey,
      requestedSessionId: session.requestedSessionId,
      allowAborted:
        request.goalOperation?.action === "resume" && request.goalOperation.preserveBudget === true,
    }) ||
    (entry.agentHarnessId !== undefined && entry.agentHarnessId !== OPENCLAW_AGENT_RUNTIME_ID)
  ) {
    return false;
  }
  if (initialEntry) {
    return true;
  }
  const freshnessScope = {
    agentId: session.agentId,
    now: Date.now(),
    resetOverride: resolveChannelResetConfig({
      sessionCfg: cfg.session,
      channel: sessionDeliveryChannel(current.entry),
    }),
    resetType: resolveSessionResetType({ sessionKey: current.canonicalKey }),
    sessionCfg: cfg.session,
    sessionKey: current.canonicalKey,
    storePath: current.storePath,
  };
  if (isIncognitoSessionKey(current.canonicalKey)) {
    return resolveSessionEntryResetFreshness(freshnessScope).state === "fresh";
  }
  if (!current.lifecycleTimestamps) {
    throw new Error("Chat session freshness was not prepared; retry.");
  }
  return (
    resolvePreparedSessionEntryResetFreshness(freshnessScope, entry, current.lifecycleTimestamps)
      .state === "fresh"
  );
}

export type PreparedGoalChatPlacement = {
  sessionId: string;
  facts: Awaited<ReturnType<WorkerSessionPlacementStore["prepareSessionPlacement"]>>;
};

/** Keep native placement facts borrowed until Goal admission consumes the current row. */
export async function withGoalChatPlacement(
  service: NonNullable<ChatSendAdmissionParams["context"]["workerSessionPlacementService"]>,
  sessionId: string,
  consume: (prepared: PreparedGoalChatPlacement) => Promise<void>,
): Promise<void> {
  if (!service.prepareSessionPlacement) {
    throw new Error("Worker placement admission reader is unavailable; retry.");
  }
  const facts = await service.prepareSessionPlacement(sessionId);
  try {
    await consume({ sessionId, facts });
  } finally {
    facts.release();
  }
}
