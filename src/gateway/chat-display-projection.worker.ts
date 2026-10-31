import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { projectPreservedCatalogMessageForDisplay } from "../chat/session-catalog-display.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  finishChatDisplayProjection,
  prepareChatDisplayProjection,
  prepareChatHistoryRecoveryMessages,
  prepareChatHistoryRecoveryFacts,
  type ChatDisplayProjectionOptions,
} from "./chat-display-projection.core.js";
import { readForwardedCronJobIds } from "./chat-display-projection.history.js";
import type {
  ChatTextWorkerInput,
  ChatTextWorkerResult,
  ChatTextWorkerQuery,
  ChatTextWorkerFacts,
} from "./chat-display-projection.worker-types.js";
import { createPreparedSessionHistorySubagentProjection } from "./session-history-delta-visibility.js";

serveWorkerTasks<ChatTextWorkerResult, ChatTextWorkerInput>(async (input, channel, control) => {
  if (input.kind === "reply-context") {
    const { projectChatSendReplyContextBody } =
      await import("./server-methods/chat-send-reply-context.js");
    return { kind: input.kind, value: projectChatSendReplyContextBody(input.message) };
  }
  if (input.kind === "media-sources") {
    const { projectAssistantMessageMediaSources } =
      await import("./control-ui-assistant-message-media.js");
    return { kind: input.kind, value: projectAssistantMessageMediaSources(input.message) };
  }
  if (input.kind === "delivery-directives") {
    const { applyAssistantDeliveryDirectives } =
      await import("../config/sessions/transcript-assistant-delivery.js");
    return { kind: input.kind, value: applyAssistantDeliveryDirectives(input.message) };
  }
  if (input.kind === "tts-supplement-marker") {
    const { projectTtsSupplementTranscriptMarker } =
      await import("./server-methods/chat-tts-markers.js");
    return { kind: input.kind, value: projectTtsSupplementTranscriptMarker(input.text) };
  }
  if (input.kind === "recovery-facts") {
    return {
      kind: input.kind,
      value: prepareChatHistoryRecoveryFacts(input.messages, input.options),
    };
  }
  if (input.kind === "recovery") {
    return {
      kind: "recovery",
      value: prepareChatHistoryRecoveryMessages(input.messages, input.options),
    };
  }
  const options: ChatDisplayProjectionOptions = { ...input.options };
  const request = async (query: ChatTextWorkerQuery): Promise<ChatTextWorkerFacts> => {
    if (!channel) {
      throw new Error("Chat display facts require the task channel");
    }
    const response = await channel.request(query);
    response.consumed();
    control.throwIfCancelled();
    // SAFETY: The owned task channel binds this reply to the host's typed query handler.
    return response.input as ChatTextWorkerFacts;
  };
  let recoveryMessages: unknown[] | undefined;
  if (input.subagentCoordination) {
    recoveryMessages = prepareChatHistoryRecoveryMessages(
      input.messages.flatMap(projectPreservedCatalogMessageForDisplay),
      options,
    );
    const facts = await request({
      kind: "coordination",
      // Coordination reads only these fields. Large authored bodies stay in the worker.
      messages: recoveryMessages.map((value) => {
        const message = asOptionalRecord(value);
        const metadata = asOptionalRecord(message?.["__openclaw"]);
        const provenance = asOptionalRecord(message?.provenance);
        return (
          message && {
            role: message.role,
            display: message.display,
            provenance: provenance && {
              kind: provenance.kind,
              sourceTool: provenance.sourceTool,
              sourceRole: provenance.sourceRole,
              sourceSessionKey: provenance.sourceSessionKey,
            },
            idempotencyKey: message.idempotencyKey,
            __openclaw: metadata && {
              runId: metadata.runId,
              seq: metadata.seq,
              idempotencyKey: metadata.idempotencyKey,
              steerTargetRunId: metadata.steerTargetRunId,
            },
          }
        );
      }),
    });
    if (facts.kind !== "coordination") {
      throw new Error("Chat display coordination reply mismatch");
    }
    // The host checks current authority before facts and again before publishing the result.
    options.subagentCoordination = createPreparedSessionHistorySubagentProjection(facts.value, () =>
      control.throwIfCancelled(),
    );
  }
  const prepared = prepareChatDisplayProjection(input.messages, options, recoveryMessages);
  if (input.cronNames) {
    const ids = [...new Set(readForwardedCronJobIds(prepared.sanitizedMessages))];
    if (ids.length) {
      const facts = await request({ kind: "cron", ids });
      if (facts.kind !== "cron") {
        throw new Error("Chat display cron reply mismatch");
      }
      const names = new Map(facts.value);
      options.resolveCronJobName = (id) => {
        if (!names.has(id)) {
          throw new Error("Chat display cron name was not prepared");
        }
        return names.get(id);
      };
    }
  }
  return { kind: "display", value: finishChatDisplayProjection(prepared, options) };
});
