import type { SessionResetBoundaryWrite } from "../../config/sessions/session-accessor.lifecycle-types.js";
import {
  createSessionResetBoundaryId,
  type SessionResetBoundaryRequest,
} from "../../config/sessions/session-reset-boundary-event.js";
import { createResetBoundaryTranscriptSource } from "../../gateway/session-end-transcript-reader.js";
import type {
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
  PluginHookSessionStartEvent,
} from "../../plugins/hook-types.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  attachSessionEndTranscriptSource,
  type SessionEndTranscriptSource,
} from "../../plugins/session-end-transcript.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";

type ReplySessionEndReason = Extract<
  PluginHookSessionEndReason,
  "new" | "reset" | "idle" | "daily" | "unknown"
>;

export function resolveExplicitSessionEndReason(
  matchedResetTriggerLower?: string,
): Extract<ReplySessionEndReason, "new" | "reset"> {
  return matchedResetTriggerLower === "/reset" ? "reset" : "new";
}

export function createReplySessionResetBoundary(params: {
  cwd: string;
  explicitReason: Extract<SessionResetBoundaryRequest["reason"], "new" | "reset">;
  previousReason?: ReplySessionEndReason;
  resetTriggered: boolean;
}): SessionResetBoundaryWrite {
  const continuityReason =
    params.previousReason === "idle" || params.previousReason === "daily"
      ? params.previousReason
      : "reset";
  const request: SessionResetBoundaryRequest = params.resetTriggered
    ? { context: "clear", reason: params.explicitReason }
    : { context: "preserve-tail", reason: continuityReason };
  return {
    boundaryId: createSessionResetBoundaryId(),
    cwd: params.cwd,
    ...request,
  };
}

type SessionHookContext = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
};

function buildSessionHookContext(params: SessionHookContext): SessionHookContext {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  };
}

export function buildSessionStartHookPayload(
  params: SessionHookContext & PluginHookSessionStartEvent,
): {
  event: PluginHookSessionStartEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      resumedFrom: params.resumedFrom,
    },
    context: buildSessionHookContext(params),
  };
}

export function emitReplySessionStartHook(
  hookRunner: HookRunner,
  params: Parameters<typeof buildSessionStartHookPayload>[0],
): void {
  const payload = buildSessionStartHookPayload(params);
  // Lifecycle hooks outlive their requester; deferred plugin work must belong
  // to the detached scope that keeps the Gateway drain alive until completion.
  void runWithGatewayDetachedWorkContinuation(async () => {
    await runOutsideStoreWriterContext(() =>
      hookRunner.runSessionStart(payload.event, payload.context),
    );
  }, "hooks:session-start").catch(() => {});
}

export function buildSessionEndHookPayload(
  params: SessionHookContext &
    Partial<PluginHookSessionEndEvent> & {
      endedTranscript?: SessionEndTranscriptSource;
    },
): {
  event: PluginHookSessionEndEvent;
  context: SessionHookContext;
} {
  const context = buildSessionHookContext(params);
  attachSessionEndTranscriptSource(
    context,
    params.endedTranscript ?? { available: false, reason: "unsupported-source" },
  );
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageCount: params.messageCount ?? 0,
      durationMs: params.durationMs,
      reason: params.reason,
      sessionFile: params.sessionFile,
      transcriptArchived: params.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
    },
    context,
  };
}

export function emitReplySessionEndHook(params: {
  hookRunner: HookRunner;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  storePath: string;
  reason?: PluginHookSessionEndReason;
  nextSessionId?: string;
  resetBoundaryId?: string;
}): void {
  const endedTranscript = params.resetBoundaryId
    ? createResetBoundaryTranscriptSource(
        {
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        params.resetBoundaryId,
      )
    : { available: false as const, reason: "unsupported-source" as const };
  const payload = buildSessionEndHookPayload({ ...params, endedTranscript });
  void runWithGatewayDetachedWorkContinuation(async () => {
    await runOutsideStoreWriterContext(() =>
      params.hookRunner.runSessionEnd(payload.event, payload.context),
    );
  }, "hooks:session-end").catch(() => {});
}
