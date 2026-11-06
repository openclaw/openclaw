import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_MESSAGE_MAX_CHARS } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { removePairingQrContent } from "../../../lib/chat/pairing-qr.ts";
import {
  messageRecoveryKey,
  resolveCappedMessageId,
  resolveSourceMessageId,
  type AssistantMessageExpansionState,
} from "../chat-message-recovery.ts";
import {
  getExpansionStateVersion,
  pruneAssistantMessageExpansions,
  setExpansionState,
} from "../chat-thread.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";

const expansionPrunes = createTranscriptMemo<void>();

export function projectTranscriptRecovery(
  expandedAssistantMessages: Map<string, AssistantMessageExpansionState>,
  props: Pick<
    ChatThreadProps,
    | "fullMessageAgentId"
    | "messages"
    | "toolMessages"
    | "pendingInputs"
    | "sessionKey"
    | "loadFullAssistantMessage"
    | "displayFacts"
  >,
) {
  if (expandedAssistantMessages.size > 0) {
    expansionPrunes(
      expandedAssistantMessages,
      [
        props.fullMessageAgentId,
        props.messages,
        props.toolMessages,
        getExpansionStateVersion(expandedAssistantMessages),
        ...(props.pendingInputs ?? []),
      ],
      () =>
        pruneAssistantMessageExpansions(expandedAssistantMessages, props.fullMessageAgentId, [
          ...props.messages,
          ...props.toolMessages,
          ...(props.pendingInputs ?? []).map((input) => input.message),
        ]),
    );
  }
  const recoveryKey = (id: string) => messageRecoveryKey(props.fullMessageAgentId, id);
  const expand = (messageId: string) => {
    const key = recoveryKey(messageId);
    const current = expandedAssistantMessages.get(key);
    const loader = props.loadFullAssistantMessage;
    if (!loader || current?.status === "loading") {
      return;
    }
    const revision = (current?.revision ?? 0) + 1;
    const pending = { status: "loading", revision } as const;
    setExpansionState(expandedAssistantMessages, key, pending);
    const completeLoad = (result: Awaited<ReturnType<typeof loader>>) => {
      // A reset or source replacement can reuse both message id and revision.
      // Only the exact pending entry may publish into this presentation.
      if (expandedAssistantMessages.get(key) !== pending) {
        return;
      }
      const message = result?.ok ? asNullableRecord(result.message) : null;
      const markdown = message ? (extractTextCached(message) ?? "") : null;
      setExpansionState(
        expandedAssistantMessages,
        key,
        markdown === null
          ? { status: "error", revision: revision + 1 }
          : { status: "loaded", markdown, message, revision: revision + 1 },
      );
      const source = message
        ? props.messages.find(
            (entry) =>
              asNullableRecord(entry)?.role === "assistant" &&
              resolveCappedMessageId(entry, "assistant") === messageId,
          )
        : undefined;
      if (message && source) {
        // Retain the accepted display, independently of API read-through memoization.
        const { openclawResponsesInputReplay: _replay, ...display } = message;
        props.displayFacts?.forRow(messageId)?.write({
          recoveredMessage: {
            source: extractTextCached(source) ?? "",
            message: removePairingQrContent(display),
          },
        });
      }
    };
    void loader({
      sessionKey: props.sessionKey,
      ...(props.fullMessageAgentId ? { agentId: props.fullMessageAgentId } : {}),
      messageId,
      ...(props.messages.some(
        (message) =>
          resolveSourceMessageId(message) === messageId &&
          asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.reason === "oversized",
      )
        ? { maxChars: CHAT_MESSAGE_MAX_CHARS }
        : {}),
    }).then(completeLoad, () => completeLoad(null));
  };
  return {
    revision: getExpansionStateVersion(expandedAssistantMessages),
    get: (messageId: string) => expandedAssistantMessages.get(recoveryKey(messageId)),
    expand,
  };
}
