/**
 * Meta-Harness unit tests
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkWorkspaceGating, ensureRuntimeLayout } from "../gating.js";
import { createFlowTraceBuilder, generateDailySummary } from "../index.js";
import type { FlowTrace, ChildTrace, DailySummary } from "../types.js";
import {
  generateTraceId,
  writeFlowTrace,
  writeChildTrace,
  writeRichTrace,
  listTraces,
} from "../writer.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mh-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Workspace Gating ────────────────────────────────────────────

describe("workspace gating", () => {
  it("returns disabled when manifest is missing", async () => {
    const result = await checkWorkspaceGating(tmpDir);
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toContain("manifest");
    }
  });

  it("returns enabled when manifest exists", async () => {
    await ensureRuntimeLayout(tmpDir);
    const result = await checkWorkspaceGating(tmpDir);
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.manifest.version).toBe("1.0.0");
    }
  });

  it("creates full runtime layout", async () => {
    const ok = await ensureRuntimeLayout(tmpDir);
    expect(ok).toBe(true);

    const expectedDirs = [
      "data/meta-harness/traces",
      "data/meta-harness/children",
      "data/meta-harness/rich",
      "data/meta-harness/daily",
      "data/meta-harness/weekly",
      "data/meta-harness/indexes",
    ];
    for (const rel of expectedDirs) {
      const stat = await fs.stat(path.join(tmpDir, rel));
      expect(stat.isDirectory()).toBe(true);
    }

    const manifest = await fs.readFile(
      path.join(tmpDir, "data/meta-harness/manifest.json"),
      "utf-8",
    );
    const parsed = JSON.parse(manifest);
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.created_at).toBeTruthy();
  });
});

// ─── Trace ID Generation ─────────────────────────────────────────

describe("trace ID generation", () => {
  it("generates unique UUIDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

// ─── Flow Trace Writer ───────────────────────────────────────────

describe("flow trace writer", () => {
  it("writes a flow trace JSON file", async () => {
    await ensureRuntimeLayout(tmpDir);
    const trace: FlowTrace = {
      trace_id: generateTraceId(),
      timestamp: new Date().toISOString(),
      session_id: "test-session",
      flow_id: "flow-1",
      trigger: "session",
      task_summary: "test task",
      triage_domain: "research",
      automation_level: "A",
      delegation_list: [],
      outcome: "completed",
      observations: [],
      harness_version: "1.0.0",
      tool_outcomes: [],
      duration_ms: 100,
    };
    const filePath = await writeFlowTrace(tmpDir, trace);
    expect(filePath).toContain("traces/");
    expect(filePath).toContain(trace.trace_id);

    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.trace_id).toBe(trace.trace_id);
    expect(parsed.trigger).toBe("session");
  });
});

// ─── Child Trace Writer ──────────────────────────────────────────

describe("child trace writer", () => {
  it("writes a child trace linked to parent", async () => {
    await ensureRuntimeLayout(tmpDir);
    const parentId = generateTraceId();
    const child: ChildTrace = {
      child_trace_id: generateTraceId(),
      parent_trace_id: parentId,
      child_session_id: "child-1",
      agent_type: "claude-code",
      task_brief: "implement feature X",
      status: "completed",
      verification_summary: "tests pass",
      summarized_tool_calls: [],
      timestamp: new Date().toISOString(),
    };
    const filePath = await writeChildTrace(tmpDir, child);
    expect(filePath).toContain("children/");

    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.parent_trace_id).toBe(parentId);
    expect(parsed.agent_type).toBe("claude-code");
  });
});

// ─── Rich Trace Writer ───────────────────────────────────────────

describe("rich trace writer", () => {
  it("writes a rich trace on escalation", async () => {
    await ensureRuntimeLayout(tmpDir);
    const richTrace = {
      trace_id: generateTraceId(),
      escalation_reason: "rule violation detected",
      timestamp: new Date().toISOString(),
      raw_content: '{"detail": "some raw data"}',
    };
    const filePath = await writeRichTrace(tmpDir, richTrace);
    expect(filePath).toContain("rich/");
    expect(filePath).toContain("rich-");
  });
});

// ─── FlowTraceBuilder ────────────────────────────────────────────

describe("FlowTraceBuilder", () => {
  it("builds and finalizes a complete flow trace", async () => {
    await ensureRuntimeLayout(tmpDir);
    const builder = createFlowTraceBuilder({
      workspaceDir: tmpDir,
      sessionId: "session-123",
      flowId: "flow-abc",
      trigger: "session",
      taskSummary: "investigate issue",
      triageDomain: "research",
      automationLevel: "B",
    });
    expect(builder).not.toBeNull();

    if (!builder) {
      return;
    }

    builder.recordToolOutcome({
      tool_name: "web_search",
      success: true,
      duration_ms: 500,
    });
    builder.recordToolOutcome({
      tool_name: "exec",
      success: false,
      error: "command timed out",
      duration_ms: 10000,
    });
    builder.recordObservation({
      kind: "OBSERVED",
      summary: "search returned 5 results",
    });
    builder.recordObservation({
      kind: "INFERRED",
      summary: "issue is likely a config problem",
    });

    const filePath = await builder.finalize("completed");
    expect(filePath).not.toBeNull();

    const content = await fs.readFile(filePath!, "utf-8");
    const parsed: FlowTrace = JSON.parse(content);
    expect(parsed.session_id).toBe("session-123");
    expect(parsed.tool_outcomes).toHaveLength(2);
    expect(parsed.tool_outcomes[1].success).toBe(false);
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
    expect(parsed.harness_version).toBe("1.0.0");
  });

  it("returns null when finalizing without manifest", async () => {
    const builder = createFlowTraceBuilder({
      workspaceDir: tmpDir,
      sessionId: "s",
      flowId: "f",
      trigger: "heartbeat",
      taskSummary: "check",
      triageDomain: "ops",
      automationLevel: "A",
    });

    const filePath = await builder!.finalize("completed");
    expect(filePath).toBeNull();
  });

  it("writes child trace via builder", async () => {
    await ensureRuntimeLayout(tmpDir);
    const builder = createFlowTraceBuilder({
      workspaceDir: tmpDir,
      sessionId: "s",
      flowId: "f",
      trigger: "session",
      taskSummary: "dispatch work",
      triageDomain: "build",
      automationLevel: "B",
    });

    const filePath = await builder!.writeChildTrace({
      child_trace_id: generateTraceId(),
      child_session_id: "child-1",
      agent_type: "claude-code",
      task_brief: "fix bug #42",
      status: "completed",
      verification_summary: "2 tests pass",
      summarized_tool_calls: [{ tool_name: "edit", success: true }],
      timestamp: new Date().toISOString(),
    });
    expect(filePath).not.toBeNull();
  });

  it("writes rich trace via builder on escalation", async () => {
    await ensureRuntimeLayout(tmpDir);
    const builder = createFlowTraceBuilder({
      workspaceDir: tmpDir,
      sessionId: "s",
      flowId: "f",
      trigger: "cron",
      taskSummary: "daily check",
      triageDomain: "ops",
      automationLevel: "A",
    });

    const filePath = await builder!.writeRichTrace(
      "terminal failure",
      '{"error": "unrecoverable"}',
    );
    expect(filePath).not.toBeNull();
  });
});

// ─── Daily Summary ───────────────────────────────────────────────

describe("daily summary", () => {
  it("generates daily summary from traces", async () => {
    await ensureRuntimeLayout(tmpDir);
    const date = new Date().toISOString().slice(0, 10);

    // Write 2 flow traces for today
    for (let i = 0; i < 2; i++) {
      const trace: FlowTrace = {
        trace_id: generateTraceId(),
        timestamp: new Date().toISOString(),
        session_id: `s-${i}`,
        flow_id: `f-${i}`,
        trigger: i === 0 ? "session" : "heartbeat",
        task_summary: `task ${i}`,
        triage_domain: i === 0 ? "research" : "ops",
        automation_level: "A",
        delegation_list: [],
        outcome: i === 0 ? "completed" : "partial",
        observations: [],
        harness_version: "1.0.0",
        tool_outcomes: [
          { tool_name: "exec", success: true, duration_ms: 100 },
          { tool_name: "web_fetch", success: false, error: "404" },
        ],
        duration_ms: 1000,
      };
      await writeFlowTrace(tmpDir, trace);
    }

    const filePath = await generateDailySummary(tmpDir, date);
    expect(filePath).not.toBeNull();

    const content = await fs.readFile(filePath!, "utf-8");
    const summary: DailySummary = JSON.parse(content);
    expect(summary.date).toBe(date);
    expect(summary.total_runs).toBe(2);
    expect(summary.outcomes.completed).toBe(1);
    expect(summary.outcomes.partial).toBe(1);
    expect(summary.tool_call_count).toBe(4);
    expect(summary.tool_error_count).toBe(2);
    expect(summary.tool_error_frequency).toBe(0.5);
  });
});

// ─── List Traces ─────────────────────────────────────────────────

describe("list traces", () => {
  it("lists all trace files in a directory", async () => {
    await ensureRuntimeLayout(tmpDir);
    await writeFlowTrace(tmpDir, {
      trace_id: "test-1",
      timestamp: new Date().toISOString(),
      session_id: "s",
      flow_id: "f",
      trigger: "session",
      task_summary: "t",
      triage_domain: "research",
      automation_level: "A",
      delegation_list: [],
      outcome: "completed",
      observations: [],
      harness_version: "1.0.0",
      tool_outcomes: [],
      duration_ms: 100,
    });

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    expect(traces).toHaveLength(1);
    expect(traces[0].data.trace_id).toBe("test-1");
  });
});
