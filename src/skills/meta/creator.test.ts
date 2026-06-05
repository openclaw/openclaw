import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentMetaInvokePlanRunner } from "../../agents/meta-invoke-runtime.js";
import type { MetaInvokeLlmCompletionOptions } from "../../agents/meta-invoke-runtime.js";
import type { AssistantMessage, Model } from "../../llm/types.js";
import { parseFrontmatter } from "../loading/frontmatter.js";
import type { Skill } from "../loading/skill-contract.js";
import { buildWorkspaceSkillSnapshot } from "../loading/workspace.js";
import type { SkillEntry } from "../types.js";
import { buildMetaSkillCatalog } from "./catalog.js";

function skillEntryFromFile(filePath: string, source: string): SkillEntry {
  const name = path.basename(path.dirname(filePath));
  const skill: Skill = {
    name,
    description: `${name} description`,
    filePath,
    baseDir: path.dirname(filePath),
    source,
    sourceInfo: {
      path: filePath,
      source: "openclaw-bundled",
      scope: "project",
      origin: "top-level",
      baseDir: path.dirname(filePath),
    },
    disableModelInvocation: false,
  };
  return {
    skill,
    frontmatter: parseFrontmatter(source),
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function createKidProjectPlannerLlmCompletion(): MetaInvokeLlmCompletionOptions {
  const model = {
    provider: "openai",
    id: "gpt-5.5",
    name: "gpt-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } satisfies Model<"openai-responses">;
  return {
    config: {},
    agentId: "main",
    prepareSimpleCompletionModelForAgent: vi.fn(async () => ({
      selection: {
        provider: "openai",
        modelId: "gpt-5.5",
        agentDir: "/tmp/openclaw-agent",
      },
      model,
      auth: {
        apiKey: "sk-test",
        source: "test",
        mode: "api-key" as const,
      },
    })) as unknown as NonNullable<
      MetaInvokeLlmCompletionOptions["prepareSimpleCompletionModelForAgent"]
    >,
    completeWithPreparedSimpleCompletionModel: vi.fn(async ({ context }) => {
      const prompt = String(context.messages[0]?.content ?? "");
      if (prompt.includes("Classify kid-project feasibility")) {
        return assistantMessage("NEEDS_ADULT_HELP");
      }
      return assistantMessage(
        [
          "# Baking Soda Volcano",
          "## Known facts and assumptions",
          "Age 8, two weeks, adult helps with messy steps.",
          "## Kid steps",
          "Build, test, observe, and present.",
          "## Parent safety notes",
          "Adult handles spills and cleanup.",
          "PACK_DELIVERED: NEEDS_ADULT_HELP",
        ].join("\n"),
      );
    }) as unknown as NonNullable<
      MetaInvokeLlmCompletionOptions["completeWithPreparedSimpleCompletionModel"]
    >,
  };
}

describe("bundled meta skills", () => {
  it("ships bundled meta skills through the real skills loader", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meta-catalog-"));
    try {
      const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
        bundledSkillsDir: path.resolve("skills"),
        managedSkillsDir: path.join(workspaceDir, ".managed-skills"),
      });

      expect(snapshot.metaSkillCatalog?.diagnostics).toEqual([]);
      expect(snapshot.metaSkillCatalog?.plans.map((plan) => plan.name)).toEqual([
        "meta-kid-project-planner",
        "meta-skill-creator",
      ]);
      expect(
        snapshot.metaSkillCatalog?.plans.find((plan) => plan.name === "meta-skill-creator"),
      ).toMatchObject({
        riskMetadata: {
          level: "medium",
        },
      });
      expect(
        snapshot.metaSkillCatalog?.plans.find((plan) => plan.name === "meta-kid-project-planner"),
      ).toMatchObject({
        riskMetadata: {
          level: "medium",
        },
        finalTextMode: { kind: "step", stepId: "project_pack_audit" },
      });
      expect(snapshot.resolvedSkills?.some((skill) => skill.name === "meta-skill-creator")).toBe(
        true,
      );
      expect(
        snapshot.resolvedSkills?.some((skill) => skill.name === "meta-kid-project-planner"),
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps the shipped meta-skill creator parseable and wired to Skill Workshop", async () => {
    const skillFile = path.resolve("skills/meta-skill-creator/SKILL.md");
    const source = await fs.readFile(skillFile, "utf8");

    const catalog = buildMetaSkillCatalog([skillEntryFromFile(skillFile, source)]);

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plans).toHaveLength(1);
    const plan = catalog.plans[0];
    expect(plan).toMatchObject({
      name: "meta-skill-creator",
      riskMetadata: {
        level: "medium",
      },
      finalTextMode: { kind: "step", stepId: "proposal" },
    });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "collect",
      "harvest_context",
      "prepare",
      "proposal",
    ]);
    const collectStep = plan.steps.find((step) => step.id === "collect");
    expect(collectStep).toMatchObject({
      kind: "user_input",
      schema: { required: ["name", "description", "workflow"] },
    });
    const harvestStep = plan.steps.find((step) => step.id === "harvest_context");
    expect(harvestStep).toMatchObject({
      kind: "tool_call",
      dependsOn: ["collect"],
      toolName: "sessions_history",
      when: { kind: "truthy", path: "input._meta.sessionKey" },
      args: {
        sessionKey: "{{input._meta.sessionKey}}",
        limit: 12,
      },
    });
    const prepareStep = plan.steps.find((step) => step.id === "prepare");
    expect(prepareStep).toMatchObject({
      kind: "tool_call",
      dependsOn: ["collect", "harvest_context"],
      toolName: "meta_skill_creator_prepare",
      args: {
        name: "{{collect.name}}",
        description: "{{collect.description}}",
        workflow: "{{collect.workflow}}",
        content: "{{collect.content}}",
        trigger: "{{collect.trigger}}",
        audience: "{{collect.audience}}",
        required_tools: "{{collect.required_tools}}",
        support_files: "{{collect.support_files}}",
        prior_context: "{{collect.prior_context}}",
        harvested_context: "{{harvest_context.result.text}}",
        risk_profile: "{{collect.risk_profile}}",
        representative_invocation: "{{collect.representative_invocation}}",
        require_runtime_e2e: "{{collect.require_runtime_e2e}}",
      },
    });
    const proposalStep = plan.steps.find((step) => step.id === "proposal");
    expect(proposalStep).toMatchObject({
      kind: "tool_call",
      dependsOn: ["prepare"],
      toolName: "skill_workshop",
      when: { kind: "equals", path: "prepare.result.details.gatesOk", value: true },
      args: {
        action: "{{prepare.result.details.workshopAction}}",
        proposal_id: "{{prepare.result.details.workshopProposalId}}",
        name: "{{prepare.result.details.name}}",
        skill_name: "{{prepare.result.details.workshopSkillName}}",
        description: "{{prepare.result.details.description}}",
        proposal_content: "{{prepare.result.details.proposalContent}}",
        support_files: "{{prepare.result.details.supportFiles}}",
        goal: "{{prepare.result.details.goal}}",
        evidence: "{{prepare.result.details.evidence}}",
      },
    });
    expect(proposalStep?.args).not.toHaveProperty("content");
  });

  it("keeps the shipped kid project planner parseable with collection, safety routing, and audit steps", async () => {
    const skillFile = path.resolve("skills/meta-kid-project-planner/SKILL.md");
    const source = await fs.readFile(skillFile, "utf8");

    const catalog = buildMetaSkillCatalog([skillEntryFromFile(skillFile, source)]);

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plans).toHaveLength(1);
    const plan = catalog.plans[0];
    expect(plan).toMatchObject({
      name: "meta-kid-project-planner",
      description:
        "Use when a child or guardian needs a safe, age-appropriate school, science, or hands-on project plan.",
      triggers: [
        { pattern: "school project" },
        { pattern: "science fair" },
        { pattern: "孩子做项目" },
        { pattern: "我要做火山" },
      ],
      riskMetadata: {
        level: "medium",
      },
      finalTextMode: { kind: "step", stepId: "project_pack_audit" },
    });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "collect",
      "feasibility",
      "project_pack_audit",
    ]);
    const collectStep = plan.steps.find((step) => step.id === "collect");
    expect(collectStep).toMatchObject({
      kind: "user_input",
      schema: {
        required: ["topic"],
        properties: {
          topic: { type: "string" },
          child_age: { type: "string" },
          deadline: { type: "string" },
          materials: { type: "string" },
          parent_supervision: { type: "string" },
        },
      },
    });
    const feasibilityStep = plan.steps.find((step) => step.id === "feasibility");
    expect(feasibilityStep).toMatchObject({
      kind: "llm_classify",
      dependsOn: ["collect"],
      choices: ["STRAIGHTFORWARD", "NEEDS_ADULT_HELP", "SAFETY_REVIEW_REQUIRED", "INAPPROPRIATE"],
      prompt: expect.stringContaining("Classify kid-project feasibility"),
    });
    const auditStep = plan.steps.find((step) => step.id === "project_pack_audit");
    expect(auditStep).toMatchObject({
      kind: "llm_chat",
      dependsOn: ["feasibility"],
      prompt: expect.stringContaining("Rewrite the draft into the final user-facing project pack"),
    });
  });

  it("runs the shipped kid project planner through feasibility and final audit", async () => {
    const skillFile = path.resolve("skills/meta-kid-project-planner/SKILL.md");
    const source = await fs.readFile(skillFile, "utf8");
    const catalog = buildMetaSkillCatalog([skillEntryFromFile(skillFile, source)]);
    const plan = catalog.plans[0];
    const llmCompletion = createKidProjectPlannerLlmCompletion();

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      llmCompletion,
    })({
      plan,
      input: {
        topic: "Baking soda volcano",
        child_age: "8",
        deadline: "two weeks",
        materials: "baking soda, vinegar, cardboard",
        parent_supervision: "light help",
      },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      finalText: expect.stringContaining("Baking Soda Volcano"),
      outputs: {
        collect: {
          topic: "Baking soda volcano",
        },
        feasibility: {
          choice: "NEEDS_ADULT_HELP",
        },
        project_pack_audit: {
          text: expect.stringContaining("Parent safety notes"),
        },
      },
    });
    expect(llmCompletion.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(2);
  });
});
