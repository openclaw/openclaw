// The finalize side schedules agent-requested compaction after the reply's
// delivery settlement: the response is delivered first, and the turn's
// deferred lifecycle has already released the embedded active-run handle.
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { scheduleReplyRequestedTurnCompaction } from "./agent-runner-maintenance.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

const { runAgentRequestedCompactionIfNeededMock } = vi.hoisted(() => ({
  runAgentRequestedCompactionIfNeededMock: vi.fn(async () => {}),
}));

vi.mock("./agent-runner-memory.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./agent-runner-memory.js")>();
  return {
    ...mod,
    runAgentRequestedCompactionIfNeeded: runAgentRequestedCompactionIfNeededMock,
  };
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createContext(overrides?: {
  request?: { focus?: string };
  aborted?: boolean;
}): FinalizeReplyAgentRunInput {
  const abortController = new AbortController();
  if (overrides?.aborted) {
    abortController.abort();
  }
  const settlement = createDeferred<boolean>();
  return {
    cfg: {} as OpenClawConfig,
    followupRun: {
      run: { agentId: "main", sessionId: "session-1", provider: "anthropic" },
    } as FinalizeReplyAgentRunInput["followupRun"],
    sessionKey: "agent:main:session-main",
    storePath: "/tmp/openclaw-test-store/sessions.json",
    runtimePolicySessionKey: undefined,
    isHeartbeat: false,
    opts: {},
    activeSessionEntry: { sessionId: "session-1" } as SessionEntry,
    activeSessionStore: {},
    replyOperation: {
      ownerSettlement: settlement.promise,
      abortSignal: abortController.signal,
      result: { kind: "completed" },
    } as unknown as FinalizeReplyAgentRunInput["replyOperation"],
    execution: {
      kind: "settled",
      status: "ok",
      agentCompactionRequest: overrides?.request,
    } as unknown as FinalizeReplyAgentRunInput["execution"],
  } as unknown as FinalizeReplyAgentRunInput;
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("scheduleReplyRequestedTurnCompaction", () => {
  it("runs the compaction only after delivery settlement", async () => {
    runAgentRequestedCompactionIfNeededMock.mockClear();
    const settlement = createDeferred<boolean>();
    const context = createContext({ request: { focus: "keep the schema decisions" } });
    (context.replyOperation as unknown as { ownerSettlement: Promise<boolean> }).ownerSettlement =
      settlement.promise;

    scheduleReplyRequestedTurnCompaction({ context });
    await flushMicrotasks();
    expect(runAgentRequestedCompactionIfNeededMock).not.toHaveBeenCalled();

    settlement.resolve(true);
    await settlement.promise;
    await flushMicrotasks();
    expect(runAgentRequestedCompactionIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runAgentRequestedCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { focus: "keep the schema decisions" },
        sessionKey: "agent:main:session-main",
        isHeartbeat: false,
      }),
    );
  });

  it("does nothing without a recorded request", async () => {
    runAgentRequestedCompactionIfNeededMock.mockClear();
    const context = createContext();

    scheduleReplyRequestedTurnCompaction({ context });
    await flushMicrotasks();

    expect(runAgentRequestedCompactionIfNeededMock).not.toHaveBeenCalled();
  });

  it("skips the run when the reply operation aborted before settlement", async () => {
    runAgentRequestedCompactionIfNeededMock.mockClear();
    const context = createContext({ request: { focus: "keep decisions" }, aborted: true });

    scheduleReplyRequestedTurnCompaction({ context });
    await flushMicrotasks();

    expect(runAgentRequestedCompactionIfNeededMock).not.toHaveBeenCalled();
  });
});
