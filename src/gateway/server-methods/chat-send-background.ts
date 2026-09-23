import { createHash } from "node:crypto";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  buildDashboardSessionTitleSource,
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveWebchatPromptCacheKey(params: {
  agentId: string;
  model: string;
  provider: string;
  sessionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "v1",
        params.provider.trim().toLowerCase(),
        params.model.trim(),
        normalizeAgentId(params.agentId),
        params.sessionKey,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `openclaw-webchat-${digest}`;
}

type DashboardSessionTitleRequest = {
  admittedSessionId: string;
  agentId: string;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  request: Pick<NormalizedChatSendRequest, "normalizedAttachments" | "rawMessage">;
  sessionKey: string;
  sessionLoadOptions: Parameters<typeof loadSessionEntry>[1];
  storePath: string;
};

export function scheduleChatDashboardSessionTitle(params: DashboardSessionTitleRequest): void {
  scheduleDashboardSessionTitle(params, "session");
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
  // Creation metadata must not hold the execution lease that cloud dispatch drains.
  // The title writer still checks the exact session generation and existing name.
  scheduleDashboardSessionTitle(
    {
      admittedSessionId: created.entry.sessionId,
      agentId: created.agentId,
      cfg,
      context,
      request: { rawMessage: titleSource, normalizedAttachments: [] },
      sessionKey: created.key,
      sessionLoadOptions: { agentId: created.agentId },
      storePath: created.storePath,
    },
    "gateway",
  );
}

function scheduleDashboardSessionTitle(
  params: DashboardSessionTitleRequest,
  admissionScope: "session" | "gateway",
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
    const generateTitle = async () => {
      const titleEntry = loadSessionEntry(params.sessionKey, params.sessionLoadOptions).entry;
      if (titleEntry?.sessionId !== params.admittedSessionId) {
        return;
      }
      const updated = await maybeGenerateDashboardSessionTitle({
        cfg: params.cfg,
        agentId: params.agentId,
        entry: titleEntry,
        sessionId: params.admittedSessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        currentUserMessage: params.request.rawMessage,
        userMessage: titleSource,
      });
      if (updated) {
        emitSessionsChanged(params.context, {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          reason: "chat.title",
        });
      }
    };
    if (admissionScope === "gateway") {
      await generateTitle();
      return;
    }
    const admission = await beginSessionWorkAdmission({
      scope: params.storePath,
      identities: [params.sessionKey, params.admittedSessionId],
      assertAllowed: () => {},
    });
    try {
      await admission.run(generateTitle);
    } finally {
      admission.release();
    }
  }, "chat-send:background").catch((err: unknown) => {
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(err)}`,
    );
  });
}
