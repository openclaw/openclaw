import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  makeCronSessionEntry,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runWithModelFallbackMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "cron-model-switch-job",
    name: "Model Switch Test",
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "run task",
      // Cron requests sonnet; agent primary is opus
      model: "anthropic/claude-sonnet-4-6",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "run task",
    sessionKey: "cron:model-switch",
    ...overrides,
  };
}

function makeSuccessfulRunResult(modelUsed = "claude-sonnet-4-6") {
  return {
    result: {
      payloads: [{ text: "task complete" }],
      meta: {
        agentMeta: {
          model: modelUsed,
          provider: "anthropic",
          usage: { input: 100, output: 50 },
        },
      },
    },
    provider: "anthropic",
    model: modelUsed,
    attempts: [],
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — LiveSessionModelSwitchError retry (#57206)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(async () => {
    previousFastTestEnv = restoreFastTestEnv();
    clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
        isNewSession: true,
      }),
    );
    updateSessionStoreMock.mockResolvedValue(undefined);
    logWarnMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (previousFastTestEnv !== undefined) {
      process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
    } else {
      delete process.env.OPENCLAW_TEST_FAST;
    }
  });

  it("retries with the requested model when runWithModelFallback throws LiveSessionModelSwitchError on the first attempt", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async (params: { provider: string; model: string; run: (p: string, m: string) => Promise<unknown> }) => {
      callCount++;
      if (callCount === 1) {
        // First attempt: session started with opus, throw to request sonnet
        throw switchError;
      }
      // Second attempt: should now be called with sonnet
      expect(params.provider).toBe("anthropic");
      expect(params.model).toBe("claude-sonnet-4-6");
      return makeSuccessfulRunResult("claude-sonnet-4-6");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(callCount).toBe(2);
  });

  it("updates provider/model on session entry after catching LiveSessionModelSwitchError", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw switchError;
      }
      return makeSuccessfulRunResult("claude-sonnet-4-6");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    // Session should have been persisted with the corrected model
    expect(updateSessionStoreMock).toHaveBeenCalled();
  });

  it("returns error (not infinite loop) when LiveSessionModelSwitchError is thrown repeatedly", async () => {
    // If the runner somehow keeps throwing the same error (e.g. broken catalog)
    // it should not loop forever. The inner runPrompt itself will eventually
    // surface an error from within the model fallback path, but we simulate
    // a different error on the second attempt to ensure the outer catch still works.
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        throw switchError;
      }
      // Second attempt throws a different error — should propagate up
      throw new Error("transient network error");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(String(result.error)).toContain("transient network error");
    // Switched once, then failed
    expect(callCount).toBe(2);
  });

  it("does not retry when the thrown error is not a LiveSessionModelSwitchError", async () => {
    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      throw new Error("some other error");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(callCount).toBe(1);
  });
});
