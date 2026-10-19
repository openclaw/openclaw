import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDescendantRunAwaitingSettleFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";

// vi.hoisted runs before module imports, ensuring FAST_TEST_MODE is picked up.
vi.hoisted(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

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

import * as gatewayCallRuntime from "../../gateway/call.js";
const callGateway = vi.spyOn(gatewayCallRuntime, "callGateway").mockResolvedValue({ status: "ok" });
afterAll(() => callGateway.mockRestore());

const { listDescendantRunsForRequester } = await import("./run-subagent-registry.runtime.js");
const { hasUnsettledCronDescendants } = await import("./delivery-subagent-registry.runtime.js");
const { readLatestAssistantReply } = await import("../../agents/run-wait.js");

async function resolveAfterAdvancingTimers<T>(promise: Promise<T>, advanceMs = 100): Promise<T> {
  await vi.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

function createDescendantRun(params?: {
  runId?: string;
  childSessionKey?: string;
  task?: string;
  cleanup?: "keep" | "delete";
  endedAt?: number;
  active?: boolean;
  resultText?: string | null;
  hasInternalTranscript?: boolean;
}): SubagentRunRecord {
  const endedAt = params?.endedAt ?? 2000;
  return {
    runId: params?.runId ?? "run-1",
    childSessionKey: params?.childSessionKey ?? "child-1",
    requesterSessionKey: "test-session",
    requesterDisplayKey: "test-session",
    task: params?.task ?? "task-1",
    cleanup: params?.cleanup ?? "keep",
    createdAt: 1000,
    execution: params?.hasInternalTranscript
      ? {
          status: "terminal",
          endedAt,
          transcriptTarget: {
            agentId: "main",
            sessionId: "internal-run",
            sessionKey: "agent:main:internal-session-effects:run",
            storePath: "/tmp/test-store",
          },
        }
      : params?.active
        ? { status: "running" }
        : { status: "terminal", endedAt, outcome: { status: "ok" } },
    ...(params?.resultText === undefined
      ? {}
      : {
          completion: {
            required: true,
            resultText: params.resultText,
            terminalReply: params.resultText
              ? { disposition: "visible", text: params.resultText }
              : { disposition: "empty" },
          },
        }),
  };
}

describe("readDescendantSubagentFallbackReply", () => {
  const runStartedAt = 1000;

  it.each([
    {
      name: "visible",
      terminalReply: { disposition: "visible", text: "bounded child output" } as const,
      resultText: "authoritative full child output",
      expected: "bounded child output",
    },
    {
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      resultText: "stale visible child output",
      expected: undefined,
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      resultText: "stale visible child output",
      expected: undefined,
    },
    {
      name: "visible literal token",
      terminalReply: { disposition: "visible", text: "NO_REPLY" } as const,
      resultText: "NO_REPLY",
      expected: "NO_REPLY",
    },
  ])(
    "uses producer-owned $name terminal evidence instead of a stale child transcript",
    async ({ terminalReply, resultText, expected }) => {
      const descendant = createDescendantRun({ resultText });
      descendant.execution.outcome = { status: "ok" };
      descendant.completion = {
        required: true,
        resultText,
        fallbackResultText: "older captured fallback",
        terminalReply,
      };
      vi.mocked(listDescendantRunsForRequester).mockResolvedValue([descendant]);
      vi.mocked(readLatestAssistantReply).mockResolvedValue("stale child transcript");

      await expect(
        readDescendantSubagentFallbackReply({ sessionKey: "test-session", runStartedAt }),
      ).resolves.toBe(expected);
    },
  );

  it.each(["NO_REPLY", "captured child answer"])(
    "does not reconstruct missing terminal facts from retained output: %s",
    async (resultText) => {
      const descendant = createDescendantRun({ resultText });
      descendant.execution.outcome = { status: "ok" };
      descendant.completion = {
        required: true,
        resultText,
        fallbackResultText: "captured child findings",
      };
      vi.mocked(listDescendantRunsForRequester).mockResolvedValue([descendant]);
      vi.mocked(readLatestAssistantReply).mockResolvedValue("stale child transcript");
      vi.mocked(readLatestAssistantReply).mockClear();
      await expect(
        readDescendantSubagentFallbackReply({ sessionKey: "test-session", runStartedAt }),
      ).resolves.toBeUndefined();
      expect(readLatestAssistantReply).not.toHaveBeenCalled();
    },
  );

  it("skips descendants with producer-owned silence", async () => {
    const silent = createDescendantRun({ resultText: "NO_REPLY" });
    silent.completion = { required: true, terminalReply: { disposition: "silent" } };
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([
      silent,
      createDescendantRun({
        runId: "run-2",
        childSessionKey: "child-2",
        task: "task-2",
        endedAt: 3000,
        resultText: "useful output",
      }),
    ]);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("useful output");
  });

  it("returns undefined when completion result is null", async () => {
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([
      createDescendantRun({
        cleanup: "delete",
        resultText: null,
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBeUndefined();
  });

  it("ignores descendants that ended before run started", async () => {
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([
      createDescendantRun({ endedAt: 900, resultText: "stale output from previous run" }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBeUndefined();
  });
});

describe("waitForDescendantSubagentSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([]);
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(false);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initialReply immediately when no active descendants and observedActiveDescendants=false", async () => {
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([]);
    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 100,
      observedActiveDescendants: false,
    });
    expect(result).toBe("on it");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("waits for a queued descendant's successor to produce the synthesis", async () => {
    let descendants = [createDescendantRun({ runId: "queued-run", active: true })];
    let parentReply = "on it";
    vi.mocked(listDescendantRunsForRequester).mockImplementation(async () => descendants);
    vi.mocked(readLatestAssistantReply).mockImplementation(async () => parentReply);
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
      const result = await waitForDescendantSubagentSummary({
        sessionKey: "test-session",
        initialReply: parentReply,
        timeoutMs: 300,
      });

      expect(result).toBe("The successor completed the report.");
      expect(
        callGateway.mock.calls.map(([request]) => (request.params as { runId: string }).runId),
      ).toEqual(["queued-run", "successor-run"]);
    } finally {
      clearTimeout(completion);
    }
  });

  it("does not mistake unchanged parent media history for synthesis", async () => {
    vi.useFakeTimers();
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("on it\n\nMEDIA:/workspace/report.png");

    const resultPromise = waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 100,
      observedActiveDescendants: true,
    });

    const result = await resolveAfterAdvancingTimers(resultPromise);

    expect(result).toBeUndefined();
  });

  it.each([false, true])(
    "waits through delayed successor admission (children already ended: %s)",
    async (childrenAlreadyEnded) => {
      vi.useFakeTimers();
      const cronSessionKey = "agent:main:cron:daily-report:run:scheduled-run";
      const orchestratorSessionKey = "agent:main:subagent:orchestrator";
      const orchestrator = createDescendantRun({
        runId: "orchestrator-yielded",
        childSessionKey: orchestratorSessionKey,
      });
      orchestrator.requesterSessionKey = cronSessionKey;
      orchestrator.pauseReason = "sessions_yield";
      const workers = ["worker-a", "worker-b"].map((runId) => {
        const worker = createDescendantRun({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          active: !childrenAlreadyEnded,
        });
        worker.requesterSessionKey = orchestratorSessionKey;
        worker.delivery = { status: "delivered", disposition: "delivered" };
        worker.cleanupCompletedAt = childrenAlreadyEnded ? 3000 : undefined;
        return worker;
      });
      let descendants = [orchestrator, ...workers];
      let cronReply = "spawned a subagent";
      const finalSynthesis = "Daily report complete: both findings reconciled.";
      vi.mocked(listDescendantRunsForRequester).mockImplementation(async () => descendants);
      vi.mocked(hasUnsettledCronDescendants).mockImplementation(async () =>
        hasDescendantRunAwaitingSettleFromRuns(
          new Map(descendants.map((entry) => [entry.runId, entry])),
          cronSessionKey,
        ),
      );
      vi.mocked(readLatestAssistantReply).mockImplementation(async () => cronReply);
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
      const resultPromise = waitForDescendantSubagentSummary({
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

  it("keeps an unsettled task within the existing deadline without selecting interim output", async () => {
    vi.useFakeTimers();
    const paused = createDescendantRun();
    paused.pauseReason = "sessions_yield";
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([paused]);
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(true);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Partial results are available.");

    const resultPromise = waitForDescendantSubagentSummary({
      sessionKey: "test-session",
      initialReply: "on it",
      timeoutMs: 60,
      observedActiveDescendants: true,
    });
    expect(await resolveAfterAdvancingTimers(resultPromise, 60)).toBeUndefined();
    expect(callGateway).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["handoff", "running"])("stops waiting when cron cancels during %s", async (phase) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const descendant = createDescendantRun({ active: phase === "running" });
    if (phase === "handoff") {
      descendant.pauseReason = "sessions_yield";
    }
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([descendant]);
    vi.mocked(hasUnsettledCronDescendants).mockResolvedValue(true);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("on it");
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

    const resultPromise = waitForDescendantSubagentSummary({
      sessionKey: "test-session",
      initialReply: "on it",
      timeoutMs: 500,
      abortSignal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(20);
    controller.abort(new Error("cron cancelled"));
    expect(await resultPromise).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(readLatestAssistantReply).toHaveBeenCalledTimes(1);
  });

  it.each(["HEARTBEAT_OK"])(
    "skips the %s control-only parent reply instead of treating it as child output",
    async (parentReply) => {
      vi.useFakeTimers();
      vi.mocked(listDescendantRunsForRequester).mockResolvedValue([]);
      vi.mocked(readLatestAssistantReply).mockResolvedValue(parentReply);

      const resultPromise = waitForDescendantSubagentSummary({
        sessionKey: "cron-session",
        initialReply: "on it",
        timeoutMs: 100,
        observedActiveDescendants: true,
      });

      const result = await resolveAfterAdvancingTimers(resultPromise);

      expect(result).toBeUndefined();
    },
  );

  it.each([
    "NO_REPLY",
    "NO_REPLY\nexample",
    "HEARTBEAT_OK child completed the scheduled reminder",
    '{"action":"HEARTBEAT_OK","message":"child completed the scheduled reminder"}',
  ])("preserves prepared synthesis without reclassifying its text: %s", async (synthesis) => {
    vi.mocked(listDescendantRunsForRequester).mockResolvedValue([]);
    vi.mocked(readLatestAssistantReply).mockResolvedValueOnce("on it").mockResolvedValue(synthesis);

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: undefined,
      timeoutMs: 100,
      observedActiveDescendants: true,
    });

    expect(result).toBe(synthesis);
  });
});
