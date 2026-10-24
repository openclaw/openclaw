import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentRunMeta } from "../agents/embedded-agent.js";
import { FailoverError } from "../agents/failover-error.js";
import { createAgentRunSupersededAbortError } from "../agents/run-termination.js";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
import { cronTestInput } from "./service.fixture-builders.test-support.js";
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
const unresolvedTool = "Code Mode could not resolve a configured MCP tool.";

function agentReply(
  meta: Pick<EmbeddedAgentRunMeta, "failureSignal" | "toolSummary" | "terminalToolFailure">,
  payloads: Array<{ text: string; isError?: boolean; toolName?: string }> = [],
) {
  mockRunCronFallbackPassthrough();
  runEmbeddedAgentMock.mockResolvedValueOnce({ payloads, meta: { agentMeta: {}, ...meta } });
}

function expectOutcomes(outcomes: unknown[], fields: Record<string, unknown>) {
  for (const outcome of outcomes) {
    expect(outcome).toMatchObject(fields);
  }
}

function diagnostic(
  source: string,
  severity: string,
  message: unknown,
  toolName?: string,
  exact = false,
) {
  const entry = expect.objectContaining({
    source,
    severity,
    message,
    ...(toolName ? { toolName } : {}),
  });
  return { entries: exact ? [entry] : expect.arrayContaining([entry]) };
}

async function runCase(name: string, modelRef: ModelRef = defaultModel) {
  const model = `${modelRef.provider}/${modelRef.model}`;
  const cfg: OpenClawConfig = {
    agents: { defaults: { model } },
    session: { store: "/tmp/store.json" },
  };
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
        const job = await cron.add(
          cronTestInput({
            name,
            payload: { kind: "agentTurn", message: `run ${name}`, model },
            delivery: { mode: "none" },
          }),
        );
        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

        const finished = events.find(
          (event) => event.action === "finished" && event.jobId === job.id,
        );
        const history = readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(storePath),
          jobId: job.id,
          limit: 1,
        }).entries[0];
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
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resetCronModelProviderPreflightCacheForTest();
    resolveConfiguredModelRefMock.mockReturnValue(defaultModel);
  });

  it("persists provider failures without internal class names", async () => {
    const message = "Saved selection requires an update.";
    const modelRef = { provider: "openai", model: "not-a-real-model" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    resolveAllowedModelRefMock.mockReturnValue({ ref: modelRef });
    runWithModelFallbackMock.mockRejectedValueOnce(
      new FailoverError(message, { reason: "model_not_found", ...modelRef }),
    );

    const { finished, history, lastError, lastErrorReason } = await runCase(
      "missing model",
      modelRef,
    );

    expectOutcomes([finished, history], {
      status: "error",
      ...modelRef,
      error: message,
      diagnostics: { summary: message },
    });
    expect({ lastError, lastErrorReason }).toEqual({
      lastError: message,
      lastErrorReason: "model_not_found",
    });
    expect(history.errorReason).toBe("model_not_found");
  });

  it("persists the coded superseded-run reason instead of reporting a timeout", async () => {
    const rejection = createAgentRunSupersededAbortError() as Error & { code: string };
    runWithModelFallbackMock.mockRejectedValueOnce(rejection);

    const { finished, history, lastError } = await runCase("superseded run");
    const expected = `${rejection.message} | ${rejection.code}`;

    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({ status: "error", error: expected });
      expect(outcome.error).not.toContain("timed out");
    }
    expect(lastError).toBe(expected);
  });

  it("persists an unresolved exec warning when the scheduled agent recovers with a reply", async () => {
    agentReply(
      {
        toolSummary: {
          calls: 1,
          tools: ["exec"],
          failures: 1,
          unresolvedError: { toolName: "exec" },
        },
      },
      [{ text: "RESULT: the command did not run" }],
    );

    const { finished, history, lastError } = await runCase("invalid exec arguments");

    expect(lastError).toBeUndefined();
    expectOutcomes([finished, history], {
      status: "ok",
      diagnostics: {
        summary: "exec tool failed",
        ...diagnostic("exec", "warn", "exec tool failed", "exec", true),
      },
    });
  });

  it("persists and emits terminal tool detail while keeping the payload generic", async () => {
    agentReply(
      { terminalToolFailure: { source: "tool", toolName: "exec", code: "UNKNOWN_TOOL_ID" } },
      [{ text: "⚠️ Exec failed", isError: true, toolName: "exec" }],
    );

    const { finished, history } = await runCase("unknown tool id");

    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryPayloads: [{ text: "cron isolated run returned an error payload", isError: true }],
        outputText: "cron isolated run returned an error payload",
        summary: unresolvedTool,
      }),
    );

    expectOutcomes([finished, history], {
      status: "error",
      ...defaultModel,
      summary: unresolvedTool,
      diagnostics: {
        summary: unresolvedTool,
        ...diagnostic("tool", "error", unresolvedTool, "exec"),
      },
    });
  });
});
