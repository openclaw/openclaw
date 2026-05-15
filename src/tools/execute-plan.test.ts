import { describe, expect, it } from "vitest";
import { executeToolPlan, type ExecutePlanToolInvokeResult } from "./execute-plan.js";

describe("executeToolPlan", () => {
  it("executes array plans through the injected tool invoker", async () => {
    const calls: Array<{ action: string; args: Record<string, unknown>; index: number }> = [];

    const result = await executeToolPlan(
      [
        { action: "openclaw.version", input: { verbose: true } },
        { name: "ticket.summarize", arguments: { id: "T-1" } },
      ],
      {
        invoke: async (step): Promise<ExecutePlanToolInvokeResult> => {
          calls.push(step);
          return { ok: true, toolName: step.action, output: { ok: true }, source: "core" };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(calls).toEqual([
      { action: "openclaw.version", args: { verbose: true }, index: 0 },
      { action: "ticket.summarize", args: { id: "T-1" }, index: 1 },
    ]);
  });

  it("executes object plans with a steps array", async () => {
    const result = await executeToolPlan(
      {
        steps: [{ tool: "model.list", args: { provider: "openai" } }],
      },
      {
        invoke: async (step) => ({
          ok: true,
          toolName: step.action,
          output: { models: [] },
          source: "core",
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.action).toBe("model.list");
    expect(result.steps[0]?.output).toEqual({ models: [] });
  });

  it("stops before later steps when a tool is blocked", async () => {
    const calls: string[] = [];

    const result = await executeToolPlan(
      {
        steps: [
          { action: "openclaw.version" },
          { action: "deploy.production", args: { service: "api" } },
          { action: "email.send", args: { to: "ops@example.com" } },
        ],
      },
      {
        invoke: async (step): Promise<ExecutePlanToolInvokeResult> => {
          calls.push(step.action);
          if (step.action === "deploy.production") {
            return {
              ok: false,
              toolName: step.action,
              error: { code: "forbidden", message: "tool call blocked" },
            };
          }
          return { ok: true, toolName: step.action };
        },
      },
    );

    expect(calls).toEqual(["openclaw.version", "deploy.production"]);
    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe("blocked_tool");
    expect(result.steps.map((step) => step.status)).toEqual(["completed", "blocked"]);
  });

  it("can continue after blocked or failed tools when requested", async () => {
    const result = await executeToolPlan(
      [{ action: "deploy.production" }, { action: "openclaw.version" }],
      {
        continueOnError: true,
        invoke: async (step): Promise<ExecutePlanToolInvokeResult> => {
          if (step.action === "deploy.production") {
            return {
              ok: false,
              toolName: step.action,
              requiresApproval: true,
              error: { code: "requires_approval", message: "approval required" },
            };
          }
          return { ok: true, toolName: step.action };
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.steps.map((step) => step.status)).toEqual(["blocked", "completed"]);
  });

  it("fails closed on malformed plans", async () => {
    await expect(
      executeToolPlan({ steps: [{}] }, { invoke: async () => ({ ok: true }) }),
    ).rejects.toThrow("step 0 requires action, name, or tool");
    await expect(
      executeToolPlan({ steps: "openclaw.version" }, { invoke: async () => ({ ok: true }) }),
    ).rejects.toThrow("execute plan must be a JSON array or an object with a steps array");
  });
});
