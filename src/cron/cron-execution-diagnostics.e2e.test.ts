import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import { createAgentRunSupersededAbortError } from "../agents/run-termination.js";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import {
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService, type CronEvent } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { cronStoreKey } from "./store/key.js";
// Keep lazy execution imports outside cron's setup deadline.
import "./isolated-agent/run-executor.runtime.js";

vi.doUnmock("./isolated-agent/model-preflight.runtime.js");

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resetCronModelProviderPreflightCacheForTest } =
  await import("./isolated-agent/model-preflight.runtime.js");

type ModelRef = { provider: string; model: string };
const defaultModel = { provider: "openai", model: "gpt-5.4" };

function expectOutcomes(outcomes: unknown[], fields: Record<string, unknown>) {
  for (const outcome of outcomes) {
    expect(outcome).toMatchObject(fields);
  }
}

function diagnostic(source: string, severity: string, message: unknown, toolName?: string) {
  return {
    entries: expect.arrayContaining([
      expect.objectContaining({ source, severity, message, ...(toolName ? { toolName } : {}) }),
    ]),
  };
}

function makeCommandLaneTaskTimeoutError(lane: string, timeoutMs: number): Error {
  const error = new Error(`Command lane "${lane}" task timed out after ${timeoutMs}ms`);
  error.name = "CommandLaneTaskTimeoutError";
  return error;
}

async function runCase(name: string, modelRef: ModelRef = defaultModel, localBaseUrl?: string) {
  const model = `${modelRef.provider}/${modelRef.model}`;
  const cfg: OpenClawConfig = { agents: { defaults: { model } } };
  if (localBaseUrl) {
    cfg.models = {
      providers: { [modelRef.provider]: { api: "ollama", baseUrl: localBaseUrl, models: [] } },
    };
  }
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-execution-diagnostics-" },
    async (state) => {
      setRuntimeConfigSnapshot(cfg);
      const events: CronEvent[] = [];
      const storePath = state.path("cron", "jobs.json");
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onEvent: (event) => events.push(structuredClone(event)),
        runIsolatedAgentJob: async (runParams) =>
          await runCronIsolatedAgentTurn({
            ...runParams,
            cfg,
            deps: {},
            sessionKey: `cron:${runParams.job.id}`,
          }),
      });
      try {
        await cron.start();
        const job = await cron.add({
          name,
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: `run ${name}`,
            model,
          },
          delivery: { mode: "none" },
        });
        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

        const finished = events.find(
          (event) => event.action === "finished" && event.jobId === job.id,
        );
        const history = readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(storePath),
          jobId: job.id,
          limit: 1,
        }).entries[0];
        expect(finished).toBeDefined();
        expect(history).toBeDefined();
        return {
          finished: finished!,
          history: history!,
          lastError: cron.getJob(job.id)?.state.lastError,
          lastErrorReason: cron.getJob(job.id)?.state.lastErrorReason,
        };
      } finally {
        cron.stop();
      }
    },
  );
}

describe("cron execution diagnostics", { concurrent: false }, () => {
  let unavailableEndpoint: TestPortClaim;

  beforeAll(async () => {
    unavailableEndpoint = await acquireTestPortBlock({ offsets: [0] });
  });

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resetCronModelProviderPreflightCacheForTest();
    resolveConfiguredModelRefMock.mockReturnValue(defaultModel);
  });

  afterAll(async () => {
    await unavailableEndpoint.release();
  });

  it("persists and emits a real isolated-run local-provider preflight failure", async () => {
    const modelRef = { provider: "ollama", model: "diagnostic-model" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    resolveAllowedModelRefMock.mockReturnValue({ ref: modelRef });

    const { finished, history } = await runCase(
      "unreachable provider",
      modelRef,
      `http://127.0.0.1:${unavailableEndpoint.port}`,
    );

    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expectOutcomes([finished, history], {
      status: "skipped",
      provider: "ollama",
      model: "diagnostic-model",
      error: expect.stringContaining("Start the local provider or correct its configured endpoint"),
      diagnostics: diagnostic(
        "model-preflight",
        "warn",
        expect.stringContaining("the local provider preflight failed"),
      ),
    });
  });

  it("persists and emits the canonical terminal timeout diagnostic", async () => {
    const modelRef = defaultModel;
    runWithModelFallbackMock.mockRejectedValueOnce(
      makeCommandLaneTaskTimeoutError("cron-nested", 330_000),
    );

    const { finished, history } = await runCase("nested lane timeout");

    expectOutcomes([finished, history], {
      status: "error",
      ...modelRef,
      error: "cron: job execution timed out",
      diagnostics: diagnostic("cron-setup", "error", "cron: job execution timed out"),
    });
  });

  it("persists provider failures without internal class names", async () => {
    const message = "Saved selection requires an update.";
    const modelRef = { provider: "openai", model: "not-a-real-model" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    resolveAllowedModelRefMock.mockReturnValue({ ref: modelRef });
    runWithModelFallbackMock.mockRejectedValueOnce(
      new FailoverError(message, {
        reason: "model_not_found",
        provider: modelRef.provider,
        model: modelRef.model,
      }),
    );

    const { finished, history, lastError, lastErrorReason } = await runCase(
      "missing provider model",
      modelRef,
    );

    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({
        status: "error",
        provider: modelRef.provider,
        model: modelRef.model,
        error: message,
        diagnostics: { summary: message },
      });
      expect(outcome.error).not.toContain("FailoverError");
    }
    expect(lastError).toBe(message);
    expect(lastErrorReason).toBe("model_not_found");
    expect(history.errorReason).toBe("model_not_found");
  });

  it.each([["superseded run", createAgentRunSupersededAbortError]])(
    "persists the coded %s reason instead of reporting a timeout",
    async (name, createError) => {
      const rejection = createError() as Error & { code: string };
      runWithModelFallbackMock.mockRejectedValueOnce(rejection);

      const { finished, history, lastError } = await runCase(name);
      const expected = `${rejection.message} | ${rejection.code}`;

      for (const outcome of [finished, history]) {
        expect(outcome).toMatchObject({
          status: "error",
          error: expected,
        });
        expect(outcome.error).not.toContain("timed out");
      }
      expect(lastError).toBe(expected);
    },
  );

  it("persists and emits a fatal execution-denial diagnostic", async () => {
    const modelRef = defaultModel;
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        agentMeta: {},
        failureSignal: {
          kind: "execution_denied",
          source: "tool",
          toolName: "exec",
          code: "SYSTEM_RUN_DENIED",
          message: "SYSTEM_RUN_DENIED: approval required",
          fatalForCron: true,
        },
      },
    });

    const { finished, history } = await runCase("execution denied");

    expectOutcomes([finished, history], {
      status: "error",
      ...modelRef,
      error: "SYSTEM_RUN_DENIED: approval required",
      summary: "SYSTEM_RUN_DENIED: approval required",
      diagnostics: diagnostic("tool", "error", "SYSTEM_RUN_DENIED: approval required"),
    });
  });

  it("persists an unresolved exec warning when the scheduled agent recovers with a reply", async () => {
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "RESULT: the command did not run" }],
      meta: {
        agentMeta: {},
        toolSummary: {
          calls: 1,
          tools: ["exec"],
          failures: 1,
          unresolvedError: { toolName: "exec" },
        },
      },
    });

    const { finished, history, lastError } = await runCase("invalid exec arguments");

    expect(lastError).toBeUndefined();
    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({
        status: "ok",
        diagnostics: {
          summary: "exec tool failed",
          entries: [
            expect.objectContaining({
              source: "exec",
              severity: "warn",
              message: "exec tool failed",
              toolName: "exec",
            }),
          ],
        },
      });
    }
  });

  it("persists and emits terminal tool detail while keeping the payload generic", async () => {
    const modelRef = defaultModel;
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "⚠️ Exec failed", isError: true, toolName: "exec" }],
      meta: {
        agentMeta: {},
        terminalToolFailure: {
          source: "tool",
          toolName: "exec",
          code: "UNKNOWN_TOOL_ID",
        },
      },
    });

    const { finished, history } = await runCase("unknown tool id");

    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryPayloads: [{ text: "cron isolated run returned an error payload", isError: true }],
        outputText: "cron isolated run returned an error payload",
        summary: "Code Mode could not resolve a configured MCP tool.",
      }),
    );

    expectOutcomes([finished, history], {
      status: "error",
      ...modelRef,
      summary: "Code Mode could not resolve a configured MCP tool.",
      diagnostics: {
        summary: "Code Mode could not resolve a configured MCP tool.",
        ...diagnostic(
          "tool",
          "error",
          "Code Mode could not resolve a configured MCP tool.",
          "exec",
        ),
      },
    });
  });
});
