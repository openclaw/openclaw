import { describe, expect, it } from "vitest";
import { TaintRiskGuard, CapabilityAllowlistGuard } from "./tool-execution-guard.js";
import { InstructionLevel } from "./types.js";
import type { ExecutionContext, ToolCall, ValidationResult } from "./types.js";

function makeContext(level: InstructionLevel): ExecutionContext {
  return { aggregateTaintLevel: level };
}

function makeCall(toolName: string): ToolCall {
  return { toolName, arguments: {} };
}

async function validate(
  guard: typeof TaintRiskGuard | typeof CapabilityAllowlistGuard,
  call: ToolCall,
  context: ExecutionContext,
  toolMeta?: Parameters<typeof TaintRiskGuard.validate>[2],
): Promise<ValidationResult> {
  return await guard.validate(call, context, toolMeta);
}

describe("TaintRiskGuard", () => {
  it("allows when taint level is not EXTERNAL_CONTENT", async () => {
    const result = await validate(
      TaintRiskGuard,
      makeCall("exec"),
      makeContext(InstructionLevel.USER),
    );
    expect(result).toEqual({ action: "allow" });
  });

  it("allows unknown tools even with EXTERNAL_CONTENT taint", async () => {
    const result = await validate(
      TaintRiskGuard,
      makeCall("unknown_tool"),
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
    );
    expect(result).toEqual({ action: "allow" });
  });

  it("escalates for critical tools with EXTERNAL_CONTENT taint", async () => {
    const result = await validate(
      TaintRiskGuard,
      makeCall("exec"),
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
    );
    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.hitlPayload.toolName).toBe("exec");
      expect(result.hitlPayload.riskLevel).toBe("critical");
      expect(result.timeoutMs).toBe(120_000);
    }
  });

  it("uses toolMeta humanReadableSummary when available", async () => {
    const result = await validate(
      TaintRiskGuard,
      { toolName: "exec", arguments: { command: "rm -rf /" } },
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
      {
        name: "exec",
        description: "Execute command",
        riskLevel: "critical",
        humanReadableSummary: (args) => `Run: ${String((args as Record<string, unknown>).command)}`,
      },
    );
    if (result.action === "escalate") {
      expect(result.hitlPayload.summary).toBe("Run: rm -rf /");
    }
  });

  it("reprompts for high-risk tools with EXTERNAL_CONTENT taint", async () => {
    const result = await validate(
      TaintRiskGuard,
      makeCall("fs_write"),
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
    );
    expect(result.action).toBe("reprompt");
    if (result.action === "reprompt") {
      expect(result.reason).toContain("fs_write");
      expect(result.agentInstruction).toContain("untrusted external source");
    }
  });

  it("allows medium-risk tools with EXTERNAL_CONTENT taint", async () => {
    const result = await validate(
      TaintRiskGuard,
      makeCall("web_fetch"),
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
    );
    expect(result).toEqual({ action: "allow" });
  });

  it("allows low-risk tools with EXTERNAL_CONTENT taint", async () => {
    const result = await validate(
      TaintRiskGuard,
      makeCall("read"),
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
    );
    expect(result).toEqual({ action: "allow" });
  });
});

describe("CapabilityAllowlistGuard", () => {
  it("allows all tools when taint is not EXTERNAL_CONTENT", async () => {
    const result = await validate(
      CapabilityAllowlistGuard,
      makeCall("exec"),
      makeContext(InstructionLevel.USER),
    );
    expect(result).toEqual({ action: "allow" });
  });

  it.each([
    "exec",
    "gateway",
    "sessions_spawn",
    "sessions_send",
    "cron",
    "whatsapp_login",
    "fs_delete",
    "fs_move",
  ])("blocks '%s' with EXTERNAL_CONTENT taint", async (toolName) => {
    const result = await validate(
      CapabilityAllowlistGuard,
      makeCall(toolName),
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
    );
    expect(result.action).toBe("block");
    if (result.action === "block") {
      expect(result.reason).toContain(toolName);
    }
  });

  it("allows non-blocked tools with EXTERNAL_CONTENT taint", async () => {
    const result = await validate(
      CapabilityAllowlistGuard,
      makeCall("fs_read"),
      makeContext(InstructionLevel.EXTERNAL_CONTENT),
    );
    expect(result).toEqual({ action: "allow" });
  });
});
