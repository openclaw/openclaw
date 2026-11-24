import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("system prompt messaging routing", () => {
  it("routes local HTML publication through the available current-conversation message tool", () => {
    const prompt = (channel: string, toolNames: string[]) =>
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames,
        sourceReplyDeliveryMode: "automatic",
        runtimeInfo: { channel },
      });
    expect(prompt("webchat", ["message"])).toContain(
      "Local HTML reports: publish the final file with `message(action=send, media=<path>)`",
    );
    expect(prompt("webchat", ["read"])).not.toContain("Local HTML reports:");
    expect(prompt("telegram", ["message"])).not.toContain("Local HTML reports:");
  });

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
        "OpenClaw messaging: use messaging tools only—never shell/CLI/curl/RPC even if messaging tools are absent.",
      );
      expect(prompt).toContain("Subagents return results via their accepted completion path");
      expect(prompt).toContain(
        "External services (e.g. email) may use authorized CLI/API under normal approvals.",
      );
      expect(prompt).toContain("`message(action=react, final=true)`");
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
