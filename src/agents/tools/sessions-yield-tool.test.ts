import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecoveryBundle, readTaskLedgerEvents } from "../session-recovery-state.js";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

describe("sessions_yield tool", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-yield-tool-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
  });

  afterEach(async () => {
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ onYield });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "No session context",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield callback with default message", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({ status: "yielded", message: "Turn yielded." });
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.");
  });

  it("passes the custom message through the yield callback", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", { message: "Waiting for fact-checker" });
    expect(result.details).toMatchObject({
      status: "yielded",
      message: "Waiting for fact-checker",
    });
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting for fact-checker");
  });

  it("records a recovery checkpoint after a successful yield when explicitly enabled", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "sess-1",
      onYield,
      recovery: {
        enabled: true,
        taskId: "task-yield",
        actorId: "avery",
        workspaceId: "/tmp/openclaw",
      },
    });

    const result = await tool.execute("call-1", { message: "Waiting for Sentry review" });

    expect(result.details).toMatchObject({
      status: "yielded",
      message: "Waiting for Sentry review",
      recovery: "recorded",
    });
    const ledger = readTaskLedgerEvents();
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toMatchObject({
      taskId: "task-yield",
      eventType: "handoff_written",
      summary: "Waiting for Sentry review",
      approvalStatus: "not_required",
    });
    expect(loadRecoveryBundle("task-yield")).toMatchObject({
      taskId: "task-yield",
      expiredApprovals: ["Approvals from prior sessions or turns are not inherited."],
    });
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "Yield not supported in this context",
    });
  });
});
