/**
 * End-to-end smoke test — verifies runtime wiring
 *
 * Tests that the meta-harness hooks module correctly integrates
 * with the hook system without actually running a gateway.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../../hooks/internal-hooks.js";
import { ensureRuntimeLayout } from "../gating.js";
import {
  registerMetaHarnessHooks,
  wrapMetaHarnessOnToolResult,
  finalizeSessionFlowTrace,
  recordDelegation,
  startHeartbeatFlowTrace,
  resetMetaHarnessState,
} from "../hooks.js";
import type { FlowTrace } from "../types.js";
import { listTraces } from "../writer.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mh-e2e-"));
  await ensureRuntimeLayout(tmpDir);
  clearInternalHooks();
  resetMetaHarnessState();
  registerMetaHarnessHooks();
});

afterEach(async () => {
  clearInternalHooks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("e2e: session lifecycle wiring", () => {
  it("starts flow trace on message:received and finalizes on complete", async () => {
    const sessionKey = "e2e-session-001";

    // Simulate gateway startup
    await triggerInternalHook(
      createInternalHookEvent("gateway", "startup", "gateway", {
        workspaceDir: tmpDir,
      }),
    );

    // Simulate message received
    await triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        workspaceDir: tmpDir,
        content: "test message",
        channelId: "feishu",
        from: "user",
      }),
    );

    // Finalize
    await finalizeSessionFlowTrace(sessionKey, tmpDir, "completed");

    // Verify trace was written
    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    const sessionTraces = traces.filter(
      (t) => t.data.session_id === sessionKey && t.data.trigger === "session",
    );
    expect(sessionTraces).toHaveLength(1);
    expect(sessionTraces[0].data.outcome).toBe("completed");
    expect(sessionTraces[0].data.task_summary).toBe("test message");
  });

  it("finalizes flow trace on failure", async () => {
    const sessionKey = "e2e-session-002";

    await triggerInternalHook(
      createInternalHookEvent("gateway", "startup", "gateway", {
        workspaceDir: tmpDir,
      }),
    );

    await triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        workspaceDir: tmpDir,
        content: "fail test",
        channelId: "telegram",
        from: "user",
      }),
    );

    await finalizeSessionFlowTrace(sessionKey, tmpDir, "failed");

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    expect(traces).toHaveLength(1);
    expect(traces[0].data.outcome).toBe("failed");
  });

  it("skips heartbeat messages in message:received", async () => {
    const sessionKey = "e2e-session-003";

    await triggerInternalHook(
      createInternalHookEvent("gateway", "startup", "gateway", {
        workspaceDir: tmpDir,
      }),
    );

    // Heartbeat messages should not create traces
    await triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        workspaceDir: tmpDir,
        content: "Read HEARTBEAT.md if it exists...",
        channelId: "feishu",
        from: "system",
      }),
    );

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    expect(traces).toHaveLength(0);
  });
});

describe("e2e: heartbeat flow trace", () => {
  it("starts and finalizes heartbeat flow trace", async () => {
    const sessionKey = "e2e-heartbeat-001";

    startHeartbeatFlowTrace(sessionKey, tmpDir, "interval");
    await finalizeSessionFlowTrace(sessionKey, tmpDir, "completed");

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    const hbTraces = traces.filter((t) => t.data.trigger === "heartbeat");
    expect(hbTraces).toHaveLength(1);
    expect(hbTraces[0].data.outcome).toBe("completed");
  });

  it("starts cron flow trace", async () => {
    const sessionKey = "e2e-cron-001";

    startHeartbeatFlowTrace(sessionKey, tmpDir, "cron");
    await finalizeSessionFlowTrace(sessionKey, tmpDir, "completed");

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    const cronTraces = traces.filter((t) => t.data.trigger === "cron");
    expect(cronTraces).toHaveLength(1);
  });
});

describe("e2e: delegation recording", () => {
  it("records delegation in active flow trace", async () => {
    const sessionKey = "e2e-delegation-001";

    await triggerInternalHook(
      createInternalHookEvent("gateway", "startup", "gateway", {
        workspaceDir: tmpDir,
      }),
    );

    await triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        workspaceDir: tmpDir,
        content: "dispatch task",
        channelId: "feishu",
        from: "user",
      }),
    );

    await recordDelegation({
      sessionKey,
      workspaceDir: tmpDir,
      childSessionId: "child-001",
      agentType: "claude-code",
      taskBrief: "implement feature",
      status: "completed",
    });

    await finalizeSessionFlowTrace(sessionKey, tmpDir, "completed");

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    expect(traces).toHaveLength(1);
    expect(traces[0].data.delegation_list).toHaveLength(1);
    expect(traces[0].data.delegation_list[0].agent_type).toBe("claude-code");
    expect(traces[0].data.delegation_list[0].status).toBe("completed");
  });
});

describe("e2e: tool result wrapping", () => {
  it("wrapMetaHarnessOnToolResult records tool outcomes", async () => {
    const sessionKey = "e2e-tool-001";
    let toolResultCalled = false;

    await triggerInternalHook(
      createInternalHookEvent("gateway", "startup", "gateway", {
        workspaceDir: tmpDir,
      }),
    );

    await triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        workspaceDir: tmpDir,
        content: "use tools",
        channelId: "feishu",
        from: "user",
      }),
    );

    // Simulate tool result
    const wrappedHandler = wrapMetaHarnessOnToolResult(
      sessionKey,
      tmpDir,
      async () => {
        toolResultCalled = true;
      },
      { toolName: "exec", success: true, durationMs: 500 },
    );

    await wrappedHandler({ text: "output" } as unknown as ReplyPayload);
    expect(toolResultCalled).toBe(true);

    await finalizeSessionFlowTrace(sessionKey, tmpDir, "completed");

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    expect(traces).toHaveLength(1);
    expect(traces[0].data.tool_outcomes).toHaveLength(1);
    expect(traces[0].data.tool_outcomes[0].tool_name).toBe("exec");
    expect(traces[0].data.tool_outcomes[0].success).toBe(true);
  });

  it("records failed tool outcomes", async () => {
    const sessionKey = "e2e-tool-002";

    await triggerInternalHook(
      createInternalHookEvent("gateway", "startup", "gateway", {
        workspaceDir: tmpDir,
      }),
    );

    await triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        workspaceDir: tmpDir,
        content: "fail tool",
        channelId: "feishu",
        from: "user",
      }),
    );

    const wrappedHandler = wrapMetaHarnessOnToolResult(sessionKey, tmpDir, async () => {}, {
      toolName: "web_search",
      success: false,
      error: "CAPTCHA",
      durationMs: 3000,
    });

    await wrappedHandler({ text: "blocked" } as unknown as ReplyPayload);
    await finalizeSessionFlowTrace(sessionKey, tmpDir, "completed");

    const traces = await listTraces<FlowTrace>(tmpDir, "traces");
    expect(traces[0].data.tool_outcomes[0].success).toBe(false);
    expect(traces[0].data.tool_outcomes[0].error).toBe("CAPTCHA");
  });
});

describe("e2e: workspace gating", () => {
  it("no-ops when workspace has no manifest", async () => {
    const sessionKey = "e2e-nomanifest";
    const noManifestDir = await fs.mkdtemp(path.join(os.tmpdir(), "mh-no-"));

    await triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        workspaceDir: noManifestDir,
        content: "test",
        channelId: "feishu",
        from: "user",
      }),
    );

    await finalizeSessionFlowTrace(sessionKey, noManifestDir, "completed");

    // No traces directory should exist
    try {
      await fs.access(path.join(noManifestDir, "data/meta-harness/traces"));
      expect.unreachable("traces directory should not exist");
    } catch {
      // Expected
    }

    await fs.rm(noManifestDir, { recursive: true, force: true });
  });
});
