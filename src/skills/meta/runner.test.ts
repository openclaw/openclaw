import { describe, expect, it } from "vitest";
import type { MetaStepContext } from "./executors.js";
import { runMetaPlan } from "./runner.js";
import type { MetaPlan } from "./types.js";

describe("runMetaPlan", () => {
  it("executes steps in order, renders prompts and args, and returns final step text", async () => {
    const seen: MetaStepContext[] = [];
    const plan = {
      name: "meta-demo",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "publish" },
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft {{input.topic}} for {{input.audience}}",
          args: {
            title: "{{input.topic}}",
            priority: "{{input.priority}}",
          },
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["draft"],
          prompt: "Publish {{draft.text}}",
          args: {
            body: "{{draft.text}}",
            score: "{{draft.score}}",
            nested: {
              tags: ["{{draft.tags}}", "{{input.topic}}"],
            },
          },
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: {
        topic: "Task 3",
        audience: "reviewers",
        priority: 5,
      },
      executors: {
        llm_chat: (context) => {
          seen.push(context);
          expect(context.renderedPrompt).toBe("Draft Task 3 for reviewers");
          expect(context.renderedArgs).toEqual({
            title: "Task 3",
            priority: "5",
          });
          return {
            text: "Drafted plan",
            score: 9,
            tags: ["meta", "task-3"],
          };
        },
        tool_call: (context) => {
          seen.push(context);
          expect(context.outputs).toEqual({
            draft: {
              text: "Drafted plan",
              score: 9,
              tags: ["meta", "task-3"],
            },
          });
          expect(context.renderedPrompt).toBe("Publish Drafted plan");
          expect(context.renderedArgs).toEqual({
            body: "Drafted plan",
            score: "9",
            nested: {
              tags: ['["meta","task-3"]', "Task 3"],
            },
          });
          return { text: "Published successfully" };
        },
      },
    });

    expect(seen.map((entry) => entry.step.id)).toEqual(["draft", "publish"]);
    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("Published successfully");
    expect(result.outputs).toEqual({
      draft: {
        text: "Drafted plan",
        score: 9,
        tags: ["meta", "task-3"],
      },
      publish: { text: "Published successfully" },
    });
    expect(result.steps.publish).toMatchObject({
      status: "succeeded",
      output: { text: "Published successfully" },
    });
  });

  it("substitutes configured output and continues after executor failure", async () => {
    const plan = {
      name: "meta-substitute",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "final" },
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft {{input.topic}}",
          onFailure: {
            kind: "substitute",
            output: { text: "Fallback draft" },
          },
        },
        {
          id: "final",
          kind: "tool_call",
          dependsOn: ["draft"],
          prompt: "Finalize {{draft.text}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: { topic: "migration" },
      executors: {
        llm_chat: async () => {
          throw new Error("draft failed");
        },
        tool_call: (context) => ({
          text: context.renderedPrompt,
        }),
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.steps.draft).toMatchObject({
      status: "succeeded",
      recovery: "substitute",
      output: { text: "Fallback draft" },
      error: "draft failed",
    });
    expect(result.steps.final.output).toEqual({ text: "Finalize Fallback draft" });
    expect(result.finalText).toBe("Finalize Fallback draft");
  });

  it("records skipped output and continues to later steps", async () => {
    const plan = {
      name: "meta-skip",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "final" },
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft {{input.topic}}",
          onFailure: { kind: "skip" },
        },
        {
          id: "final",
          kind: "tool_call",
          dependsOn: ["draft"],
          prompt: "Finalize {{draft.text}} for {{input.topic}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: { topic: "migration" },
      executors: {
        llm_chat: async () => {
          throw new Error("draft failed");
        },
        tool_call: (context) => {
          expect(context.outputs).toEqual({
            draft: {},
          });
          expect(context.renderedPrompt).toBe("Finalize  for migration");
          return { text: "skip continued" };
        },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.draft).toEqual({});
    expect(result.steps.draft).toMatchObject({
      status: "skipped",
      output: {},
      error: "draft failed",
    });
    expect(result.steps.final).toMatchObject({
      status: "succeeded",
      output: { text: "skip continued" },
    });
    expect(result.finalText).toBe("skip continued");
  });

  it("formats nested error causes in failed step messages", async () => {
    const plan = {
      name: "meta-error-cause",
      description: "Demo",
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
      input: { topic: "migration" },
      executors: {
        llm_chat: () => {
          throw new Error("outer failure", {
            cause: new Error("inner failure"),
          });
        },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("outer failure | inner failure");
    expect(result.steps.draft).toEqual({
      status: "failed",
      error: "outer failure | inner failure",
    });
  });

  it("fails with a useful message when a step kind has no executor", async () => {
    const plan = {
      name: "meta-missing-executor",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "auto" },
      steps: [
        {
          id: "clarify",
          kind: "user_input",
          dependsOn: [],
          prompt: "Question",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: { topic: "migration" },
      executors: {},
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain('No executor registered for meta step kind "user_input"');
    expect(result.finalText).toContain('step "clarify"');
    expect(result.steps).toEqual({});
  });

  it("uses JSON fallback for auto mode when the last step has no text", async () => {
    const plan = {
      name: "meta-auto-json",
      description: "Demo",
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
      input: { topic: "migration" },
      executors: {
        llm_chat: () => ({ payload: { ok: true } }),
      },
    });

    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.finalText)).toEqual({
      output: { payload: { ok: true } },
      steps: {
        draft: {
          status: "succeeded",
          output: { payload: { ok: true } },
        },
      },
    });
  });

  it("returns the raw aggregate payload for raw final text mode", async () => {
    const plan = {
      name: "meta-raw",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "raw" },
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft",
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["draft"],
          prompt: "Publish {{draft.text}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: { topic: "migration" },
      executors: {
        llm_chat: () => ({ text: "drafted", score: 1 }),
        tool_call: () => ({ text: "published", ok: true }),
      },
    });

    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.finalText)).toEqual({
      outputs: {
        draft: { text: "drafted", score: 1 },
        publish: { text: "published", ok: true },
      },
      steps: {
        draft: {
          status: "succeeded",
          output: { text: "drafted", score: 1 },
        },
        publish: {
          status: "succeeded",
          output: { text: "published", ok: true },
        },
      },
    });
  });

  it("rejects non-plain-object step outputs", async () => {
    const plan = {
      name: "meta-invalid-output",
      description: "Demo",
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
      input: { topic: "migration" },
      executors: {
        llm_chat: () => new Date() as unknown as Record<string, unknown>,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain('Meta step "draft" failed');
    expect(result.finalText).toContain("returned a non-record output");
    expect(result.steps.draft).toEqual({
      status: "failed",
      error: "Meta step draft returned a non-record output",
    });
  });

  it("fails early when the same meta plan is already active", async () => {
    const plan = {
      name: "meta-recursive",
      description: "Demo",
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
      input: { topic: "migration" },
      activeMetaNames: ["meta-recursive", "other-plan"],
      executors: {
        llm_chat: () => ({ text: "should not run" }),
      },
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("meta-recursive");
    expect(result.finalText).toContain("already active");
    expect(result.steps).toEqual({});
  });
});
