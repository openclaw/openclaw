import type { Model } from "@openclaw/ai";
import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { formatSkillsForPromptCore } from "../skills/loading/skill-contract.js";
import { prepareSkillsForPrompt } from "../skills/loading/skill-prompt-limits.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
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
  it.each([false])("preserves the system and tools prefix with developer role %s", (reasoning) => {
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
  });

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

const demo = createFixtureSkillEntry("demo").skill;
const unlistedPrompts = [
  { label: "empty prompt", skillsPrompt: "" },
  {
    label: "zero-entry budget notice",
    skillsPrompt: prepareSkillsForPrompt({ skills: [demo], maxSkillsInPrompt: 0 }).prompt,
  },
];

describe("installed skill prompt guidance", () => {
  it.each([false, true])("uses Code Mode skill access only when admitted (%s)", (admitted) => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      codeModeActive: true,
      toolNames: ["exec"],
      capabilityToolNames: admitted ? ["skills_search", "skills_read"] : ["read"],
      skillsPrompt: formatSkillsForPromptCore([
        { ...demo, description: "Review invoices.\nCalculate tax." },
      ]),
    });
    if (admitted) {
      expect(prompt).toContain('`skills.read("<name>")`');
      expect(prompt).toContain("skills.search(query)");
      expect(prompt).not.toContain("read exact <location> with `read`");
      expect(prompt).toContain("- demo: Review invoices. Calculate tax.");
    } else {
      expect(prompt).not.toContain("skills.read(");
      expect(prompt).not.toContain("skills.search(");
    }
  });

  it.each([false, true])(
    "keeps a stable compact catalog without locations (Code Mode %s)",
    (codeModeActive) => {
      const render = (installedSkills: { name: string; description: string }[]) =>
        buildAgentSystemPrompt({
          workspaceDir: "/tmp/openclaw",
          codeModeActive,
          toolNames: codeModeActive ? ["exec"] : ["skills_search", "skills_read"],
          capabilityToolNames: ["skills_search", "skills_read"],
          skillsPrompt: formatSkillsForPromptCore([demo]),
          installedSkills,
        });
      const skills = [
        { name: "zebra", description: "Find striped animals. ".repeat(10) },
        { name: "alpha", description: "Review invoices.\nCalculate tax." },
      ];
      const prompt = render(skills);
      expect(prompt).toContain("- alpha: Review invoices. Calculate tax.\n- zebra: ");
      expect(prompt).toContain(`- zebra: ${skills[0].description.trim().slice(0, 60)}`);
      expect(prompt).not.toContain("<location>");
      expect(prompt).not.toContain(demo.filePath);
      expect(prompt).not.toContain("Before work involving files");
      expect(render(skills.toReversed())).toBe(prompt);
      expect(render(skills)).toBe(prompt);
    },
  );

  it("drops triggers before names, then falls back to the installed count", () => {
    const render = (installedSkills: { name: string; description: string }[]) =>
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: ["skills_search", "skills_read"],
        installedSkills,
      });
    const skills = Array.from({ length: 80 }, (_, index) => ({
      name: `skill-${String(index).padStart(3, "0")}`,
      description: "x".repeat(60),
    }));
    const namesOnly = render(skills);
    expect(namesOnly).toContain("- skill-000\n");
    expect(namesOnly).toContain("- skill-079");
    expect(namesOnly).not.toContain("x".repeat(60));
    const countOnly = render(
      Array.from({ length: 800 }, (_, index) => ({
        name: `skill-${index}`,
        description: "workflow",
      })),
    );
    expect(countOnly).toContain("800 skills installed; use `skills_search`.");
    expect(countOnly).not.toContain("- skill-");
  });

  it.each([
    { toolNames: ["read"] },
    { toolNames: ["read", "skills_search"] },
    { toolNames: ["read", "skills_read"] },
    { toolNames: ["skills_search", "skills_read"], promptSurface: "cli_backend" as const },
    { toolNames: ["skills_search", "skills_read"], compactSkills: false },
  ])(
    "preserves fallback directory bytes for $toolNames $promptSurface $compactSkills",
    (options) => {
      const skillsPrompt = prepareSkillsForPrompt({
        skills: [demo],
        maxSkillsInPrompt: 1,
      }).prompt.trim();
      let rendered = "";
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        skillsPrompt,
        onRenderedSkillsPrompt: (value) => {
          rendered = value;
        },
        ...options,
      });
      expect(rendered).toBe(skillsPrompt);
      expect(prompt).toContain(skillsPrompt);
      expect(prompt).toContain(`<location>${demo.filePath}</location>`);
    },
  );

  describe("without listed entries", () => {
    it.each(unlistedPrompts)("guides discovery with $label", ({ skillsPrompt }) => {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: ["skills_search", "skills_read"],
        capabilityToolNames: ["skills_search", "skills_read"],
        skillsPrompt,
      });
      expect(prompt).toContain("skills_search");
      expect(prompt).toContain("skills_read");
      expect(prompt).not.toContain("Scan <available_skills>");
      expect(prompt).not.toContain("use a listed match");
      const denied = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: ["read"],
        capabilityToolNames: ["read"],
        skillsPrompt,
      });
      expect(denied).not.toContain("skills_search");
      expect(denied).not.toContain("skills.search(");
      expect(denied).not.toContain("Scan <available_skills>");
      expect(denied).not.toContain("read exact <location>");
      if (skillsPrompt) {
        expect(denied).toContain(skillsPrompt);
      } else {
        expect(denied).not.toContain("## Skills");
      }
    });
  });
});

describe("Ultra system prompt capability", () => {
  it("adds run-scoped Ultra orchestration only when sessions_spawn is callable", () => {
    const base = {
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
      subagentDelegationMode: "prefer",
    } satisfies Parameters<typeof buildAgentSystemPrompt>[0];
    const ultra = (params: Partial<Parameters<typeof buildAgentSystemPrompt>[0]> = {}) =>
      buildAgentSystemPrompt({ ...base, ...params, proactiveSubagentOrchestration: true });
    const maxPrompt = buildAgentSystemPrompt(base);
    const ultraPrompt = ultra();
    const deferredUltraPrompt = ultra({
      toolNames: ["tool_search"],
      capabilityToolNames: ["sessions_spawn"],
    });
    const minimalUltraPrompt = ultra({ promptMode: "minimal" });
    const unavailablePrompt = ultra({ toolNames: ["subagents"] });
    const rawPrompt = ultra({ promptMode: "none" });

    expect(maxPrompt).not.toContain("## Proactive Sub-Agent Orchestration");
    expect(ultraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(ultraPrompt).toContain("Ultra active");
    expect(ultraPrompt).not.toContain("Mode: prefer");
    expect(deferredUltraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(minimalUltraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(unavailablePrompt).not.toContain("## Proactive Sub-Agent Orchestration");
    expect(unavailablePrompt).toContain("## Ultra Execution");
    expect(unavailablePrompt).toContain("verify the result before replying");
    expect(unavailablePrompt).not.toContain("Use `sessions_spawn` when independent work");
    expect(rawPrompt).not.toContain("## Proactive Sub-Agent Orchestration");
  });
});

describe("USER prompt context", () => {
  it("keeps shared preferences before the current person's overlay", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      contextFiles: [
        { path: "/workspace/USER.md", content: "Shared preferences" },
        {
          path: "/workspace/users/person/USER.md",
          content: "Personal preferences",
          personalUser: true,
        },
      ],
    });
    expect(prompt.indexOf("Shared preferences")).toBeLessThan(
      prompt.indexOf("Personal preferences"),
    );
    expect(prompt).toContain("belongs to this session");
  });
});
