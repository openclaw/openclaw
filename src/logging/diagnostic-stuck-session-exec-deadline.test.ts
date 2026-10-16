import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { createStubChildAdapter } from "../process/supervisor/supervisor.test-support.js";
import {
  createDiagnosticRunHandle,
  resetDiagnosticRecoveryState,
  createQueuedRecoveryHeartbeat,
  diagnosticTimerTypes,
} from "./diagnostic-recovery.test-support.js";
import { getDiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";
import { logSessionStateChange } from "./diagnostic.js";

const mocks = vi.hoisted(() => ({
  getSupervisor: vi.fn(),
  createChildAdapter: vi.fn(),
  approve: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: mocks.getSupervisor }));
vi.mock("../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: mocks.createChildAdapter,
}));
vi.mock("../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/shell-env.js")>()),
  getShellPathFromLoginShell: () => null,
  resolveShellEnvFallbackTimeoutMs: () => 0,
  shouldEnableShellEnvFallback: () => false,
}));
vi.mock("../agents/bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: mocks.approve,
}));

let supervisor: ReturnType<typeof createProcessSupervisor>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...diagnosticTimerTypes] });
  vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
  mocks.approve.mockReset();
  mocks.createChildAdapter.mockReset();
  supervisor = createProcessSupervisor();
  mocks.getSupervisor.mockReturnValue(supervisor);
  setDiagnosticsEnabledForProcess(true);
});

afterEach(async () => {
  await supervisor.shutdown();
  resetProcessRegistryForTests();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetDiagnosticRecoveryState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["future", "expired", "absent"] as const)(
  "rechecks a %s command deadline at queued recovery dispatch",
  async (deadlineState) => {
    const sessionId = `exec-preparation-${deadlineState}`;
    const ref = { sessionId, sessionKey: `agent:main:${sessionId}`, runId: sessionId };
    const controller = new AbortController();
    const { classified, dispatch, recovered, start } = createQueuedRecoveryHeartbeat();
    start();
    logSessionStateChange({ ...ref, state: "processing" });
    const abort = vi.fn(() => {
      controller.abort();
      clearActiveEmbeddedRun(sessionId, handle, ref.sessionKey);
    });
    const handle = createDiagnosticRunHandle(ref, abort);
    setActiveEmbeddedRun(sessionId, handle, ref.sessionKey);
    const preparing = createDeferred();
    const preparation = createDeferred<object>();
    mocks.approve.mockImplementationOnce(() => {
      preparing.resolve();
      return preparation.promise;
    });
    const spawned = createDeferred();
    const adapter = {
      ...createStubChildAdapter({
        onKill: (signal, child) => child.settle(null, signal ?? "SIGTERM"),
      }),
      pid: undefined,
    };
    mocks.createChildAdapter.mockImplementationOnce(async () => {
      spawned.resolve();
      return { adapter, ready: Promise.resolve() };
    });
    const spawn = vi.spyOn(supervisor, "spawn");
    const tool = wrapToolWithBeforeToolCallHook(
      createExecTool({ host: "gateway", security: "full", ask: "off", allowBackground: false }),
      ref,
    );
    const execution = tool
      .execute(
        "foreground",
        { command: "sleep 970", timeoutSeconds: deadlineState === "absent" ? 0 : 1400 },
        controller.signal,
      )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    try {
      await preparing.promise;
      await waitForDiagnosticEventsDrained();
      await vi.advanceTimersByTimeAsync(930_000);
      expect(await classified.promise).toMatchObject({ allowActiveAbort: true, sessionId });
      expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBeUndefined();

      preparation.resolve({});
      await spawned.promise;
      await spawn.mock.results[0]?.value;
      await vi.advanceTimersByTimeAsync(0);
      await waitForDiagnosticEventsDrained();
      const deadline = getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs;
      if (deadlineState !== "absent") {
        expect(deadline).toBe(Date.now() + 1_400_000 + 900_000);
      }
      if (deadlineState === "expired") {
        vi.setSystemTime(deadline! + 1);
      }
      if (deadlineState === "future") {
        const attention: string[] = [];
        const unsubscribe = onDiagnosticEvent((event) => {
          if (event.type === "session.stalled" || event.type === "session.long_running") {
            attention.push(event.type);
          }
        });
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          await waitForDiagnosticEventsDrained();
          expect(attention).toEqual(["session.long_running"]);
        } finally {
          unsubscribe();
        }
      }
      dispatch.resolve();
      const outcome = await recovered.promise;
      if (deadlineState === "future") {
        expect(outcome).toMatchObject({ status: "skipped", action: "observe_only" });
        expect(abort).not.toHaveBeenCalled();
        adapter.settle(0);
        await expect(execution).resolves.toMatchObject({
          result: { details: { status: "completed" } },
        });
      } else {
        expect(outcome).toMatchObject({ status: "aborted", action: "abort_embedded_run" });
        expect(abort).toHaveBeenCalledOnce();
      }
    } finally {
      preparation.resolve({});
      dispatch.resolve();
      adapter.settle(0);
      clearActiveEmbeddedRun(sessionId, handle, ref.sessionKey);
      controller.abort();
      await execution;
    }
  },
);
