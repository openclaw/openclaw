import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { recordCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { readSessionMessagesAsyncMock } from "./run-automation.test-support.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

function expectCall(mock: unknown, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

const runAgent = await h.loadRunCronIsolatedAgentTurn();
const completedTurn = () => ({ payloads: [{ text: "test output" }], meta: { agentMeta: {} } });

function runJob(job: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return runAgent(
    makeIsolatedAgentParamsFixture({ ...overrides, job: makeIsolatedAgentJobFixture(job) }),
  );
}

function makeParams(sessionTarget = "isolated") {
  return makeIsolatedAgentParamsFixture({
    job: makeIsolatedAgentJobFixture({ delivery: { mode: "none" }, sessionTarget }),
  });
}

function expectCronInvocationContext(runParams: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
}): string {
  expect(runParams.runId).not.toBe("");
  expect(runParams.runId).not.toBe("test-session-id");
  expect(runParams.sessionId).toBe("test-session-id");
  expect(getAgentRunContext(runParams.runId)).toMatchObject({
    sessionId: runParams.sessionId,
    sessionKey: runParams.sessionKey,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
  });
  return runParams.runId;
}

describe("runCronIsolatedAgentTurn invocation ownership", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => h.mockRunCronFallbackPassthrough());

  it.each([
    { schedule: "at", target: "session:agent:default:main", eligible: true },
    { schedule: "at", target: "isolated", eligible: false },
    { schedule: "at", target: "current", eligible: false },
    { schedule: "cron", target: "session:agent:default:main", eligible: false },
  ])(
    "accepts next_check only for an explicit one-shot continuation ($schedule, $target)",
    async ({ schedule, target, eligible }) => {
      let invocationRunId = "";
      h.runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
        invocationRunId = runParams.runId;
        const propose = () => recordCronNextCheckProposal(runParams.runId, "test-job", 60_000);
        if (eligible) {
          propose();
        } else {
          expect(propose).toThrow("cron next_check requires");
        }
        return completedTurn();
      });
      const result = await runJob(
        {
          sessionTarget: target,
          schedule:
            schedule === "at"
              ? { kind: "at", at: "2026-07-27T12:00:00.000Z" }
              : { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          delivery: { mode: "none" },
        },
        target.startsWith("session:") ? { sessionKey: target.slice(8) } : {},
      );
      expect(result.status, result.error).toBe("ok");
      expect(result.nextCheck).toEqual(eligible ? { delayMs: 60_000 } : undefined);
      expect(() => recordCronNextCheckProposal(invocationRunId, "test-job", 60_000)).toThrow(
        "cron next_check is only available to the currently running job",
      );
    },
  );

  it("retains the selected owner while reusing a global session", async () => {
    h.resolveCronSessionMock.mockReturnValue(h.makeCronSession({ isNewSession: false }));
    h.runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      expect(getAgentRunContext(runParams.runId)).toMatchObject({
        sessionKey: "global",
        agentId: "research",
      });
      return completedTurn();
    });
    const result = await runJob(
      { sessionTarget: "session:main", delivery: { mode: "none" } },
      {
        cfg: { agents: { entries: { main: {}, research: {} } }, session: { scope: "global" } },
        agentId: "research",
        sessionKey: "main",
      },
    );
    expect(result).toMatchObject({ status: "ok", sessionKey: "global" });
  });

  it.each([
    { target: "isolated", failure: false, physical: "current" },
    { target: "current", failure: true, physical: "stale" },
  ])(
    "releases $target invocation context (failure=$failure, physical=$physical)",
    async ({ target, failure, physical }) => {
      const sessionKey = "agent:default:cron:test";
      const initialSessionEntry = h.makeCronSessionEntry({ retained: true });
      const cronSession = h.makeCronSession(
        failure ? {} : { store: { [sessionKey]: initialSessionEntry }, initialSessionEntry },
      );
      if (!failure) {
        h.loadSessionEntryMock.mockImplementation((_storePath, key) =>
          key === sessionKey ? initialSessionEntry : undefined,
        );
      }
      h.resolveCronSessionMock.mockReturnValue(cronSession);
      const previousGeneration = getAgentEventLifecycleGeneration();
      if (physical === "current") {
        registerAgentRunContext("test-session-id", { sessionKey, verboseLevel: "off" });
      } else {
        claimAgentRunContext("test-session-id", {
          sessionKey,
          sessionId: "test-session-id",
          lifecycleGeneration: previousGeneration,
        });
      }
      const expectedContext = { ...getAgentRunContext("test-session-id") };
      if (physical === "stale") {
        rotateAgentEventLifecycleGeneration();
      }
      const onExecutionStarted = vi.fn();
      let invocationRunId = "";
      h.runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
        invocationRunId = expectCronInvocationContext(runParams);
        if (failure) {
          throw new Error("runner failed");
        }
        await runParams.onExecutionStarted?.();
        return completedTurn();
      });
      try {
        const result = await runAgent({
          ...makeParams(target),
          onExecutionStarted,
        });
        expect(result).toMatchObject(
          failure ? { status: "error", error: "runner failed" } : { status: "ok" },
        );
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
    let invocationRunId = "";
    let newerLifecycleGeneration = "";
    h.runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
      invocationRunId = expectCronInvocationContext(runParams);
      runParams.onExecutionStarted?.();
      newerLifecycleGeneration = rotateAgentEventLifecycleGeneration();
      claimAgentRunContext(invocationRunId, {
        sessionKey: runParams.sessionKey,
        sessionId: "test-session-id",
        lifecycleGeneration: newerLifecycleGeneration,
      });
      return completedTurn();
    });

    await runAgent(makeParams());

    expect(getAgentRunContext(invocationRunId)).toMatchObject({
      sessionId: "test-session-id",
      lifecycleGeneration: newerLifecycleGeneration,
    });
    clearAgentRunContext(invocationRunId, newerLifecycleGeneration);
  });

  it("rejects cron work when the gateway lifecycle rotates during preparation", async () => {
    const preflightStarted = createDeferred();
    const releasePreflight = createDeferred();
    h.preflightCronModelProviderMock.mockImplementationOnce(async () => {
      preflightStarted.resolve();
      await releasePreflight.promise;
      return { status: "available" };
    });

    const runPromise = runAgent(makeParams());
    await preflightStarted.promise;
    rotateAgentEventLifecycleGeneration();
    releasePreflight.resolve();

    await expect(runPromise).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Agent run belongs to a stale gateway lifecycle"),
    });
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(getAgentRunContext("test-session-id")).toBeUndefined();
  });

  it("serializes overlapping persistent-session invocations and releases their contexts independently", async () => {
    process.env.OPENCLAW_TEST_FAST = "1";
    h.resolveCronSessionMock.mockImplementation(() => h.makeCronSession());
    const invocationRunIds: string[] = [];
    const runnerEvents: string[] = [];
    const first = { started: createDeferred(), blocked: createDeferred() };
    const second = { started: createDeferred(), blocked: createDeferred() };
    h.runEmbeddedAgentMock.mockImplementation(async (runParams) => {
      invocationRunIds.push(expectCronInvocationContext(runParams));
      const isFirst = invocationRunIds.length === 1;
      const turn = isFirst ? first : second;
      runnerEvents.push(isFirst ? "first started" : "second started");
      turn.started.resolve();
      await turn.blocked.promise;
      runnerEvents.push(isFirst ? "first returned" : "second returned");
      return completedTurn();
    });
    const sessionKey = "agent:default:messagechat:direct:123";
    const runParams = { ...makeParams(`session:${sessionKey}`), sessionKey };

    const firstRun = runAgent(runParams);
    await first.started.promise;
    const secondRun = runAgent(runParams);
    first.blocked.resolve();
    await second.started.promise;

    expect(runnerEvents).toEqual(["first started", "first returned", "second started"]);
    const [firstRunId, secondRunId] = invocationRunIds;
    assert(firstRunId && secondRunId);
    expect(firstRunId).not.toBe(secondRunId);
    expect(getAgentRunContext(secondRunId)).toBeDefined();
    expect(getAgentRunContext("test-session-id")).toBeUndefined();

    expect((await firstRun).status).toBe("ok");
    expect(getAgentRunContext(firstRunId)).toBeUndefined();
    expect(getAgentRunContext(secondRunId)).toBeDefined();

    second.blocked.resolve();
    const secondResult = await secondRun;
    expect(secondResult.status, secondResult.error).toBe("ok");
    expect(getAgentRunContext(firstRunId)).toBeUndefined();
    expect(getAgentRunContext(secondRunId)).toBeUndefined();
  });
});

describe("runCronIsolatedAgentTurn session cleanup", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it.each([false, true])(
    "keeps deletion with delivery dispatch (rejected=%s)",
    async (rejected) => {
      const delivery = rejected
        ? { mode: "announce", channel: "messagechat", to: "test-target" }
        : { mode: "none" };
      if (rejected) {
        h.resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, ...delivery });
        h.dispatchCronDeliveryMock.mockRejectedValueOnce(
          new Error("delivery receipt store unavailable"),
        );
      } else {
        h.dispatchCronDeliveryMock.mockImplementationOnce(
          (await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js"))
            .dispatchCronDelivery,
        );
      }
      const result = await runJob({ deleteAfterRun: true, delivery });
      if (rejected) {
        expect(result).toMatchObject({
          status: "error",
          error: "delivery receipt store unavailable",
        });
        expect(h.callGatewayMock).not.toHaveBeenCalled();
        expectCall(h.retireSessionMcpRuntimeMock, {
          sessionId: "test-session-id",
          reason: "isolated-cron-dispose",
          onError: expect.any(Function),
        });
      } else {
        expect(result.status).toBe("ok");
        expectCall(h.callGatewayMock, { method: "sessions.delete" });
      }
    },
  );

  it("retires the previous bundled MCP runtime when a persistent cron session rolls over", async () => {
    h.resolveCronSessionMock.mockReturnValue(
      h.makeCronSession({
        previousSessionId: "stale-session-id",
        sessionEntry: { ...h.makeCronSession().sessionEntry, sessionId: "rotated-session-id" },
      }),
    );
    h.mockRunCronFallbackPassthrough();
    const result = await runJob(
      { sessionTarget: "session:agent:main:main:thread:9999" },
      { sessionKey: "agent:main:main:thread:9999" },
    );
    expect(result.status).toBe("ok");
    expectCall(h.runEmbeddedAgentMock, {
      cleanupBundleMcpOnRunEnd: false,
      allowGatewaySubagentBinding: true,
    });
    expect(h.retireSessionMcpRuntimeMock).toHaveBeenCalledExactlyOnceWith({
      sessionId: "stale-session-id",
      reason: "cron-session-rollover",
      onError: expect.any(Function),
    });
  });
  it.each([false, true])(
    "uses source history only for current targets (isolated=%s)",
    async (isolated) => {
      h.mockRunCronFallbackPassthrough();
      const sourceGeneration = {
        sessionId: "source-session",
        lifecycleRevision: "source-revision",
      };
      const source = { sessionKey: "agent:default:telegram:direct:42", ...sourceGeneration };
      const sourceEntry = h.makeCronSessionEntry(
        isolated
          ? {
              sessionId: "replacement-source-session",
              lifecycleRevision: "replacement-source-revision",
              thinkingLevel: "high",
            }
          : sourceGeneration,
      );
      h.resolveCronSessionMock.mockReturnValue(
        h.makeCronSession({ store: { [source.sessionKey]: sourceEntry } }),
      );
      readSessionMessagesAsyncMock.mockResolvedValue([{ role: "user", content: "Animal fact." }]);
      const message = "Summarize the animal fact.";
      const result = await runJob({
        sessionKey: source.sessionKey,
        sessionTarget: isolated ? "isolated" : "current",
        ...(isolated ? { sourceConversation: source } : {}),
        payload: { kind: "agentTurn", message },
      });
      expect(result.status).toBe("ok");
      const prompt = h.runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt;
      if (isolated) {
        expect(result.sessionKey).not.toBe(source.sessionKey);
        expect(readSessionMessagesAsyncMock).not.toHaveBeenCalled();
        expect(prompt).toContain(message);
        expect(prompt).not.toContain("Animal fact.");
      } else {
        expect(prompt).toContain(
          "Recent conversation:\n- User: Animal fact.\n\nSummarize the animal fact.",
        );
      }
      expectCall(h.dispatchCronDeliveryMock, {
        sourceSessionKey: source.sessionKey,
        sourceSessionGeneration: sourceGeneration,
      });
    },
  );
});
