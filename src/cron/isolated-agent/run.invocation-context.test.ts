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

  it.each([
    { target: "isolated", failure: false, physical: "current" },
    { target: "current", failure: false, physical: "current" },
    { target: "current", failure: true, physical: "none" },
    { target: "current", failure: true, physical: "stale" },
  ])(
    "releases $target invocation context (failure=$failure, physical=$physical)",
    async ({ target, failure, physical }) => {
      mockRunCronFallbackPassthrough();
      const sessionKey = "agent:default:cron:message-tool-policy";
      const initialSessionEntry = { retained: true };
      const cronSession = makeCronSession(
        !failure
          ? {
              store: { [sessionKey]: initialSessionEntry },
              initialSessionEntry,
            }
          : {},
      );
      if (!failure) {
        loadSessionEntryMock.mockImplementation((_storePath, key) =>
          key === sessionKey ? initialSessionEntry : undefined,
        );
      }
      resolveCronSessionMock.mockReturnValue(cronSession);
      const previousGeneration = getAgentEventLifecycleGeneration();
      if (physical === "current") {
        registerAgentRunContext("test-session-id", { sessionKey, verboseLevel: "off" });
      } else if (physical === "stale") {
        claimAgentRunContext("test-session-id", {
          sessionKey,
          sessionId: "test-session-id",
          lifecycleGeneration: previousGeneration,
        });
      }
      const existingContext = getAgentRunContext("test-session-id");
      const expectedContext = existingContext ? { ...existingContext } : undefined;
      if (physical === "stale") {
        rotateAgentEventLifecycleGeneration();
      }
      const onExecutionStarted = vi.fn();
      let invocationRunId = "";
      runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
        invocationRunId = expectCronInvocationContext(runParams);
        if (failure) {
          throw new Error("runner failed");
        }
        await runParams.onExecutionStarted?.();
        return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
      });
      try {
        const result = await runCronIsolatedAgentTurn({
          ...makeParams(target),
          onExecutionStarted,
        });
        expect(result).toMatchObject(
          failure ? { status: "error", error: "runner failed" } : { status: "ok" },
        );
        expect(invocationRunId).not.toBe("");
        expect(getAgentRunContext(invocationRunId)).toBeUndefined();
        expect(getAgentRunContext("test-session-id")).toEqual(expectedContext);
        expect(cronSession.store).toEqual({});
        if (!failure) {
          expect(onExecutionStarted).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ sessionId: "test-session-id", runId: invocationRunId }),
          );
        }
      } finally {
        clearAgentRunContext("test-session-id", previousGeneration);
      }
    },
  );

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
