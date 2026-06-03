import { describe, expect, it } from "vitest";
import { resolveMetaInvokeRuntime } from "./runtime.js";
import type { MetaPlan } from "./types.js";

const userInputPlan = {
  name: "clarify",
  description: "Ask for missing details",
  triggers: [],
  steps: [
    {
      id: "ask",
      kind: "user_input",
      dependsOn: [],
      schema: { required: ["topic"] },
      onFailure: { kind: "fail" },
    },
  ],
  finalTextMode: { kind: "step", stepId: "ask" },
} satisfies MetaPlan;

const constrainedUserInputPlan = {
  name: "clarify-constrained",
  description: "Ask for constrained details",
  triggers: [],
  steps: [
    {
      id: "ask",
      kind: "user_input",
      dependsOn: [],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["topic"],
        properties: {
          topic: {
            type: "string",
            enum: ["SQLite"],
          },
        },
      },
      onFailure: { kind: "fail" },
    },
  ],
  finalTextMode: { kind: "step", stepId: "ask" },
} satisfies MetaPlan;

const llmChatPlan = {
  name: "draft",
  description: "Draft with an LLM",
  triggers: [],
  steps: [
    {
      id: "draft",
      kind: "llm_chat",
      dependsOn: [],
      prompt: "Draft",
      onFailure: { kind: "fail" },
    },
  ],
  finalTextMode: { kind: "auto" },
} satisfies MetaPlan;

const dependentUserInputPlan = {
  name: "multi-turn-clarify",
  description: "Needs persisted resume state",
  triggers: [],
  steps: [
    {
      id: "first",
      kind: "user_input",
      dependsOn: [],
      schema: { required: ["name"] },
      onFailure: { kind: "fail" },
    },
    {
      id: "second",
      kind: "user_input",
      dependsOn: ["first"],
      schema: { required: ["content"] },
      onFailure: { kind: "fail" },
    },
  ],
  finalTextMode: { kind: "step", stepId: "second" },
} satisfies MetaPlan;

describe("resolveMetaInvokeRuntime", () => {
  it("does not expose a runtime without cataloged meta plans", () => {
    expect(resolveMetaInvokeRuntime(undefined, undefined)).toBeUndefined();
    expect(
      resolveMetaInvokeRuntime(
        {
          prompt: "",
          skills: [],
          resolvedSkills: [],
          metaSkillCatalog: { plans: [], diagnostics: [] },
          version: 1,
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("does not expose default runtime plans with unsupported step kinds", () => {
    expect(
      resolveMetaInvokeRuntime(
        {
          prompt: "",
          skills: [],
          resolvedSkills: [],
          metaSkillCatalog: { plans: [llmChatPlan], diagnostics: [] },
          version: 1,
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("does not expose default runtime plans that require persisted user_input resume state", () => {
    expect(
      resolveMetaInvokeRuntime(
        {
          prompt: "",
          skills: [],
          resolvedSkills: [],
          metaSkillCatalog: { plans: [dependentUserInputPlan], diagnostics: [] },
          version: 1,
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("preserves unsupported step kinds when an explicit runner is provided", () => {
    const runMetaPlan = async () => ({
      status: "succeeded" as const,
      finalText: "ok",
      outputs: {},
      steps: {},
    });
    const runtime = resolveMetaInvokeRuntime(
      {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        metaSkillCatalog: { plans: [llmChatPlan], diagnostics: [] },
        version: 1,
      },
      runMetaPlan,
    );

    expect(runtime?.metaSkillCatalog.plans).toEqual([llmChatPlan]);
    expect(runtime?.runMetaPlan).toBe(runMetaPlan);
  });

  it("supplies a default runner for cataloged user_input meta plans", async () => {
    const runtime = resolveMetaInvokeRuntime(
      {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        metaSkillCatalog: { plans: [userInputPlan], diagnostics: [] },
        version: 1,
      },
      undefined,
    );

    expect(runtime?.metaSkillCatalog.plans).toEqual([userInputPlan]);
    const result = await runtime?.runMetaPlan({
      plan: userInputPlan,
      input: {},
    });

    expect(result).toMatchObject({
      status: "paused",
      outputs: {
        ask: {
          __meta_pause__: true,
          schema: { required: ["topic"] },
        },
      },
      steps: {
        ask: {
          status: "paused",
        },
      },
    });
  });

  it("resumes default user_input plans when required input is provided", async () => {
    const runtime = resolveMetaInvokeRuntime(
      {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        metaSkillCatalog: { plans: [userInputPlan], diagnostics: [] },
        version: 1,
      },
      undefined,
    );

    const result = await runtime?.runMetaPlan({
      plan: userInputPlan,
      input: { topic: "SQLite" },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      outputs: {
        ask: {
          topic: "SQLite",
        },
      },
      steps: {
        ask: {
          status: "succeeded",
        },
      },
    });
  });

  it("keeps default user_input plans paused for schema-invalid input", async () => {
    const runtime = resolveMetaInvokeRuntime(
      {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        metaSkillCatalog: { plans: [constrainedUserInputPlan], diagnostics: [] },
        version: 1,
      },
      undefined,
    );

    const result = await runtime?.runMetaPlan({
      plan: constrainedUserInputPlan,
      input: { topic: "Redis" },
    });

    expect(result).toMatchObject({
      status: "paused",
      outputs: {
        ask: {
          __meta_pause__: true,
          schema: constrainedUserInputPlan.steps[0].schema,
          prefill: {
            topic: "Redis",
          },
        },
      },
      steps: {
        ask: {
          status: "paused",
        },
      },
    });
  });

  it("keeps reserved pause sentinel fields out of default user_input output", async () => {
    const runtime = resolveMetaInvokeRuntime(
      {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        metaSkillCatalog: { plans: [userInputPlan], diagnostics: [] },
        version: 1,
      },
      undefined,
    );

    const result = await runtime?.runMetaPlan({
      plan: userInputPlan,
      input: { topic: "SQLite", __meta_pause__: true },
    });

    expect(result).toMatchObject({
      status: "paused",
      outputs: {
        ask: {
          __meta_pause__: true,
          schema: { required: ["topic"] },
          prefill: {
            topic: "SQLite",
          },
        },
      },
      steps: {
        ask: {
          status: "paused",
        },
      },
    });
    expect(result?.outputs.ask).not.toHaveProperty("prefill.__meta_pause__");
  });
});
