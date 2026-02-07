import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";

const {
  createOpenClawToolsMock,
  executeToolWithErrorHandlingMock,
  resolveSkillCommandInvocationMock,
  listSkillCommandsForWorkspaceMock,
} = vi.hoisted(() => ({
  createOpenClawToolsMock: vi.fn(),
  executeToolWithErrorHandlingMock: vi.fn(),
  resolveSkillCommandInvocationMock: vi.fn(),
  listSkillCommandsForWorkspaceMock: vi.fn(),
}));

vi.mock("../../agents/openclaw-tools.js", () => ({
  createOpenClawTools: createOpenClawToolsMock,
}));

vi.mock("../../agents/tools/execute-tool.js", () => ({
  executeToolWithErrorHandling: executeToolWithErrorHandlingMock,
}));

vi.mock("../skill-commands.js", () => ({
  resolveSkillCommandInvocation: resolveSkillCommandInvocationMock,
  listSkillCommandsForWorkspace: listSkillCommandsForWorkspaceMock,
}));

describe("handleInlineActions skill tool dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes /skill-name tool dispatch through unified execution", async () => {
    const tool: AnyAgentTool = {
      name: "demo_tool",
      label: "demo_tool",
      description: "Demo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };

    createOpenClawToolsMock.mockReturnValue([tool]);
    listSkillCommandsForWorkspaceMock.mockReturnValue([{ name: "demo" }]);
    resolveSkillCommandInvocationMock.mockReturnValue({
      command: {
        name: "demo",
        skillName: "demo-skill",
        dispatch: { kind: "tool", toolName: "demo_tool" },
      },
      args: "hello world",
    });
    executeToolWithErrorHandlingMock.mockResolvedValue({
      result: { content: [{ type: "text", text: '{"status":"ok"}' }] },
      aborted: false,
      error: {
        message: "boom",
      },
    });

    const result = await handleInlineActions({
      ctx: {
        Surface: "telegram",
        Provider: "telegram",
        To: "chat-id",
      } as never,
      sessionCtx: {} as never,
      cfg: {} as never,
      agentId: "agent-1",
      sessionKey: "session-1",
      sessionScope: {} as never,
      workspaceDir: process.cwd(),
      isGroup: false,
      typing: { cleanup: vi.fn() } as never,
      allowTextCommands: true,
      inlineStatusRequested: false,
      command: {
        commandBodyNormalized: "/demo hello world",
        isAuthorizedSender: true,
      } as never,
      directives: {} as never,
      cleanedBody: "/demo hello world",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "on",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "high",
      resolvedElevatedLevel: "off",
      resolveDefaultThinkingLevel: async () => "low",
      provider: "openai",
      model: "gpt-5",
      contextTokens: 0,
      abortedLastRun: false,
    });

    expect(executeToolWithErrorHandlingMock).toHaveBeenCalledTimes(1);
    expect(executeToolWithErrorHandlingMock).toHaveBeenCalledWith(
      tool,
      expect.objectContaining({
        toolName: "demo_tool",
        sessionKey: "session-1",
        agentId: "agent-1",
        params: {
          command: "hello world",
          commandName: "demo",
          skillName: "demo-skill",
        },
      }),
    );

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "❌ boom" },
    });
  });
});
