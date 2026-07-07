/**
 * Hook agent dispatch crash-safety tests: task-ledger persistence, watchdog
 * timeout for wedged runs, operator cancel, and dispatch isolation so one
 * dead run cannot silently swallow later dispatches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatMock = vi.fn();
const runCronIsolatedAgentTurnMock = vi.fn();
const resolveMainSessionKeyMock = vi.fn(() => "main-session");
const loadConfigMock = vi.fn(() => ({}));
const createRunningTaskRunMock = vi.fn(() => ({ runId: "task" }));
const completeTaskRunByRunIdMock = vi.fn();
const failTaskRunByRunIdMock = vi.fn();
const cleanupTimedOutIsolatedAgentRunMock = vi.fn(async () => {});

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));
vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: resolveMainSessionKeyMock,
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveAgentMainSessionKey: vi.fn(
    (params: { agentId: string }) => `agent:${params.agentId}:main`,
  ),
}));
vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));
vi.mock("../../tasks/detached-task-runtime.js", () => ({
  createRunningTaskRun: createRunningTaskRunMock,
  completeTaskRunByRunId: completeTaskRunByRunIdMock,
  failTaskRunByRunId: failTaskRunByRunIdMock,
}));
vi.mock("../timed-out-agent-run-cleanup.js", () => ({
  cleanupTimedOutIsolatedAgentRun: cleanupTimedOutIsolatedAgentRunMock,
}));

let capturedDispatchAgentHook: ((...args: unknown[]) => unknown) | undefined;

vi.mock("./hooks-request-handler.js", () => ({
  createHooksRequestHandler: vi.fn((opts: Record<string, unknown>) => {
    capturedDispatchAgentHook = opts.dispatchAgentHook as typeof capturedDispatchAgentHook;
    return vi.fn();
  }),
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");
const { CRON_AGENT_SETUP_WATCHDOG_MS } = await import("../../cron/service/agent-watchdog.js");
const { isCronJobActive } = await import("../../cron/active-jobs.js");
const { cancelActiveCronTaskRun, resetActiveCronTaskRunsForTests } =
  await import("../../tasks/cron-task-cancel.js");

const logHooksInfoMock = vi.fn();
const logHooksWarnMock = vi.fn();

function buildMinimalParams() {
  return {
    deps: {} as never,
    getHooksConfig: () => null,
    getClientIpConfig: () => ({ trustedProxies: undefined, allowRealIpFallback: false }),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: logHooksWarnMock,
      debug: vi.fn(),
      info: logHooksInfoMock,
      error: vi.fn(),
    } as never,
  };
}

function buildAgentPayload(name: string, sessionKey = "session-1") {
  return {
    message: "test message",
    name,
    agentId: undefined,
    idempotencyKey: undefined,
    wakeMode: "now" as const,
    sessionKey,
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    to: undefined,
    model: undefined,
    thinking: undefined,
    timeoutSeconds: undefined,
    allowUnsafeExternalContent: undefined,
    externalContentSource: undefined,
  };
}

function dispatchAgentHook(payload: unknown): string {
  if (!capturedDispatchAgentHook) {
    throw new Error("dispatchAgentHook missing");
  }
  return capturedDispatchAgentHook(payload) as string;
}

function dispatchedJobId(callIndex = 0): string {
  const call = runCronIsolatedAgentTurnMock.mock.calls[callIndex]?.[0] as
    | { job: { id: string } }
    | undefined;
  if (!call) {
    throw new Error(`missing runCronIsolatedAgentTurn call ${callIndex}`);
  }
  return call.job.id;
}

describe("dispatchAgentHook crash safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveCronTaskRunsForTests();
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler(buildMinimalParams());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("persists a ledger row for accepted dispatches and completes it on success", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
      delivered: false,
    });

    const runId = dispatchAgentHook(buildAgentPayload("Reindex"));

    await vi.waitFor(() => expect(completeTaskRunByRunIdMock).toHaveBeenCalledTimes(1));
    // The registry's cron contract requires sourceId to be the active job id.
    expect(createRunningTaskRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "cron",
        runId,
        label: "Hook: Reindex",
        sourceId: dispatchedJobId(),
      }),
    );
    expect(completeTaskRunByRunIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId, runtime: "cron", terminalSummary: "done" }),
    );
    expect(failTaskRunByRunIdMock).not.toHaveBeenCalled();
    expect(isCronJobActive(dispatchedJobId())).toBe(false);
  });

  it("completes the ledger row for skipped runs like the cron ledger does", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "skipped",
      summary: "no eligible model",
      delivered: false,
    });

    const runId = dispatchAgentHook(buildAgentPayload("Reindex"));

    await vi.waitFor(() => expect(completeTaskRunByRunIdMock).toHaveBeenCalledTimes(1));
    expect(completeTaskRunByRunIdMock).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    expect(failTaskRunByRunIdMock).not.toHaveBeenCalled();
  });

  it("fails the ledger row when the run returns an error status", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "error",
      summary: "boom",
      delivered: false,
    });

    const runId = dispatchAgentHook(buildAgentPayload("Reindex"));

    await vi.waitFor(() => expect(failTaskRunByRunIdMock).toHaveBeenCalledTimes(1));
    expect(failTaskRunByRunIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId, status: "failed", error: "boom" }),
    );
  });

  it("fails the ledger row when the run rejects", async () => {
    runCronIsolatedAgentTurnMock.mockRejectedValueOnce(new Error("agent exploded"));

    const runId = dispatchAgentHook(buildAgentPayload("Reindex"));

    await vi.waitFor(() => expect(failTaskRunByRunIdMock).toHaveBeenCalledTimes(1));
    expect(failTaskRunByRunIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId, status: "failed", error: "Error: agent exploded" }),
    );
  });

  it("times out a wedged run, cleans it up, and keeps later dispatches executing", async () => {
    vi.useFakeTimers();
    // A run wedged before the runner starts: promise never settles, no phases.
    let sawAbort = false;
    runCronIsolatedAgentTurnMock.mockImplementationOnce(
      (params: { abortSignal?: AbortSignal }) =>
        new Promise(() => {
          params.abortSignal?.addEventListener("abort", () => {
            sawAbort = true;
          });
        }),
    );

    const wedgedRunId = dispatchAgentHook(buildAgentPayload("Wedged"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(isCronJobActive(dispatchedJobId())).toBe(true);

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1_000);

    expect(sawAbort).toBe(true);
    expect(cleanupTimedOutIsolatedAgentRunMock).toHaveBeenCalledTimes(1);
    expect(failTaskRunByRunIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: wedgedRunId, status: "timed_out" }),
    );
    expect(
      enqueueSystemEventMock.mock.calls.some(([message]) =>
        String(message).startsWith("Hook Wedged (timeout):"),
      ),
    ).toBe(true);
    expect(requestHeartbeatMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "hook", intent: "immediate" }),
    );
    expect(isCronJobActive(dispatchedJobId())).toBe(false);

    // The dead run must not swallow subsequent dispatches (live wedge repro:
    // gateway kept acking hook posts for hours without executing them).
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
      delivered: false,
    });
    const nextRunId = dispatchAgentHook(buildAgentPayload("Next"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(completeTaskRunByRunIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: nextRunId }),
    );
  });

  it("reports operator cancel quietly instead of as a hook failure", async () => {
    runCronIsolatedAgentTurnMock.mockImplementationOnce(() => new Promise(() => {}));

    const runId = dispatchAgentHook(buildAgentPayload("Cancelled"));
    await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));

    expect(cancelActiveCronTaskRun({ runId, reason: "Cancelled by operator." })).toBe(true);

    await vi.waitFor(() =>
      expect(failTaskRunByRunIdMock).toHaveBeenCalledWith(
        expect.objectContaining({ runId, status: "cancelled" }),
      ),
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(
      logHooksInfoMock.mock.calls.some(([message]) => message === "hook agent run cancelled"),
    ).toBe(true);
  });

  it("runs concurrent dispatches as independent isolated jobs", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    runCronIsolatedAgentTurnMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const firstRunId = dispatchAgentHook(buildAgentPayload("First", "hook:one"));
    const secondRunId = dispatchAgentHook(buildAgentPayload("Second", "hook:two"));
    await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));

    expect(firstRunId).not.toBe(secondRunId);
    const [firstCall, secondCall] = runCronIsolatedAgentTurnMock.mock.calls as Array<
      [{ job: { id: string; sessionTarget: string }; sessionKey: string }]
    >;
    expect(firstCall[0].job.sessionTarget).toBe("isolated");
    expect(secondCall[0].job.sessionTarget).toBe("isolated");
    expect(firstCall[0].job.id).not.toBe(secondCall[0].job.id);
    expect(firstCall[0].sessionKey).not.toBe(secondCall[0].sessionKey);

    for (const resolve of resolvers) {
      resolve({ status: "ok", summary: "done", delivered: false });
    }
    await vi.waitFor(() => expect(completeTaskRunByRunIdMock).toHaveBeenCalledTimes(2));
    runCronIsolatedAgentTurnMock.mockReset();
  });
});
