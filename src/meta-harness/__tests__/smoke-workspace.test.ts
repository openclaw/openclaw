/**
 * Smoke test — verifies actual workspace trace writing
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createFlowTraceBuilder, generateDailySummary } from "../index.js";
import { generateTraceId } from "../writer.js";

const WORKSPACE = "/home/openclaw/.openclaw/workspace";

describe("smoke test: actual workspace", () => {
  it("writes a flow trace to real workspace", async () => {
    const builder = createFlowTraceBuilder({
      workspaceDir: WORKSPACE,
      sessionId: "smoke-test-session",
      flowId: "smoke-flow-001",
      trigger: "session",
      taskSummary: "Meta-Harness smoke test",
      triageDomain: "ops",
      automationLevel: "A",
    });
    expect(builder).not.toBeNull();

    builder!.recordToolOutcome({ tool_name: "read", success: true, duration_ms: 50 });
    builder!.recordToolOutcome({
      tool_name: "exec",
      success: false,
      error: "not found",
      duration_ms: 200,
    });

    const filePath = await builder!.finalize("completed");
    expect(filePath).not.toBeNull();
    expect(filePath!).toContain("traces/");

    // Verify file exists and is valid JSON
    const content = await fs.readFile(filePath!, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.trace_id).toBeTruthy();
    expect(parsed.tool_outcomes).toHaveLength(2);
    expect(parsed.outcome).toBe("completed");
  });

  it("writes a child trace linked to parent", async () => {
    const builder = createFlowTraceBuilder({
      workspaceDir: WORKSPACE,
      sessionId: "smoke-parent",
      flowId: "smoke-flow-002",
      trigger: "session",
      taskSummary: "parent for child test",
      triageDomain: "build",
      automationLevel: "B",
    });

    const childPath = await builder!.writeChildTrace({
      child_trace_id: generateTraceId(),
      child_session_id: "child-smoke-001",
      agent_type: "claude-code",
      task_brief: "fix bug",
      status: "completed",
      verification_summary: "tests pass",
      summarized_tool_calls: [
        { tool_name: "edit", success: true },
        { tool_name: "exec", success: false, error: "failed" },
      ],
      timestamp: new Date().toISOString(),
    });
    expect(childPath).not.toBeNull();
    expect(childPath!).toContain("children/");

    // Verify child links to parent
    const content = await fs.readFile(childPath!, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.parent_trace_id).toBe(builder!.traceId);
  });

  it("writes a rich trace on escalation", async () => {
    const builder = createFlowTraceBuilder({
      workspaceDir: WORKSPACE,
      sessionId: "smoke-rich",
      flowId: "smoke-flow-003",
      trigger: "cron",
      taskSummary: "escalation test",
      triageDomain: "governance",
      automationLevel: "B",
    });

    const richPath = await builder!.writeRichTrace("rule violation", '{"detail": "test"}');
    expect(richPath).not.toBeNull();
    expect(richPath!).toContain("rich/");

    await builder!.finalize("escalated");
  });

  it("generates daily summary", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const summaryPath = await generateDailySummary(WORKSPACE, today);
    expect(summaryPath).not.toBeNull();
    expect(summaryPath!).toContain("daily/");

    const content = await fs.readFile(summaryPath!, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.date).toBe(today);
    expect(parsed.total_runs).toBeGreaterThanOrEqual(0);
    // Tool errors from parent + child traces should be counted
    expect(typeof parsed.tool_error_count).toBe("number");
  });

  it("verifies all runtime directories exist", async () => {
    const dirs = ["traces", "children", "rich", "daily", "weekly", "indexes"];
    for (const d of dirs) {
      const p = path.join(WORKSPACE, "data/meta-harness", d);
      const stat = await fs.stat(p);
      expect(stat.isDirectory()).toBe(true);
    }
  });
});
