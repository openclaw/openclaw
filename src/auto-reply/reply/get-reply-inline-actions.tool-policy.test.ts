import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const handleCommandsMock = vi.fn();
const gatewayExecuteMock = vi.fn();
const readExecuteMock = vi.fn();

vi.mock("./commands.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: vi.fn(),
  buildCommandContext: vi.fn(),
}));

vi.mock("../../agents/openclaw-tools.js", () => ({
  createOpenClawTools: () => [
    {
      name: "gateway",
      ownerOnly: true,
      execute: gatewayExecuteMock,
    },
    {
      name: "read",
      execute: readExecuteMock,
    },
  ],
}));

const { handleInlineActions } = await import("./get-reply-inline-actions.js");
type HandleInlineActionsInput = Parameters<typeof handleInlineActions>[0];

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

const skillCommands: SkillCommandSpec[] = [
  {
    name: "danger-skill",
    skillName: "danger-skill",
    description: "Direct tool dispatch",
    dispatch: {
      kind: "tool",
      toolName: "gateway",
    },
  },
];

function createInput(): HandleInlineActionsInput {
  const ctx = buildTestCtx({
    Body: "/danger-skill test",
    CommandBody: "/danger-skill test",
    Provider: "whatsapp",
    Surface: "whatsapp",
    From: "whatsapp:+123",
    To: "whatsapp:+123",
  });
  return {
    ctx,
    sessionCtx: ctx as unknown as TemplateContext,
    cfg: {
      commands: { text: true },
      tools: {
        deny: ["gateway"],
      },
    },
    agentId: "main",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    isGroup: false,
    typing: createTypingController(),
    allowTextCommands: true,
    inlineStatusRequested: false,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "owner-1",
      abortKey: "whatsapp:+123",
      rawBodyNormalized: "/danger-skill test",
      commandBodyNormalized: "/danger-skill test",
      from: "whatsapp:+123",
      to: "whatsapp:+123",
    },
    directives: clearInlineDirectives("/danger-skill test"),
    cleanedBody: "/danger-skill test",
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultActivation: () => "always",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: undefined,
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => "off",
    provider: "openai",
    model: "gpt-4o-mini",
    contextTokens: 0,
    abortedLastRun: false,
    sessionScope: "per-sender",
    skillCommands,
  };
}

describe("handleInlineActions skill tool dispatch", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset();
    gatewayExecuteMock.mockReset().mockResolvedValue({ content: "EXECUTED" });
    readExecuteMock.mockReset().mockResolvedValue({ content: "READ" });
  });

  it("applies the tool policy pipeline before direct /skill tool execution", async () => {
    const result = await handleInlineActions(createInput());

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "❌ Tool not available: gateway" },
    });
    expect(gatewayExecuteMock).not.toHaveBeenCalled();
  });
});
