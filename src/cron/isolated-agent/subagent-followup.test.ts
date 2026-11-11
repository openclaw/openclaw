import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDescendantRunAwaitingSettleFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";

vi.hoisted(() => vi.stubEnv("OPENCLAW_TEST_FAST", "1"));

import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.js";

vi.mock("./run-subagent-registry.runtime.js", () => ({
  listDescendantRunsForRequester: vi.fn().mockResolvedValue([]),
}));

vi.mock("./delivery-subagent-registry.runtime.js", () => ({
  hasUnsettledCronDescendants: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../agents/run-wait.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/run-wait.js")>(
    "../../agents/run-wait.js",
  );
  return {
    ...actual,
    readLatestAssistantReply: vi.fn().mockResolvedValue(undefined),
  };
});

import * as announceOutput from "../../agents/subagents/announce/subagent-announce-output.js";
import * as gatewayCallRuntime from "../../gateway/call.js";
const callGateway = vi.spyOn(gatewayCallRuntime, "callGateway").mockResolvedValue({ status: "ok" });
const finalAnswer = vi.spyOn(announceOutput, "readSubagentRunFinalAnswer");
afterAll(() => [callGateway, finalAnswer].forEach((spy) => spy.mockRestore()));

const { listDescendantRunsForRequester } = await import("./run-subagent-registry.runtime.js");
const { hasUnsettledCronDescendants } = await import("./delivery-subagent-registry.runtime.js");
const { readLatestAssistantReply } = await import("../../agents/run-wait.js");
const listRuns = vi.mocked(listDescendantRunsForRequester);
const latestReply = vi.mocked(readLatestAssistantReply);
const unsettled = vi.mocked(hasUnsettledCronDescendants);

async function resolveAfterAdvancingTimers<T>(promise: Promise<T>, advanceMs = 100): Promise<T> {
  await vi.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

function waitSummary(params: Partial<Parameters<typeof waitForDescendantSubagentSummary>[0]> = {}) {
  return waitForDescendantSubagentSummary({
    sessionKey: "cron-session",
    initialReply: "on it",
    timeoutMs: 100,
    observedActiveDescendants: true,
    ...params,
  });
}

const fallbackReply = () =>
  readDescendantSubagentFallbackReply({ sessionKey: "test-session", runStartedAt: 1000 });

function createDescendantRun(
  params: Partial<SubagentRunRecord> & {
    endedAt?: number;
    active?: boolean;
    resultText?: string | null;
  } = {},
): SubagentRunRecord {
  const { endedAt = 2000, active, resultText, ...overrides } = params;
  return {
    runId: "run-1",
    childSessionKey: "child-1",
    requesterSessionKey: "test-session",
    requesterDisplayKey: "test-session",
    task: "task-1",
    cleanup: "keep",
    createdAt: 1000,
    execution: active
      ? { status: "running" }
      : { status: "terminal", endedAt, outcome: { status: "ok" } },
    ...(resultText === undefined
      ? {}
      : {
          completion: {
            required: true,
            resultText,
            terminalReply: resultText
              ? { disposition: "visible", text: resultText }
              : { disposition: "empty" },
          },
        }),
    ...overrides,
  };
}

function terminalRun(
  terminalReply: NonNullable<SubagentRunRecord["completion"]>["terminalReply"],
  resultText = "stale output",
  outcome: "ok" | "error" = "ok",
) {
  return createDescendantRun({
    execution: { status: "terminal", endedAt: 2000, outcome: { status: outcome } },
    completion: { required: true, terminalReply, resultText, fallbackResultText: "older fallback" },
  });
}

describe("readDescendantSubagentFallbackReply", () => {
  it.each([
    ["visible", [terminalRun({ disposition: "visible", text: "brief" }, "full")], "brief"],
    ["silent", [terminalRun({ disposition: "silent" })], undefined],
    ["empty", [terminalRun({ disposition: "empty" })], undefined],
    ["token", [terminalRun({ disposition: "visible", text: "NO_REPLY" }, "NO_REPLY")], "NO_REPLY"],
    ["missing terminal token", [terminalRun(undefined, "NO_REPLY")], undefined],
    ["missing terminal answer", [terminalRun(undefined, "captured answer")], undefined],
    ["null result", [createDescendantRun({ cleanup: "delete", resultText: null })], undefined],
    ["old", [createDescendantRun({ endedAt: 900, resultText: "old" })], undefined],
    [
      "skip silent child",
      [
        terminalRun({ disposition: "silent" }),
        createDescendantRun({
          runId: "run-2",
          childSessionKey: "child-2",
          task: "task-2",
          endedAt: 3000,
          resultText: "useful output",
        }),
      ],
      "useful output",
    ],
  ] as const)("%s uses only current terminal evidence", async (_name, runs, expected) => {
    listRuns.mockResolvedValue([...runs]);
    latestReply.mockResolvedValue("stale transcript").mockClear();
    await expect(fallbackReply()).resolves.toBe(expected);
    expect(latestReply).not.toHaveBeenCalled();
  });

  it.each([
    ["ok", "\nrecovered\n", "recovered"],
    ["ok", undefined, "brief…"],
    ["error", "must not publish", "brief…"],
  ] as const)("capped child preview %# (%s)", async (outcome, answer, expected) => {
    const run = terminalRun({ disposition: "visible", text: "brief…" }, "stale output", outcome);
    listRuns.mockResolvedValue([run]);
    finalAnswer.mockReset().mockResolvedValue(answer);
    await expect(fallbackReply()).resolves.toBe(expected);
  });
});

describe("waitForDescendantSubagentSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    listRuns.mockResolvedValue([]);
    unsettled.mockResolvedValue(false);
    latestReply.mockResolvedValue(undefined);
    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
  });

  afterEach(() => vi.useRealTimers());

  it("returns initialReply immediately when no active descendants and observedActiveDescendants=false", async () => {
    const result = await waitSummary({ observedActiveDescendants: false });
    expect(result).toBe("on it");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("waits for a queued descendant's successor to produce the synthesis", async () => {
    let descendants = [createDescendantRun({ runId: "queued-run", active: true })];
    let parentReply = "on it";
    listRuns.mockImplementation(async () => descendants);
    latestReply.mockImplementation(async () => parentReply);
    callGateway.mockImplementation(async (request) => {
      if ((request.params as { runId: string }).runId === "queued-run") {
        return { status: "pending", timeoutPhase: "queue", providerStarted: false };
      }
      descendants = [];
      parentReply = "The successor completed the report.";
      return { status: "ok" };
    });
    const completion = setTimeout(() => {
      descendants = [createDescendantRun({ runId: "successor-run", active: true })];
    }, 0);

    try {
      const result = await waitSummary({
        sessionKey: "test-session",
        initialReply: parentReply,
        timeoutMs: 300,
        observedActiveDescendants: undefined,
      });

      expect(result).toBe("The successor completed the report.");
      expect(
        callGateway.mock.calls.map(([request]) => (request.params as { runId: string }).runId),
      ).toEqual(["queued-run", "successor-run"]);
    } finally {
      clearTimeout(completion);
    }
  });

  it.each(["on it\n\nMEDIA:/workspace/report.png", "HEARTBEAT_OK"])(
    "ignores unchanged/control-only parent reply %s",
    async (parentReply) => {
      vi.useFakeTimers();
      latestReply.mockResolvedValue(parentReply);
      expect(await resolveAfterAdvancingTimers(waitSummary())).toBeUndefined();
    },
  );

  it.each([false, true])(
    "waits through delayed successor admission (children already ended: %s)",
    async (childrenAlreadyEnded) => {
      vi.useFakeTimers();
      const cronSessionKey = "agent:main:cron:daily-report:run:scheduled-run";
      const orchestratorSessionKey = "agent:main:subagent:orchestrator";
      const orchestrator = createDescendantRun({
        runId: "orchestrator-yielded",
        childSessionKey: orchestratorSessionKey,
        requesterSessionKey: cronSessionKey,
        pauseReason: "sessions_yield",
      });
      const workers = ["worker-a", "worker-b"].map((runId) =>
        createDescendantRun({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          active: !childrenAlreadyEnded,
          requesterSessionKey: orchestratorSessionKey,
          delivery: { status: "delivered", disposition: "delivered" },
          cleanupCompletedAt: childrenAlreadyEnded ? 3000 : undefined,
        }),
      );
      let descendants = [orchestrator, ...workers];
      let cronReply = "spawned a subagent";
      const finalSynthesis = "Daily report complete: both findings reconciled.";
      listRuns.mockImplementation(async () => descendants);
      unsettled.mockImplementation(async () =>
        hasDescendantRunAwaitingSettleFromRuns(
          new Map(descendants.map((entry) => [entry.runId, entry])),
          cronSessionKey,
        ),
      );
      latestReply.mockImplementation(async () => cronReply);
      const admitSuccessor = () => {
        descendants = [
          {
            ...orchestrator,
            runId: "orchestrator-successor",
            pauseReason: undefined,
            execution: { status: "running" },
          },
          ...workers,
        ];
      };
      vi.mocked(callGateway).mockImplementation(async (request) => {
        const runId = (request.params as { runId: string }).runId;
        const completed = descendants.find((entry) => entry.runId === runId);
        expect(completed).toBeDefined();
        completed!.execution = { status: "terminal", endedAt: 3000 };
        completed!.cleanupCompletedAt = 3000;
        if (runId === "orchestrator-successor") {
          cronReply = finalSynthesis;
        } else if (workers.every((entry) => entry.execution.endedAt !== undefined)) {
          // Admission can take longer than the final-reply grace period.
          setTimeout(admitSuccessor, 100);
        }
        return { status: "ok" };
      });
      if (childrenAlreadyEnded) {
        setTimeout(admitSuccessor, 100);
      }

      let settled = false;
      const resultPromise = waitSummary({
        sessionKey: cronSessionKey,
        initialReply: cronReply,
        timeoutMs: 500,
        observedActiveDescendants: !childrenAlreadyEnded,
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(80);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(await resultPromise).toBe(finalSynthesis);
      const waitedRunIds = vi
        .mocked(callGateway)
        .mock.calls.map(([request]) => (request.params as { runId: string }).runId);
      expect(waitedRunIds).toEqual(
        childrenAlreadyEnded
          ? ["orchestrator-successor"]
          : ["worker-a", "worker-b", "orchestrator-successor"],
      );
    },
  );

  it.each([-60_000, 0, 60_000])(
    "keeps the descendant wait budget after a %s ms wall-clock step",
    async (wallClockStepMs) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      listRuns.mockResolvedValue([createDescendantRun({ pauseReason: "sessions_yield" })]);
      unsettled.mockResolvedValue(true);
      latestReply.mockResolvedValue("Partial results are available.");
      let settled = false;
      const resultPromise = waitSummary({ timeoutMs: 300, abortSignal: controller.signal }).then(
        (result) => {
          settled = true;
          return result;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(100);
        vi.setSystemTime(Date.now() + wallClockStepMs);
        await vi.advanceTimersByTimeAsync(150);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(true);
        await expect(resultPromise).resolves.toBeUndefined();
        expect([vi.getTimerCount(), callGateway.mock.calls.length]).toEqual([0, 0]);
      } finally {
        controller.abort();
        await resultPromise;
      }
    },
  );

  it.each(["handoff", "running"])("stops waiting when cron cancels during %s", async (phase) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const descendant = createDescendantRun({
      active: phase === "running",
      pauseReason: phase === "handoff" ? "sessions_yield" : undefined,
    });
    listRuns.mockResolvedValue([descendant]);
    unsettled.mockResolvedValue(true);
    latestReply.mockResolvedValue("on it");
    vi.mocked(callGateway).mockImplementation(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted", { cause: signal.reason })),
          { once: true },
        );
      });
      return { status: "ok" };
    });

    const resultPromise = waitSummary({
      sessionKey: "test-session",
      timeoutMs: 500,
      abortSignal: controller.signal,
      observedActiveDescendants: undefined,
    });
    await vi.advanceTimersByTimeAsync(20);
    controller.abort(new Error("cron cancelled"));
    expect(await resultPromise).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(readLatestAssistantReply).toHaveBeenCalledTimes(1);
  });

  it.each([
    "NO_REPLY",
    "NO_REPLY\nexample",
    "HEARTBEAT_OK child completed the scheduled reminder",
    '{"action":"HEARTBEAT_OK","message":"child completed the scheduled reminder"}',
  ])("preserves prepared synthesis without reclassifying its text: %s", async (synthesis) => {
    latestReply.mockResolvedValueOnce("on it").mockResolvedValue(synthesis);
    await expect(waitSummary({ initialReply: undefined })).resolves.toBe(synthesis);
  });
});
