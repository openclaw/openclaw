// Subagent followup tests cover followup handling after isolated cron agent runs.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDescendantRunAwaitingSettleFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";

// vi.hoisted runs before module imports, ensuring FAST_TEST_MODE is picked up.
vi.hoisted(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.js";

vi.mock("../../agents/subagents/registry/subagent-registry-read.js", () => ({
  listDescendantRunsForRequester: vi.fn().mockReturnValue([]),
  hasDescendantRunAwaitingSettle: vi.fn().mockReturnValue(false),
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

const { listDescendantRunsForRequester, hasDescendantRunAwaitingSettle } =
  await import("../../agents/subagents/registry/subagent-registry-read.js");
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
        : { status: "terminal", endedAt },
    ...(params?.resultText === undefined
      ? {}
      : { completion: { required: true, resultText: params.resultText } }),
  };
}

describe("isLikelyInterimCronMessage", () => {
  it("detects 'on it' as interim", () => {
    expect(isLikelyInterimCronMessage("on it")).toBe(true);
  });
  it("detects subagent-related interim text", () => {
    expect(isLikelyInterimCronMessage("spawned a subagent, it'll auto-announce when done")).toBe(
      true,
    );
  });
  it("rejects substantive content", () => {
    expect(isLikelyInterimCronMessage("Here are your results: revenue was $5000 this month")).toBe(
      false,
    );
  });
  it("does not treat whitespace-only as interim", () => {
    expect(isLikelyInterimCronMessage("   ")).toBe(false);
  });
});

describe("expectsSubagentFollowup", () => {
  it("returns true for subagent spawn hints", () => {
    expect(expectsSubagentFollowup("subagent spawned")).toBe(true);
    expect(expectsSubagentFollowup("spawned a subagent")).toBe(true);
    expect(expectsSubagentFollowup("it'll auto-announce when done")).toBe(true);
    expect(expectsSubagentFollowup("both subagents are running")).toBe(true);
  });
  it("returns false for plain interim text", () => {
    expect(expectsSubagentFollowup("on it")).toBe(false);
    expect(expectsSubagentFollowup("working on it")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(expectsSubagentFollowup("")).toBe(false);
  });
});

describe("readDescendantSubagentFallbackReply", () => {
  const runStartedAt = 1000;

  it("returns undefined when no descendants exist", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBeUndefined();
  });

  it("falls back to frozenResultText when session transcript unavailable", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({
        cleanup: "delete",
        resultText: "frozen child output",
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("frozen child output");
  });

  it("prefers session transcript over frozenResultText", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({ resultText: "frozen text" }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("live transcript text");
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("live transcript text");
  });

  it.each([
    {
      name: "visible",
      terminalReply: { disposition: "visible", text: "authoritative child output" } as const,
      resultText: "older captured output",
      expected: "authoritative child output",
    },
    {
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      resultText: "NO_REPLY",
      expected: undefined,
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      resultText: null,
      expected: undefined,
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
      vi.mocked(listDescendantRunsForRequester).mockReturnValue([descendant]);
      vi.mocked(readLatestAssistantReply).mockResolvedValue("stale child transcript");

      await expect(
        readDescendantSubagentFallbackReply({ sessionKey: "test-session", runStartedAt }),
      ).resolves.toBe(expected);
    },
  );

  it.each([
    { name: "missing transcript", hasInternalTranscript: false, transcript: undefined },
    { name: "silent transcript", hasInternalTranscript: false, transcript: "NO_REPLY" },
    { name: "internal resume", hasInternalTranscript: true, transcript: undefined },
  ])(
    "retains a successful NO_REPLY fallback with a $name",
    async ({ hasInternalTranscript, transcript }) => {
      const descendant = createDescendantRun({ resultText: "NO_REPLY", hasInternalTranscript });
      descendant.execution.outcome = { status: "ok" };
      descendant.completion = {
        required: true,
        resultText: "NO_REPLY",
        fallbackResultText: "captured child findings",
      };
      vi.mocked(listDescendantRunsForRequester).mockReturnValue([descendant]);
      vi.mocked(readLatestAssistantReply).mockResolvedValue(transcript);

      await expect(
        readDescendantSubagentFallbackReply({ sessionKey: "test-session", runStartedAt }),
      ).resolves.toBe("captured child findings");
    },
  );

  it("prefers captured completion for internally resumed descendants", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({
        resultText: "fresh recovered output",
        hasInternalTranscript: true,
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("stale visible transcript");
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("fresh recovered output");
  });

  it("does not fall back to visible transcript for internally resumed descendants without captured output", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({
        resultText: null,
        hasInternalTranscript: true,
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockClear();
    vi.mocked(readLatestAssistantReply).mockResolvedValue("stale visible transcript");
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBeUndefined();
    expect(readLatestAssistantReply).not.toHaveBeenCalled();
  });

  it("joins replies from multiple descendants", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({ resultText: "first child output" }),
      createDescendantRun({
        runId: "run-2",
        childSessionKey: "child-2",
        task: "task-2",
        endedAt: 3000,
        resultText: "second child output",
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("first child output\n\nsecond child output");
  });

  it("skips SILENT_REPLY_TOKEN descendants", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun(),
      createDescendantRun({
        runId: "run-2",
        childSessionKey: "child-2",
        task: "task-2",
        endedAt: 3000,
        resultText: "useful output",
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockImplementation(async (params) => {
      if (params.sessionKey === "child-1") {
        return "NO_REPLY";
      }
      return undefined;
    });
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("useful output");
  });

  it("returns undefined when completion result is null", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
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
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
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
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    vi.mocked(hasDescendantRunAwaitingSettle).mockReturnValue(false);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initialReply immediately when no active descendants and observedActiveDescendants=false", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 100,
      observedActiveDescendants: false,
    });
    expect(result).toBe("on it");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("awaits active descendants via agent.wait and returns synthesis after grace period", async () => {
    // First call: active run; second call (after agent.wait resolves): no active runs
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-abc",
          childSessionKey: "child-session",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "morning briefing",
          cleanup: "keep",
          createdAt: 1000,
          execution: { status: "running" },
          // no endedAt → active
        },
      ])
      .mockReturnValue([]); // subsequent calls: all done

    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Morning briefing complete!");

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    expect(result).toBe("Morning briefing complete!");
    // agent.wait should have been called with the active run's ID
    const gatewayCalls = (
      callGateway as unknown as {
        mock: { calls: Array<[{ method?: string; params?: { runId?: string } }]> };
      }
    ).mock.calls;
    const waitCall = gatewayCalls.find(([request]) => request.method === "agent.wait")?.[0];
    expect(waitCall?.method).toBe("agent.wait");
    expect(waitCall?.params?.runId).toBe("run-abc");
  });

  it("waits for a queued descendant's successor to produce the synthesis", async () => {
    let descendants = [createDescendantRun({ runId: "queued-run", active: true })];
    let parentReply = "on it";
    vi.mocked(listDescendantRunsForRequester).mockImplementation(() => descendants);
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

  it.each(["on it", "on it\n\nMEDIA:/workspace/report.png"])(
    "does not mistake unchanged parent history for synthesis: %s",
    async (parentReply) => {
      vi.useFakeTimers();
      // No active runs at call time, but observedActiveDescendants=true (saw them before)
      vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
      // readLatestAssistantReply keeps returning interim text
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

  it("returns synthesis even if initial reply was undefined", async () => {
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-xyz",
          childSessionKey: "child-2",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "report",
          cleanup: "keep",
          createdAt: 1000,
          execution: { status: "running" },
        },
      ])
      .mockReturnValue([]);

    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Report generated successfully.");

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: undefined,
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    expect(result).toBe("Report generated successfully.");
  });

  it("uses agent.wait for each active run when multiple descendants exist", async () => {
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: "child-1",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-1",
          cleanup: "keep",
          createdAt: 1000,
          execution: { status: "running" },
        },
        {
          runId: "run-2",
          childSessionKey: "child-2",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-2",
          cleanup: "keep",
          createdAt: 1000,
          execution: { status: "running" },
        },
      ])
      .mockReturnValue([]);

    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReply).mockResolvedValue("All tasks complete.");

    await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "spawned a subagent",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    // agent.wait called once for each active run
    const waitCalls = vi
      .mocked(callGateway)
      .mock.calls.filter((c) => (c[0] as { method?: string }).method === "agent.wait");
    expect(waitCalls).toHaveLength(2);
    const runIds = waitCalls.map((c) => (c[0] as { params: { runId: string } }).params.runId);
    expect(runIds).toContain("run-1");
    expect(runIds).toContain("run-2");
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
      vi.mocked(listDescendantRunsForRequester).mockImplementation(() => descendants);
      vi.mocked(hasDescendantRunAwaitingSettle).mockImplementation(() =>
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
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([paused]);
    vi.mocked(hasDescendantRunAwaitingSettle).mockReturnValue(true);
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
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([descendant]);
    vi.mocked(hasDescendantRunAwaitingSettle).mockReturnValue(true);
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

  it("handles agent.wait errors gracefully and still reads the synthesis", async () => {
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-err",
          childSessionKey: "child-err",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-err",
          cleanup: "keep",
          createdAt: 1000,
          execution: { status: "running" },
        },
      ])
      .mockReturnValue([]);

    vi.mocked(callGateway).mockRejectedValue(new Error("gateway unavailable"));
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Completed despite gateway error.");

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    expect(result).toBe("Completed despite gateway error.");
  });

  it.each([
    "NO_REPLY",
    "HEARTBEAT_OK",
    "**HEARTBEAT_OK**",
    "<b>HEARTBEAT_OK</b>",
    "<thinking>Check the schedule.</thinking>\nHEARTBEAT_OK",
    '{"action":"HEARTBEAT_OK"}',
    '"HEARTBEAT_OK"',
  ])(
    "skips the %s control-only parent reply instead of treating it as child output",
    async (parentReply) => {
      vi.useFakeTimers();
      vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
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
    "HEARTBEAT_OK child completed the scheduled reminder",
    "child completed the scheduled reminder HEARTBEAT_OK",
    "<b>HEARTBEAT_OK</b> child completed the scheduled reminder",
    "<thinking>Check the schedule.</thinking>\nHere is the scheduled reminder.\nHEARTBEAT_OK",
    '{"action":"HEARTBEAT_OK","message":"child completed the scheduled reminder"}',
  ])(
    "preserves substantive synthesis that also contains a heartbeat token: %s",
    async (synthesis) => {
      vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
      vi.mocked(readLatestAssistantReply).mockResolvedValue(synthesis);

      const result = await waitForDescendantSubagentSummary({
        sessionKey: "cron-session",
        initialReply: undefined,
        timeoutMs: 100,
        observedActiveDescendants: true,
      });

      expect(result).toBe(synthesis);
    },
  );
});
