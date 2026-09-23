import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";

const BRANCH_HEADLINE_MAX_CHARS = 120;
export type SessionBranchTranscriptEntry = Record<string, unknown> & {
  seq: number;
  headlineCandidate: boolean;
};

export function projectSessionBranchEntry(
  event: TranscriptEvent,
  seq: number,
): SessionBranchTranscriptEntry | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const role = asRecord(record.message)?.role;
  const entry: SessionBranchTranscriptEntry = {
    seq,
    headlineCandidate: record.type === "message" && (role === "user" || role === "assistant"),
  };
  // Keep own-field presence and values intact; the tree scanner owns navigation normalization.
  for (const key of ["type", "id", "parentId", "targetId", "appendParentId", "appendMode"]) {
    if (Object.hasOwn(record, key)) {
      entry[key] = record[key];
    }
  }
  if (typeof record.timestamp === "string" && record.timestamp.trim()) {
    entry.timestamp = record.timestamp;
  }
  return entry;
}

export function extractSessionBranchHeadline(event: TranscriptEvent): string | undefined {
  const record = asRecord(event);
  const headline = record?.type === "message" ? extractHeadlineText(record.message) : undefined;
  return headline === undefined ? undefined : truncateBranchHeadline(headline);
}

function extractHeadlineText(messageValue: unknown): string | undefined {
  const message = asRecord(messageValue);
  if (message?.role !== "user" && message?.role !== "assistant") {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : extractEditorText(message.content ?? message.text);
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncateBranchHeadline(value: string): string {
  const prefix = truncateCodePoints(value, BRANCH_HEADLINE_MAX_CHARS);
  return prefix.length === value.length
    ? prefix
    : `${truncateCodePoints(prefix, BRANCH_HEADLINE_MAX_CHARS - 1)}…`;
}

export function extractEditorText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
  return text || undefined;
}
