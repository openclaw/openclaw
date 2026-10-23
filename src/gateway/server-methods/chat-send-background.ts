import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { maybeRefineDashboardSessionTitle } from "../dashboard-session-title-refinement.js";
import {
  buildDashboardSessionTitleSource,
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import { formatForLog } from "../ws-log.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { emitSessionTitleChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

type DashboardSessionTitleRequest = {
  admittedSessionId: string;
  agentId: string;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  request: Pick<NormalizedChatSendRequest, "normalizedAttachments" | "rawMessage">;
  sessionKey: string;
  skipNextRefinementMessage?: boolean;
  storePath: string;
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
  if (!created.isNew || created.entry.incognito || created.entry.displayName || !titleSource) {
    return;
  }
  scheduleChatDashboardSessionTitle({
    admittedSessionId: created.entry.sessionId,
    agentId: created.agentId,
    cfg,
    context,
    request: { rawMessage: titleSource, normalizedAttachments: [] },
    sessionKey: created.key,
    skipNextRefinementMessage: true,
    storePath: created.storePath,
  });
}

const REFINEMENT_ATTACHMENT_SOURCE_MAX_CHARS = 160;
const REFINEMENT_ATTACHMENT_SOURCE_MAX_ITEMS = 4;

/**
 * Bounded context for refinement counting on attachment-only turns: an
 * accepted chat.send with empty text plus a non-text attachment (image, PDF)
 * is a real task, but buildDashboardSessionTitleSource decodes only text/*
 * attachments, leaving an empty source that the candidate guard would drop
 * from the refinement threshold entirely (Codex 4304147111). The descriptor
 * feeds refinement counting and excerpt context only — title generation is
 * unaffected and still requires real text via the candidate check.
 */
function describeAttachmentsForRefinementSource(
  attachments: NormalizedChatSendRequest["normalizedAttachments"],
): string {
  const parts: string[] = [];
  for (const attachment of attachments.slice(0, REFINEMENT_ATTACHMENT_SOURCE_MAX_ITEMS)) {
    const mime = attachment.mimeType?.trim() || "application/octet-stream";
    if (mime.toLowerCase().startsWith("text/")) {
      continue;
    }
    const fileName = attachment.fileName?.trim();
    parts.push(`[attachment: ${mime}${fileName ? ` ${fileName}` : ""}]`);
  }
  return truncateUtf16Safe(parts.join("\n"), REFINEMENT_ATTACHMENT_SOURCE_MAX_CHARS);
}

export function scheduleChatDashboardSessionTitle(
  params: DashboardSessionTitleRequest,
  retryAfter?: Promise<void>,
): void {
  const titleSource = buildDashboardSessionTitleSource({
    message: params.request.rawMessage,
    attachments: params.request.normalizedAttachments,
  });
  // Attachment-only turns count toward refinement through the bounded
  // attachment descriptor; turns with neither text nor attachments stay
  // dropped (Codex 4304147111).
  const refinementSource =
    titleSource || describeAttachmentsForRefinementSource(params.request.normalizedAttachments);
  if (
    !isDashboardSessionTitleCandidate({
      sessionKey: params.sessionKey,
      userMessage: titleSource,
    }) &&
    !refinementSource
  ) {
    return;
  }
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    // Naming only patches metadata under the title writer's session identity check.
    // It must not hold a turn admission while waiting on a model.
    let joinedTitleRequest = false;
    const titled = await maybeGenerateDashboardSessionTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionId: params.admittedSessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      currentUserMessage: params.request.rawMessage,
      userMessage: titleSource,
      ...(params.skipNextRefinementMessage ? { skipNextRefinementMessage: true } : {}),
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
      markJoined: (joined: boolean) => {
        joinedTitleRequest = joined;
      },
    });
    // Opt-in one-time refinement runs after the initial title pass; it never
    // creates a title, only refines an existing generated one. The turn that
    // persisted the initial title is not a "later" turn: skip counting it so
    // the threshold counts subsequent task messages only. A caller that joined
    // an in-flight title request did NOT persist the title, so its message is
    // a genuine later task and must count (Codex 4303083912).
    if (!titled || joinedTitleRequest) {
      await maybeRefineDashboardSessionTitle({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionId: params.admittedSessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        currentUserMessage: params.request.rawMessage,
        // Attachment-only turns carry no text source; the bounded attachment
        // descriptor keeps their refinement count advancing (Codex 4304147111).
        userMessage: refinementSource,
        // Retry the refinement after the overlapping turn settles, mirroring
        // the initial-title path, instead of timing out behind it (4304532543).
        ...(retryAfter ? { retryAfter } : {}),
        onTitleStateChanged: () =>
          emitSessionTitleChanged(params.context, {
            sessionKey: params.sessionKey,
            sessionId: params.admittedSessionId,
            agentId: params.agentId,
          }),
      });
    }
  }, "chat-send:background").catch((err: unknown) => {
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(err)}`,
    );
  });
}
