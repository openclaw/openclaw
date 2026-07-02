// Session memory policy centralizes which sessions receive long-term memory by default.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { deriveSessionChatTypeFromKey } from "./session-chat-type-shared.js";
import {
  isAcpRuntimeSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "./session-key-utils.js";

export type LongTermMemoryDefaultPolicy = "include" | "explicit-only";

export type LongTermMemoryDefaultPolicyInput = {
  sessionKey?: string | null;
  chatType?: string | null;
  longTermMemoryDefaultPolicy?: LongTermMemoryDefaultPolicy | null;
};

export type LongTermMemoryScopedChatTypeInput = {
  sessionKey?: string | null;
  liveChatType?: string | null;
  storedChatType?: string | null;
  longTermMemoryDefaultPolicy?: LongTermMemoryDefaultPolicy | null;
  preferStoredPolicy?: boolean;
};

export type LongTermMemoryRuntimePolicyContext = {
  chatType?: ChatType;
  longTermMemoryDefaultPolicy: LongTermMemoryDefaultPolicy;
};

export type SessionMemoryBoundaryPlan = {
  currentEntry: SessionEntry;
  runMemoryPolicy: LongTermMemoryDefaultPolicy;
  runMemoryChatType: ChatType | undefined;
  nextSessionId: string;
  nextSessionFile: string;
  expectedSessionFile?: string;
  expectedPolicy?: LongTermMemoryDefaultPolicy;
  needsPolicyStamp: boolean;
  needsTranscriptRotation: boolean;
};

function normalizePolicyInput(
  input?: string | null | LongTermMemoryDefaultPolicyInput,
): LongTermMemoryDefaultPolicyInput {
  return typeof input === "object" && input !== null ? input : { sessionKey: input };
}

function normalizeDerivedChatType(sessionKey?: string | null): ChatType | undefined {
  const derived = deriveSessionChatTypeFromKey(sessionKey);
  return derived === "direct" || derived === "group" || derived === "channel" ? derived : undefined;
}

export function resolveLongTermMemoryDefaultPolicy(
  input?: string | null | LongTermMemoryDefaultPolicyInput,
): LongTermMemoryDefaultPolicy {
  const {
    sessionKey,
    chatType: rawChatType,
    longTermMemoryDefaultPolicy,
  } = normalizePolicyInput(input);
  if (longTermMemoryDefaultPolicy === "explicit-only") {
    return "explicit-only";
  }
  const chatType = normalizeChatType(rawChatType ?? undefined);
  if (
    isSubagentSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    isAcpRuntimeSessionKey(sessionKey)
  ) {
    return "explicit-only";
  }
  const sessionKeyChatType = deriveSessionChatTypeFromKey(sessionKey);
  if (sessionKeyChatType === "group" || sessionKeyChatType === "channel") {
    return "explicit-only";
  }
  if (chatType === "group" || chatType === "channel") {
    return "explicit-only";
  }
  return "include";
}

export function shouldIncludeLongTermMemoryByDefault(
  input?: string | null | LongTermMemoryDefaultPolicyInput,
): boolean {
  return resolveLongTermMemoryDefaultPolicy(input) === "include";
}

export function resolveLongTermMemoryScopedChatType(
  input?: string | null | LongTermMemoryDefaultPolicyInput,
): ChatType | undefined {
  const normalized = normalizePolicyInput(input);
  const chatType = normalizeChatType(normalized.chatType ?? undefined);
  if (resolveLongTermMemoryDefaultPolicy(normalized) === "explicit-only") {
    return chatType === "channel" ? "channel" : "group";
  }
  return chatType;
}

export function resolveLongTermMemoryTargetChatType(
  input: LongTermMemoryScopedChatTypeInput,
): ChatType | undefined {
  const liveChatType = normalizeChatType(input.liveChatType ?? undefined);
  if (liveChatType === "group" || liveChatType === "channel") {
    return liveChatType;
  }
  const derivedChatType = normalizeDerivedChatType(input.sessionKey);
  const storedChatType =
    derivedChatType === "group" || derivedChatType === "channel"
      ? derivedChatType
      : (normalizeChatType(input.storedChatType ?? undefined) ?? derivedChatType);
  const chatType =
    input.preferStoredPolicy === true
      ? (storedChatType ?? liveChatType)
      : (liveChatType ?? storedChatType);
  const authoritativeStoredPolicy =
    input.preferStoredPolicy === true || !liveChatType
      ? input.longTermMemoryDefaultPolicy
      : undefined;
  return resolveLongTermMemoryScopedChatType({
    sessionKey: input.sessionKey,
    chatType,
    longTermMemoryDefaultPolicy: authoritativeStoredPolicy,
  });
}

export function resolveLongTermMemoryRunPolicy(
  input: LongTermMemoryScopedChatTypeInput,
): LongTermMemoryDefaultPolicy {
  const liveChatType = normalizeChatType(input.liveChatType ?? undefined);
  const shouldUseStoredPolicy = input.preferStoredPolicy === true || !liveChatType;
  return resolveLongTermMemoryDefaultPolicy({
    sessionKey: input.sessionKey,
    chatType: resolveLongTermMemoryTargetChatType(input),
    longTermMemoryDefaultPolicy: shouldUseStoredPolicy
      ? input.longTermMemoryDefaultPolicy
      : undefined,
  });
}

export function resolveLongTermMemoryRuntimePolicyContext(
  input: LongTermMemoryScopedChatTypeInput,
): LongTermMemoryRuntimePolicyContext {
  const chatType = resolveLongTermMemoryTargetChatType(input);
  return {
    ...(chatType ? { chatType } : {}),
    longTermMemoryDefaultPolicy: resolveLongTermMemoryRunPolicy(input),
  };
}

export function resolveSessionMemoryBoundaryPlan(params: {
  currentEntry: SessionEntry;
  sessionKey: string;
  sessionFile: string;
  liveChatType?: string | null;
  storedChatType?: string | null;
  preferStoredPolicy?: boolean;
  hasPersistedTranscriptContent: boolean;
  runMemoryPolicy?: LongTermMemoryDefaultPolicy;
  runMemoryChatType?: ChatType;
}): SessionMemoryBoundaryPlan | null {
  const runMemoryPolicy =
    params.runMemoryPolicy ??
    resolveLongTermMemoryRunPolicy({
      sessionKey: params.sessionKey,
      liveChatType: params.liveChatType,
      storedChatType: params.storedChatType,
      longTermMemoryDefaultPolicy: params.currentEntry.longTermMemoryDefaultPolicy,
      preferStoredPolicy: params.preferStoredPolicy,
    });
  const runMemoryChatType =
    params.runMemoryChatType ??
    resolveLongTermMemoryTargetChatType({
      sessionKey: params.sessionKey,
      liveChatType: params.liveChatType,
      storedChatType: params.storedChatType,
      longTermMemoryDefaultPolicy: params.currentEntry.longTermMemoryDefaultPolicy,
      preferStoredPolicy: params.preferStoredPolicy,
    });
  const storedMemoryPolicy =
    params.currentEntry.longTermMemoryDefaultPolicy ??
    (params.hasPersistedTranscriptContent ? "include" : runMemoryPolicy);
  const needsTranscriptRotation = storedMemoryPolicy !== runMemoryPolicy;
  const needsPolicyStamp =
    params.currentEntry.longTermMemoryDefaultPolicy !== runMemoryPolicy &&
    (runMemoryPolicy === "explicit-only" ||
      params.currentEntry.longTermMemoryDefaultPolicy !== undefined);
  if (!needsTranscriptRotation && !needsPolicyStamp) {
    return null;
  }
  return {
    currentEntry: params.currentEntry,
    runMemoryPolicy,
    runMemoryChatType,
    nextSessionId: needsTranscriptRotation ? randomUUID() : params.currentEntry.sessionId,
    nextSessionFile: needsTranscriptRotation
      ? resolvePolicyIsolatedTranscriptPath({
          sessionFile: params.sessionFile,
          policy: runMemoryPolicy,
        })
      : params.sessionFile,
    expectedSessionFile: params.currentEntry.sessionFile,
    expectedPolicy: params.currentEntry.longTermMemoryDefaultPolicy,
    needsPolicyStamp,
    needsTranscriptRotation,
  };
}

export function resolvePolicyIsolatedTranscriptPath(params: {
  sessionFile: string;
  policy: LongTermMemoryDefaultPolicy;
}): string {
  return path.join(
    path.dirname(params.sessionFile),
    `memory-${params.policy}-${randomUUID()}.jsonl`,
  );
}
