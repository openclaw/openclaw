import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { loadChatHistory } from "./chat-history.ts";
import { isTerminalFailureChatSendAck, type ChatSendAck } from "./chat-send-ack.ts";
import {
  settleChatCommandComposer,
  submittedCommandScopeIsVisible,
  type ChatCommandComposerRecovery,
} from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import {
  isActiveLeafChangedError,
  requestChatSend,
  resolveDisplayedLeafEntryId,
} from "./chat-send-request.ts";
import { formatTerminalChatSendAckError } from "./chat-send-support.ts";
import { formatConnectError } from "./connect-error.ts";

export async function sendDetachedCommandMessage(
  host: ChatHost,
  message: string,
  opts: {
    attachments?: ChatAttachment[];
    recovery: ChatCommandComposerRecovery;
  },
) {
  let ack: ChatSendAck | null = null;
  if (host.client && host.connected && (message.trim() || opts.attachments?.length)) {
    if (submittedCommandScopeIsVisible(host, opts.recovery)) {
      setChatError(host, null);
    }
    try {
      ack = await requestChatSend(host, {
        message: message.trim(),
        attachments: opts.attachments,
        runId: generateUUID(),
        expectedLeafEntryId: resolveDisplayedLeafEntryId(host),
      });
    } catch (err) {
      if (submittedCommandScopeIsVisible(host, opts.recovery)) {
        const activeLeafChanged = isActiveLeafChangedError(err);
        setChatError(
          host,
          activeLeafChanged ? t("chat.sendErrors.activeLeafChanged") : formatConnectError(err),
        );
        if (activeLeafChanged) {
          void Promise.all([loadChatHistory(host), loadChatBranches(host)]);
        }
      }
    }
  }
  const completed =
    ack?.status === "ok" || ack?.status === "started" || ack?.status === "in_flight";
  settleChatCommandComposer(host, opts.recovery, completed, opts.attachments);
  if (isTerminalFailureChatSendAck(ack) && submittedCommandScopeIsVisible(host, opts.recovery)) {
    setChatError(host, formatTerminalChatSendAckError(ack, "detached"));
  }
}
