import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnProcessAdapter } from "../process/supervisor/types.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { testing as controllerTesting } from "../sessions/session-controller.test-support.js";
import { getDiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const mocks = vi.hoisted(() => ({
  getSupervisor: vi.fn(),
  createChildAdapter: vi.fn(),
  approve: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: mocks.getSupervisor }));
vi.mock("../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: async (
    ...args: Parameters<typeof import("../process/supervisor/adapters/child.js").createChildAdapter>
  ) => ({
    adapter: await mocks.createChildAdapter(...args),
    ready: Promise.resolve(),
  }),
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

describe("heartbeat recovery after exec preparation", () => {
  let supervisor: ReturnType<typeof createProcessSupervisor>;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
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
    controllerTesting.resetSessionControllerForTest();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
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
      const operation = createReplyOperation({ ...ref, resetTriggered: false });
      operation.setPhase("running");
      const watchdogAttempt = operation.watchdog.attachAttempt({
        assertCurrent: () => controller.signal.throwIfAborted(),
      });
      const abort = vi.fn(() => controller.abort());
      operation.attachBackend({ kind: "embedded", runId: sessionId, cancel: abort });
      const preparing = createDeferred();
      const preparation = createDeferred<object>();
      mocks.approve.mockImplementationOnce(() => {
        preparing.resolve();
        return preparation.promise;
      });
      const completed = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
      const spawned = createDeferred();
      const adapter: SpawnProcessAdapter = {
        supportsRawOutput: true,
        onStdout: () => undefined,
        onStderr: () => undefined,
        wait: () => completed.promise,
        kill: (signal) => completed.resolve({ code: null, signal: signal ?? "SIGTERM" }),
        dispose: () => undefined,
      };
      mocks.createChildAdapter.mockImplementationOnce(async () => {
        spawned.resolve();
        return adapter;
      });
      const spawn = vi.spyOn(supervisor, "spawn");
      const tool = wrapToolWithBeforeToolCallHook(
        createExecTool({ host: "gateway", security: "full", ask: "off", allowBackground: false }),
        { ...ref, watchdogAttempt },
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
        )
        .finally(() => operation.complete());
      try {
        await preparing.promise;
        await waitForDiagnosticEventsDrained();
        // Recheck the exact owner after preparation publishes its enforced deadline.
        vi.setSystemTime(Date.now() + 930_000);
        expect(operation.watchdog.decide().action).toBe("stop");

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
        const outcome = await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: 930_000 });
        if (deadlineState === "future") {
          expect(outcome).toMatchObject({ status: "skipped", action: "observe_only" });
          expect(abort).not.toHaveBeenCalled();
          completed.resolve({ code: 0, signal: null });
          await expect(execution).resolves.toMatchObject({
            result: { details: { status: "completed" } },
          });
        } else {
          expect(outcome).toMatchObject({ status: "failed", action: "none" });
          expect(abort).toHaveBeenCalledOnce();
        }
      } finally {
        preparation.resolve({});
        completed.resolve({ code: 0, signal: null });
        controller.abort();
        await execution;
      }
    },
  );
});
