import { afterEach, describe, expect, it } from "vitest";
import {
  GuardPipeline,
  ensureGlobalGuardPipeline,
  getGlobalGuardPipeline,
  resetGlobalGuardPipeline,
} from "./guard-pipeline.js";
import { InstructionLevel } from "./types.js";
import type { ExecutionContext, ToolCall, ToolExecutionGuard, ValidationResult } from "./types.js";

function makeContext(level: InstructionLevel = InstructionLevel.SYSTEM): ExecutionContext {
  return { aggregateTaintLevel: level };
}

function makeCall(toolName: string = "test_tool"): ToolCall {
  return { toolName, arguments: {} };
}

function makeGuard(
  name: string,
  priority: number,
  result: ValidationResult = { action: "allow" },
): ToolExecutionGuard {
  return {
    name,
    priority,
    validate: () => result,
  };
}

describe("GuardPipeline", () => {
  describe("register / unregister", () => {
    it("registers guards sorted by priority descending", () => {
      const pipeline = new GuardPipeline();
      pipeline.register(makeGuard("low", 10));
      pipeline.register(makeGuard("high", 100));
      pipeline.register(makeGuard("mid", 50));

      expect(pipeline.guardNames()).toEqual(["high", "mid", "low"]);
    });

    it("replaces guard with same name", () => {
      const pipeline = new GuardPipeline();
      pipeline.register(makeGuard("g", 10, { action: "allow" }));
      pipeline.register(makeGuard("g", 20, { action: "block", reason: "updated" }));

      expect(pipeline.size).toBe(1);
      expect(pipeline.guardNames()).toEqual(["g"]);
    });

    it("unregisters by name", () => {
      const pipeline = new GuardPipeline();
      pipeline.register(makeGuard("a", 10));
      pipeline.register(makeGuard("b", 20));
      pipeline.unregister("a");

      expect(pipeline.guardNames()).toEqual(["b"]);
    });
  });

  describe("validate", () => {
    it("returns allow when no guards are registered", async () => {
      const pipeline = new GuardPipeline();
      const result = await pipeline.validate(makeCall(), makeContext());
      expect(result).toEqual({ action: "allow" });
    });

    it("returns allow when all guards allow", async () => {
      const pipeline = new GuardPipeline();
      pipeline.register(makeGuard("a", 100));
      pipeline.register(makeGuard("b", 50));

      const result = await pipeline.validate(makeCall(), makeContext());
      expect(result).toEqual({ action: "allow" });
    });

    it("short-circuits on first non-allow result", async () => {
      const calls: string[] = [];
      const pipeline = new GuardPipeline();

      pipeline.register({
        name: "blocker",
        priority: 100,
        validate: () => {
          calls.push("blocker");
          return { action: "block", reason: "blocked" };
        },
      });

      pipeline.register({
        name: "after",
        priority: 50,
        validate: () => {
          calls.push("after");
          return { action: "allow" };
        },
      });

      const result = await pipeline.validate(makeCall(), makeContext());
      expect(result.action).toBe("block");
      expect(calls).toEqual(["blocker"]);
    });

    it("runs guards in priority order (highest first)", async () => {
      const calls: string[] = [];
      const pipeline = new GuardPipeline();

      pipeline.register({
        name: "low",
        priority: 10,
        validate: () => {
          calls.push("low");
          return { action: "allow" };
        },
      });

      pipeline.register({
        name: "high",
        priority: 100,
        validate: () => {
          calls.push("high");
          return { action: "allow" };
        },
      });

      await pipeline.validate(makeCall(), makeContext());
      expect(calls).toEqual(["high", "low"]);
    });

    it("fail-closed: guard exception produces block result", async () => {
      const pipeline = new GuardPipeline();
      pipeline.register({
        name: "broken",
        priority: 100,
        validate: () => {
          throw new Error("guard crashed");
        },
      });

      const result = await pipeline.validate(makeCall(), makeContext());
      expect(result.action).toBe("block");
      if (result.action === "block") {
        expect(result.reason).toContain("broken");
        expect(result.reason).toContain("fail-closed");
      }
    });

    it("handles async guards", async () => {
      const pipeline = new GuardPipeline();
      pipeline.register({
        name: "async-guard",
        priority: 100,
        validate: async () => {
          return { action: "block", reason: "async block" };
        },
      });

      const result = await pipeline.validate(makeCall(), makeContext());
      expect(result.action).toBe("block");
    });

    it("passes reprompt results through", async () => {
      const pipeline = new GuardPipeline();
      pipeline.register({
        name: "reprompt-guard",
        priority: 100,
        validate: () => ({
          action: "reprompt",
          agentInstruction: "Ask the user",
          reason: "needs confirmation",
        }),
      });

      const result = await pipeline.validate(makeCall(), makeContext());
      expect(result.action).toBe("reprompt");
    });

    it("passes escalate results through", async () => {
      const pipeline = new GuardPipeline();
      pipeline.register({
        name: "escalate-guard",
        priority: 100,
        validate: () => ({
          action: "escalate",
          timeoutMs: 30_000,
          hitlPayload: { toolName: "exec", summary: "test", riskLevel: "critical" },
        }),
      });

      const result = await pipeline.validate(makeCall(), makeContext());
      expect(result.action).toBe("escalate");
    });
  });
});

describe("global pipeline", () => {
  afterEach(() => {
    resetGlobalGuardPipeline();
  });

  it("returns null before initialization", () => {
    expect(getGlobalGuardPipeline()).toBeNull();
  });

  it("ensureGlobalGuardPipeline creates and returns singleton", () => {
    const a = ensureGlobalGuardPipeline();
    const b = ensureGlobalGuardPipeline();
    expect(a).toBe(b);
    expect(getGlobalGuardPipeline()).toBe(a);
  });

  it("resetGlobalGuardPipeline clears the singleton", () => {
    ensureGlobalGuardPipeline();
    resetGlobalGuardPipeline();
    expect(getGlobalGuardPipeline()).toBeNull();
  });
});
