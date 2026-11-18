import { expect, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { resolveReplyDirectives } from "./get-reply-directives.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { createTypingController } from "./typing.js";

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

    typing: makeTypingController(),
    ...overrides,
  };
}

export function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session-id", updatedAt: Date.now(), ...overrides };
}

export function makeTypingController() {
  return { ...createTypingController({}), cleanup: vi.fn() };
}

export function mockCallInput(
  mock: { mock: { calls: unknown[][] } },
  index = 0,
): Record<string, unknown> {
  const input = mock.mock.calls[index]?.[0];
  if (!input || typeof input !== "object") {
    throw new Error(`expected mock input ${index}`);
  }
  return input as Record<string, unknown>;
}

export async function expectContinueResult(
  value: Awaited<ReturnType<typeof resolveReplyDirectives>>,
  fields: Record<string, unknown>,
) {
  if (value.kind !== "continue") {
    throw new Error(`expected continue result, got ${value.kind}`);
  }
  const levels = Object.hasOwn(fields, "resolvedReasoningLevel")
    ? await value.result.resolveModelLevels()
    : {};
  expect({ ...value.result, ...levels }).toMatchObject(fields);
}

export function parseInlineDirectivesForTargetSessionTest(body: string) {
  const normalized = body.trim();
  const modelDirective = normalized.match(/(?:^|\n)\/model\s+(\S+)/)?.[1];
  const reasoning = !modelDirective && normalized === "/reasoning stream";
  return {
    cleaned: modelDirective
      ? normalized.replace(/(?:^|\n)\/model\s+\S+/, "").trim()
      : reasoning
        ? ""
        : body,
    hasThinkDirective: false,
    hasVerboseDirective: false,
    hasTraceDirective: false,
    hasFastDirective: false,
    hasReasoningDirective: reasoning,
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasModelDirective: Boolean(modelDirective),
    hasQueueDirective: false,
    hasStatusDirective: false,
    queueReset: false,
    ...(modelDirective ? { rawModelDirective: modelDirective } : {}),
    ...(reasoning ? { reasoningLevel: "stream", rawReasoningLevel: "stream" } : {}),
  };
}
