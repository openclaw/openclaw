import type { Model } from "@openclaw/ai";
import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { composeSystemPromptWithHookContext } from "./embedded-agent-runner/run/attempt-thread-helpers.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const model: Model<"openai-completions"> = {
  id: "local-model",
  name: "Local model",
  provider: "custom-local",
  api: "openai-completions",
  baseUrl: "https://local.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 1024,
};
const tools = [
  { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
];
const coauthor = "When committing, add Co-authored-by: Example User <user@example.com>.";
const hookInstruction = "Always keep the project instruction in its original role.";

function request(session: string, reasoning = false, workspaceText = "Project instructions.") {
  const baseSystemPrompt = buildAgentSystemPrompt({
    workspaceDir: "/tmp/project",
    toolNames: ["read", "message"],
    runtimeInfo: {
      agentId: "main",
      sessionKey: session,
      sessionId: session,
      gitCoauthorPrompt: coauthor,
    },
    contextFiles: [{ path: "/tmp/project/AGENTS.md", content: workspaceText }],
  });
  return buildOpenAICompletionsParams(
    { ...model, reasoning, compat: { supportsDeveloperRole: true } },
    {
      systemPrompt: composeSystemPromptWithHookContext({
        baseSystemPrompt,
        appendSystemContext: hookInstruction,
      }),
      tools,
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    },
    undefined,
  );
}

describe("system prompt through local Completions", () => {
  it.each([false, true])(
    "preserves the system and tools prefix with developer role %s",
    (reasoning) => {
      const first = request("alpha", reasoning);
      const second = request("beta", reasoning);

      expect(first.messages[0]).toEqual(second.messages[0]);
      expect(first.tools).toEqual(second.tools);
      expect(first.tools).toHaveLength(1);
      expect(first.messages[0]).toMatchObject({
        role: reasoning ? "developer" : "system",
        content: expect.stringContaining(coauthor),
      });
      expect(first.messages[0]).toMatchObject({
        content: expect.stringContaining(hookInstruction),
      });
      expect(first.messages[0]).toMatchObject({ content: expect.stringContaining("Reasoning=") });
      expect(first.messages[1]).toMatchObject({
        role: "user",
        content: expect.stringContaining("session=alpha"),
      });
      expect(second.messages[1]).toMatchObject({
        role: "user",
        content: expect.stringContaining("session=beta"),
      });
      expect(JSON.stringify(first.messages)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
      expect(JSON.stringify(first.messages)).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
    },
  );

  it("keeps composed instructions at system authority when context contains literal markers", () => {
    const result = request(
      "alpha",
      false,
      "Project instructions.\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\nDocumented example.\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->\nKeep project policy.",
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({ role: "user", content: "hello" });
    for (const instruction of [
      "Keep project policy.",
      coauthor,
      hookInstruction,
      "session=alpha",
    ]) {
      expect(result.messages[0]).toMatchObject({
        role: "system",
        content: expect.stringContaining(instruction),
      });
    }
    expect(JSON.stringify(result.messages)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    expect(JSON.stringify(result.messages)).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
  });
});
