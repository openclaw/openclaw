import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const handleCommandsMock = vi.fn();
const state = {
  invocation: null as {
    command: {
      name: string;
      skillName: string;
      description: string;
      dispatch: { kind: "tool"; toolName: string; argMode: "raw" };
    };
    args?: string;
  } | null,
  skillCommands: [] as Array<{ name: string; skillName: string; description: string }>,
  // oxlint-disable-next-line typescript/no-explicit-any
  tools: [] as Array<any>,
};

vi.mock("./commands.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: vi.fn(),
  buildCommandContext: vi.fn(),
}));

vi.mock("../skill-commands.js", () => ({
  listReservedChatSlashCommandNames: () => new Set<string>(),
  listSkillCommandsForWorkspace: () => state.skillCommands,
  resolveSkillCommandInvocation: () => state.invocation,
}));

vi.mock("../../agents/openclaw-tools.js", () => ({
  createOpenClawTools: () => state.tools,
}));

vi.mock("../../agents/tool-policy.js", () => ({
  applyOwnerOnlyToolPolicy: (tools: unknown[]) => tools,
}));

// Import after mocks.
const { handleInlineActions } = await import("./get-reply-inline-actions.js");

function createTypingController() {
  const typing: TypingController = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
  return typing;
}

async function runInlineSkillDispatch(params?: { cfg?: OpenClawConfig }) {
  const typing = createTypingController();
  const ctx = buildTestCtx({
    Body: "/danger echo hello",
    CommandBody: "/danger echo hello",
    From: "whatsapp:+123",
    To: "whatsapp:+123",
    CommandAuthorized: true,
  });

  const result = await handleInlineActions({
    ctx,
    sessionCtx: ctx as unknown as TemplateContext,
    cfg: params?.cfg ?? {},
    agentId: "main",
    sessionKey: "s:main",
    workspaceDir: "/tmp",
    isGroup: false,
    typing,
    allowTextCommands: true,
    inlineStatusRequested: false,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      ownerList: ["whatsapp:+123"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "whatsapp:+123",
      abortKey: "whatsapp:+123",
      rawBodyNormalized: "/danger echo hello",
      commandBodyNormalized: "/danger echo hello",
      from: "whatsapp:+123",
      to: "whatsapp:+123",
    },
    directives: clearInlineDirectives("/danger echo hello"),
    cleanedBody: "/danger echo hello",
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
    model: "gpt-5",
    contextTokens: 0,
    abortedLastRun: false,
    sessionScope: "per-sender",
  });

  return { result, typing };
}

describe("handleInlineActions skill tool dispatch policy", () => {
  it("blocks high-risk tool dispatch by default", async () => {
    handleCommandsMock.mockReset();
    const execute = vi.fn();
    state.tools = [{ name: "exec", execute }];
    state.skillCommands = [{ name: "danger", skillName: "danger-skill", description: "Danger" }];
    state.invocation = {
      command: {
        name: "danger",
        skillName: "danger-skill",
        description: "Danger",
        dispatch: { kind: "tool", toolName: "exec", argMode: "raw" },
      },
      args: "echo hello",
    };

    const { result, typing } = await runInlineSkillDispatch();
    expect(result.kind).toBe("reply");
    if (result.kind === "reply" && !Array.isArray(result.reply)) {
      expect(result.reply?.text).toContain("blocked");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalled();
  });

  it("allows blocked tools when explicitly allowlisted", async () => {
    handleCommandsMock.mockReset();
    const execute = vi.fn().mockResolvedValue({ content: "ok" });
    state.tools = [{ name: "exec", execute }];
    state.skillCommands = [{ name: "danger", skillName: "danger-skill", description: "Danger" }];
    state.invocation = {
      command: {
        name: "danger",
        skillName: "danger-skill",
        description: "Danger",
        dispatch: { kind: "tool", toolName: "exec", argMode: "raw" },
      },
      args: "echo hello",
    };

    const { result } = await runInlineSkillDispatch({
      cfg: {
        skills: {
          commandDispatch: {
            allowTools: ["exec"],
          },
        },
      },
    });

    expect(result.kind).toBe("reply");
    if (result.kind === "reply" && !Array.isArray(result.reply)) {
      expect(result.reply?.text).toBe("ok");
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      command: "echo hello",
      commandName: "danger",
      skillName: "danger-skill",
    });
  });
});
