import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import type {
  PersistedUserTurnMessage,
  UserTurnInput,
} from "../../sessions/user-turn-transcript.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import {
  buildDashboardSessionTitleSource,
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import { formatForLog } from "../ws-log.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { emitSessionTitleChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

type DashboardSessionTitleRequest = {
  admittedSessionId: string;
  entry?: Pick<SessionEntry, "lifecycleRevision">;
  agentId: string;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  request: Pick<NormalizedChatSendRequest, "normalizedAttachments" | "rawMessage"> &
    Partial<Pick<NormalizedChatSendRequest, "p">>;
  sessionKey: string;
  storePath: string;
  awaitingFirstMessage?: boolean;
  baseInput?: Pick<UserTurnInput, "display" | "excludeFromContext" | "provenance">;
  approvedInput?: Promise<PersistedUserTurnMessage>;
  approvedOpeningText?: string;
  inputFinished?: Promise<unknown>;
};

/** Prepare the existing title scheduler to wait for approved user input. */
export function makeApprovedChatDashboardSessionTitleRequest(
  params: StartChatDispatchParams,
  finalized: Promise<void>,
): DashboardSessionTitleRequest {
  const { request, session, admission, context } = params;
  return {
    admittedSessionId: admission.admittedSessionId,
    agentId: session.agentId,
    cfg: session.cfg,
    context,
    entry: session.entry,
    request,
    sessionKey: session.sessionKey,
    storePath: session.storePath,
    baseInput: params.userTurn.baseInput,
    approvedInput: params.titleInput,
    inputFinished: Promise.allSettled([admission.sourceRef.input.settlement.promise, finalized]),
  };
}

export function scheduleCreatedDashboardSessionTitle(
  created: {
    key: string;
    agentId: string;
    entry: SessionEntry;
    storePath: string;
    isNew: boolean;
  },
  cfg: OpenClawConfig,
  context: GatewayRequestContext,
  titleSource?: string,
): void {
  if (!created.isNew || created.entry.incognito || !titleSource) {
    return;
  }
  scheduleChatDashboardSessionTitle({
    admittedSessionId: created.entry.sessionId,
    entry: created.entry,
    awaitingFirstMessage: true,
    agentId: created.agentId,
    cfg,
    context,
    request: { rawMessage: titleSource, normalizedAttachments: [] },
    sessionKey: created.key,
    storePath: created.storePath,
  });
}

export function scheduleChatDashboardSessionTitle(
  params: DashboardSessionTitleRequest,
  retryAfter?: Promise<void>,
): void {
  const { approvedInput, baseInput, inputFinished, ...titleParams } = params;
  if (approvedInput && baseInput && inputFinished) {
    if (
      baseInput.display === false ||
      baseInput.excludeFromContext === true ||
      (baseInput.provenance && baseInput.provenance.kind !== "external_user")
    ) {
      return;
    }
    void Promise.race([approvedInput, inputFinished.then(() => undefined)])
      .then((message) => {
        if (
          !message ||
          message["__openclaw"]?.beforeAgentRunBlocked !== undefined ||
          message.display === false ||
          message.excludeFromContext === true ||
          (message.provenance && message.provenance.kind !== "external_user")
        ) {
          return;
        }
        const approvedText =
          extractTextFromChatContent(message.content, {
            joinWith: "\n",
            normalizeText: (value) => value,
          }) ?? "";
        scheduleChatDashboardSessionTitle(
          {
            ...titleParams,
            approvedOpeningText: approvedText,
            request: {
              ...params.request,
              rawMessage: approvedText,
              // Media facts are restored after hooks and do not approve attachment contents.
              normalizedAttachments: [],
            },
          },
          retryAfter,
        );
      })
      .catch((error: unknown) => {
        params.context.logGateway.warn(
          "dashboard session title input failed: " + formatForLog(error),
        );
      });
    return;
  }
  const lifecycleRevision = params.entry?.lifecycleRevision;
  const titleSource = buildDashboardSessionTitleSource({
    message: params.request.rawMessage,
    attachments: params.request.normalizedAttachments,
  });
  if (
    !isDashboardSessionTitleCandidate({ sessionKey: params.sessionKey, userMessage: titleSource })
  ) {
    return;
  }
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    // Naming only patches metadata under the title writer's session identity check.
    // It must not hold a turn admission while waiting on a model.
    await maybeGenerateDashboardSessionTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionId: params.admittedSessionId,
      lifecycleRevision,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      currentUserMessage: params.request.rawMessage,
      approvedOpeningText: params.approvedOpeningText,
      messageId: params.request.p?.idempotencyKey,
      awaitingFirstMessage: params.awaitingFirstMessage,
      userMessage: titleSource,
      ...(retryAfter ? { retryAfter } : {}),
      onFallback: () =>
        params.context.logGateway.warn(
          "dashboard session title generation exhausted; using a crustacean fallback name",
        ),
      onTitleStateChanged: () =>
        emitSessionTitleChanged(params.context, {
          sessionKey: params.sessionKey,
          sessionId: params.admittedSessionId,
          agentId: params.agentId,
        }),
    });
  }, "chat-send:background").catch((err: unknown) => {
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(err)}`,
    );
  });
}
