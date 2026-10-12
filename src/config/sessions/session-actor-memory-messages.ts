import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import type { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import type { SessionActorPhaseBackend } from "./session-actor-phase.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";
import type {
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
} from "./session-pending-input.types.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { messagesMatchForIdempotentReplay } from "./transcript-message-equality.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

type MessageInput = TranscriptMessageAppendOptions<unknown> & {
  messageJson?: string;
  appendMode?: "side";
  custody?: { facts: SessionPendingInputWorkerFacts; relocation?: string };
  preparedMessage?: SessionTurnPlan["options"]["messages"][number]["preparedMessage"];
  fresh?: () => void;
};

export function createSessionActorMemoryMessages(
  options: {
    state: SessionActorMemoryState;
    agentId: string;
    path: string;
    admit: SessionActorPhaseBackend["admit"];
  },
  events: ReturnType<typeof createSessionActorMemoryEvents>,
) {
  const { state, path, admit } = options;
  const { version, writeEvent, parent, checkMutation } = events;
  const pending = createSessionActorMemoryPending(state, options);
  const requireEntry = () => {
    if (!state.hot.entry) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return state.hot.entry;
  };
  const findByKey = (input: Pick<MessageInput, "message" | "idempotencyLookup">) => {
    const key = readMessageIdempotencyKey(input.message);
    if (!key || input.idempotencyLookup === "caller-checked") {
      return undefined;
    }
    const identity = state.hot.transcript.idempotency.find((item) => item.key === key);
    const row = state.events.findLast(
      ({ event }) =>
        isRecord(event) &&
        event.type === "message" &&
        (input.idempotencyLookup === "scan-assistant"
          ? isRecord(event.message) &&
            event.message.role === "assistant" &&
            readMessageIdempotencyKey(event.message) === key
          : event.id === identity?.eventId),
    );
    return row && isRecord(row.event) && typeof row.event.id === "string" ? row.event : undefined;
  };
  const appendMessage = (
    input: MessageInput,
  ): {
    result: TranscriptMessageAppendResult<unknown> | undefined;
    receipt?: SessionPendingInputWorkerReceipt;
  } => {
    const entry = requireEntry();
    const key = readMessageIdempotencyKey(input.message);
    const row = key ? state.pendingInputs.get(key) : undefined;
    const facts = input.custody?.facts;
    if (
      input.custody?.relocation !== undefined &&
      input.custody.relocation !== facts?.transcriptInputId
    ) {
      throw new SessionPendingInputCustodyError(
        "Pending input relocation does not match its admitted transcript entry",
      );
    }
    const owns =
      facts &&
      key === facts.idempotencyKey &&
      facts.databasePath === path &&
      facts.sessionKey === state.hot.target.sessionKey &&
      facts.sessionId === entry.sessionId;
    const usesCustody =
      isRecord(input.message) && input.message.role === "user" && (row !== undefined || owns);
    if (usesCustody && !owns) {
      throw new SessionPendingInputCustodyError(
        "Pending input cannot be appended outside its admitted turn",
      );
    }
    const sources = usesCustody && facts ? (facts.sources ?? [facts]) : [];
    const accepted = sources.map((source) => {
      const sourceRow = state.pendingInputs.get(source.idempotencyKey);
      if (
        source.databasePath !== path ||
        source.sessionKey !== state.hot.target.sessionKey ||
        source.sessionId !== entry.sessionId ||
        (sourceRow &&
          (sourceRow.input_id !== source.inputId ||
            sourceRow.lifecycle_generation !== source.lifecycleGeneration ||
            sourceRow.message_json !== source.messageJson ||
            sourceRow.state !== "queued" ||
            (sourceRow.consumed_event_id !== null &&
              sourceRow.consumed_event_id !== facts?.transcriptInputId)))
      ) {
        throw new SessionPendingInputCustodyError(
          "Pending input custody changed before transcript promotion",
        );
      }
      if (facts?.sources && !sourceRow) {
        throw new SessionPendingInputCustodyError(
          "Collected input custody changed before transcript promotion",
        );
      }
      return sourceRow;
    });
    const promoted =
      usesCustody &&
      accepted.every((value) => !value || value.consumed_event_id === facts?.transcriptInputId);
    const relocating = promoted && input.custody?.relocation !== undefined;
    const acceptedMessage =
      usesCustody && facts ? parseSessionPendingInputMessage(facts.messageJson) : undefined;
    const existing = findByKey(input);
    const byId = state.events.find(
      ({ event }) =>
        isRecord(event) &&
        event.type === "message" &&
        event.id ===
          (usesCustody && facts && !relocating ? facts.transcriptInputId : input.eventId),
    );
    const replay = existing ?? (byId && isRecord(byId.event) ? byId.event : undefined);
    const consume = (relocatedId?: string): SessionPendingInputWorkerReceipt | undefined => {
      if (!usesCustody || !facts) {
        return undefined;
      }
      const ids: string[] = [];
      if (!promoted) {
        for (const [index, source] of sources.entries()) {
          const current = accepted[index];
          if (current) {
            if (facts.sources) {
              state.pendingInputs.set(source.idempotencyKey, {
                ...current,
                consumed_event_id: facts.transcriptInputId,
              });
            } else {
              state.pendingInputs.delete(source.idempotencyKey);
            }
            ids.push(source.inputId);
          }
        }
        state.hot.pendingInputs = [...state.pendingInputs.values()].map(
          ({ message_json: _message, ...value }) => value,
        );
      }
      return { transcriptInputId: relocatedId ?? facts.transcriptInputId, consumedInputIds: ids };
    };
    if (usesCustody && facts && !promoted) {
      admit("transaction", {
        kind: "session-message",
        check: "pending",
        authority: facts.preparedAuthority ? pending.authority(facts.agentId) : undefined,
      });
    }
    if (replay && typeof replay.id === "string") {
      if (
        ((!input.preparedMessage || usesCustody) &&
          !messagesMatchForIdempotentReplay(replay.message, acceptedMessage ?? input.message)) ||
        (usesCustody && (relocating ? input.eventId : facts?.transcriptInputId) !== replay.id)
      ) {
        throw new Error(
          `Transcript idempotency key "${key ?? input.eventId}" conflicts with the admitted message.`,
        );
      }
      const anchor = state.hot.transcript.anchors.find((value) => value.entryId === replay.id);
      if (usesCustody && !anchor) {
        throw new SessionPendingInputCustodyError(
          "Pending input is no longer active in its admitted transcript",
        );
      }
      return {
        result: {
          appended: false,
          message: structuredClone(replay.message),
          messageId: replay.id,
          effectiveParentId: typeof replay.parentId === "string" ? replay.parentId : null,
          ...(anchor ? { anchor: { ...anchor } } : {}),
        },
        receipt: consume(relocating ? replay.id : undefined),
      };
    }
    if (promoted && !relocating) {
      throw new SessionPendingInputCustodyError(
        "Pending input custody ended before transcript promotion",
      );
    }
    const approvedMessage = usesCustody
      ? acceptedMessage
      : input.preparedMessage
        ? input.preparedMessage.message
        : input.message;
    if (approvedMessage === undefined) {
      return { result: undefined };
    }
    checkMutation(input.expectedMutationAt);
    if (
      !usesCustody &&
      input.expectedTranscript &&
      !isDeepStrictEqual(version(), input.expectedTranscript)
    ) {
      throw new SqliteTranscriptMutationConflictError(entry.sessionId);
    }
    if (!usesCustody) {
      input.fresh?.();
    }
    const messageJson =
      usesCustody && facts
        ? facts.messageJson
        : (input.messageJson ?? JSON.stringify(approvedMessage));
    if (!state.events.length) {
      writeEvent(createSessionTranscriptHeader({ sessionId: entry.sessionId, cwd: input.cwd }));
    }
    const messageId =
      usesCustody && facts && !relocating
        ? facts.transcriptInputId
        : (input.eventId ?? randomUUID());
    const envelope = {
      type: "message",
      id: messageId,
      parentId: parent(input),
      timestamp: resolveTimestampMsToIsoString(input.now ?? Date.now()),
      ...(input.appendMode ? { appendMode: input.appendMode } : {}),
    };
    const eventJson = `${JSON.stringify(envelope).slice(0, -1)},"message":${messageJson}}`;
    const event: unknown = JSON.parse(eventJson);
    if (!writeEvent(event, eventJson, input.idempotencyLookup)) {
      throw new Error(`Transcript append did not insert message ${messageId}`);
    }
    const anchor = state.hot.transcript.anchors.find((value) => value.entryId === messageId);
    return {
      result: {
        appended: true,
        message: JSON.parse(messageJson),
        messageId,
        effectiveParentId: envelope.parentId,
        ...(anchor ? { anchor: { ...anchor } } : {}),
      },
      receipt: consume(relocating ? messageId : undefined),
    };
  };
  return { findByKey, appendMessage };
}
