import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { bindSupervisedRootSource } from "../../tasks/supervised-task.root-source.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { loadSessionEntry } from "../session-utils.js";
import { broadcastChatFinal } from "./chat-broadcast.js";
import { hasGatewayAdminScope } from "./chat-origin-routing.js";
import {
  hasRestartRecoveryTerminalRun,
  type RestartSafeChatTerminalState,
} from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Scope = {
  directExternal: boolean;
  internalOptions: boolean;
  isInternalCommand: boolean;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
};
export function isSupervisedChatRoot(params: Scope): boolean {
  const { request, session } = params;
  return Boolean(
    params.directExternal &&
    !params.internalOptions &&
    !params.isInternalCommand &&
    hasGatewayAdminScope(params.client) &&
    session.cfg.agents?.entries?.[session.agentId]?.taskSupervision?.enabled &&
    !session.entry?.spawnedBy &&
    !session.entry?.cronRunContinuation &&
    !request.systemInputProvenance &&
    !request.systemProvenanceReceipt &&
    !request.suppressCommandInterpretation &&
    !request.reconnectResumeRequested &&
    !request.goalOperation &&
    request.turnKind === "main" &&
    request.normalizedAttachments.length === 0,
  );
}

/** Must run before native injection or detached ordinary dispatch. Source
 * transcript materialization may create a restart claim; a committed task
 * handoff settles that source claim, never the independent task itself. */
export async function handoffSupervisedChatRoot(
  params: Scope & {
    ctx: RuntimeMsgContext;
    admission: AdmittedChatSend;
    context: GatewayRequestHandlerOptions["context"];
    respond: GatewayRequestHandlerOptions["respond"];
    recorder: UserTurnTranscriptRecorder;
    persistUserTurn: UserTurnTranscriptRecorder["persistFallback"];
    terminalizeRestartSafeAdmission: (state: RestartSafeChatTerminalState) => Promise<boolean>;
  },
): Promise<boolean> {
  if (!isSupervisedChatRoot(params)) {
    return false;
  }
  const { session, admission, context, request } = params;
  const assertCurrent = (materialized = true) => {
    admission.activeRunAbort.controller.signal.throwIfAborted();
    admission.assertWorkAdmissionCurrent();
    if (
      admission.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      session.sessionRoutingChanged(context.getRuntimeConfig())
    ) {
      throw new Error("Chat source lifecycle changed before supervised handoff");
    }
    // Resolve again after source creation: an absent-target authorization is not
    // reused as permission on a newly materialized session.
    const permission = resolveSessionMutationAuthorization({
      client: params.client,
      context,
      method: "chat.send",
      requestParams: request.p,
    });
    if (permission.error) {
      throw new Error("Chat supervision source authorization changed");
    }
    permission.authorization?.assertCurrent();
    const current = loadSessionEntry(session.sessionKey, session.sessionLoadOptions);
    const entry = current.entry ?? (!materialized ? admission.initialSessionEntry : undefined);
    if (
      current.storePath !== session.storePath ||
      current.canonicalKey !== session.sessionKey ||
      entry?.sessionId !== admission.admittedSessionId ||
      entry.archivedAt !== undefined
    ) {
      throw new Error("Chat supervision requires the exact current source session");
    }
  };
  assertCurrent(false);
  const persisted = await params.persistUserTurn();
  assertCurrent();
  // The pending-input receipt's state is a staging/replay observation, not a
  // live SQL projection. A fresh append consumes custody in the canonical
  // writer transaction and returns its exact committed transcript anchor.
  if (
    !persisted ||
    persisted.admission.sessionId !== admission.admittedSessionId ||
    persisted.admission.agentId !== session.agentId
  ) {
    throw new Error("Chat input custody was not consumed by its transcript owner");
  }
  const { provider, model } = session.resolvedSessionModel;
  const { maybeAdmitSupervisedRootTask } = await import("../../tasks/supervised-task.admission.js");
  assertCurrent();
  const disposition = await maybeAdmitSupervisedRootTask({
    config: session.cfg,
    source: bindSupervisedRootSource({
      config: session.cfg,
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      sessionId: admission.admittedSessionId,
      namespace: "gateway",
      inputId: session.clientRunId,
    }),
    message: params.ctx.RawBody ?? request.rawMessage,
    model: `${provider}/${model}`,
    ownerAuthorized: true,
    internal: false,
    assertCurrent,
  });
  if (disposition.kind === "ordinary") {
    return false;
  }
  assertCurrent();
  if (admission.restartSafeAdmission) {
    const settled = await params.terminalizeRestartSafeAdmission({
      retryable: false,
      status: "completed",
    });
    if (!settled) {
      const entry = loadSessionEntry(session.sessionKey, session.sessionLoadOptions).entry;
      if (!entry || !hasRestartRecoveryTerminalRun(entry, session.clientRunId)) {
        throw new Error("Supervised source handoff remains pending reconciliation");
      }
    }
  }
  assertCurrent();
  const summary =
    disposition.kind === "handled"
      ? disposition.message
      : "Task accepted for supervised continuation; its goal is not yet complete.";
  if (disposition.kind === "handled") {
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      expectedSessionId: admission.admittedSessionId,
      text: summary,
      idempotencyKey: `supervised-input:${session.clientRunId}`,
      config: session.cfg,
      updateMode: "file-only",
    });
    if (!appended.ok) {
      throw new Error("Supervised control response history remains pending");
    }
  }
  assertCurrent();
  const payload = {
    runId: session.clientRunId,
    status: "ok",
    summary,
    ...(disposition.flowId
      ? { supervisedTask: { flowId: disposition.flowId, episode: disposition.episode } }
      : {}),
  };
  setGatewayDedupeEntry({
    dedupe: context.dedupe,
    key: `chat:${session.clientRunId}`,
    entry: { ts: Date.now(), ok: true, payload },
  });
  params.respond(true, payload, undefined, { runId: session.clientRunId });
  broadcastChatFinal({
    context,
    runId: session.clientRunId,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    ...(disposition.kind === "handled"
      ? { message: { role: "assistant", content: [{ type: "text", text: summary }] } }
      : {}),
  });
  admission.cleanupAdmittedRun();
  clearAgentRunContext(session.clientRunId, admission.lifecycleGeneration);
  return true;
}
