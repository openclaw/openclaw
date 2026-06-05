import { describe, expect, it, vi } from "vitest";
import type { MetaSkillCatalog } from "./catalog.js";
import { resolveMetaInvokeRuntime, runTriggeredMetaPlan } from "./runtime.js";
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

const triggeredPlan = {
  ...userInputPlan,
  name: "triggered",
  triggers: [{ pattern: "/triggered" }, { pattern: "run triggered" }],
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

  it("keeps internal meta input context out of user_input schema validation", async () => {
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
      input: { topic: "SQLite", _meta: { sessionKey: "agent:main:main" } },
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
    expect(result?.outputs.ask).not.toHaveProperty("_meta");
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

  it("keeps internal meta input context out of user_input prefill", async () => {
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
      input: { _meta: { sessionKey: "agent:main:main" } },
    });

    expect(result).toMatchObject({
      status: "paused",
      outputs: {
        ask: {
          __meta_pause__: true,
          schema: { required: ["topic"] },
        },
      },
    });
    expect(result?.outputs.ask).not.toHaveProperty("prefill._meta");
  });
});

describe("runTriggeredMetaPlan", () => {
  it("runs the matched meta plan for a unique deterministic trigger", async () => {
    const catalog = {
      plans: [triggeredPlan],
      diagnostics: [],
    } satisfies MetaSkillCatalog;
    const runMetaPlan = vi.fn(async () => ({
      status: "succeeded" as const,
      finalText: "triggered ok",
      outputs: {},
      steps: {},
    }));

    const result = await runTriggeredMetaPlan({
      catalog,
      inputText: "/triggered with details",
      input: { topic: "SQLite" },
      runMetaPlan,
      parentToolCallId: "turn-1",
    });

    expect(runMetaPlan).toHaveBeenCalledWith({
      plan: triggeredPlan,
      input: { topic: "SQLite" },
      parentToolCallId: "turn-1",
    });
    expect(result).toMatchObject({
      match: {
        kind: "deterministic",
        trigger: "/triggered",
        plan: triggeredPlan,
      },
      result: {
        status: "succeeded",
        finalText: "triggered ok",
      },
    });
  });

  it("does not run soft or ambiguous trigger matches", async () => {
    const duplicate = {
      ...triggeredPlan,
      name: "duplicate-triggered",
    } satisfies MetaPlan;
    const runMetaPlan = vi.fn(async () => ({
      status: "succeeded" as const,
      finalText: "should not run",
      outputs: {},
      steps: {},
    }));

    await expect(
      runTriggeredMetaPlan({
        catalog: { plans: [triggeredPlan], diagnostics: [] },
        inputText: "please run triggered for this",
        input: {},
        runMetaPlan,
      }),
    ).resolves.toBeUndefined();
    await expect(
      runTriggeredMetaPlan({
        catalog: { plans: [triggeredPlan, duplicate], diagnostics: [] },
        inputText: "/triggered details",
        input: {},
        runMetaPlan,
      }),
    ).resolves.toBeUndefined();
    expect(runMetaPlan).not.toHaveBeenCalled();
  });
});
