import { expect, it } from "vitest";
import {
  SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
  buildSystemAgentAssistantUserPrompt,
  buildSystemAgentSystemPrompt,
  parseSystemAgentAssistantPlanText,
} from "./assistant-prompts.js";
import { createSystemAgentOverviewFixture } from "./overview.fixture.test-support.js";

function overview() {
  const base = createSystemAgentOverviewFixture();
  return {
    ...base,
    agents: [
      {
        id: "main",
        name: "Main",
        isDefault: true,
        workspace: "/tmp/main",
      },
    ],
    defaultModel: "openai/gpt-5.5",
    tools: {
      ...base.tools,
      apiKeys: { openai: true, anthropic: false },
    },
    references: {
      ...base.references,
      docsPath: "/tmp/openclaw/docs",
      sourcePath: "/tmp/openclaw",
    },
  };
}

function expectContents(prompt: string, parts: string[]) {
  for (const part of parts) {
    expect(prompt).toContain(part);
  }
}

it.each([
  ["fallback planner", SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT, "copy-only hosted flow"],
  ["primary agent loop", buildSystemAgentSystemPrompt(), "default agent's existing workspace"],
])("keeps %s within hosted setup boundaries", (_name, prompt, memoryBoundary) => {
  expectContents(prompt, [
    "cannot run normal-agent slash commands such as `/codex`",
    "never that the task, conversation, or work has already transferred",
    "running the Gateway on another machine",
    "`openclaw onboard` for fresh setup",
    "`openclaw configure` for the mode question",
    "LOCAL Gateway's port, bind, auth, and Tailscale exposure",
    memoryBoundary,
  ]);
  expect(prompt).not.toMatch(/\bask for secrets?\b/iu);
});

it.each([
  [
    'thinking... {"reply":"Aye aye.","command":"restart gateway"}',
    { reply: "Aye aye.", command: "restart gateway" },
  ],
  ['[0] {"reply":"Ready."}', { reply: "Ready." }],
  ['{"reply":"A } brace."} {"reply":"Later."}', { reply: "A } brace." }],
  ['prefix "{not-json}" {"reply":"Later."}', null],
  ['{"reply":"First.","extra":{"nested":true}} trailing }', { reply: "First." }],
  ["I would edit config directly.", null],
  ["{}", null],
  ['{"reply":"just chatting"}', { reply: "just chatting" }],
])("parses only the first valid object plan: %s", (input, expected) => {
  expect(parseSystemAgentAssistantPlanText(input)).toEqual(expected);
});

it("includes only operational summary context in planner prompts", () => {
  const prompt = buildSystemAgentAssistantUserPrompt({
    input: "fix my setup",
    overview: overview(),
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
