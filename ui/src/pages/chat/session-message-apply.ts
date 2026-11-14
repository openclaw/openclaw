import {
  normalizeSessionProjectionRunId,
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "@openclaw/gateway-client/browser";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
import { prunePersistedAssistantStreamSegments } from "./stream-segment-pruning.ts";
import { resetToolStreamRun } from "./tool-stream-state.ts";

type SessionMessageApplySource =
  | { kind: "history-delta" }
  | { kind: "live"; activeRunId: string | null };

/** Apply one durable session.message payload through the pane-owned transcript reducer. */
export function applySessionMessagePayload(
  state: ChatState,
  payload: unknown,
  runActive: boolean | undefined,
  source: SessionMessageApplySource,
): void {
  const event = asNonArrayRecord(payload);
  const sourceMessage = event.message;
  const sourceRecord = asNonArrayRecord(sourceMessage);
  const sourceMetadata = asNonArrayRecord(sourceRecord["__openclaw"]);
  const incoming = readSessionMessageIdentity(sourceMessage, event);
  if (!incoming) {
    return;
  }
  const isAssistant = incoming.role === "assistant";
  const scope = readChatSessionProjectionScope(state, { agentId: resolveChatAgentId(state) });
  // Producer ownership cannot come from a client correlation key or override a conflict.
  const producerRunId =
    incoming.runId === normalizeSessionProjectionRunId(event.runId ?? sourceMetadata.runId)
      ? incoming.runId
      : null;
  let assistantOwnerRunId: string | null = null;
  if (source.kind === "live" && incoming.role !== "user") {
    const isPreviousRunAssistant =
      isAssistant &&
      incoming.sequence !== null &&
      incoming.runId &&
      source.activeRunId &&
      incoming.runId !== source.activeRunId;
    if (!isPreviousRunAssistant) {
      const ownedMessage = incoming.id && !incoming.isImported;
      const ownedProducer = ownedMessage && incoming.sequence !== null && producerRunId;
      let ownerRunId: string | null = null;
      if (
        ownedMessage &&
        (isAssistant
          ? producerRunId || (!incoming.runId && runActive !== true)
          : ownedProducer &&
            normalizeRoleForGrouping(incoming.role) === "tool" &&
            Array.isArray(sourceRecord.content) &&
            sourceRecord.content.some((part) => {
              const block = asNonArrayRecord(part);
              return (
                block.type === "image" &&
                typeof block.artifactId === "string" &&
                block.artifactId.trim()
              );
            }))
      ) {
        // Persisted replies can follow terminal delivery. Only an exact producer
        // or the matching legacy reply may reuse the pane's terminal tombstone.
        const recent = state.lastLocalTerminalReconcile;
        ownerRunId =
          source.activeRunId || (recent?.sessionKey === state.sessionKey ? recent.runId : null);
        if (producerRunId) {
          if (producerRunId !== ownerRunId) {
            ownerRunId = null;
          }
        } else if (ownerRunId && !source.activeRunId) {
          const projectedText = extractText(
            getChatSessionProjection(state, scope).runs[ownerRunId]?.message,
          )?.trim();
          if (!projectedText || projectedText !== extractText(sourceMessage)?.trim()) {
            ownerRunId = null;
          }
        }
      }
      assistantOwnerRunId = isAssistant ? ownerRunId : null;
      if (!ownerRunId) {
        const deliveryMirror = asNonArrayRecord(sourceRecord.openclawDeliveryMirror);
        // Unadopted setup replies own display, never an unrelated assistant stream.
        if (
          !isAssistant ||
          source.activeRunId ||
          !ownedProducer ||
          deliveryMirror.kind !== "message-tool-source-reply" ||
          deliveryMirror.final !== false
        ) {
          return;
        }
      }
    }
  }
  // Partial import provenance cannot turn an envelope position into durable
  // transcript identity; only the persisted row can prove its source order.
  if (
    incoming.isImported &&
    !incoming.externalSource &&
    readSessionMessageSequence(sourceMessage) === null
  ) {
    return;
  }
  if (!incoming.id && !incoming.idempotencyKey && incoming.sequence === null) {
    return;
  }
  const message = {
    ...sourceRecord,
    __openclaw: {
      ...sourceMetadata,
      ...(incoming.id ? { id: incoming.id } : {}),
      ...(incoming.idempotencyKey ? { idempotencyKey: incoming.idempotencyKey } : {}),
      ...(incoming.sequence !== null ? { seq: incoming.sequence } : {}),
      ...(producerRunId ? { runId: producerRunId } : {}),
    },
  };
  const projection = reduceChatSessionProjection(
    state,
    {
      type: "messagePersisted",
      message,
      envelope: assistantOwnerRunId ? { ...event, runId: assistantOwnerRunId } : event,
    },
    { scope, runActive },
  );
  if (isAssistant && projection.messages.includes(message)) {
    prunePersistedAssistantStreamSegments(state, message);
    // Terminal rows replace the live tail; keyed commentary replaces only its segment.
    if (
      assistantOwnerRunId &&
      (runActive === false ||
        ((normalizeSessionProjectionRunId(event.runId) === assistantOwnerRunId ||
          incoming.idempotencyKey === `cli-assistant:${assistantOwnerRunId}`) &&
          !readAssistantStreamSegmentIdentity(message)))
    ) {
      state.chatStream = null;
      state.chatStreamStartedAt = null;
      if (runActive === false) {
        resetToolStreamRun(state, assistantOwnerRunId);
      }
    }
  }
  const steerTargetRunId = persistedSteerTargetRunId(message);
  const currentRunId = state.chatRunId;
  if (
    incoming.role === "user" &&
    (runActive === true || (runActive === undefined && currentRunId === steerTargetRunId)) &&
    incoming.runId &&
    steerTargetRunId &&
    (!currentRunId || currentRunId === steerTargetRunId || currentRunId === incoming.runId)
  ) {
    state.chatRunId = steerTargetRunId;
  }
}
