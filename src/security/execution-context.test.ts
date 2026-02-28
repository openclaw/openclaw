import { describe, expect, it } from "vitest";
import { buildExecutionContext } from "./execution-context.js";
import { TaintTracker } from "./taint-tracker.js";
import { InstructionLevel } from "./types.js";

describe("buildExecutionContext", () => {
  it("defaults aggregateTaintLevel to SYSTEM when no tracker is attached", () => {
    const ctx = buildExecutionContext({});
    expect(ctx.aggregateTaintLevel).toBe(InstructionLevel.SYSTEM);
    expect(ctx.fieldTaint).toBeUndefined();
  });

  it("uses taint tracker aggregate level when attached", () => {
    const tracker = new TaintTracker();
    tracker.tagField("args.url", InstructionLevel.EXTERNAL_CONTENT);

    const ctx = buildExecutionContext({ taintTracker: tracker });
    expect(ctx.aggregateTaintLevel).toBe(InstructionLevel.EXTERNAL_CONTENT);
  });

  it("provides fieldTaint accessor when tracker is attached", () => {
    const tracker = new TaintTracker();
    tracker.tagField("a", InstructionLevel.USER, "input");

    const ctx = buildExecutionContext({ taintTracker: tracker });
    expect(ctx.fieldTaint).toBeDefined();

    const fields = ctx.fieldTaint!();
    expect(fields).toHaveLength(1);
    expect(fields[0].fieldPath).toBe("a");
  });

  it("passes through session metadata", () => {
    const ctx = buildExecutionContext({
      activeTask: "process-email",
      sessionRole: "owner",
      agentId: "agent-1",
      sessionKey: "hook:gmail:inbox",
      senderIsOwner: true,
    });

    expect(ctx.activeTask).toBe("process-email");
    expect(ctx.sessionRole).toBe("owner");
    expect(ctx.agentId).toBe("agent-1");
    expect(ctx.sessionKey).toBe("hook:gmail:inbox");
    expect(ctx.senderIsOwner).toBe(true);
  });

  it("handles tracker at SYSTEM level (no taint)", () => {
    const tracker = new TaintTracker();
    const ctx = buildExecutionContext({ taintTracker: tracker });
    expect(ctx.aggregateTaintLevel).toBe(InstructionLevel.SYSTEM);
    expect(ctx.fieldTaint!()).toEqual([]);
  });
});
