import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo } from "solid-js";
import type { AnswerLens, AnswerLensSource } from "../../pages/chat/answer-lens.ts";
import { persistedMessageEntryId } from "../../pages/chat/chat-thread-items.ts";
import type { ChatThreadProps } from "../../pages/chat/components/chat-thread-interactions.ts";
import { projectSource } from "./projection.ts";

export function createAnswerLensProjection(
  owner: () => AnswerLens | undefined,
  source: () => AnswerLensSource | undefined,
) {
  const projection = createMemo(() => {
    const currentOwner = owner();
    const currentSource = source();
    return currentOwner && currentSource
      ? projectSource(currentOwner, {
          read: (lens) => lens.read(currentSource),
          subscribe: (lens, notify) => {
            const unsubscribe = lens.subscribe(notify);
            let active = true;
            // Presentation subscription admits the latest answer after rendering settles.
            queueMicrotask(() => {
              if (active) {
                void lens.applyRemembered(currentSource);
              }
            });
            return () => {
              active = false;
              unsubscribe();
            };
          },
          equality: "revision",
        })
      : undefined;
  });
  return () => projection()?.read();
}

export function configureTranscriptAnswerLens(owner: AnswerLens, props: ChatThreadProps) {
  owner.configure({
    client: props.connected ? (props.gatewayClient ?? null) : null,
    epoch: props.connectionEpoch,
    // The pane advances this on config changes and sharing revocation.
    policyEpoch: props.mediaPolicyEpoch,
    sessionKey: props.sessionKey,
    latestMessageId: persistedMessageEntryId(
      props.messages.findLast((message) => asOptionalRecord(message)?.role === "assistant"),
    ),
    agentId: props.currentAgentId ?? props.fullMessageAgentId,
  });
  return props.connected && props.gatewayClient ? owner : undefined;
}
