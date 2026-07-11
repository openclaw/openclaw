import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.js";
import {
  MESSAGE_TOOL_ONLY_UNDELIVERED_FINAL_CUSTOM_TYPE,
  MESSAGE_TOOL_ONLY_UNDELIVERED_FINAL_NOTICE,
  type MessageToolOnlyUndeliveredFinalNoticeDetails,
} from "../../config/sessions/undelivered-final-notice.js";
import { isSilentReplyText } from "../tokens.js";

export async function persistMessageToolOnlyUndeliveredFinalNotice(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionId: string;
  expectedLifecycleRevision?: string;
  sessionKey?: string;
  storePath?: string;
  sessionAgentId?: string;
  threadId?: string | number;
  workspaceDir: string;
  sourceReplyDeliveryMode?: string;
  sendPolicyDenied: boolean;
  finalTextDeliveredToCurrentSourceRoute: boolean;
  finalText: string;
}): Promise<void> {
  if (
    params.sourceReplyDeliveryMode !== "message_tool_only" ||
    params.sendPolicyDenied ||
    params.finalTextDeliveredToCurrentSourceRoute
  ) {
    return;
  }
  const trimmed = params.finalText.trim();
  if (!trimmed || isSilentReplyText(trimmed)) {
    return;
  }
  const sessionKey = params.sessionKey?.trim();
  const sessionId = params.sessionId.trim();
  if (!sessionKey || !sessionId) {
    return;
  }

  await persistSessionTranscriptTurn(
    {
      sessionId,
      sessionKey,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      agentId: params.sessionAgentId,
      threadId: params.threadId,
    },
    {
      config: params.cfg,
      cwd: params.workspaceDir,
      messages: [
        {
          message: {
            role: "custom",
            customType: MESSAGE_TOOL_ONLY_UNDELIVERED_FINAL_CUSTOM_TYPE,
            content: MESSAGE_TOOL_ONLY_UNDELIVERED_FINAL_NOTICE,
            display: false,
            details: {
              sourceReplyDeliveryMode: "message_tool_only",
              delivered: false,
              finalTextLength: trimmed.length,
            } satisfies MessageToolOnlyUndeliveredFinalNoticeDetails,
            timestamp: Date.now(),
          },
        },
      ],
      publishWhen: "when-appended",
      touchSessionEntry: true,
      updateMode: "file-only",
      ...(params.storePath
        ? {
            expectedSessionId: sessionId,
            ...(params.expectedLifecycleRevision
              ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
              : {}),
          }
        : {}),
    },
  );
}
