import { randomUUID } from "node:crypto";

export type PromptPivot = {
  promptId: string;
  messageId?: string;
  userMessageIndex: number;
};

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveMessageId(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.id === "string" && entry.id.trim().length > 0) {
    return entry.id.trim();
  }
  if (typeof entry.messageId === "string" && entry.messageId.trim().length > 0) {
    return entry.messageId.trim();
  }
  return undefined;
}

function deriveBasePromptId(messageId: string | undefined, userMessageIndex: number): string {
  if (messageId) {
    const normalized = normalizeToken(messageId);
    if (normalized.length > 0) {
      return `p-${normalized.slice(0, 8)}`;
    }
  }
  return `p-${(userMessageIndex + 1).toString(36)}`;
}

export function collectUserPromptPivots(messages: unknown[]): PromptPivot[] {
  const pivots: PromptPivot[] = [];
  let userMessageIndex = 0;
  const used = new Set<string>();

  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (entry.role !== "user") {
      continue;
    }
    const messageId = resolveMessageId(entry);
    const base = deriveBasePromptId(messageId, userMessageIndex);
    let promptId = base;
    let suffix = 2;
    while (used.has(promptId)) {
      promptId = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(promptId);
    pivots.push({
      promptId,
      messageId,
      userMessageIndex,
    });
    userMessageIndex += 1;
  }

  return pivots;
}

export function createLocalPromptId(): string {
  return `p-${randomUUID().slice(0, 8).toLowerCase()}`;
}

export function matchPromptPivotById(
  pivots: PromptPivot[],
  rawPromptId: string,
): PromptPivot | null {
  const raw = rawPromptId.trim();
  if (!raw) {
    return null;
  }
  const normalizedInput = normalizeToken(raw);
  for (const pivot of pivots) {
    if (pivot.promptId === raw) {
      return pivot;
    }
    if (pivot.messageId === raw) {
      return pivot;
    }
    if (normalizeToken(pivot.promptId) === normalizedInput) {
      return pivot;
    }
    if (pivot.messageId && normalizeToken(pivot.messageId) === normalizedInput) {
      return pivot;
    }
  }
  return null;
}
