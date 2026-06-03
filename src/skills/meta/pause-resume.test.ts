import { describe, expect, it } from "vitest";
import { runMetaPlan } from "./runner.js";
import type { MetaPlan } from "./types.js";

describe("runMetaPlan pause and resume", () => {
  it("pauses when a user_input executor returns a pause sentinel", async () => {
    const plan = {
      name: "collect-topic",
      description: "Collect topic before drafting",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "publish" },
      steps: [
        {
          id: "clarify",
          kind: "user_input",
          dependsOn: [],
          prompt: "Which topic?",
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "llm_chat",
          dependsOn: ["clarify"],
          prompt: "Topic {{clarify.topic}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        user_input: () => ({
          __meta_pause__: true,
          schema: {
            required: ["topic"],
          },
        }),
        llm_chat: () => ({ text: "should not run" }),
      },
    });

    expect(result.status).toBe("paused");
    expect(result.steps.clarify).toEqual({
      status: "paused",
      output: {
        __meta_pause__: true,
        schema: {
          required: ["topic"],
        },
      },
    });
    expect(result.outputs).toEqual({
      clarify: {
        __meta_pause__: true,
        schema: {
          required: ["topic"],
        },
      },
    });
    expect(result.finalText).toContain("collect-topic");
    expect(result.finalText).toContain("clarify");
    expect(result.finalText).toContain("topic");
  });

  it("succeeds on resume when the input is provided and executors return normal outputs", async () => {
    const plan = {
      name: "collect-topic",
      description: "Collect topic before drafting",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "publish" },
      steps: [
        {
          id: "clarify",
          kind: "user_input",
          dependsOn: [],
          prompt: "Which topic?",
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "llm_chat",
          dependsOn: ["clarify"],
          prompt: "Topic {{clarify.topic}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: { topic: "SQLite" },
      executors: {
        user_input: ({ input }) => ({ topic: String(input.topic) }),
        llm_chat: ({ renderedPrompt }) => ({ text: renderedPrompt }),
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("Topic SQLite");
    expect(result.outputs).toEqual({
      clarify: { topic: "SQLite" },
      publish: { text: "Topic SQLite" },
    });
  });

  it("fails if a non-user_input step returns a pause sentinel", async () => {
    const plan = {
      name: "bad-pause",
      description: "Guard pause sentinel usage",
      triggers: [],
      finalTextMode: { kind: "auto" },
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        llm_chat: () => ({
          __meta_pause__: true,
          schema: {
            required: ["topic"],
          },
        }),
      },
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("pause");
    expect(result.finalText).toContain("user_input");
    expect(result.steps.draft).toEqual({
      status: "failed",
      error: 'Meta step "draft" returned a pause sentinel, but only "user_input" steps may pause.',
    });
  });

  it("does not recover non-user_input pause sentinels through skip or substitute policies", async () => {
    for (const onFailure of [
      { kind: "skip" },
      { kind: "substitute", output: { text: "fallback" } },
    ] as const) {
      const plan = {
        name: `bad-pause-${onFailure.kind}`,
        description: "Guard pause sentinel recovery",
        triggers: [],
        finalTextMode: { kind: "auto" },
        steps: [
          {
            id: "draft",
            kind: "llm_chat",
            dependsOn: [],
            prompt: "Draft",
            onFailure,
          },
        ],
      } satisfies MetaPlan;

      const result = await runMetaPlan({
        plan,
        input: {},
        executors: {
          llm_chat: () => ({
            __meta_pause__: true,
            schema: {
              required: ["topic"],
            },
          }),
        },
      });

      expect(result.status).toBe("failed");
      expect(result.outputs).toEqual({});
      expect(result.steps.draft).toEqual({
        status: "failed",
        error:
          'Meta step "draft" returned a pause sentinel, but only "user_input" steps may pause.',
      });
    }
  });

  it("rejects pause sentinels with prototypeful schema objects", async () => {
    const plan = {
      name: "bad-pause-schema",
      description: "Guard pause sentinel shape",
      triggers: [],
      finalTextMode: { kind: "auto" },
      steps: [
        {
          id: "clarify",
          kind: "user_input",
          dependsOn: [],
          prompt: "Which topic?",
          onFailure: { kind: "skip" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        user_input: () => ({
          __meta_pause__: true,
          schema: new Date(),
        }),
      },
    });

    expect(result.status).toBe("failed");
    expect(result.outputs).toEqual({});
    expect(result.steps.clarify).toEqual({
      status: "failed",
      error: "Meta step clarify returned an invalid pause sentinel",
    });
  });
});
