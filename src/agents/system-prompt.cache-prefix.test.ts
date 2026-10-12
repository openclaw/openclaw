import type { Model } from "@openclaw/ai";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
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
      skillsPrompt: formatSkillsForPromptCore([demo]),
    });
    if (admitted) {
      expect(prompt).toContain('`skills.read("<name>")`');
      expect(prompt).toContain("skills.search(query)");
      expect(prompt).not.toContain("read exact <location> with `read`");
    } else {
      expect(prompt).not.toContain("skills.read(");
      expect(prompt).not.toContain("skills.search(");
    }
  });

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
        expect(prompt).toContain(skillsPrompt);
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

describe("system prompt elevated guidance cache prefix", () => {
  type Elevated = NonNullable<
    NonNullable<Parameters<typeof buildAgentSystemPrompt>[0]["sandboxInfo"]>["elevated"]
  >;
  const parts = (elevated: Elevated) => {
    const rendered = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [{ path: "AGENTS.md", content: "Stable project instructions." }],
      toolNames: ["exec"],
      sandboxInfo: { enabled: true, elevated },
    });
    const [prefix, suffix] = rendered.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
    return { prefix, suffix };
  };

  it("keeps elevated-availability changes below the stable prefix", () => {
    // Elevated availability is a per-run fact: a normal parent turn and a
    // sessions_yield/announce turn can disagree. It must not perturb the stable
    // prefix, or provider-side literal prefix caches re-evaluate the whole prompt.
    const allowed = parts({ allowed: true, defaultLevel: "ask", fullAccessAvailable: true });
    expect(parts({ allowed: false, defaultLevel: "off", fullAccessAvailable: false }).prefix).toBe(
      allowed.prefix,
    );
    expect(
      parts({
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      }).prefix,
    ).toBe(allowed.prefix);
    expect(allowed.prefix).toContain("Stable project instructions.");
    expect(allowed.prefix).not.toContain("Elevated exec is");
    expect(allowed.prefix).not.toContain("/elevated");
  });

  it("retains every elevated guidance line below the boundary", () => {
    const available = parts({ allowed: true, defaultLevel: "ask", fullAccessAvailable: true });
    expect(available.suffix).toContain("Elevated exec is available for this session.");
    expect(available.suffix).toContain("User can toggle with /elevated on|off|ask|full.");
    expect(available.suffix).toContain("You may also send /elevated on|off|ask|full when needed.");
    const noFull = parts({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "runtime",
    });
    expect(noFull.suffix).toContain("User can toggle with /elevated on|off|ask.");
    expect(noFull.suffix).toContain(
      "Auto-approved /elevated full is unavailable here (runtime constraints).",
    );
    const unavailable = parts({ allowed: false, defaultLevel: "off", fullAccessAvailable: false });
    expect(unavailable.suffix).toContain("Elevated exec is unavailable for this session.");
    expect(unavailable.suffix).toContain(
      "Do not tell the user to switch to /elevated full in this session.",
    );
  });
});
