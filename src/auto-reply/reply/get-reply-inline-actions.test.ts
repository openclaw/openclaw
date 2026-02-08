import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { CommandContext } from "./commands-types.js";
import type { InlineDirectives } from "./directive-handling.js";
import type { TypingController } from "./typing.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";

// Mock handleCommands so we can count calls and control return values.
const handleCommandsMock = vi.fn();
vi.mock("./commands.js", () => ({
  buildStatusReply: vi.fn(),
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

// Mock extractInlineSimpleCommand to simulate envelope-formatted bodies.
const extractInlineMock = vi.fn();
vi.mock("./reply-inline.js", () => ({
  extractInlineSimpleCommand: (...args: unknown[]) => extractInlineMock(...args),
}));

// Stub isDirectiveOnly to return false (no directive-only messages).
vi.mock("./directive-handling.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    isDirectiveOnly: () => false,
  };
});

// Stub channel dock to avoid side-effects.
vi.mock("../../channels/dock.js", () => ({
  getChannelDock: () => null,
}));

// Stub skill commands.
vi.mock("../skill-commands.js", () => ({
  listSkillCommandsForWorkspace: () => [],
  resolveSkillCommandInvocation: () => null,
}));

function makeTyping(): TypingController {
  return {
    onReplyStart: vi.fn().mockResolvedValue(undefined),
    startTypingLoop: vi.fn().mockResolvedValue(undefined),
    startTypingOnText: vi.fn().mockResolvedValue(undefined),
    refreshTypingTtl: vi.fn(),
    isActive: () => false,
    cleanup: vi.fn(),
  };
}

function makeCtx(body: string): MsgContext {
  return {
    Body: body,
    CommandBody: body,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "signal",
    Surface: "signal",
  } as MsgContext;
}

function makeSessionCtx(body: string): TemplateContext {
  return {
    Body: body,
    BodyForAgent: body,
    BodyStripped: body,
  } as TemplateContext;
}

function makeCommand(rawBody: string): CommandContext {
  return {
    surface: "signal",
    channel: "signal",
    channelId: undefined,
    ownerList: ["*"],
    senderIsOwner: true,
    isAuthorizedSender: true,
    senderId: "+1234567890",
    abortKey: "agent:main:main",
    rawBodyNormalized: rawBody,
    commandBodyNormalized: rawBody,
    from: "+1234567890",
    to: "+0987654321",
  };
}

function makeDirectives(cleaned: string): InlineDirectives {
  return {
    cleaned,
    hasThinkDirective: false,
    hasVerboseDirective: false,
    hasReasoningDirective: false,
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasStatusDirective: false,
    hasModelDirective: false,
    hasProviderDirective: false,
  } as InlineDirectives;
}

describe("handleInlineActions – inline command double-send", () => {
  it("does not call handleCommands twice when inline command has non-empty cleaned body (envelope format)", async () => {
    // Simulate Signal envelope: "[Signal UserName 2026-02-06 12:08 EST] /help"
    const envelopeBody = "[Signal UserName 2026-02-06 12:08 EST] /help";
    const envelopeCleaned = "[Signal UserName 2026-02-06 12:08 EST]";

    // extractInlineSimpleCommand returns a match with non-empty cleaned (the envelope prefix)
    extractInlineMock.mockReturnValue({
      command: "/help",
      cleaned: envelopeCleaned,
    });

    // First call (inline path): command handled, reply produced
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Help text here" },
    });
    // Second call (main path): should NOT happen, but if it does, it also returns a reply
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Help text here (duplicate)" },
    });

    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(envelopeBody);
    const sessionCtx = makeSessionCtx(envelopeBody);

    const result = await handleInlineActions({
      ctx,
      sessionCtx,
      cfg: { signal: { allowFrom: ["*"] } } as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionScope: undefined,
      workspaceDir: "/tmp/test-workspace",
      isGroup: false,
      opts: { onBlockReply },
      typing: makeTyping(),
      allowTextCommands: true,
      inlineStatusRequested: false,
      command: makeCommand(envelopeBody.trim().toLowerCase()),
      directives: makeDirectives(envelopeBody),
      cleanedBody: envelopeBody,
      elevatedEnabled: true,
      elevatedAllowed: true,
      elevatedFailures: [],
      defaultActivation: () => "mention",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: undefined,
      resolveDefaultThinkingLevel: async () => undefined,
      provider: "signal",
      model: "test-model",
      contextTokens: 0,
      abortedLastRun: false,
    });

    // The inline path should send the reply via onBlockReply (line 316)
    expect(onBlockReply).toHaveBeenCalledWith({ text: "Help text here" });

    // handleCommands should only be called ONCE (for the inline command),
    // NOT twice (once inline + once at the main command path).
    expect(handleCommandsMock).toHaveBeenCalledTimes(1);

    // The result should continue to the LLM (the cleaned body is non-empty)
    expect(result.kind).toBe("continue");
  });
});
