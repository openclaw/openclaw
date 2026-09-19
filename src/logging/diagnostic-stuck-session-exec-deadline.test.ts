import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnProcessAdapter } from "../process/supervisor/types.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
} from "./diagnostic-run-activity.js";
import type {
  StuckSessionRecoveryOutcome,
  StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { logSessionStateChange, startDiagnosticHeartbeat } from "./diagnostic.js";
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
vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: () => null,
  resolveShellEnvFallbackTimeoutMs: () => 0,
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
    embeddedRunTesting.resetActiveEmbeddedRuns();
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
      const classified = createDeferred<StuckSessionRecoveryRequest>();
      const dispatch = createDeferred();
      const recovered = createDeferred<StuckSessionRecoveryOutcome>();
      startDiagnosticHeartbeat(
        { diagnostics: { enabled: true } },
        {
          sampleLiveness: () => null,
          recoverStuckSession: async (request) => {
            classified.resolve(request);
            await dispatch.promise;
            const outcome = await recoverStuckDiagnosticSession(request);
            recovered.resolve(outcome);
            return outcome;
          },
        },
      );
      logSessionStateChange({ ...ref, state: "processing" });
      const owner = createDiagnosticEmbeddedRunOwner(ref);
      const abort = vi.fn(() => {
        controller.abort();
        clearActiveEmbeddedRun(sessionId, handle, ref.sessionKey);
      });
      const handle = {
        runId: sessionId,
        diagnosticOwner: owner,
        closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(owner),
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort,
      };
      setActiveEmbeddedRun(sessionId, handle, ref.sessionKey);
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
        await waitForDiagnosticEventsDrained();
        const deadline = getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs;
        if (deadlineState !== "absent") {
          expect(deadline).toBe(Date.now() + 1_400_000 + 900_000);
        }
        if (deadlineState === "expired") {
          vi.setSystemTime(deadline! + 1);
        }
        dispatch.resolve();
        const outcome = await recovered.promise;
        if (deadlineState === "future") {
          expect(outcome).toMatchObject({ status: "skipped", action: "observe_only" });
          expect(abort).not.toHaveBeenCalled();
          completed.resolve({ code: 0, signal: null });
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
        completed.resolve({ code: 0, signal: null });
        clearActiveEmbeddedRun(sessionId, handle, ref.sessionKey);
        controller.abort();
        await execution;
      }
    },
  );
});
