import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import {
  deleteAgentRunTerminalReceipt,
  readAgentRunTerminalReceipt,
  writeAgentRunTerminalReceipt,
} from "../../state/agent-run-terminal-receipts.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  resetAgentJobStateForTest,
  setAgentJobTerminalPersistenceFailureForTest,
  setGatewayDedupeEntry,
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
  it("settles concurrent padded run IDs for one session independently across recovery", async () => {
    const paddedRunId = ` run-concurrent-${runSequence++} `;
    const plainRunId = paddedRunId.trim();
    startRun(paddedRunId);
    startRun(plainRunId);

    finishRun(paddedRunId, { endedAt: 21 });
    finishRun(plainRunId, { endedAt: 22 });

    await expect(
      Promise.all([
        waitForAgentJob({ runId: paddedRunId, timeoutMs: 0 }),
        waitForAgentJob({ runId: plainRunId, timeoutMs: 0 }),
      ]),
    ).resolves.toMatchObject([
      { status: "ok", endedAt: 21 },
      { status: "ok", endedAt: 22 },
    ]);

    resetAgentJobStateForTest();
    await expect(
      Promise.all([
        waitForAgentJob({ runId: paddedRunId, timeoutMs: 0 }),
        waitForAgentJob({ runId: plainRunId, timeoutMs: 0 }),
      ]),
    ).resolves.toMatchObject([
      { status: "ok", endedAt: 21 },
      { status: "ok", endedAt: 22 },
    ]);
  });

  it.each([
    ["oversized", `run-${"x".repeat(257)}`],
    ["whitespace-only", " \t\n "],
  ])("terminalizes an admitted %s run ID without a persistence retry", async (_label, runId) => {
    vi.useFakeTimers();
    startRun(runId);
    finishRun(runId);

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
      terminalReceipt: { runId, turnId: `turn-${runId}` },
    });
    expect(vi.getTimerCount()).toBe(0);

    resetAgentJobStateForTest();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
      terminalReceipt: { runId, turnId: `turn-${runId}` },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminalizes deterministic receipt validation failures without retrying", async () => {
    vi.useFakeTimers();
    const runId = `run-invalid-owner-${runSequence++}`;
    startRun(runId, { ...owner, agentId: "a".repeat(129) });
    finishRun(runId);

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      error: "durable terminal receipt validation failed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a dedupe-only run start when its terminal owner settles", async () => {
    const runId = `run-dedupe-only-${runSequence++}`;
    const dedupe = new Map();
    registerAgentRunContext(runId, owner);
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: { ts: 10, ok: true, payload: { status: "accepted", runId } },
    });
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: { ts: 20, ok: true, payload: { status: "ok", runId, endedAt: 20 } },
    });

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
    });
  });

  it.each([
    {
      label: "failure",
      data: { phase: "error", status: "error", error: "execution failed" },
      expected: { status: "error", error: "execution failed" },
    },
    {
      label: "cancellation",
      data: { phase: "error", status: "error", stopReason: "rpc" },
      expected: { status: "error", stopReason: "rpc" },
    },
    {
      label: "hard timeout",
      data: {
        phase: "end",
        status: "timeout",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expected: { status: "timeout", timeoutPhase: "provider" },
    },
  ])(
    "promotes a later execution $label over provisional durable delivery success",
    async ({ data, expected }) => {
      const runId = `run-delivery-before-execution-${runSequence++}`;
      const dedupe = new Map();
      registerAgentRunContext(runId, owner);
      setGatewayDedupeEntry({
        dedupe,
        key: `agent:${runId}`,
        entry: { ts: 10, ok: true, payload: { status: "accepted", runId } },
      });
      setGatewayDedupeEntry({
        dedupe,
        key: `agent:${runId}`,
        entry: { ts: 20, ok: true, payload: { status: "ok", runId, endedAt: 20 } },
      });
      await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
        status: "ok",
      });

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { ...data, executionSettled: true, startedAt: 10, endedAt: 30 },
      });
      resetAgentJobStateForTest();

      await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject(expected);
    },
  );

  it("replaces a provisional delivery failure with the later execution failure", async () => {
    const runId = `run-delivery-failure-before-execution-${runSequence++}`;
    const dedupe = new Map();
    startRun(runId);
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: 20,
        ok: false,
        payload: { status: "error", runId, error: "delivery failed", endedAt: 20 },
      },
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        status: "error",
        executionSettled: true,
        error: "execution failed",
        endedAt: 30,
      },
    });
    resetAgentJobStateForTest();

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      error: "execution failed",
    });
  });

  it("preserves a chat delivery failure after execution success is durable", async () => {
    const runId = `run-delivery-after-execution-${runSequence++}`;
    const dedupe = new Map();
    startRun(runId);
    finishRun(runId);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
    });

    setGatewayDedupeEntry({
      dedupe,
      key: `chat:${runId}`,
      entry: {
        ts: 30,
        ok: false,
        payload: { status: "error", runId, error: "delivery failed", endedAt: 30 },
      },
    });

    await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      error: "delivery failed",
      endedAt: 30,
    });
  });

  it.each([
    {
      label: "provider timeout",
      payload: { status: "timeout", timeoutPhase: "provider", providerStarted: true },
      expected: { status: "timeout", timeoutPhase: "provider" },
    },
    {
      label: "cancellation",
      payload: { status: "error", stopReason: "rpc" },
      expected: { status: "error", stopReason: "rpc" },
    },
  ])(
    "keeps a provisional $label through later execution success while preserving delivery evidence",
    async ({ payload, expected }) => {
      const runId = `run-sticky-before-success-${runSequence++}`;
      const dedupe = new Map();
      startRun(runId);
      setGatewayDedupeEntry({
        dedupe,
        key: `agent:${runId}`,
        entry: {
          ts: 20,
          ok: false,
          payload: { runId, startedAt: 10, endedAt: 20, ...payload },
        },
      });
      finishRun(runId, {
        endedAt: 30,
        terminalDelivery: { status: "sent", resultCount: 1 },
      });

      const hot = await waitForAgentJob({ runId, timeoutMs: 0 });
      expect(hot).toMatchObject({
        ...expected,
        terminalDelivery: { status: "sent", resultCount: 1 },
      });
      expect(hot).not.toHaveProperty("executionSettled");

      resetAgentJobStateForTest();
      const recovered = await waitForAgentJob({ runId, timeoutMs: 0 });
      expect(recovered).toMatchObject({
        ...expected,
        terminalDelivery: { status: "sent", resultCount: 1 },
      });
      expect(recovered).not.toHaveProperty("executionSettled");
      expect(
        JSON.parse(readAgentRunTerminalReceipt({ runId, owner })?.terminalJson ?? "null"),
      ).toMatchObject({ executionSettled: true });
    },
  );

  it("retires a conflicting durable owner with one explicit failure and no retry", async () => {
    vi.useFakeTimers();
    const runId = `run-owner-conflict-${runSequence++}`;
    const conflictingOwner = {
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
      sessionId: "session-b",
    };
    startRun(runId);
    writeAgentRunTerminalReceipt({
      runId,
      owner: conflictingOwner,
      terminalJson: JSON.stringify({ status: "ok", executionSettled: true, endedAt: 15 }),
    });

    finishRun(runId);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("durable terminal receipt owner conflict"),
    });

    deleteAgentRunTerminalReceipt({ runId });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readAgentRunTerminalReceipt({ runId, owner })).toBeUndefined();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("durable terminal receipt owner conflict"),
    });
  });

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

  it("keeps incognito terminal outcomes process-local", async () => {
    const runId = `run-incognito-${runSequence++}`;
    const incognitoOwner = {
      ...owner,
      sessionKey: "agent:agent-a:dashboard:incognito-private",
      sessionId: "incognito-session",
    };
    startRun(runId, incognitoOwner);
    finishRun(runId);

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
    });
    expect(readAgentRunTerminalReceipt({ runId, owner: incognitoOwner })).toBeUndefined();

    resetAgentJobStateForTest();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
  });

  it("does not project an ordinary receipt onto an incognito run that reuses its id", async () => {
    const runId = `run-ordinary-to-incognito-${runSequence++}`;
    startRun(runId);
    finishRun(runId);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
    });
    resetAgentJobStateForTest();

    const incognitoOwner = {
      ...owner,
      sessionKey: "agent:agent-a:dashboard:incognito-reused-id",
      sessionId: "incognito-session",
    };
    startRun(runId, incognitoOwner);
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        status: "error",
        executionSettled: true,
        error: "current incognito completion",
        endedAt: 40,
      },
    });

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      error: "current incognito completion",
      endedAt: 40,
    });
    expect(readAgentRunTerminalReceipt({ runId })).toBeUndefined();

    resetAgentJobStateForTest();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
  });

  it("does not recover an incognito receipt written by an older gateway", async () => {
    const runId = `run-legacy-incognito-${runSequence++}`;
    const incognitoOwner = {
      ...owner,
      sessionKey: "agent:agent-a:dashboard:incognito-legacy",
      sessionId: "incognito-session",
    };
    writeAgentRunTerminalReceipt({
      runId,
      owner: incognitoOwner,
      terminalJson: JSON.stringify({ status: "ok", executionSettled: true, endedAt: 20 }),
    });

    resetAgentJobStateForTest();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
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

  it("honors a same-owner durable winner when the local terminal write is retained", async () => {
    const runId = `run-retained-terminal-${runSequence++}`;
    startRun(runId);
    writeAgentRunTerminalReceipt({
      runId,
      owner,
      terminalJson: JSON.stringify({
        status: "error",
        executionSettled: true,
        error: "first durable completion",
        endedAt: 15,
      }),
    });

    finishRun(runId, { endedAt: 99 });

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      error: "first durable completion",
      endedAt: 15,
    });
    expect(
      JSON.parse(readAgentRunTerminalReceipt({ runId, owner })?.terminalJson ?? "null"),
    ).toMatchObject({ status: "error", error: "first durable completion", endedAt: 15 });
  });

  it("does not recreate a pruned receipt from a stale late completion callback", async () => {
    const runId = `run-pruned-terminal-${runSequence++}`;
    startRun(runId);
    finishRun(runId);
    expect(deleteAgentRunTerminalReceipt({ runId })).toBe(true);

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        status: "error",
        executionSettled: true,
        error: "late callback",
        endedAt: 99,
      },
    });

    expect(readAgentRunTerminalReceipt({ runId, owner })).toBeUndefined();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      endedAt: 20,
    });
    resetAgentJobStateForTest();
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
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
