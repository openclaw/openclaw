// Invocation ownership is independent of a persistent automation's transcript identity.
import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  preflightCronModelProviderMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
  callGatewayMock,
  dispatchCronDeliveryMock,
  retireSessionMcpRuntimeMock,
  resolveCronDeliveryPlanMock,
  makeCronSessionEntry,
  readSessionMessagesAsyncMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams(sessionTarget = "isolated") {
  return makeIsolatedAgentParamsFixture({
    job: makeIsolatedAgentJobFixture({
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "none" },
      sessionTarget,
    }),
    message: "send a message",
    sessionKey: "cron:message-tool-policy",
  });
}

function expectCronInvocationContext(runParams: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
}): string {
  expect(runParams.runId).toEqual(expect.any(String));
  expect(runParams.runId).not.toBe("");
  expect(runParams.runId).not.toBe("test-session-id");
  expect(runParams.sessionId).toBe("test-session-id");
  expect(getAgentRunContext(runParams.runId)).toMatchObject({
    sessionId: runParams.sessionId,
    sessionKey: runParams.sessionKey,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    cronRunsByJobId: new Map([["message-tool-policy", { pacingEnabled: false }]]),
  });
  return runParams.runId;
}

describe("runCronIsolatedAgentTurn invocation ownership", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "messagechat",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("retains the selected owner while reusing a global session", async () => {
    mockRunCronFallbackPassthrough();
    const session = makeCronSession({ isNewSession: false });
    resolveCronSessionMock.mockReturnValue(session);
    let admittedOwner: { sessionKey?: string; agentId?: string } | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      const admitted = getAgentRunContext(runParams.runId);
      admittedOwner = { sessionKey: admitted?.sessionKey, agentId: admitted?.agentId };
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: { entries: { main: {}, research: {} } },
          session: { scope: "global" },
        },
        agentId: "research",
        sessionKey: "main",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "session:main",
          delivery: { mode: "none" },
        }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe("global");
    expect(admittedOwner).toEqual({ sessionKey: "global", agentId: "research" });
  });

  it("releases current invocation context without clearing an existing physical context", async () => {
    mockRunCronFallbackPassthrough();
    const sessionKey = "agent:default:cron:message-tool-policy";
    const initialSessionEntry = { retained: true };
    const cronSession = makeCronSession({
      store: { [sessionKey]: initialSessionEntry },
      initialSessionEntry,
    });
    loadSessionEntryMock.mockImplementation((_storePath, key) =>
      key === sessionKey ? initialSessionEntry : undefined,
    );
    resolveCronSessionMock.mockReturnValue(cronSession);
    const previousGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("test-session-id", { sessionKey, verboseLevel: "off" });
    const expectedContext = { ...getAgentRunContext("test-session-id") };
    const onExecutionStarted = vi.fn();
    let invocationRunId = "";
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      invocationRunId = expectCronInvocationContext(runParams);
      await runParams.onExecutionStarted?.();
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });
    try {
      const result = await runCronIsolatedAgentTurn({
        ...makeParams("current"),
        onExecutionStarted,
      });
      expect(result).toMatchObject({ status: "ok" });
      expect(invocationRunId).not.toBe("");
      expect(getAgentRunContext(invocationRunId)).toBeUndefined();
      expect(getAgentRunContext("test-session-id")).toEqual(expectedContext);
      expect(cronSession.store).toEqual({});
      expect(onExecutionStarted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: "test-session-id", runId: invocationRunId }),
      );
    } finally {
      clearAgentRunContext("test-session-id", previousGeneration);
    }
  });

  it("does not let old cron cleanup clear a newer same-id run context", async () => {
    mockRunCronFallbackPassthrough();
    let invocationRunId = "";
    let newerLifecycleGeneration = "";
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      invocationRunId = expectCronInvocationContext(runParams);
      runParams.onExecutionStarted?.();
      newerLifecycleGeneration = rotateAgentEventLifecycleGeneration();
      claimAgentRunContext(invocationRunId, {
        sessionKey: runParams.sessionKey,
        sessionId: "test-session-id",
        lifecycleGeneration: newerLifecycleGeneration,
      });
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(invocationRunId).not.toBe("");
    expect(getAgentRunContext(invocationRunId)).toEqual(
      expect.objectContaining({
        sessionId: "test-session-id",
        lifecycleGeneration: newerLifecycleGeneration,
      }),
    );
    clearAgentRunContext(invocationRunId, newerLifecycleGeneration);
  });

  it("rejects cron work when the gateway lifecycle rotates during preparation", async () => {
    const preflightStarted = createDeferred();
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      preflightStarted.resolve();
      await releasePreflight.promise;
      return { status: "available" };
    });

    const runPromise = runCronIsolatedAgentTurn(makeParams());
    await preflightStarted.promise;
    rotateAgentEventLifecycleGeneration();
    releasePreflight.resolve();

    await expect(runPromise).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Agent run belongs to a stale gateway lifecycle"),
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(getAgentRunContext("test-session-id")).toBeUndefined();
  });

  it("releases overlapping persistent-session invocation contexts independently", async () => {
    // Exercise process-local ownership without the persistent session admission
    // that serializes real turns on one key.
    process.env.OPENCLAW_TEST_FAST = "1";
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockImplementation(() => makeCronSession());
    const invocationRunIds: string[] = [];
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const firstBlocked = createDeferred();
    const secondBlocked = createDeferred();
    runEmbeddedAgentMock.mockImplementation(async (runParams) => {
      invocationRunIds.push(expectCronInvocationContext(runParams));
      if (invocationRunIds.length === 1) {
        firstStarted.resolve();
        await firstBlocked.promise;
      } else {
        secondStarted.resolve();
        await secondBlocked.promise;
      }
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });
    const sessionKey = "agent:default:messagechat:direct:123";
    const runParams = { ...makeParams(`session:${sessionKey}`), sessionKey };

    const firstRun = runCronIsolatedAgentTurn(runParams);
    await firstStarted.promise;
    const secondRun = runCronIsolatedAgentTurn(runParams);
    await secondStarted.promise;

    expect(invocationRunIds).toHaveLength(2);
    const [firstRunId, secondRunId] = invocationRunIds;
    assert(firstRunId && secondRunId);
    expect(firstRunId).not.toBe(secondRunId);
    expect(getAgentRunContext(firstRunId)).toBeDefined();
    expect(getAgentRunContext(secondRunId)).toBeDefined();
    expect(getAgentRunContext("test-session-id")).toBeUndefined();

    firstBlocked.resolve();
    expect((await firstRun).status).toBe("ok");
    expect(getAgentRunContext(firstRunId)).toBeUndefined();
    expect(getAgentRunContext(secondRunId)).toBeDefined();

    secondBlocked.resolve();
    const secondResult = await secondRun;
    expect(secondResult.status, secondResult.error).toBe("ok");
    expect(getAgentRunContext(firstRunId)).toBeUndefined();
    expect(getAgentRunContext(secondRunId)).toBeUndefined();
  });
});

describe("runCronIsolatedAgentTurn session cleanup", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("deletes the run-scoped cron session after delivery-none deleteAfterRun jobs", async () => {
    dispatchCronDeliveryMock.mockImplementationOnce(
      (await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js"))
        .dispatchCronDelivery,
    );
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          deleteAfterRun: true,
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "cleanup me", model: "openai/gpt-4" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:default:cron:test",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "test-session-id",
        expectedLifecycleRevision: "test-lifecycle-revision",
        expectedSessionUpdatedAt: 0,
      },
      timeoutMs: 10_000,
    });
  });

  it("leaves transcript cleanup with dispatch when delivery rejects", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    dispatchCronDeliveryMock.mockRejectedValueOnce(new Error("delivery receipt store unavailable"));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          deleteAfterRun: true,
          delivery: { mode: "announce", channel: "messagechat", to: "test-target" },
          payload: { kind: "agentTurn", message: "cleanup once", model: "openai/gpt-4" },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("delivery receipt store unavailable");
    expect(dispatchCronDeliveryMock).toHaveBeenCalledOnce();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledWith({
      sessionId: "test-session-id",
      reason: "isolated-cron-dispose",
      onError: expect.any(Function),
    });
  });

  it("retires the previous bundled MCP runtime when a persistent cron session rolls over", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        previousSessionId: "stale-session-id",
        sessionEntry: { ...makeCronSession().sessionEntry, sessionId: "rotated-session-id" },
      }),
    );
    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey: "agent:main:main:thread:9999",
        job: makeIsolatedAgentJobFixture({ sessionTarget: "session:agent:main:main:thread:9999" }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupBundleMcpOnRunEnd: false,
        allowGatewaySubagentBinding: true,
      }),
    );
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledExactlyOnceWith({
      sessionId: "stale-session-id",
      reason: "cron-session-rollover",
      onError: expect.any(Function),
    });
  });
});

const sourceSessionKey = "agent:default:telegram:direct:42";

function embeddedPrompt(): string {
  const prompt = runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt;
  if (typeof prompt !== "string") {
    throw new Error("expected embedded run prompt");
  }
  return prompt;
}

describe("runCronIsolatedAgentTurn — current conversation context", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("prepends the bound source conversation to a current-target payload", async () => {
    mockRunCronFallbackPassthrough();
    const sourceSessionEntry = makeCronSessionEntry({
      sessionId: "source-session",
      lifecycleRevision: "source-revision",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ store: { [sourceSessionKey]: sourceSessionEntry } }),
    );
    readSessionMessagesAsyncMock.mockResolvedValue([
      { role: "user", content: "Otters hold hands while sleeping." },
      { role: "assistant", content: "Got it." },
    ]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          sessionKey: sourceSessionKey,
          sessionTarget: "current",
          payload: { kind: "agentTurn", message: "Summarize the animal fact." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(readSessionMessagesAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: sourceSessionEntry,
        sessionId: "source-session",
        sessionKey: sourceSessionKey,
      }),
      { mode: "recent", maxBytes: 256 * 1024, maxLines: 220, maxMessages: 220 },
    );
    expect(embeddedPrompt()).toContain(
      "Recent conversation:\n- User: Otters hold hands while sleeping.\n- Assistant: Got it.\n\nSummarize the animal fact.",
    );
    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionKey,
        sourceSessionGeneration: {
          sessionId: "source-session",
          lifecycleRevision: "source-revision",
        },
      }),
    );
  });
});
