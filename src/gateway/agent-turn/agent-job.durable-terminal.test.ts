import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { readAgentRunTerminalReceipt } from "../../state/agent-run-terminal-receipts.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  resetAgentJobStateForTest,
  setAgentJobTerminalPersistenceFailureForTest,
  waitForAgentJob,
} from "./agent-job.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

let originalStateDir: string | undefined;
let runSequence = 0;

const owner = { agentId: "agent-a", sessionKey: "agent:agent-a:main", sessionId: "session-a" };

function terminalReceipt(runId: string) {
  return {
    runId,
    sessionId: owner.sessionId,
    turnId: `turn-${runId}`,
    requested: { provider: "test", model: "requested" },
    effective: { provider: "test", model: "effective", responseModel: "effective" },
    successfulToolNames: [],
    rerouted: false,
    terminalDisposition: "visible" as const,
  };
}

function startRun(runId: string, runOwner = owner) {
  registerAgentRunContext(runId, runOwner);
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 10 } });
}

function finishRun(runId: string, overrides: Record<string, unknown> = {}) {
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: {
      phase: "end",
      status: "ok",
      executionSettled: true,
      startedAt: 10,
      endedAt: 20,
      terminalReceipt: terminalReceipt(runId),
      ...overrides,
    },
  });
}

beforeEach(() => {
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const root = tempDirs.make("openclaw-agent-job-terminal-");
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  runOpenClawStateWriteTransaction(() => undefined);
  resetAgentJobStateForTest();
  resetAgentRunRegistryForTest();
});

afterEach(() => {
  setAgentJobTerminalPersistenceFailureForTest(false);
  resetAgentJobStateForTest();
  resetAgentRunRegistryForTest();
  vi.useRealTimers();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("durable agent job terminal receipts", () => {
  it("returns a stable terminal snapshot repeatedly after process-local state is lost", async () => {
    const runId = `run-durable-${runSequence++}`;
    const waiting = waitForAgentJob({ runId, timeoutMs: 5_000 });
    startRun(runId);
    finishRun(runId);
    await expect(waiting).resolves.toMatchObject({ status: "ok", startedAt: 10, endedAt: 20 });

    resetAgentJobStateForTest();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      startedAt: 10,
      endedAt: 20,
    });
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
    });
  });

  it("keeps the first terminal write authoritative across conflicting late events", async () => {
    const runId = `run-first-terminal-${runSequence++}`;
    startRun(runId);
    finishRun(runId);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({ endedAt: 20 });
    resetAgentJobStateForTest();

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "error", status: "error", executionSettled: true, endedAt: 99 },
    });
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
    });
  });

  it("allows a provisional retry error to resolve as success before durable publication", async () => {
    vi.useFakeTimers();
    const runId = `run-provisional-${runSequence++}`;
    startRun(runId);
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "error", status: "error", error: "retryable", endedAt: 15 },
    });
    finishRun(runId, { endedAt: 30 });
    await vi.runAllTimersAsync();

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 30,
    });
  });

  it("fences a retained receipt when a new owner starts with the same run id", async () => {
    const runId = `run-owner-fence-${runSequence++}`;
    startRun(runId);
    finishRun(runId);
    await waitForAgentJob({ runId, timeoutMs: 0 });
    resetAgentJobStateForTest();

    startRun(runId, {
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
      sessionId: "session-b",
    });
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
  });

  it("fails closed while a reused-run ownership fence cannot be persisted", async () => {
    vi.useFakeTimers();
    const runId = `run-failed-fence-${runSequence++}`;
    startRun(runId);
    finishRun(runId);
    await waitForAgentJob({ runId, timeoutMs: 0 });
    resetAgentJobStateForTest();

    setAgentJobTerminalPersistenceFailureForTest(true);
    startRun(runId, {
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
      sessionId: "session-b",
    });
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();

    setAgentJobTerminalPersistenceFailureForTest(false);
    finishRun(runId, { endedAt: 40 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 40,
    });
  });

  it("keeps ignoreCachedSnapshot compatible without replaying a durable receipt", async () => {
    const runId = `run-ignore-durable-${runSequence++}`;
    startRun(runId);
    finishRun(runId);
    await waitForAgentJob({ runId, timeoutMs: 0 });
    resetAgentJobStateForTest();

    await expect(
      waitForAgentJob({ runId, timeoutMs: 0, ignoreCachedSnapshot: true }),
    ).resolves.toBeNull();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({ status: "ok" });
  });

  it("commits durable state before waking waiters", async () => {
    const runId = `run-order-${runSequence++}`;
    const waiting = waitForAgentJob({ runId, timeoutMs: 5_000 }).then((snapshot) => ({
      snapshot,
      durable: readAgentRunTerminalReceipt({ runId, owner }),
    }));
    startRun(runId);
    finishRun(runId);

    await expect(waiting).resolves.toMatchObject({
      snapshot: { status: "ok" },
      durable: { runId, owner },
    });
  });

  it("does not publish terminal success until a failed durable write retries", async () => {
    vi.useFakeTimers();
    const runId = `run-write-failure-${runSequence++}`;
    startRun(runId);
    setAgentJobTerminalPersistenceFailureForTest(true);
    finishRun(runId);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();

    setAgentJobTerminalPersistenceFailureForTest(false);
    const recovered = waitForAgentJob({ runId, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(recovered).resolves.toMatchObject({ status: "ok", endedAt: 20 });
  });

  it("omits terminal reply content while retaining bounded delivery metadata", async () => {
    const runId = `run-no-reply-${runSequence++}`;
    startRun(runId);
    finishRun(runId, {
      terminalReply: { disposition: "visible", text: "PRIVATE COMPLETION TEXT" },
      terminalDelivery: { status: "sent", resultCount: 1 },
    });
    await waitForAgentJob({ runId, timeoutMs: 0 });
    const durable = readAgentRunTerminalReceipt({ runId, owner });
    const stored = JSON.parse(durable?.terminalJson ?? "null") as Record<string, unknown>;

    expect(stored).not.toHaveProperty("terminalReply");
    expect(durable?.terminalJson).not.toContain("PRIVATE COMPLETION TEXT");
    expect(stored.terminalDelivery).toEqual({ status: "sent", resultCount: 1 });
  });

  it("redacts and bounds persisted terminal error text", async () => {
    const runId = `run-bounded-error-${runSequence++}`;
    const secret = `sk-${"s".repeat(96)}`;
    startRun(runId);
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        status: "error",
        executionSettled: true,
        error: `${secret} ${"failure ".repeat(20_000)}`,
        endedAt: 20,
        terminalReceipt: terminalReceipt(runId),
      },
    });
    await waitForAgentJob({ runId, timeoutMs: 0 });
    const durable = readAgentRunTerminalReceipt({ runId, owner });

    expect(Buffer.byteLength(durable?.terminalJson ?? "", "utf8")).toBeLessThanOrEqual(65_536);
    expect(durable?.terminalJson).not.toContain(secret);
    expect(JSON.parse(durable?.terminalJson ?? "null")).toMatchObject({ status: "error" });
  });

  it("persists approval linkage when present and omits it when absent", async () => {
    const linkedRunId = `run-approval-${runSequence++}`;
    startRun(linkedRunId);
    emitAgentEvent({
      runId: linkedRunId,
      stream: "approval",
      data: {
        phase: "requested",
        kind: "exec",
        status: "pending",
        title: "Run command",
        approvalId: "approval-1",
        toolCallId: "tool-1",
      },
    });
    emitAgentEvent({
      runId: linkedRunId,
      stream: "approval",
      data: {
        phase: "resolved",
        kind: "exec",
        status: "approved",
        title: "Run command",
        approvalId: "approval-1",
        toolCallId: "tool-1",
      },
    });
    finishRun(linkedRunId);
    resetAgentJobStateForTest();
    await expect(waitForAgentJob({ runId: linkedRunId, timeoutMs: 0 })).resolves.toMatchObject({
      terminalReceipt: {
        approvalReceipts: [{ approvalId: "approval-1", toolCallId: "tool-1", state: "resolved" }],
      },
    });

    const absentRunId = `run-no-approval-${runSequence++}`;
    startRun(absentRunId);
    finishRun(absentRunId);
    resetAgentJobStateForTest();
    const absent = await waitForAgentJob({ runId: absentRunId, timeoutMs: 0 });
    expect(absent?.terminalReceipt).not.toHaveProperty("approvalReceipts");
  });
});
