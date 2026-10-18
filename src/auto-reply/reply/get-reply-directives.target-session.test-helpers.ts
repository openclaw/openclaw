import { expect, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { resolveReplyDirectives } from "./get-reply-directives.js";
import { prepareReplyConversation } from "./prompt-session-context.js";

type DirectiveParams = Parameters<typeof resolveReplyDirectives>[0];

export function replyDirectiveParams(
  overrides: Pick<DirectiveParams, "ctx" | "sessionCtx" | "sessionEntry"> &
    Partial<DirectiveParams>,
): DirectiveParams {
  const sessionKey = overrides.sessionKey ?? "agent:main:whatsapp:+2000";
  const sessionStore = overrides.sessionStore ?? {};
  return {
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: {},
    sessionStore,
    sessionKey,
    storePath: "/tmp/sessions.json",
    sessionScope: "per-sender",
    conversation: prepareReplyConversation({
      ctx: overrides.sessionCtx,
      sessionEntry: sessionStore[sessionKey] ?? overrides.sessionEntry,
      isHeartbeat: overrides.opts?.isHeartbeat,
    }),
    isGroup: false,
    triggerBodyNormalized: "hello",
    resetTriggered: false,
    commandAuthorized: false,
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "openai",
    model: "gpt-4o-mini",
    hasResolvedHeartbeatModelOverride: false,
    typing: makeTypingController(),
    ...overrides,
  };
}

export function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

export function mockCallInput(
  mock: { mock: { calls: unknown[][] } },
  index = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  const input = call[0];
  if (!input || typeof input !== "object") {
    throw new Error(`expected mock input ${index}`);
  }
  return input as Record<string, unknown>;
}

export async function expectContinueResult(
  value: Awaited<ReturnType<typeof resolveReplyDirectives>>,
  fields: Record<string, unknown>,
) {
  expect(value.kind).toBe("continue");
  if (value.kind !== "continue") {
    throw new Error(`expected continue result, got ${value.kind}`);
  }
  const levels = Object.hasOwn(fields, "resolvedReasoningLevel")
    ? await value.result.resolveModelLevels()
    : {};
  const result = { ...value.result, ...levels };
  for (const [key, expected] of Object.entries(fields)) {
    expect(result[key as keyof typeof result]).toEqual(expected);
  }
}

export function parseInlineDirectivesForTargetSessionTest(body: string) {
  const base = {
    cleaned: body,
    hasThinkDirective: false,
    hasVerboseDirective: false,
    hasTraceDirective: false,
    traceLevel: undefined,
    rawTraceLevel: undefined,
    hasFastDirective: false,
    hasReasoningDirective: false,
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasModelDirective: false,
    hasQueueDirective: false,
    hasStatusDirective: false,
    queueReset: false,
    thinkLevel: undefined,
    verboseLevel: undefined,
    fastMode: undefined,
    reasoningLevel: undefined,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
    rawModelDirective: undefined,
  };
  const normalized = body.trim();
  const modelDirective = normalized.match(/(?:^|\n)\/model\s+(\S+)/)?.[1];
  if (modelDirective) {
    return {
      ...base,
      cleaned: normalized.replace(/(?:^|\n)\/model\s+\S+/, "").trim(),
      hasModelDirective: true,
      rawModelDirective: modelDirective,
    };
  }
  if (normalized === "/reasoning stream") {
    return {
      ...base,
      cleaned: "",
      hasReasoningDirective: true,
      reasoningLevel: "stream",
      rawReasoningLevel: "stream",
    };
  }
  return base;
}
