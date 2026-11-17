import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadTranscriptEvents,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as pendingInputs from "../../config/sessions/session-accessor.pending-inputs.js";
import { listLiveSessionPendingInputs } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { prepareSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readSessionQueuedInputPage } from "../../config/sessions/session-pending-input-history.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { GatewayOperatorAccessUnavailableError } from "../../infra/operator-authority-error.js";
import { captureGatewayRootWorkReleaseObserver } from "../../process/gateway-work-admission.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { createFollowupRunner } from "./followup-runner.js";
import { executeFollowupTurn } from "./followup-turn-execution.js";
import {
  admitFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createReplyParams } from "./test-helpers.js";
import { createTypingController } from "./typing.js";

vi.mock("./agent-runner-execution.js", () => ({ executeAgentTurn: vi.fn() }));
// mock-isolation: Exercise real input custody with controlled maintenance failures, without loading provider compaction.
vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: vi.fn(),
  runSessionCompactionIfNeeded: vi.fn(),
}));

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
    vi.mocked(runMemoryFlushIfNeeded).mockReset();
    vi.mocked(runSessionCompactionIfNeeded).mockReset();
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });

  afterEach(async () => {
    clearFollowupQueue(sessionKey);
    for (const recorder of recorders.splice(0)) {
      recorder.finishPendingInput?.("interrupted", "failed");
    }
    await closeOpenClawAgentDatabasesAsync();
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

  it.each(["queued followup", "ordinary reply"] as const)(
    "retains unstaged channel input across failed maintenance and restart (%s)",
    async (entrypoint) => {
      const text = "Original channel request: ünicode 🦞\nKeep this exact input.";
      const idempotencyKey = "channel-maintenance:user";
      const recorder = createUserTurnTranscriptRecorder({
        input: { text, idempotencyKey },
        target: { ...scope(), sessionEntry: undefined },
        updateMode: "none",
      });
      recorders.push(recorder);
      const onAdopted = vi.fn(() => {});
      const observed: { operation?: ReplyOperation } = {};
      const queued: FollowupRun = {
        ...createQueueTestRun({ prompt: text, messageId: "channel-maintenance" }),
        transcriptPrompt: text,
        originatingChannel: "telegram",
        userTurnTranscriptRecorder: recorder,
        turnAdoptionLifecycle: { admission: "cancel-only", onAdopted },
        run: {
          ...createQueueTestRun({ prompt: "" }).run,
          agentId: "main",
          sessionKey,
          sessionId,
          messageProvider: "telegram",
          workspaceDir: fixture.sessionsDir(),
          config: { session: { store: fixture.storePath() } },
          onOperationAdmitted: (operation) => {
            observed.operation = operation;
          },
        },
      };
      const sessionEntry = { sessionId, updatedAt: 1 };
      const typing = createTypingController({});
      const defaults = {
        typing,
        typingMode: "never" as const,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath: fixture.storePath(),
        defaultModel: "gpt-test",
      };
      const failure = new Error("stop after observing maintenance input custody");
      const maintenanceInputs: Awaited<ReturnType<typeof listSessionPendingInputs>>[] = [];
      vi.mocked(runMemoryFlushIfNeeded).mockImplementation(async (params) => {
        maintenanceInputs.push(await listSessionPendingInputs(scope()));
        return { sessionEntry: params.sessionEntry, outcome: "skipped" };
      });
      vi.mocked(runSessionCompactionIfNeeded).mockImplementation(async (params) => {
        maintenanceInputs.push(await listSessionPendingInputs(scope()));
        await params.beforeCompaction?.(sessionEntry);
        throw failure;
      });
      expect((await listSessionPendingInputs(scope())).total).toBe(0);
      try {
        const run =
          entrypoint === "queued followup"
            ? createFollowupRunner(defaults)(queued)
            : runReplyAgent(
                createReplyParams(queued, {
                  ...defaults,
                  transcriptCommandBody: text,
                  opts: { turnAdoptionLifecycle: queued.turnAdoptionLifecycle },
                  sessionCtx: {
                    Provider: "telegram",
                    MessageSid: "channel-maintenance",
                    SessionKey: sessionKey,
                  },
                }),
              );
        if (entrypoint === "queued followup") {
          await expect(run).resolves.toBeUndefined();
          const result = observed.operation?.result;
          assert(result?.kind === "failed", "Queued failure must be recorded on its operation");
          expect(result.code).toBe("run_failed");
          expect(result.cause).toBe(failure);
        } else {
          await expect(run).rejects.toBe(failure);
        }
        expect(executeAgentTurn).not.toHaveBeenCalled();
        expect(onAdopted).not.toHaveBeenCalled();
        expect(maintenanceInputs).toHaveLength(2);
        for (const pending of maintenanceInputs) {
          expect(
            pending,
            `${entrypoint}: maintenance checkpoint retains staged source`,
          ).toMatchObject({
            total: 1,
            items: [{ state: "queued", message: { role: "user", content: text, idempotencyKey } }],
          });
        }
        expect(() => recorder.withPendingInput?.(() => "stale execution")).toThrow(
          "ownership ended",
        );
        const retained = await listSessionPendingInputs(scope());
        expect(retained).toMatchObject({ total: 1, items: [{ state: "cancelled" }] });
        rotateAgentEventLifecycleGeneration();
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        expect(await listSessionPendingInputs(scope())).toEqual(retained);
        expect(await readSessionSubmittedInput(scope(), idempotencyKey)).toMatchObject({
          role: "user",
          content: text,
          idempotencyKey,
        });
        expect(await loadTranscriptEvents(scope())).toEqual([]);
      } finally {
        typing.cleanup();
      }
    },
  );

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

  it("rejects a different run ID when reattaching a relinquished native queued input", async () => {
    const message = {
      role: "user",
      content: "Retain the original accepted native run identity.",
      idempotencyKey: "native-run-identity:user",
      timestamp: 1,
    } satisfies PersistedUserTurnMessage;
    const receipts: pendingInputs.SessionPendingInputReceipt[] = [];
    try {
      const original = await pendingInputs.stageSessionPendingInput(scope(), {
        runId: "native-original",
        message,
        assertCurrent() {},
      });
      assert(original, "Expected the original native receipt");
      receipts.push(original);
      original.relinquish();
      await original.settled?.();
      await expect(
        pendingInputs
          .stageSessionPendingInput(scope(), {
            runId: "native-different",
            message,
            assertCurrent() {},
          })
          .then((receipt) => {
            if (receipt) {
              receipts.push(receipt);
            }
            return receipt;
          }),
      ).rejects.toThrow("Pending input idempotency key conflicts with the accepted input");
      expect((await pending()).items).toMatchObject([
        { runId: "native-original", state: "queued", message },
      ]);
      expect((await readSessionQueuedInputPage(scope())).rows).toMatchObject([
        { run_id: "native-original", state: "queued" },
      ]);
      expect(await loadMessages()).toEqual([]);
    } finally {
      for (const receipt of receipts) {
        if (receipt.state === "consumed") {
          receipt.release();
        } else {
          receipt.relinquish();
        }
        await receipt.settled?.();
      }
    }
  });

  it("admits one native owner when independent callers race to reattach a relinquished queued input", async () => {
    const runId = "native-reattach-race";
    const message = {
      role: "user",
      content: "Execute the accepted native input exactly once.",
      idempotencyKey: `${runId}:user`,
      timestamp: 1,
    } satisfies PersistedUserTurnMessage;
    const receipts: pendingInputs.SessionPendingInputReceipt[] = [];
    try {
      const original = await pendingInputs.stageSessionPendingInput(scope(), {
        runId,
        message,
        assertCurrent() {},
      });
      assert(original, "Expected the original native receipt");
      receipts.push(original);
      original.relinquish();
      await original.settled?.();
      const attempts = await Promise.allSettled(
        [scope(), scope()].map((target) =>
          pendingInputs.stageSessionPendingInput(target, { runId, message, assertCurrent() {} }),
        ),
      );
      const admitted = attempts.flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      );
      receipts.push(...admitted);
      const refused = attempts.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        message: expect.stringMatching(/already admitted|already has a live owner/u),
      });
      const winner = admitted[0];
      assert(winner, "Expected one native reattachment owner");
      const execute = vi.fn(async () => appendTranscriptMessage(scope(), { message }));
      await winner.run(execute);
      expect(execute).toHaveBeenCalledOnce();
      winner.release();
      await winner.settled?.();
      const messages = await loadMessages();
      expect(messages).toHaveLength(1);
      expect(messages).toMatchObject([{ message }]);
      expect((await pending()).items).toEqual([]);
    } finally {
      for (const receipt of receipts) {
        if (receipt.state === "consumed") {
          receipt.release();
        } else {
          receipt.relinquish();
        }
        await receipt.settled?.();
      }
    }
  });

  it("relinquishes queued custody during an authority outage and the existing drain runs it once", async ({
    signal,
  }) => {
    const runId = "queued-authority-outage";
    const text = "Keep this accepted follow-up through the policy outage.";
    const recorder = createUserTurnTranscriptRecorder({
      input: { text, idempotencyKey: `${runId}:user` },
      target: { ...scope(), sessionEntry: undefined, config },
      updateMode: "none",
    });
    recorders.push(recorder);
    let unavailable = false;
    const outage = new GatewayOperatorAccessUnavailableError();
    const queued = createQueueTestRun(
      {
        prompt: text,
        messageId: runId,
        userTurnTranscriptRecorder: recorder,
        turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: async () => {} },
        operatorAuthority: createAdmittedRunOperatorAuthority({
          profileId: "queued-requester",
          scopes: ["operator.write"],
          assertCurrent: () => {
            if (unavailable) {
              throw outage;
            }
          },
        }),
      },
      { agentId: "main", sessionKey, sessionId, config, workspaceDir: fixture.sessionsDir() },
    );
    const stage = pendingInputs.stageSessionPendingInput;
    using staging = vi.spyOn(pendingInputs, "stageSessionPendingInput");
    staging.mockImplementationOnce(async (inputScope, options) => {
      let committedReceipt: pendingInputs.SessionPendingInputReceipt | undefined;
      const observeSettlement = (receipt: pendingInputs.SessionPendingInputReceipt) => {
        const waitForSettlement = receipt.settled;
        assert(waitForSettlement, "Expected the real pending-input receipt settlement");
        const settlement = vi.spyOn(receipt, "settled");
        settlement.mockImplementation(async () => {
          await waitForSettlement();
          if (
            !unavailable ||
            observedOutage ||
            listLiveSessionPendingInputs(databasePath, resolved.sessionKey, sessionId).some(
              (input) => input.inputId === receipt.inputId,
            )
          ) {
            return;
          }
          observedOutage = true;
          firstAttempt.resolve();
        });
        restoreSettlements.push(() => settlement.mockRestore());
      };
      const receipt = await stage(inputScope, {
        ...options,
        onCommitted: (committed) => {
          committedReceipt = committed;
          observeSettlement(committed);
          options.onCommitted?.(committed);
        },
      });
      assert(receipt, "Expected the staged pending-input receipt");
      if (receipt !== committedReceipt) {
        observeSettlement(receipt);
      }
      unavailable = true;
      return receipt;
    });
    const resolved = await prepareSqliteScope(scope());
    assert(resolved.path, "Expected the durable queue database");
    const databasePath = resolved.path;
    vi.mocked(runMemoryFlushIfNeeded).mockImplementation(async (params) => ({
      sessionEntry: params.sessionEntry,
      outcome: "skipped",
    }));
    vi.mocked(runSessionCompactionIfNeeded).mockImplementation(
      async (params) => params.sessionEntry,
    );
    vi.mocked(executeAgentTurn).mockImplementation(async (params) => {
      await persistQueuedRun(params.followupRun);
      return { runId, outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const typing = createTypingController({});
    const sessionEntry = { sessionId, updatedAt: 1 };
    const runner = createFollowupRunner({
      typing,
      typingMode: "never",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: fixture.storePath(),
      defaultModel: "gpt-test",
    });
    const firstAttempt = createDeferred();
    let observedOutage = false;
    const restoreSettlements: Array<() => void> = [];
    enqueue(queued);
    try {
      scheduleFollowupDrain(sessionKey, runner);
      await withinTest(firstAttempt.promise, signal);
      expect(executeAgentTurn).not.toHaveBeenCalled();
      expect(await pending()).toMatchObject({
        total: 1,
        items: [{ state: "queued", message: { content: text } }],
      });
      expect(listLiveSessionPendingInputs(databasePath, resolved.sessionKey, sessionId)).toEqual(
        [],
      );
      expect((await readSessionQueuedInputPage(scope())).rows).toMatchObject([
        { state: "queued", end_cause: null },
      ]);
      unavailable = false;
      await withinTest(queued.controllerInput!.settlement.promise, signal);
      await queued.controllerInput!.claim?.settlement.promise;
      expect(executeAgentTurn).toHaveBeenCalledOnce();
      const messages = await loadMessages();
      expect(messages).toMatchObject([
        { message: { content: text, idempotencyKey: `${runId}:user` } },
      ]);
      expect(messages).toHaveLength(1);
      expect((await pending()).items).toEqual([]);
    } finally {
      unavailable = false;
      for (const restore of restoreSettlements) {
        restore();
      }
      typing.cleanup();
    }
  });

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
    expect(calls.map((run) => run.prompt)).toEqual(["staged approved", "unstaged runtime body"]);
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
        const operation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
          mailboxClaim: run.controllerClaim ?? run.controllerInput!.claim,
        });
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

  it("retains elided overflow sources until their summary commits", async () => {
    const sources = await Promise.all(["first", "second", "third"].map(createStagedRun));
    const settings = { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" } as const;
    for (const source of sources) {
      source.run.summaryLine = `${source.run.messageId} private summary`;
      expect(enqueueFollowupRun(sessionKey, source.run, settings)).toBe(true);
    }
    const pendingRunIds: string[][] = [];
    const calls: FollowupRun[] = [];
    const failures: unknown[] = [];
    scheduleFollowupDrain(sessionKey, async (run) => {
      calls.push(run);
      try {
        await admitFollowupRunLifecycle(run);
        await persistQueuedRun(run);
        pendingRunIds.push((await pending()).items.map((input) => input.runId));
      } catch (error) {
        failures.push(error);
      }
    });
    // Durable append owns real worker I/O; a polling deadline is not its receipt.
    await Promise.all(sources.map(({ run }) => run.controllerInput!.settlement.promise));
    await Promise.all(
      sources.flatMap(({ run }) => {
        const claim = run.controllerInput!.claim;
        return claim ? [claim.settlement.promise] : [];
      }),
    );
    expect(getExistingFollowupQueue(sessionKey)).toBeUndefined();
    expect(failures).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe(
      "[Queue overflow] Dropped 2 messages due to cap.\nSummary:\n- second approved",
    );
    // Context pairs with the shown line; the elided line's source adds no unmatched context.
    expect(calls[0]?.currentInboundContext).toEqual({ text: "second runtime context" });
    expect(pendingRunIds).toEqual([["third"], []]);
    expect(await loadMessages()).toMatchObject([
      { message: { content: calls[0]?.prompt } },
      { message: { content: "third approved" } },
    ]);
    expectWrites(...sources);
  });
});
