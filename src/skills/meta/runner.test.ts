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

  it("executes independent ready branches in parallel and joins before dependents", async () => {
    const plan = {
      name: "meta-parallel",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "final" },
      steps: [
        {
          id: "left",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Left",
          onFailure: { kind: "fail" },
        },
        {
          id: "right",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Right",
          onFailure: { kind: "fail" },
        },
        {
          id: "final",
          kind: "tool_call",
          dependsOn: ["left", "right"],
          prompt: "{{left.text}} + {{right.text}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;
    const events: string[] = [];
    let resolveLeft!: () => void;
    let resolveRight!: () => void;

    const runPromise = runMetaPlan({
      plan,
      input: {},
      executors: {
        llm_chat: (context) => {
          events.push(`start:${context.step.id}`);
          expect(context.outputs).toEqual({});
          return new Promise<Record<string, unknown>>((resolve) => {
            const finish = () => {
              events.push(`finish:${context.step.id}`);
              resolve({ text: context.step.id });
            };
            if (context.step.id === "left") {
              resolveLeft = finish;
            } else {
              resolveRight = finish;
            }
          });
        },
        tool_call: (context) => {
          events.push("start:final");
          expect(context.outputs).toEqual({
            left: { text: "left" },
            right: { text: "right" },
          });
          return { text: context.renderedPrompt };
        },
      },
    });

    expect(events).toEqual(["start:left", "start:right"]);
    resolveLeft();
    await Promise.resolve();
    expect(events).toEqual(["start:left", "start:right", "finish:left"]);
    resolveRight();

    const result = await runPromise;
    expect(events).toEqual([
      "start:left",
      "start:right",
      "finish:left",
      "finish:right",
      "start:final",
    ]);
    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("left + right");
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

    if (result.status !== "succeeded") {
      throw new Error(`expected succeeded, got ${result.status}`);
    }
    const draftStep = result.steps.draft;
    if (draftStep.status !== "succeeded") {
      throw new Error(`expected draft succeeded, got ${draftStep.status}`);
    }
    const finalStep = result.steps.final;
    if (finalStep.status !== "succeeded") {
      throw new Error(`expected final succeeded, got ${finalStep.status}`);
    }
    expect(draftStep).toMatchObject({
      status: "succeeded",
      recovery: "substitute",
      output: { text: "Fallback draft" },
      error: "draft failed",
    });
    expect(finalStep.output).toEqual({ text: "Finalize Fallback draft" });
    expect(result.finalText).toBe("Finalize Fallback draft");
  });

  it("runs bounded failover attempts after executor failure", async () => {
    const plan = {
      name: "meta-failover",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "publish" },
      steps: [
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: [],
          toolName: "primary_publish",
          prompt: "Publish {{input.topic}}",
          args: {
            body: "{{input.topic}}",
          },
          onFailure: {
            kind: "failover",
            maxAttempts: 1,
            attempts: [
              {
                toolName: "backup_publish",
                prompt: "Backup publish {{input.topic}}",
                args: {
                  body: "{{input.topic}}",
                  channel: "backup",
                },
              },
              {
                toolName: "last_chance_publish",
              },
            ],
          },
        },
      ],
    } satisfies MetaPlan;
    const calls: Array<{
      toolName?: string;
      renderedPrompt: string;
      renderedArgs: unknown;
    }> = [];

    const result = await runMetaPlan({
      plan,
      input: { topic: "SQLite" },
      executors: {
        tool_call: (context) => {
          calls.push({
            toolName: context.step.toolName,
            renderedPrompt: context.renderedPrompt,
            renderedArgs: context.renderedArgs,
          });
          if (context.step.toolName === "primary_publish") {
            throw new Error("primary unavailable");
          }
          return { text: `published through ${context.step.toolName}` };
        },
      },
    });

    expect(calls).toEqual([
      {
        toolName: "primary_publish",
        renderedPrompt: "Publish SQLite",
        renderedArgs: {
          body: "SQLite",
        },
      },
      {
        toolName: "backup_publish",
        renderedPrompt: "Backup publish SQLite",
        renderedArgs: {
          body: "SQLite",
          channel: "backup",
        },
      },
    ]);
    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("published through backup_publish");
    expect(result.steps.publish).toEqual({
      status: "succeeded",
      recovery: "failover",
      output: { text: "published through backup_publish" },
      error: "primary unavailable",
      failoverAttempt: 1,
    });
  });

  it("fails after exhausting bounded failover attempts", async () => {
    const plan = {
      name: "meta-failover-exhausted",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "draft" },
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft",
          onFailure: {
            kind: "failover",
            maxAttempts: 2,
            attempts: [{ prompt: "Fallback one" }, { prompt: "Fallback two" }],
          },
        },
      ],
    } satisfies MetaPlan;
    const prompts: string[] = [];

    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        llm_chat: (context) => {
          prompts.push(context.renderedPrompt);
          throw new Error(`failed ${prompts.length}`);
        },
      },
    });

    expect(prompts).toEqual(["Draft", "Fallback one", "Fallback two"]);
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("failed 1");
    expect(result.finalText).toContain("failover 1: failed 2");
    expect(result.finalText).toContain("failover 2: failed 3");
    expect(result.steps.draft).toMatchObject({
      status: "failed",
      error: "failed 1; failover 1: failed 2; failover 2: failed 3",
    });
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

  it("skips steps whose when expression does not match and runs matching branches", async () => {
    const plan = {
      name: "meta-conditional",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "final" },
      steps: [
        {
          id: "classify",
          kind: "llm_classify",
          dependsOn: [],
          prompt: "Classify",
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["classify"],
          prompt: "Publish",
          when: { kind: "equals", path: "classify.choice", value: "publish" },
          onFailure: { kind: "fail" },
        },
        {
          id: "archive",
          kind: "tool_call",
          dependsOn: ["classify"],
          prompt: "Archive",
          when: { kind: "equals", path: "classify.choice", value: "archive" },
          onFailure: { kind: "fail" },
        },
        {
          id: "final",
          kind: "llm_chat",
          dependsOn: ["publish", "archive"],
          prompt: "Published={{publish.text}} Archived={{archive.text}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const seen: string[] = [];
    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        llm_classify: () => {
          seen.push("classify");
          return { choice: "publish" };
        },
        tool_call: (context) => {
          seen.push(context.step.id);
          return { text: context.step.id };
        },
        llm_chat: (context) => {
          seen.push("final");
          return { text: context.renderedPrompt };
        },
      },
    });

    expect(seen).toEqual(["classify", "publish", "final"]);
    expect(result.status).toBe("succeeded");
    expect(result.outputs.archive).toEqual({});
    expect(result.steps.archive).toMatchObject({
      status: "skipped",
      output: {},
      reason: "when expression did not match: classify.choice",
    });
    expect(result.finalText).toBe("Published=publish Archived=");
  });

  it("routes to the selected downstream case and skips unselected branches", async () => {
    const plan = {
      name: "meta-route",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "final" },
      steps: [
        {
          id: "classify",
          kind: "llm_classify",
          dependsOn: [],
          prompt: "Classify",
          route: {
            path: "choice",
            cases: {
              publish: ["publish"],
              archive: ["archive"],
            },
          },
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["classify"],
          prompt: "Publish",
          onFailure: { kind: "fail" },
        },
        {
          id: "archive",
          kind: "tool_call",
          dependsOn: ["classify"],
          prompt: "Archive",
          onFailure: { kind: "fail" },
        },
        {
          id: "final",
          kind: "llm_chat",
          dependsOn: ["publish", "archive"],
          prompt: "Published={{publish.text}} Archived={{archive.text}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const seen: string[] = [];
    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        llm_classify: () => {
          seen.push("classify");
          return { choice: "publish" };
        },
        tool_call: (context) => {
          seen.push(context.step.id);
          return { text: context.step.id };
        },
        llm_chat: (context) => {
          seen.push("final");
          return { text: context.renderedPrompt };
        },
      },
    });

    expect(seen).toEqual(["classify", "publish", "final"]);
    expect(result.status).toBe("succeeded");
    expect(result.outputs.archive).toEqual({});
    expect(result.steps.archive).toMatchObject({
      status: "skipped",
      output: {},
      reason: "route case not selected by classify.choice",
    });
    expect(result.finalText).toBe("Published=publish Archived=");
  });

  it("routes to default targets when no case matches", async () => {
    const plan = {
      name: "meta-route-default",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "final" },
      steps: [
        {
          id: "classify",
          kind: "llm_classify",
          dependsOn: [],
          prompt: "Classify",
          route: {
            path: "choice",
            cases: {
              publish: ["publish"],
            },
            default: ["review"],
          },
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["classify"],
          prompt: "Publish",
          onFailure: { kind: "fail" },
        },
        {
          id: "review",
          kind: "tool_call",
          dependsOn: ["classify"],
          prompt: "Review",
          onFailure: { kind: "fail" },
        },
        {
          id: "final",
          kind: "llm_chat",
          dependsOn: ["publish", "review"],
          prompt: "Published={{publish.text}} Reviewed={{review.text}}",
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const seen: string[] = [];
    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        llm_classify: () => {
          seen.push("classify");
          return { choice: "needs_review" };
        },
        tool_call: (context) => {
          seen.push(context.step.id);
          return { text: context.step.id };
        },
        llm_chat: (context) => {
          seen.push("final");
          return { text: context.renderedPrompt };
        },
      },
    });

    expect(seen).toEqual(["classify", "review", "final"]);
    expect(result.status).toBe("succeeded");
    expect(result.steps.publish).toMatchObject({
      status: "skipped",
      output: {},
      reason: "route case not selected by classify.choice",
    });
    expect(result.finalText).toBe("Published= Reviewed=review");
  });

  it("does not require an executor for a conditionally skipped step", async () => {
    const plan = {
      name: "meta-conditional-missing-executor",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "auto" },
      steps: [
        {
          id: "optional",
          kind: "tool_call",
          dependsOn: [],
          when: { kind: "equals", path: "input.enabled", value: true },
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: { enabled: false },
      executors: {},
    });

    expect(result.status).toBe("succeeded");
    expect(result.steps.optional).toMatchObject({
      status: "skipped",
      output: {},
      reason: "when expression did not match: input.enabled",
    });
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

  it("falls back to the latest prior text when the selected final step is skipped", async () => {
    const plan = {
      name: "meta-final-skipped",
      description: "Demo",
      triggers: [],
      finalTextMode: { kind: "step", stepId: "publish" },
      steps: [
        {
          id: "prepare",
          kind: "tool_call",
          dependsOn: [],
          prompt: "Prepare",
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["prepare"],
          prompt: "Publish",
          when: { kind: "equals", path: "prepare.ok", value: true },
          onFailure: { kind: "fail" },
        },
      ],
    } satisfies MetaPlan;

    const result = await runMetaPlan({
      plan,
      input: {},
      executors: {
        tool_call: (context) => {
          if (context.step.id === "prepare") {
            return { ok: false, text: "Blocked before publish." };
          }
          return { text: "Published." };
        },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.steps.publish).toMatchObject({
      status: "skipped",
      reason: "when expression did not match: prepare.ok",
    });
    expect(result.finalText).toBe("Blocked before publish.");
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
