import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const handleCommandsMock = vi.fn();
const createOpenClawCodingToolsMock = vi.fn();

vi.mock("../../agents/pi-tools.js", () => ({
  createOpenClawCodingTools: (...args: unknown[]) => createOpenClawCodingToolsMock(...args),
}));

vi.mock("./commands.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: vi.fn(),
  buildCommandContext: vi.fn(),
}));

const { handleInlineActions } = await import("./get-reply-inline-actions.js");
type HandleInlineActionsInput = Parameters<typeof handleInlineActions>[0];

function createTypingController(): TypingController {
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

function createInput(params: {
  commandBody: string;
  skillCommands: SkillCommandSpec[];
}): HandleInlineActionsInput {
  const ctx = buildTestCtx({
    Body: params.commandBody,
    CommandBody: params.commandBody,
    Provider: "whatsapp",
  });
  const cleanedBody = params.commandBody;

  return {
    ctx,
    sessionCtx: ctx as unknown as TemplateContext,
    cfg: { tools: { profile: "messaging" } },
    agentId: "main",
    sessionKey: "agent:main:whatsapp:+15550001",
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
      senderIsOwner: false,
      isAuthorizedSender: true,
      senderId: "user-1",
      abortKey: "user-1",
      rawBodyNormalized: params.commandBody,
      commandBodyNormalized: params.commandBody,
      from: "whatsapp:+15550001",
      to: "whatsapp:+15550001",
    },
    directives: clearInlineDirectives(cleanedBody),
    cleanedBody,
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
    model: "gpt-5.2",
    contextTokens: 0,
    abortedLastRun: false,
    sessionScope: "per-sender",
    skillCommands: params.skillCommands,
  };
}

describe("handleInlineActions skill tool dispatch policy", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset();
    createOpenClawCodingToolsMock.mockReset();
  });

  it("rejects dispatch when requested tool is filtered out by policy", async () => {
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "message",
        execute: vi.fn(),
      },
    ]);

    const skillCommands: SkillCommandSpec[] = [
      {
        name: "hello_world",
        skillName: "hello-world",
        description: "Run hello world script",
        dispatch: { kind: "tool", toolName: "exec", argMode: "raw" },
      },
    ];

    const result = await handleInlineActions(
      createInput({
        commandBody: "/hello_world echo hello",
        skillCommands,
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "❌ Tool not available: exec" } });
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("executes dispatch when tool is available after policy filtering", async () => {
    const execute = vi.fn(async () => ({ content: "Hello World\n" }));
    createOpenClawCodingToolsMock.mockReturnValue([{ name: "exec", execute }]);

    const skillCommands: SkillCommandSpec[] = [
      {
        name: "hello_world",
        skillName: "hello-world",
        description: "Run hello world script",
        dispatch: { kind: "tool", toolName: "exec", argMode: "raw" },
      },
    ];

    const result = await handleInlineActions(
      createInput({
        commandBody: "/hello_world python3 scripts/hello_world.py",
        skillCommands,
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "Hello World" } });
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^cmd_/),
      expect.objectContaining({
        command: "python3 scripts/hello_world.py",
        commandName: "hello_world",
        skillName: "hello-world",
      }),
    );
  });
});
