import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { readSessionTranscriptModelContextAsync } from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import type {
  GroupConversationMessage,
  GroupParticipationEvidence,
} from "./group-participation-decisions.js";
import type { GroupParticipationInput } from "./group-participation-inputs.js";

function projectMessage(entryId: string, message: AgentMessage) {
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }
  if (Reflect.get(message, "excludeFromContext") === true) {
    return undefined;
  }
  const provenance = normalizeInputProvenance(Reflect.get(message, "provenance"));
  if (message.role === "user" && provenance && provenance.kind !== "external_user") {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : extractTextFromChatContent(message.content, {
          normalizeText: (value) => value,
          joinWith: "\n",
        });
  if (!text) {
    return undefined;
  }
  const metadata = asOptionalRecord(Reflect.get(message, "__openclaw"));
  const transport = asOptionalRecord(metadata?.transport);
  const preview = asOptionalRecord(metadata?.replyToPreview);
  const mirror = asOptionalRecord(Reflect.get(message, "openclawDeliveryMirror"));
  if (mirror?.kind === "channel-final-suppressed") {
    return undefined;
  }
  const confirmed =
    message.role === "user" ||
    mirror?.kind === "channel-final" ||
    mirror?.kind === "message-tool-source-reply";
  const projected: GroupConversationMessage = {
    id: normalizeOptionalString(transport?.messageId) ?? entryId,
    role: message.role,
    text,
    ...(typeof metadata?.senderId === "string" ? { senderId: metadata.senderId } : {}),
    ...(typeof metadata?.senderName === "string" ? { senderName: metadata.senderName } : {}),
    ...(typeof transport?.replyToId === "string"
      ? { replyToId: transport.replyToId }
      : typeof metadata?.replyToId === "string"
        ? { replyToId: metadata.replyToId }
        : {}),
    ...(typeof preview?.text === "string" ? { replyToText: preview.text } : {}),
  };
  return { message: projected, confirmed };
}

/** Keep source conversation separate from model output whose delivery is unknown. */
export async function readGroupParticipationEvidence(params: {
  agentId: string;
  agentName?: string;
  target: SessionTranscriptRuntimeTarget;
  sourceMessageId?: string;
  replyToText?: string;
  recorder: UserTurnTranscriptRecorder;
  acceptedInputs?: readonly GroupParticipationInput[];
  adoptedRecorders?: ReadonlySet<UserTurnTranscriptRecorder>;
  signal: AbortSignal;
}): Promise<GroupParticipationEvidence> {
  const current =
    params.recorder.getPersistedMessage?.() ?? (await params.recorder.resolveMessage());
  if (!current) {
    throw new Error("Group participation requires its source message");
  }
  const context = await readSessionTranscriptModelContextAsync(
    params.target,
    undefined,
    params.signal,
    undefined,
    { maxBytes: 256 * 1024, maxEvents: 128 },
  );
  params.signal.throwIfAborted();
  const projected = context.events.flatMap((entry) => {
    if (!isIndexedSessionEntry(entry) || entry.type !== "message") {
      return [];
    }
    const message = projectMessage(entry.id, entry.message);
    return message ? [message] : [];
  });
  const sources = params.acceptedInputs?.length
    ? params.acceptedInputs
    : [
        {
          recorder: params.recorder,
          sourceMessageId: params.sourceMessageId,
          replyToText: params.replyToText,
        },
      ];
  const earlierSources: typeof projected = [];
  for (const [index, input] of sources.entries()) {
    const message =
      input.recorder.getPersistedMessage?.() ?? (await input.recorder.resolveMessage());
    if (!message) {
      continue;
    }
    const entryId = input.recorder.getAdmissionReceipt()?.entryId ?? input.sourceMessageId;
    const source = projectMessage(entryId ?? `accepted-input-${index}`, message);
    if (!source) {
      continue;
    }
    source.message.admission = params.adoptedRecorders?.has(input.recorder) ? "current" : "queued";
    if (input.replyToText !== undefined) {
      source.message.replyToText = input.replyToText;
    }
    const currentIndex = projected.findIndex((entry) => entry.message.id === source.message.id);
    if (currentIndex === -1) {
      const admission = input.recorder.getAdmissionReceipt();
      // A committed source omitted by the retained window precedes that window.
      // Input accepted after this read remains at the end of the conversation.
      if (
        admission &&
        (admission.sessionId !== params.target.sessionId ||
          (admission.generation === context.version?.generation &&
            admission.rawSeq <= (context.version.rawSeq ?? 0)))
      ) {
        earlierSources.push(source);
      } else {
        projected.push(source);
      }
    } else {
      projected[currentIndex] = source;
    }
  }
  projected.unshift(...earlierSources);
  const messages = projected.filter((entry) => entry.confirmed).map((entry) => entry.message);
  const agentTranscriptEvidence = projected
    .filter((entry) => !entry.confirmed)
    .map((entry) => entry.message);
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages) {
    const target = message.replyToId ? byId.get(message.replyToId) : undefined;
    if (target) {
      message.replyToText = target.text;
    }
  }
  return {
    agentId: params.agentId,
    ...(params.agentName ? { agentName: params.agentName } : {}),
    messages,
    ...(agentTranscriptEvidence.length ? { agentTranscriptEvidence } : {}),
  };
}
