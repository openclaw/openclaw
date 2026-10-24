import { describe, expect, it } from "vitest";
import {
  SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
  buildSystemAgentAssistantUserPrompt,
  buildSystemAgentSystemPrompt,
  parseSystemAgentAssistantPlanText,
} from "./assistant-prompts.js";
import type { SystemAgentOverview } from "./overview.js";

function overview(configured = false): SystemAgentOverview {
  return {
    config: {
      path: "/tmp/openclaw.json",
      exists: configured,
      valid: configured,
      issues: [],
      hash: configured ? "hash" : null,
    },
    agents: configured
      ? [
          {
            id: "main",
            name: "Main",
            isDefault: true,
            model: "openai/gpt-5.5",
            workspace: "/tmp/main",
          },
        ]
      : [],
    defaultAgentId: configured ? "main" : "default",
    ...(configured ? { defaultModel: "openai/gpt-5.5" } : {}),
    tools: {
      codex: {
        command: "codex",
        found: configured,
        ...(configured ? { version: "codex 1.0.0" } : {}),
      },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: configured, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:14567", source: "local loopback", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
      ...(configured ? { docsPath: "/tmp/openclaw/docs", sourcePath: "/tmp/openclaw" } : {}),
    },
  };
}

function expectContents(prompt: string, parts: string[]) {
  for (const part of parts) {
    expect(prompt).toContain(part);
  }
}

describe("OpenClaw assistant", () => {
  it("teaches both planner and agent-loop prompts about hosted setup flows", () => {
    expectContents(SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT, [
      "- configure skills",
      "- configure search",
      "- open search wizard",
      "- configure gateway",
      "- open gateway wizard",
      "- memory import",
      "copy-only hosted flow",
    ]);
    expectContents(buildSystemAgentSystemPrompt(), [
      "call configure_skills",
      "call configure_search",
      "call configure_gateway",
      "call import_memory",
      "default agent's existing workspace",
    ]);
  });

  it("does not tell the fallback planner to solicit secrets", () => {
    expect(SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT).not.toMatch(/\bask for secrets?\b/iu);
  });

  it.each([
    ["fallback planner", SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT],
    ["primary agent loop", buildSystemAgentSystemPrompt()],
  ])("keeps normal-agent slash commands out of %s", (_name, prompt) => {
    expect(prompt).toContain("cannot run normal-agent slash commands such as `/codex`");
    expect(prompt).toContain("never that the task, conversation, or work has already transferred");
  });
  it("keeps remote Gateway mode outside both hosted chat planners", () => {
    for (const prompt of [SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT, buildSystemAgentSystemPrompt()]) {
      expect(prompt).toContain("running the Gateway on another machine");
      expect(prompt).toContain("`openclaw onboard` for fresh setup");
      expect(prompt).toContain("`openclaw configure` for the mode question");
      expect(prompt).toContain("LOCAL Gateway's port, bind, auth, and Tailscale exposure");
    }
  });

  it("parses the first compact JSON command", () => {
    expect(
      parseSystemAgentAssistantPlanText(
        'thinking... {"reply":"Aye aye.","command":"restart gateway"}',
      ),
    ).toEqual({ reply: "Aye aye.", command: "restart gateway" });
  });

  it.each([
    ['[0] {"reply":"Ready."}', { reply: "Ready." }],
    ['{"reply":"A } brace."} {"reply":"Later."}', { reply: "A } brace." }],
    ['prefix "{not-json}" {"reply":"Later."}', null],
    ['{"reply":"First.","extra":{"nested":true}} trailing }', { reply: "First." }],
  ])("preserves object-only, first-object extraction: %s", (input, expected) => {
    expect(parseSystemAgentAssistantPlanText(input)).toEqual(expected);
  });

  it("rejects non-JSON and empty plans but accepts chat-only replies", () => {
    expect(parseSystemAgentAssistantPlanText("I would edit config directly.")).toBeNull();
    expect(parseSystemAgentAssistantPlanText("{}")).toBeNull();
    expect(parseSystemAgentAssistantPlanText('{"reply":"just chatting"}')).toEqual({
      reply: "just chatting",
    });
  });

  it("includes only operational summary context in planner prompts", () => {
    const prompt = buildSystemAgentAssistantUserPrompt({
      input: "fix my setup",
      overview: overview(true),
    });

    expectContents(prompt, [
      "User request: fix my setup",
      "Default model: openai/gpt-5.5",
      "id=main, name=Main, workspace=/tmp/main",
      "OpenAI API key: found",
      "OpenClaw docs: /tmp/openclaw/docs",
      "OpenClaw source: /tmp/openclaw",
    ]);
  });
});
