import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("system prompt messaging routing", () => {
  it.each(["full", "minimal"] as const)(
    "keeps messaging routing and terminal reactions in %s prompts",
    (promptMode) => {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        promptMode,
        sourceReplyDeliveryMode: "message_tool_only",
        toolNames: ["exec", "message"],
        runtimeInfo: { channel: "discord" },
      });

      expect(prompt).toContain(
        "OpenClaw messaging: use available messaging tools, never shell commands, the CLI, curl, or direct RPC.",
      );
      expect(prompt).toContain("Missing messaging tools are not permission to use another route.");
      expect(prompt).toContain("Subagents return results through their accepted completion path");
      expect(prompt).toContain(
        "Other services (e.g. email): user-authorized CLI/API use is allowed",
      );
      expect(prompt).toContain("normal tool permissions and approvals still apply");
      expect(prompt).toContain(
        "or a final reaction to the current source message: `message(action=react, final=true)`",
      );
      expect(prompt).not.toContain("Provider messaging: never exec/curl");
      expect(prompt).not.toContain("NO_REPLY");
      expect(prompt).not.toContain("user explicitly requests only a reaction");
    },
  );
  it.each([
    { channel: "telegram", chatType: "direct", mode: "automatic", silent: true },
    { channel: "discord", chatType: "group", mode: "automatic", silent: true },
    { channel: "telegram", chatType: "direct", mode: "message_tool_only", silent: false },
    { channel: "webchat", chatType: "direct", mode: "automatic", silent: false },
  ] as const)("keeps explicit silence guidance scoped to $channel/$mode", (testCase) => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      sourceReplyDeliveryMode: testCase.mode,
      toolNames: ["message"],
      runtimeInfo: { channel: testCase.channel, chatType: testCase.chatType },
    });
    expect(prompt.includes("## Silent Replies")).toBe(testCase.silent);
    expect(prompt.includes("Only that whole reply is silent.")).toBe(testCase.silent);
  });

  it("omits silence guidance for a private completion on an external channel", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      sourceReplyDeliveryMode: "message_tool_only",
      silentReplyPromptMode: "none",
      toolNames: ["message"],
      runtimeInfo: { channel: "telegram" },
    });
    expect(prompt).not.toContain("NO_REPLY");
    expect(prompt).not.toContain("## Silent Replies");
  });
});
