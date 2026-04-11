import { sanitizeForPromptLiteral } from "../../agents/sanitize-for-prompt.js";
import type { SessionSharedRoomState } from "../../config/sessions/types.js";
import type { SharedRoomContext, SharedRoomMessage } from "./types.js";

function sanitizeRoomLine(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return sanitizeForPromptLiteral(trimmed);
}

function getAdmittedMessages(context: SharedRoomContext): SharedRoomMessage[] {
  const seenThroughSeq =
    typeof context.seenThroughSeq === "number" && Number.isFinite(context.seenThroughSeq)
      ? context.seenThroughSeq
      : undefined;
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const admitted = messages
    .filter((message) => Number.isFinite(message.seq))
    .filter((message) => seenThroughSeq === undefined || message.seq <= seenThroughSeq)
    .toSorted((left, right) => left.seq - right.seq);
  return admitted;
}

export function summarizeSharedRoomContext(
  context: SharedRoomContext | undefined,
): SessionSharedRoomState | undefined {
  const roomId = sanitizeRoomLine(context?.roomId);
  if (!roomId) {
    return undefined;
  }
  const admitted = context ? getAdmittedMessages(context) : [];
  const lastMessageSeq = admitted.length > 0 ? admitted.at(-1)?.seq : undefined;
  return {
    roomId,
    roomLabel: sanitizeRoomLine(context?.roomLabel),
    truthModel: sanitizeRoomLine(context?.truthModel),
    participantId: sanitizeRoomLine(context?.participantId),
    participantLabel: sanitizeRoomLine(context?.participantLabel),
    seenThroughSeq:
      typeof context?.seenThroughSeq === "number" && Number.isFinite(context.seenThroughSeq)
        ? context.seenThroughSeq
        : undefined,
    lastMessageSeq:
      typeof lastMessageSeq === "number" && Number.isFinite(lastMessageSeq)
        ? lastMessageSeq
        : undefined,
    participantCount: Array.isArray(context?.participants)
      ? context.participants.length
      : undefined,
  };
}

export function buildSharedRoomContextPrompt(
  context: SharedRoomContext | undefined,
): string | undefined {
  const summary = summarizeSharedRoomContext(context);
  if (!summary) {
    return undefined;
  }
  const admitted = context ? getAdmittedMessages(context) : [];
  const lines: string[] = ["## Shared Room Context"];
  const roomLabel = summary.roomLabel ?? summary.roomId;
  lines.push(`You are seated in the shared room "${roomLabel}".`);
  if (summary.truthModel) {
    lines.push(`Room truth model: ${summary.truthModel}.`);
  }
  if (summary.participantLabel || summary.participantId) {
    lines.push(
      `Your seat identity in this room: ${summary.participantLabel ?? summary.participantId}.`,
    );
  }
  if (typeof summary.seenThroughSeq === "number") {
    lines.push(
      `Your admitted room context includes room events through seq ${summary.seenThroughSeq}.`,
    );
  }
  lines.push(
    "Only claim to have directly seen room messages included in this admitted context.",
    "If another participant's message is not present here, say so plainly instead of guessing.",
  );

  const participants = Array.isArray(context?.participants) ? context.participants : [];
  if (participants.length > 0) {
    lines.push("", "Participants:");
    for (const participant of participants) {
      const id = sanitizeRoomLine(participant.id);
      if (!id) {
        continue;
      }
      const parts = [
        sanitizeRoomLine(participant.label),
        sanitizeRoomLine(participant.role),
        sanitizeRoomLine(participant.seat),
      ].filter(Boolean);
      lines.push(`- ${id}${parts.length > 0 ? ` — ${parts.join(" · ")}` : ""}`);
    }
  }

  if (admitted.length > 0) {
    lines.push("", "Admitted room messages:");
    for (const message of admitted) {
      const author = sanitizeRoomLine(message.author) ?? "Unknown";
      const text = sanitizeRoomLine(message.text) ?? "";
      if (!text) {
        continue;
      }
      lines.push(`- [#${message.seq}] ${author}: ${text}`);
    }
  } else {
    lines.push("", "Admitted room messages: none.");
  }

  return lines.join("\n");
}

export function mergeExtraSystemPrompts(...prompts: Array<string | undefined>): string | undefined {
  const normalized = prompts.map((prompt) => prompt?.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.join("\n\n");
}
