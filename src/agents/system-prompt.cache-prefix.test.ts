import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { formatSkillsForPromptCore } from "../skills/loading/skill-contract.js";
import { prepareSkillsForPrompt } from "../skills/loading/skill-prompt-limits.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { composeSystemPromptWithHookContext } from "./embedded-agent-runner/run/attempt-thread-helpers.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture<"openai-completions">({
  id: "local-model",
  provider: "custom-local",
  api: "openai-completions",
  baseUrl: "https://local.example/v1",
});
const tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
const coauthor = "When committing, add Co-authored-by: Example User <user@example.com>.";
const hookInstruction = "Always keep the project instruction in its original role.";
type PromptOptions = Omit<Parameters<typeof buildAgentSystemPrompt>[0], "workspaceDir">;
const render = (params: PromptOptions) =>
  buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", ...params });

function request(session: string, workspaceText = "Project instructions.") {
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
    { ...model, compat: { supportsDeveloperRole: true } },
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

function expectMessage(message: unknown, role: string, ...contents: string[]) {
  for (const text of contents) {
    expect(message).toMatchObject({ role, content: expect.stringContaining(text) });
  }
}

it.each([false, true])("preserves system authority with literal markers=%s", (markers) => {
  const first = request(
    "alpha",
    markers
      ? "Project instructions.\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\nDocumented example.\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->\nKeep project policy."
      : undefined,
  );
  expectMessage(first.messages[0], "system", coauthor, hookInstruction);
  expectMessage(
    first.messages[0],
    "system",
    "Empty or none reports no items for that snapshot's scope and time; it does not prove unqueried work is absent, establish global inactivity, or show whether earlier work ran.",
  );
  expect(JSON.stringify(first.messages[0])).not.toContain("none means no active work");
  expect(JSON.stringify(first.messages)).not.toMatch(
    /OPENCLAW_CACHE_BOUNDARY|OPENCLAW-RELOCATABLE-BOUNDARY/,
  );
  if (markers) {
    expect(first.messages).toHaveLength(2);
    expect(first.messages[1]).toEqual({ role: "user", content: "hello" });
    expectMessage(first.messages[0], "system", "Keep project policy.", "session=alpha");
  } else {
    const second = request("beta");
    expect(first.messages[0]).toEqual(second.messages[0]);
    expect(first.tools).toEqual(second.tools);
    expect(first.tools).toHaveLength(1);
    expectMessage(first.messages[0], "system", "Reasoning=");
    expectMessage(first.messages[1], "user", "session=alpha");
    expectMessage(second.messages[1], "user", "session=beta");
  }
});

const demo = createFixtureSkillEntry("demo").skill;
function renderSkills(toolNames: string[], skillsPrompt: string, codeModeActive = false) {
  return render({
    toolNames: codeModeActive ? ["exec"] : toolNames,
    capabilityToolNames: toolNames,
    skillsPrompt,
    codeModeActive,
  });
}

it.each([false, true])("uses Code Mode skill access only when admitted (%s)", (admitted) => {
  const prompt = renderSkills(
    admitted ? ["skills_search", "skills_read"] : ["read"],
    formatSkillsForPromptCore([demo]),
    true,
  );
  if (admitted) {
    expect(prompt).toContain('`skills.read("<name>")`');
    expect(prompt).toContain("skills.search(query)");
    expect(prompt).not.toContain("read exact <location> with `read`");
  } else {
    expect(prompt).not.toMatch(
      /## Skills|<available_skills>|read exact <location>|skills\.(read|search)\(/,
    );
  }
});

it.each(["", prepareSkillsForPrompt({ skills: [demo], maxSkillsInPrompt: 0 }).prompt])(
  "guides discovery without listed entries: %s",
  (skillsPrompt) => {
    const prompt = renderSkills(["skills_search", "skills_read"], skillsPrompt);
    expect(prompt).toContain("skills_search");
    expect(prompt).toContain("skills_read");
    expect(prompt).not.toMatch(/Scan <available_skills>|use a listed match/);
    const denied = renderSkills(["read"], skillsPrompt);
    expect(denied).not.toMatch(
      /skills_search|skills\.search\(|Scan <available_skills>|read exact <location>/,
    );
    if (skillsPrompt) {
      expect(prompt).toContain(skillsPrompt);
      expect(denied).toContain(skillsPrompt);
    } else {
      expect(denied).not.toContain("## Skills");
    }
  },
);

it("adds Ultra orchestration only when sessions_spawn is callable", () => {
  const base: PromptOptions = { toolNames: ["sessions_spawn"], subagentDelegationMode: "prefer" };
  const ultra = (params: PromptOptions = {}) =>
    render({ ...base, ...params, proactiveSubagentOrchestration: true });
  const heading = "## Proactive Sub-Agent Orchestration";
  expect(render(base)).not.toContain(heading);
  const prompt = ultra();
  expect(prompt).toContain(heading);
  expect(prompt).toContain("Ultra active");
  expect(prompt).not.toContain("Mode: prefer");
  expect(ultra({ toolNames: ["tool_search"], capabilityToolNames: ["sessions_spawn"] })).toContain(
    heading,
  );
  expect(ultra({ promptMode: "minimal" })).toContain(heading);
  const unavailable = ultra({ toolNames: ["subagents"] });
  expect(unavailable).not.toContain(heading);
  expect(unavailable).toContain("## Ultra Execution");
  expect(unavailable).toContain("verify the result before replying");
  expect(unavailable).not.toContain("Use `sessions_spawn` when independent work");
  expect(ultra({ promptMode: "none" })).not.toContain(heading);
});
