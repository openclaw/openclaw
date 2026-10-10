import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import {
  buildDashboardSessionTitleSource,
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import { formatForLog } from "../ws-log.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

type DashboardSessionTitleRequest = {
  admittedSessionId: string;
  agentId: string;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  request: Pick<NormalizedChatSendRequest, "normalizedAttachments" | "rawMessage">;
  sessionKey: string;
  storePath: string;
};

/** Reply gate for chat-turn naming; `released` reports whether its turn was still running. */
type DashboardSessionTitleTurn = {
  released: Promise<boolean>;
  settled: Promise<void>;
};

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
  turn?: DashboardSessionTitleTurn,
): void {
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
    const retryAfter = turn && (await turn.released) ? turn.settled : undefined;
    const updated = await maybeGenerateDashboardSessionTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionId: params.admittedSessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      currentUserMessage: params.request.rawMessage,
      userMessage: titleSource,
      ...(retryAfter ? { retryAfter } : {}),
      onFallback: () =>
        params.context.logGateway.warn(
          "dashboard session title generation exhausted; using a crustacean fallback name",
        ),
    });
    if (updated) {
      emitSessionsChanged(params.context, {
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        reason: "chat.title",
      });
    }
  }, "chat-send:background").catch((err: unknown) => {
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(err)}`,
    );
  });
}
