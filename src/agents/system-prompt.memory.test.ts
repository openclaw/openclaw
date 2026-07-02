// System prompt memory tests cover opt-out behavior when context engines own
// memory prompt assembly for a run.
import { afterEach, describe, expect, it } from "vitest";
import { clearMemoryPluginState, registerMemoryPromptSection } from "../plugins/memory-state.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt memory guidance", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("can suppress base memory guidance so context engines own memory prompt assembly", () => {
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully.", ""]);

    const promptWithMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });
    const promptWithoutMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      includeMemorySection: false,
    });

    expect(promptWithMemory).toContain("## Memory Recall");
    expect(promptWithoutMemory).not.toContain("## Memory Recall");
  });

  it("passes the runtime session key and chat type to memory prompt builders", () => {
    registerMemoryPromptSection(({ sessionKey, chatType }) => [
      "## Memory Recall",
      `session=${sessionKey ?? "missing"}`,
      `chatType=${chatType ?? "missing"}`,
      "",
    ]);

    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        sessionKey: "agent:main:acp:binding:telegram:acct:abc123",
        chatType: "group",
      },
    });

    expect(prompt).toContain("session=agent:main:acp:binding:telegram:acct:abc123");
    expect(prompt).toContain("chatType=group");
  });
});
