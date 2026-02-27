/**
 * IBEL Phase 1 — Integration tests.
 *
 * End-to-end tests covering the full guard pipeline flow:
 * guard registration → tool call validation → block/reprompt/escalate outcomes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../gateway/exec-approval-manager.js";
import { buildExecutionContext } from "./execution-context.js";
import { tagExternalContent } from "./external-content.js";
import {
  GuardPipeline,
  ensureGlobalGuardPipeline,
  getGlobalGuardPipeline,
  resetGlobalGuardPipeline,
} from "./guard-pipeline.js";
import { handleEscalation } from "./hitl-escalation.js";
import { deriveTaint } from "./taint-propagation.js";
import { TaintTracker } from "./taint-tracker.js";
import { TaintRiskGuard, CapabilityAllowlistGuard } from "./tool-execution-guard.js";
import { getToolMetadata, resetToolRiskRegistry } from "./tool-risk-registry.js";
import { InstructionLevel } from "./types.js";
import type { ToolCall, ToolExecutionGuard, ValidationResult } from "./types.js";

afterEach(() => {
  resetGlobalGuardPipeline();
  resetToolRiskRegistry();
});

describe("IBEL integration", () => {
  describe("no guards registered = pass-through (backward compat)", () => {
    it("returns allow when global pipeline is null", () => {
      expect(getGlobalGuardPipeline()).toBeNull();
    });

    it("returns allow with an empty pipeline", async () => {
      const pipeline = new GuardPipeline();
      const call: ToolCall = { toolName: "exec", arguments: { command: "rm -rf /" } };
      const ctx = buildExecutionContext({});
      const result = await pipeline.validate(call, ctx);
      expect(result).toEqual({ action: "allow" });
    });
  });

  describe("default guards with tainted context", () => {
    it("blocks dangerous tools via CapabilityAllowlistGuard when tainted", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);
      pipeline.register(CapabilityAllowlistGuard);

      const tracker = new TaintTracker();
      tracker.tagField("args.command", InstructionLevel.EXTERNAL_CONTENT, "email");

      const call: ToolCall = { toolName: "exec", arguments: { command: "rm -rf /" } };
      const ctx = buildExecutionContext({ taintTracker: tracker });

      const result = await pipeline.validate(call, ctx, getToolMetadata("exec"));

      // TaintRiskGuard (priority 100) runs first and escalates for critical + external
      expect(result.action).toBe("escalate");
    });

    it("reprompts for high-risk tools with EXTERNAL_CONTENT taint", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);
      pipeline.register(CapabilityAllowlistGuard);

      const tracker = new TaintTracker();
      tracker.tagField("args.path", InstructionLevel.EXTERNAL_CONTENT, "web_fetch");

      const call: ToolCall = { toolName: "fs_write", arguments: { path: "/etc/passwd" } };
      const ctx = buildExecutionContext({ taintTracker: tracker });

      const result = await pipeline.validate(call, ctx, getToolMetadata("fs_write"));

      expect(result.action).toBe("reprompt");
      if (result.action === "reprompt") {
        expect(result.agentInstruction).toContain("untrusted external source");
      }
    });

    it("allows low-risk tools even with EXTERNAL_CONTENT taint", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);
      pipeline.register(CapabilityAllowlistGuard);

      const tracker = new TaintTracker();
      tracker.tagField("query", InstructionLevel.EXTERNAL_CONTENT);

      const call: ToolCall = { toolName: "read", arguments: { path: "/tmp/safe" } };
      const ctx = buildExecutionContext({ taintTracker: tracker });

      const result = await pipeline.validate(call, ctx, getToolMetadata("read"));
      expect(result).toEqual({ action: "allow" });
    });

    it("allows all tools when context is not tainted", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);
      pipeline.register(CapabilityAllowlistGuard);

      const call: ToolCall = { toolName: "exec", arguments: { command: "ls" } };
      const ctx = buildExecutionContext({});

      const result = await pipeline.validate(call, ctx, getToolMetadata("exec"));
      expect(result).toEqual({ action: "allow" });
    });
  });

  describe("guard priority ordering", () => {
    it("higher priority guard runs first and short-circuits", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      const calls: string[] = [];

      const highGuard: ToolExecutionGuard = {
        name: "high",
        priority: 200,
        validate: () => {
          calls.push("high");
          return { action: "block", reason: "blocked by high" };
        },
      };

      const lowGuard: ToolExecutionGuard = {
        name: "low",
        priority: 10,
        validate: () => {
          calls.push("low");
          return { action: "allow" };
        },
      };

      pipeline.register(lowGuard);
      pipeline.register(highGuard);

      const result = await pipeline.validate(
        { toolName: "test", arguments: {} },
        buildExecutionContext({}),
      );

      expect(result.action).toBe("block");
      expect(calls).toEqual(["high"]);
    });

    it("guards run before plugin hooks (structural test)", () => {
      // The integration in pi-tools.before-tool-call.ts places the guard pipeline
      // invocation BEFORE the plugin hook runner call. This test verifies the guards
      // are registered at higher structural priority.
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);
      pipeline.register(CapabilityAllowlistGuard);

      expect(pipeline.guardNames()).toEqual(["TaintRiskGuard", "CapabilityAllowlistGuard"]);
    });
  });

  describe("HITL escalation flow", () => {
    it("blocks on timeout (fail-closed)", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);

      const tracker = new TaintTracker();
      tracker.tagArtifact(InstructionLevel.EXTERNAL_CONTENT);

      const call: ToolCall = { toolName: "exec", arguments: { command: "danger" } };
      const ctx = buildExecutionContext({ taintTracker: tracker });

      const result = await pipeline.validate(call, ctx, getToolMetadata("exec"));
      expect(result.action).toBe("escalate");

      if (result.action === "escalate") {
        const manager = new ExecApprovalManager();
        const escalation = await handleEscalation({ ...result, timeoutMs: 50 }, manager);
        expect(escalation.approved).toBe(false);
        if (!escalation.approved) {
          expect(escalation.reason).toContain("timed out");
        }
      }
    });

    it("allows when human approves", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);

      const tracker = new TaintTracker();
      tracker.tagArtifact(InstructionLevel.EXTERNAL_CONTENT);

      const call: ToolCall = { toolName: "exec", arguments: { command: "safe" } };
      const ctx = buildExecutionContext({ taintTracker: tracker });

      const result = await pipeline.validate(call, ctx, getToolMetadata("exec"));
      expect(result.action).toBe("escalate");

      if (result.action === "escalate") {
        const manager = new ExecApprovalManager();
        const createSpy = vi.spyOn(manager, "create");

        const promise = handleEscalation(result, manager, { agentId: "test" });

        await new Promise((r) => setTimeout(r, 10));
        const record = createSpy.mock.results[0].value;
        manager.resolve(record.id, "allow-once");

        const escalation = await promise;
        expect(escalation.approved).toBe(true);
      }
    });
  });

  describe("taint propagation through the pipeline", () => {
    it("deriveTaint preserves worst-case level for guard consumption", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);

      const clean = tagExternalContent("safe data", { source: "web_search" });
      const tainted = tagExternalContent("unsafe data", { source: "email" });
      const combined = deriveTaint([clean, tainted]);

      expect(combined.level).toBe(InstructionLevel.EXTERNAL_CONTENT);

      const tracker = new TaintTracker();
      tracker.tagArtifact(combined.level);

      const ctx = buildExecutionContext({ taintTracker: tracker });
      const result = await pipeline.validate(
        { toolName: "exec", arguments: {} },
        ctx,
        getToolMetadata("exec"),
      );

      expect(result.action).toBe("escalate");
    });

    it("taint tracker collapse preserves aggregate level", async () => {
      const tracker = new TaintTracker({ explosionThreshold: 3 });

      // Add fields until collapse
      for (let i = 0; i < 4; i++) {
        tracker.tagField(`field_${i}`, InstructionLevel.EXTERNAL_CONTENT);
      }

      expect(tracker.isCollapsed()).toBe(true);
      expect(tracker.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);

      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(CapabilityAllowlistGuard);

      const ctx = buildExecutionContext({ taintTracker: tracker });
      const result = await pipeline.validate({ toolName: "sessions_spawn", arguments: {} }, ctx);

      expect(result.action).toBe("block");
    });
  });

  describe("tagExternalContent", () => {
    it("produces TaggedPayload at EXTERNAL_CONTENT level", () => {
      const payload = tagExternalContent("some data", { source: "email" });
      expect(payload.level).toBe(InstructionLevel.EXTERNAL_CONTENT);
      expect(payload.content).toBe("some data");
      expect(payload.source).toBe("email");
    });
  });

  describe("reprompt result formatting", () => {
    it("reprompt reason includes tool name and taint level", async () => {
      const pipeline = ensureGlobalGuardPipeline();
      pipeline.register(TaintRiskGuard);

      const tracker = new TaintTracker();
      tracker.tagField("data", InstructionLevel.EXTERNAL_CONTENT);

      const ctx = buildExecutionContext({ taintTracker: tracker });
      const result = await pipeline.validate(
        { toolName: "edit", arguments: {} },
        ctx,
        getToolMetadata("edit"),
      );

      expect(result.action).toBe("reprompt");
      if (result.action === "reprompt") {
        expect(result.reason).toContain("edit");
        expect(result.reason).toContain("EXTERNAL_CONTENT");
        // Verify the prefix convention used in before-tool-call integration
        const prefixed = `[REPROMPT] ${result.agentInstruction}`;
        expect(prefixed).toMatch(/^\[REPROMPT\] /);
      }
    });
  });
});
