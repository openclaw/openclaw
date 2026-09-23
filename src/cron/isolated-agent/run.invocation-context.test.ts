// Invocation ownership is independent of a persistent automation's transcript identity.
import { assert, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
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

function makeMessageToolPolicyJob() {
  return makeIsolatedAgentJobFixture({
    id: "message-tool-policy",
    name: "Message Tool Policy",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "agentTurn", message: "send a message" },
    delivery: { mode: "none" },
  });
}

function makeParams() {
  return makeIsolatedAgentParamsFixture({
    job: makeMessageToolPolicyJob(),
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

  it("releases invocation context without clearing an existing physical-id context", async () => {
    mockRunCronFallbackPassthrough();
    const initialSessionEntry = { retained: true };
    loadSessionEntryMock.mockImplementation((_storePath, sessionKey) =>
      sessionKey === "agent:default:cron:message-tool-policy" ? initialSessionEntry : undefined,
    );
    const cronSession = makeCronSession({
      store: { "agent:default:cron:message-tool-policy": initialSessionEntry },
      initialSessionEntry,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const { clearAgentRunContext, registerAgentRunContext } =
      await import("../../infra/agent-run-registry.js");
    registerAgentRunContext("test-session-id", {
      sessionKey: "agent:default:cron:message-tool-policy",
      verboseLevel: "off",
    });
    const existingContext = { ...getAgentRunContext("test-session-id") };
    let invocationRunId = "";
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      invocationRunId = expectCronInvocationContext(runParams);
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(invocationRunId).not.toBe("");
    expect(getAgentRunContext(invocationRunId)).toBeUndefined();
    expect(getAgentRunContext("test-session-id")).toEqual(existingContext);
    expect(cronSession.store).toEqual({});
    clearAgentRunContext("test-session-id");
  });

  it("does not let old cron cleanup clear a newer same-id run context", async () => {
    mockRunCronFallbackPassthrough();
    const { claimAgentRunContext, clearAgentRunContext } =
      await import("../../infra/agent-run-registry.js");
    const { rotateAgentEventLifecycleGeneration } = await import("../../infra/agent-events.js");
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
    let releasePreflight: (() => void) | undefined;
    const preflightStarted = new Promise<void>((resolveStarted) => {
      preflightCronModelProviderMock.mockImplementationOnce(async () => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          releasePreflight = resolve;
        });
        return { status: "available" };
      });
    });
    const { rotateAgentEventLifecycleGeneration } = await import("../../infra/agent-events.js");

    const runPromise = runCronIsolatedAgentTurn(makeParams());
    await preflightStarted;
    rotateAgentEventLifecycleGeneration();
    releasePreflight?.();

    await expect(runPromise).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Agent run belongs to a stale gateway lifecycle"),
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(getAgentRunContext("test-session-id")).toBeUndefined();
  });

  it("releases current-session invocation context and preserves existing physical-id context", async () => {
    mockRunCronFallbackPassthrough();
    const initialSessionEntry = { retained: true };
    loadSessionEntryMock.mockImplementation((_storePath, sessionKey) =>
      sessionKey === "agent:default:cron:message-tool-policy" ? initialSessionEntry : undefined,
    );
    const cronSession = makeCronSession({
      store: { "agent:default:cron:message-tool-policy": initialSessionEntry },
      initialSessionEntry,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const { clearAgentRunContext, registerAgentRunContext } =
      await import("../../infra/agent-run-registry.js");
    registerAgentRunContext("test-session-id", {
      sessionKey: "agent:default:cron:message-tool-policy",
      verboseLevel: "off",
    });
    const existingContext = { ...getAgentRunContext("test-session-id") };
    let invocationRunId = "";
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      invocationRunId = expectCronInvocationContext(runParams);
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });
    const currentSessionJob = makeMessageToolPolicyJob() as unknown as Record<string, unknown>;
    currentSessionJob.sessionTarget = "current";

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: currentSessionJob as never,
    });

    expect(result.status).toBe("ok");
    expect(invocationRunId).not.toBe("");
    expect(getAgentRunContext(invocationRunId)).toBeUndefined();
    expect(getAgentRunContext("test-session-id")).toEqual(existingContext);
    expect(cronSession.store).toEqual({});
    clearAgentRunContext("test-session-id");
  });

  it("releases a current-session invocation context after execution fails", async () => {
    mockRunCronFallbackPassthrough();
    let invocationRunId = "";
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      invocationRunId = expectCronInvocationContext(runParams);
      throw new Error("runner failed");
    });
    const currentSessionJob = makeMessageToolPolicyJob() as unknown as Record<string, unknown>;
    currentSessionJob.sessionTarget = "current";

    await expect(
      runCronIsolatedAgentTurn({
        ...makeParams(),
        job: currentSessionJob as never,
      }),
    ).resolves.toMatchObject({ status: "error", error: "runner failed" });

    expect(invocationRunId).not.toBe("");
    expect(getAgentRunContext(invocationRunId)).toBeUndefined();
    expect(getAgentRunContext("test-session-id")).toBeUndefined();
  });

  it("releases overlapping persistent-session invocation contexts independently", async () => {
    // Exercise process-local ownership without the persistent session admission
    // that serializes real turns on one key.
    process.env.OPENCLAW_TEST_FAST = "1";
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockImplementation(() => makeCronSession());
    const invocationRunIds: string[] = [];
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    let markFirstStarted = () => {};
    let markSecondStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    runEmbeddedAgentMock.mockImplementation(async (runParams) => {
      invocationRunIds.push(expectCronInvocationContext(runParams));
      if (invocationRunIds.length === 1) {
        markFirstStarted();
        await firstBlocked;
      } else {
        markSecondStarted();
        await secondBlocked;
      }
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });
    const sessionKey = "agent:default:messagechat:direct:123";
    const persistentSessionJob = makeMessageToolPolicyJob() as unknown as Record<string, unknown>;
    persistentSessionJob.sessionTarget = `session:${sessionKey}`;
    const runParams = {
      ...makeParams(),
      sessionKey,
      job: persistentSessionJob as never,
    };

    const firstRun = runCronIsolatedAgentTurn(runParams);
    await firstStarted;
    const secondRun = runCronIsolatedAgentTurn(runParams);
    await secondStarted;

    expect(invocationRunIds).toHaveLength(2);
    const [firstRunId, secondRunId] = invocationRunIds;
    assert(firstRunId && secondRunId);
    expect(firstRunId).not.toBe(secondRunId);
    expect(getAgentRunContext(firstRunId)).toBeDefined();
    expect(getAgentRunContext(secondRunId)).toBeDefined();
    expect(getAgentRunContext("test-session-id")).toBeUndefined();

    releaseFirst();
    expect((await firstRun).status).toBe("ok");
    expect(getAgentRunContext(firstRunId)).toBeUndefined();
    expect(getAgentRunContext(secondRunId)).toBeDefined();

    releaseSecond();
    const secondResult = await secondRun;
    expect(secondResult.status, secondResult.error).toBe("ok");
    expect(getAgentRunContext(firstRunId)).toBeUndefined();
    expect(getAgentRunContext(secondRunId)).toBeUndefined();
  });

  it("preserves unrelated stale physical-id context after an invocation fails", async () => {
    mockRunCronFallbackPassthrough();
    let invocationRunId = "";
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      invocationRunId = expectCronInvocationContext(runParams);
      throw new Error("runner failed");
    });
    const { claimAgentRunContext, clearAgentRunContext } =
      await import("../../infra/agent-run-registry.js");
    const { rotateAgentEventLifecycleGeneration } = await import("../../infra/agent-events.js");
    const previousLifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext("test-session-id", {
      sessionKey: "agent:default:cron:message-tool-policy",
      sessionId: "test-session-id",
      lifecycleGeneration: previousLifecycleGeneration,
    });
    const existingContext = { ...getAgentRunContext("test-session-id") };
    rotateAgentEventLifecycleGeneration();
    const currentSessionJob = makeMessageToolPolicyJob() as unknown as Record<string, unknown>;
    currentSessionJob.sessionTarget = "current";

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: currentSessionJob as never,
    });

    expect(result).toMatchObject({ status: "error", error: "runner failed" });
    expect(invocationRunId).not.toBe("");
    expect(getAgentRunContext(invocationRunId)).toBeUndefined();
    expect(getAgentRunContext("test-session-id")).toEqual(existingContext);
    clearAgentRunContext("test-session-id", previousLifecycleGeneration);
  });
});
