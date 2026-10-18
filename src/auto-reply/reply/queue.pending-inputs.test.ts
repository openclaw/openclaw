import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayRootWorkReleaseObserver } from "../../process/gateway-work-admission.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { executeFollowupTurn } from "./followup-turn-execution.js";
import {
  admitFollowupRunLifecycle,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { createTypingController } from "./typing.js";

vi.mock("./agent-runner-execution.js", () => ({ executeAgentTurn: vi.fn() }));

const fault = useSqliteWorkerFault([
  {
    name: "fail_second_source",
    match: /^insert into transcript_events\b/u,
    sql: `CREATE TEMP TRIGGER fail_second_source BEFORE INSERT ON main.transcript_events
      WHEN instr(NEW.event_json, 'second:user') > 0
      BEGIN SELECT RAISE(ABORT, 'injected second source failure'); END;`,
  },
]);

describe("followup queue durable input consumption", () => {
  const fixture = useTempSessionsFixture("openclaw-queue-pending-");
  let config: OpenClawConfig;
  let caseSequence = 0;
  let sessionKey = "";
  const sessionId = "queue-pending-session";
  const recorders: UserTurnTranscriptRecorder[] = [];
  const scope = () => ({ agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() });

  beforeEach(async () => {
    config = { session: { store: fixture.storePath() } };
    setRuntimeConfigSnapshot(config);
    sessionKey = `agent:main:queue-pending-${++caseSequence}`;
    vi.mocked(executeAgentTurn).mockReset();
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });

  afterEach(() => {
    clearFollowupQueue(sessionKey);
    for (const recorder of recorders.splice(0)) {
      recorder.finishPendingInput?.("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
    clearRuntimeConfigSnapshot();
  });

  const createStagedRun = async (runId: string) => {
    const beforeMessageWrite = vi.fn((params: { message: PersistedUserTurnMessage }) => ({
      ...params.message,
      content: `${runId} approved`,
    }));
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: `${runId} private source`, idempotencyKey: `${runId}:user` },
      target: { ...scope(), sessionEntry: undefined, config },
      beforeMessageWrite,
      updateMode: "none",
    });
    recorders.push(recorder);
    expect(await recorder.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
    const run = Object.assign(
      createQueueTestRun({ prompt: `${runId} approved`, messageId: runId }),
      {
        // A stale display projection must not undo the approval when sources combine.
        transcriptPrompt: `${runId} private source`,
        userTurnTranscriptRecorder: recorder,
        currentInboundContext: { text: `${runId} runtime context` },
        turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: async () => {} },
      } satisfies Partial<FollowupRun>,
    );
    Object.assign(run.run, { agentId: "main", sessionKey, sessionId, config });
    return { run, beforeMessageWrite };
  };

  const persistQueuedRun = async (run: FollowupRun) => {
    const recorder = run.userTurnTranscriptRecorder;
    assert(recorder?.withPendingInput, "queued turn is missing its transcript owner");
    return await recorder.withPendingInput(() => recorder.persistApproved());
  };

  const enqueue = (...runs: FollowupRun[]) => {
    for (const run of runs) {
      expect(enqueueFollowupRun(sessionKey, run, { mode: "collect", debounceMs: 0 })).toBe(true);
    }
  };
  const drain = async (consume = async (_run: FollowupRun, _index: number) => {}) => {
    const calls: FollowupRun[] = [];
    const failures: unknown[] = [];
    scheduleFollowupDrain(sessionKey, async (run) => {
      calls.push(run);
      try {
        await consume(run, calls.length - 1);
      } catch (error) {
        if (error instanceof FollowupRunDeferredError) {
          throw error;
        }
        failures.push(error);
      }
    });
    await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());
    expect(failures).toEqual([]);
    return calls;
  };
  const loadMessages = async () =>
    (await loadTranscriptEvents(scope()))
      .filter(isRecord)
      .filter((event) => event.type === "message");
  const expectWrites = (...sources: Awaited<ReturnType<typeof createStagedRun>>[]) => {
    for (const { beforeMessageWrite } of sources) {
      expect(beforeMessageWrite).toHaveBeenCalledOnce();
    }
  };
  const pending = () => listSessionPendingInputs(scope());
  const pair = async () =>
    [await createStagedRun("first"), await createStagedRun("second")] as const;
  const collected = (...texts: string[]) =>
    `[Queued messages while agent was busy]\n\n${texts.map((text, i) => `---\nQueued #${i + 1}\n${text}`).join("\n\n")}`;

  it("preserves the committed prefix when a native batch falls back after a later source write fails", async () => {
    const [first, second] = await pair();
    await persistQueuedRun(first.run);
    fault.enable();
    try {
      await expect(persistQueuedRun(second.run)).rejects.toThrow("injected second source failure");
    } finally {
      fault.disable();
    }
    expect(first.run.userTurnTranscriptRecorder?.hasPersisted()).toBe(true);
    expect(second.run.userTurnTranscriptRecorder?.hasPersisted()).toBe(false);
    const before = await loadTranscriptEvents(scope());
    enqueue(first.run, second.run);
    const calls = await drain(async (run) => {
      await admitFollowupRunLifecycle(run);
      await persistQueuedRun(run);
    });
    expect(
      calls.map(({ prompt, userTurnTranscriptRecorder }) => [prompt, userTurnTranscriptRecorder]),
    ).toEqual([
      ["first approved", first.run.userTurnTranscriptRecorder],
      ["second approved", second.run.userTurnTranscriptRecorder],
    ]);
    const after = await loadTranscriptEvents(scope());
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.filter(isRecord).filter((event) => event.type === "message")).toMatchObject([
      { message: { content: "first approved", idempotencyKey: "first:user" } },
      { message: { content: "second approved", idempotencyKey: "second:user" } },
    ]);
    expect((await pending()).items).toEqual([]);
    expectWrites(first, second);
  });

  it("keeps unstaged input out of an already-approved collect group", async () => {
    const staged = await createStagedRun("staged");
    const unstaged: FollowupRun = {
      ...staged.run,
      prompt: "unstaged runtime body",
      transcriptPrompt: "unstaged transcript body",
      messageId: "unstaged",
      userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
        input: { text: "unstaged transcript body" },
        target: { ...scope(), sessionEntry: undefined, config: staged.run.run.config },
      }),
      turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: async () => {} },
    };
    enqueue(staged.run, unstaged);
    const calls = await drain();
    expect(calls.map((run) => run.prompt)).toEqual(
      ["staged approved", "unstaged runtime body"].map((text) => collected(text)),
    );
    expect(calls[1]?.transcriptPrompt).toContain("unstaged transcript body");
  });

  it.for([false, true])(
    "binds collected custody before runtime append (cancel during preparation: %s)",
    async (abortDuringPreparation, { signal }) => {
      const [first, second] = await pair();
      first.run.prompt = "first private source";
      second.run.prompt = "second private source";
      enqueue(first.run, second.run);
      const calls: FollowupRun[] = [];
      const failures: unknown[] = [];
      const pendingTotals: number[] = [];
      const drainReleased = createDeferred<"settled" | "reset">();
      vi.mocked(executeAgentTurn).mockImplementation(async (params) => {
        const message = await params.followupRun.userTurnTranscriptRecorder?.resolveMessage();
        if (!message) {
          throw new Error("runtime user message missing");
        }
        // The runtime writes directly, not through the recorder's self-persistence helper.
        await appendTranscriptMessage(scope(), { message });
        return { runId: "collected-run", outcome: { kind: "rejected", payload: { text: "done" } } };
      });
      scheduleFollowupDrain(sessionKey, async (run) => {
        const observeRelease = captureGatewayRootWorkReleaseObserver();
        assert(observeRelease, "followup execution must own root admission");
        observeRelease(drainReleased.resolve);
        calls.push(run);
        const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
        const typing = createTypingController({});
        try {
          pendingTotals.push((await pending()).total);
          await admitFollowupRunLifecycle(run);
          if (abortDuringPreparation) {
            const recorder = second.run.userTurnTranscriptRecorder!;
            const resolveMessage = recorder.resolveMessage;
            vi.spyOn(recorder, "resolveMessage").mockImplementation(async () => {
              await Promise.resolve();
              operation.abortForRestart();
              return resolveMessage();
            });
          }
          await executeFollowupTurn({
            turn: {
              runId: "collected-run",
              queued: run,
              operation,
              config: run.run.config,
              session: {
                kind: "detached",
                current: () => undefined,
                publish: () => {},
                adopt: () => {},
              },
              sendPolicy: "allow",
              preflightCompactionApplied: false,
            },
            defaults: { typing, typingMode: "never", defaultModel: "gpt-test" },
            onToolResult: async () => {},
            onCompactionNoticePayload: async () => {},
          });
          pendingTotals.push((await pending()).total);
        } catch (error) {
          failures.push(error);
        } finally {
          operation.complete();
          typing.cleanup();
        }
      });
      expect(await withinTest(drainReleased.promise, signal)).toBe("settled");
      expect(getExistingFollowupQueue(sessionKey)).toBeUndefined();
      expect(failures).toHaveLength(abortDuringPreparation ? 1 : 0);
      expect(pendingTotals).toEqual(abortDuringPreparation ? [2] : [2, 0]);
      expect(calls).toHaveLength(1);
      expect(executeAgentTurn).toHaveBeenCalledTimes(abortDuringPreparation ? 0 : 1);
      const expected = collected("first approved", "second approved");
      expect(calls[0]).toMatchObject({ prompt: expected, transcriptPrompt: expected });
      expect(calls[0]?.currentInboundContext?.text).toBe(
        "Queued #1 context:\nfirst runtime context\n\nQueued #2 context:\nsecond runtime context",
      );
      expect(await loadMessages()).toMatchObject(
        abortDuringPreparation ? [] : [{ message: { role: "user", content: expected } }],
      );
      expect((await pending()).total).toBe(abortDuringPreparation ? 2 : 0);
      expectWrites(first, second);
    },
  );

  it("retains elided and retried overflow sources until their summary commits", async () => {
    const sources = await Promise.all(["first", "second", "third"].map(createStagedRun));
    const settings = { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" } as const;
    for (const source of sources) {
      source.run.summaryLine = `${source.run.messageId} private summary`;
      expect(enqueueFollowupRun(sessionKey, source.run, settings)).toBe(true);
    }
    const pendingRunIds: string[][] = [];
    const calls = await drain(async (run, index) => {
      if (index === 0) {
        throw new FollowupRunDeferredError();
      }
      await admitFollowupRunLifecycle(run);
      await persistQueuedRun(run);
      pendingRunIds.push((await pending()).items.map((input) => input.runId));
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]?.prompt).toBe(
      "[Queue overflow] Dropped 2 messages due to cap.\nSummary:\n- second approved",
    );
    expect(pendingRunIds).toEqual([["third"], []]);
    expect(await loadMessages()).toMatchObject([
      { message: { content: calls[1]?.prompt } },
      { message: { content: "third approved" } },
    ]);
    expectWrites(...sources);
  });
});
