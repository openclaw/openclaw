// Crestodian assistant prompt tests cover UTF-16-safe history truncation.
import { describe, expect, it } from "vitest";
import { buildCrestodianAssistantUserPrompt } from "./assistant-prompts.js";
import type { CrestodianOverview } from "./overview.js";

function overview(): CrestodianOverview {
  return {
    config: {
      path: "/tmp/openclaw.json",
      exists: false,
      valid: false,
      issues: [],
      hash: null,
    },
    agents: [],
    defaultAgentId: "default",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:14567",
      source: "local loopback",
      reachable: false,
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
}

const HISTORY_TURN_MAX_CHARS = 500;

describe("buildCrestodianAssistantUserPrompt history truncation", () => {
  it("includes short history turns without truncation", () => {
    const prompt = buildCrestodianAssistantUserPrompt({
      input: "test",
      overview: overview(),
      history: [{ role: "user", text: "hello" }],
    });
    expect(prompt).toContain("User: hello");
  });

  it("truncates long history turns instead of splitting surrogate pairs", () => {
    const emoji = "🎉";
    const padBefore = "a".repeat(HISTORY_TURN_MAX_CHARS - 1);
    const padAfter = "b".repeat(50);
    const text = `${padBefore}${emoji}${padAfter}`;
    const prompt = buildCrestodianAssistantUserPrompt({
      input: "test",
      overview: overview(),
      history: [{ role: "user", text }],
    });
    expect(prompt).not.toContain("\uFFFD");
  });

  it("keeps multi-emoji text intact at truncation boundary", () => {
    const emojis = "🎉🦀🐚";
    const padBefore = "a".repeat(HISTORY_TURN_MAX_CHARS - 2);
    const padAfter = "c".repeat(80);
    const text = `${padBefore}${emojis}${padAfter}`;
    const prompt = buildCrestodianAssistantUserPrompt({
      input: "test",
      overview: overview(),
      history: [{ role: "user", text }],
    });
    expect(prompt).not.toContain("\uFFFD");
    expect(prompt).toContain("…");
  });
});
