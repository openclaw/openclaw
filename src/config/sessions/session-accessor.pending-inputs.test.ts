import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction as writeTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission as withWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptMessage as appendMessage,
  appendTranscriptMessageSync as appendMessageSync,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  readActiveTranscriptEntryAnchor as readActiveAnchor,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  readSessionPendingInput,
  readSessionPendingInputRequesterOrigin,
  stageSessionPendingInput,
  prepareForeignLiveSessionPendingInputEntries,
  withSessionPendingInputPersistence as withPersistence,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { withSessionPendingInputRelocation } from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEvents,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { readSessionPendingInputReceiptsInWorker as listSessionPendingInputReceipts } from "./session-pending-input-receipts.js";
import {
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { timedMessageEvent } from "./transcript-message.test-support.js";

const custodyFault = useSqliteWorkerFault([
  {
    name: "reject_pending_consume",
    match: /^delete from session_pending_inputs\b/u,
    sql: `CREATE TEMP TRIGGER reject_pending_consume BEFORE DELETE ON main.session_pending_inputs
      BEGIN SELECT RAISE(ABORT, 'consume failed'); END`,
  },
  {
    name: "reject_collect_consume",
    match: /^update session_pending_inputs\b/u,
    sql: `CREATE TEMP TRIGGER reject_collect_consume BEFORE UPDATE OF consumed_event_id ON main.session_pending_inputs
      WHEN OLD.run_id = 'atomic-b' BEGIN SELECT RAISE(ABORT, 'collect consume failed'); END`,
  },
]);

const fixture = useTempSessionsFixture("openclaw-pending-inputs-");
const sessionKey = "agent:main:pending-inputs";
const sessionId = "pending-session";
const receipts: SessionPendingInputReceipt[] = [];
const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
const databaseOptions = () => toDatabaseOptions(resolveSqliteScope(scope()));
const database = () => openOpenClawAgentDatabase(databaseOptions());
const storedInputs = () =>
  database().db.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all();
const trackPendingReads = () =>
  trackSqliteStatementExecutions(requireNativeSqliteDatabase(database().db), ["pending"], (sql) =>
    sql.startsWith("select ") && sql.includes('from "session_pending_inputs"') ? "pending" : null,
  );
const appendResult = (messageId: string, appended = true) => ({ appended, messageId });
const nativeResult = (messageId: string, appended = true) => ({
  ok: true,
  value: appendResult(messageId, appended),
});
const pendingPage = (inputs: SessionPendingInputReceipt[], state = "queued") => ({
  total: inputs.length,
  items: inputs.map(({ inputId: id, message }) => ({ id, state, message })),
});
const message = (runId: string, content = "Continue the task"): PersistedUserTurnMessage => ({
  role: "user",
  content,
  timestamp: 100,
  idempotencyKey: `${runId}:user`,
});
const stage = async (
  runId: string,
  options: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
) => {
  const receipt = await stageSessionPendingInput(scope(), {
    runId,
    message: message(runId),
    assertCurrent: () => {},
    ...options,
  });
  if (receipt) {
    receipts.push(receipt);
  }
  return receipt!;
};
const readTranscript = () => loadTranscriptEvents(scope());
const pendingInputs = (options?: Parameters<typeof listSessionPendingInputs>[1]) =>
  listSessionPendingInputs(scope(), options);
const readPending = (id: string) => readSessionPendingInput(scope(), id);
const submitted = (id: string) => readSessionSubmittedInput(scope(), id);
type AppendOptions = Omit<Parameters<typeof appendMessage<PersistedUserTurnMessage>>[1], "message">;
const append = (input: PersistedUserTurnMessage, options: AppendOptions = {}) =>
  appendMessage(scope(), { message: input, ...options });
const appendSync = (input: PersistedUserTurnMessage, options: AppendOptions = {}) =>
  appendMessageSync(scope(), { message: input, ...options });
const promote = (receipt: SessionPendingInputReceipt) => receipt.run(() => append(receipt.message));
const promoteSync = (receipt: SessionPendingInputReceipt) =>
  receipt.run(() => appendSync(receipt.message));
const anchor = (entryId: string) => readActiveAnchor({ ...scope(), entryId });
const bind = (sources: SessionPendingInputReceipt[], runId: string) => {
  const receipt = bindSessionPendingInputSources(sources, message(runId))!;
  receipts.push(receipt);
  return receipt;
};
const createRelocation = (receipt: SessionPendingInputReceipt) => {
  const copy = (sourceInputId: string, eventId: string) =>
    withSessionPendingInputRelocation(sourceInputId, receipt.message, () =>
      appendSync(receipt.message, {
        eventId,
        idempotencyLookup: "caller-checked",
        parentId: null,
      }),
    );
  return { copy, move: (source: string, id: string) => receipt.run(() => copy(source, id)) };
};

beforeEach(async () => {
  setRuntimeConfigSnapshot({ session: { store: fixture.storePath() } });
  // Raw custody/savepoint fixtures need their native handle before worker writes start.
  database();
  await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
});
afterEach(async () => {
  const retained = receipts.splice(0);
  for (const receipt of retained) {
    receipt.finish("interrupted");
  }
  await Promise.allSettled(retained.map(async (receipt) => receipt.settled?.()));
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
});

it.each([false, true])(
  "releases settled input authority while its timer remains pending (collected: %s)",
  async (collected) => {
    const makeTimer = () => setTimeout(() => {}, 60_000);
    async function settle() {
      const entry = { sessionId, skillsSnapshot: { prompt: "synthetic prompt", skills: [] } };
      const reference = new WeakRef(entry);
      const receipt = (await stageSessionPendingInput(scope(), {
        runId: "retention",
        message: message("retention"),
        assertCurrent: () => {
          expect(entry.sessionId).toBe(sessionId);
        },
      }))!;
      const execution = collected
        ? bindSessionPendingInputSources([receipt], message("collected-retention"))!
        : receipt;
      const timer = execution.run(makeTimer);
      execution.finish("cancelled");
      await execution.settled?.();
      expect(() => execution.run(() => {})).toThrow(SessionPendingInputCustodyError);
      return { reference, timer };
    }
    const { reference, timer } = await settle();
    try {
      const control = new WeakRef({});
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(timer.hasRef()).toBe(true);
      expect(reference.deref()).toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
  },
);

it("keeps accepted input outside the active transcript and applies its hook once across replay and promotion", async () => {
  await append(message("active", "First task"));
  expect(await submitted("active:user")).toEqual(message("active", "First task"));
  const before = await readTranscript();
  const prepare = vi.fn((input: PersistedUserTurnMessage) => ({
    ...input,
    content: typeof input.content === "string" ? `${input.content} (approved)` : input.content,
  }));
  const receipt = await stage("queued", { prepareMessageAfterIdempotencyCheck: prepare });
  expect(await submitted("queued:user")).toEqual(receipt.message);
  await expect(
    stage("queued", {
      message: { ...message("queued"), timestamp: 200 },
      prepareMessageAfterIdempotencyCheck: prepare,
    }),
  ).rejects.toThrow("already admitted");
  expect(prepare).toHaveBeenCalledOnce();
  expect(await readTranscript()).toEqual(before);
  expect(await pendingInputs()).toMatchObject(pendingPage([receipt]));
  await expect(stage("queued", { message: message("queued", "Changed input") })).rejects.toThrow(
    "conflicts",
  );
  await expect(append(receipt.message)).rejects.toThrow("outside its admitted turn");
  const secondHook = vi.fn(() => undefined);
  const appended = await receipt.run(() =>
    append(receipt.message, { prepareMessageAfterIdempotencyCheck: secondHook }),
  );
  expect(secondHook).not.toHaveBeenCalled();
  expect(appended).toMatchObject({ ...appendResult(receipt.inputId), message: receipt.message });
  expect(await pendingInputs()).toEqual({ total: 0, items: [] });
  expect(await submitted("queued:user")).toEqual(receipt.message);
  const committedReplay = await stage("queued", { prepareMessageAfterIdempotencyCheck: prepare });
  expect(committedReplay.message).toEqual(receipt.message);
  expect(bindSessionPendingInputSources([committedReplay], message("recollected"))).toBeUndefined();
  expect(prepare).toHaveBeenCalledOnce();
  receipt.finish("interrupted");
  expect(() => receipt.run(() => {})).toThrow("ownership ended");
  const readForeign = await prepareForeignLiveSessionPendingInputEntries(scope());
  expect(readForeign()).toEqual(new Map([[receipt.inputId, receipt.message.idempotencyKey]]));
  committedReplay.finish("interrupted");
  await committedReplay.settled?.();
  expect(readForeign()).toEqual(new Map());
});

it("keeps requester facts with exact accepted custody through projection edits and restart replay", async () => {
  const requesterOrigin = {
    sessionKey: "agent:research:telegram:group:requesters",
    messageProvider: "telegram",
    senderId: "bob",
  };
  const input = { ...message("requester-custody"), __openclaw: { requesterOrigin } };
  const receipt = await stage("requester-custody", { message: input });
  receipt.message["__openclaw"] = {
    requesterOrigin: { ...requesterOrigin, senderId: "alice" },
  };
  expect(readSessionPendingInputRequesterOrigin(receipt)).toMatchObject(requesterOrigin);
  const captured = readSessionPendingInputRequesterOrigin(receipt);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(captured?.sessionKey).toBe(requesterOrigin.sessionKey);
  expect(readSessionPendingInputRequesterOrigin({ ...receipt })).toBeUndefined();
  receipt.finish("interrupted");
  await receipt.settled?.();
  rotateAgentEventLifecycleGeneration();
  const recovered = await stage("requester-custody", {
    message: input,
    trackCompletion: true,
  });
  expect(readSessionPendingInputRequesterOrigin(recovered)).toMatchObject(requesterOrigin);
  await expect(
    stage("requester-custody", {
      message: {
        ...input,
        __openclaw: { requesterOrigin: { ...requesterOrigin, senderId: "alice" } },
      },
      trackCompletion: true,
    }),
  ).rejects.toThrow("conflicts");
});

it("mirrors a correlated input to another session without borrowing or consuming source custody", async () => {
  const target = {
    ...scope(),
    sessionKey: "agent:main:bound-target",
    sessionId: "bound-target-session",
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const receipt = await stage("bound-mirror", {
    message: {
      ...message("bound-mirror"),
      __openclaw: { transport: { clients: [{ id: "cli", mode: "cli" }] } },
    },
  });
  const pending = await pendingInputs();
  const sourceTranscript = await readTranscript();
  const mirrored = await receipt.run(() => appendMessage(target, { message: receipt.message }));
  expect(mirrored).toMatchObject({ appended: true, message: receipt.message });
  expect(mirrored?.messageId).not.toBe(receipt.inputId);
  expect(await pendingInputs()).toEqual(pending);
  expect(await readTranscript()).toEqual(sourceTranscript);
  expect(await readSessionSubmittedInput(target, "bound-mirror:user")).toEqual(receipt.message);
  await expect(append(receipt.message)).rejects.toThrow("outside its admitted turn");

  expect(await promote(receipt)).toMatchObject(appendResult(receipt.inputId));
  expect(await pendingInputs()).toEqual({ total: 0, items: [] });
  const targetTranscript = await loadTranscriptEvents(target);
  expect(
    await receipt.run(() => appendMessage(target, { message: receipt.message })),
  ).toMatchObject({ appended: false, messageId: mirrored?.messageId });
  expect(await loadTranscriptEvents(target)).toEqual(targetTranscript);
});

it.each([
  { disposition: "interrupted", restart: true },
  { disposition: "interrupted", restart: false },
  { disposition: "collected-consumed", restart: true },
] as const)(
  "preserves request-bound receipts across legacy-hash rejection ($disposition, restart=$restart)",
  async ({ disposition, restart }) => {
    const runId = "versioned-input";
    const requestFingerprint = "f".repeat(64);
    const receipt = await stage(runId, { requestFingerprint });
    if (disposition === "collected-consumed") {
      await promote(bind([receipt], "versioned-collect"));
    }
    receipt.finish("interrupted");
    await receipt.settled?.();
    expect(() => readSessionPendingInputRequesterOrigin(receipt)).toThrow(
      SessionPendingInputCustodyError,
    );
    if (restart) {
      rotateAgentEventLifecycleGeneration();
    }
    const readStoredSource = () =>
      database()
        .db.prepare("SELECT * FROM session_pending_inputs WHERE input_id = ?")
        .get(receipt.inputId);
    const storedSource = readStoredSource();
    expect(storedSource).toMatchObject({
      request_hash: `request:${requestFingerprint}`,
      consumed_event_id: disposition === "collected-consumed" ? expect.any(String) : null,
    });
    const transcript = await readTranscript();
    const prepare = vi.fn((input: PersistedUserTurnMessage) => input);
    const execute = vi.fn();
    // v2026.9.2 compares the unprefixed hash before consumed-receipt handling.
    await expect(stage(runId, { prepareMessageAfterIdempotencyCheck: prepare })).rejects.toThrow(
      "idempotency key conflicts",
    );
    expect(() => receipt.run(execute)).toThrow();
    expect(readStoredSource()).toEqual(storedSource);
    expect(await readTranscript()).toEqual(transcript);
    expect((await pendingInputs()).total).toBe(disposition === "interrupted" ? 1 : 0);

    if (!restart) {
      await expect(stage(runId, { requestFingerprint })).rejects.toThrow("ownership ended");
    }
    const renewed = await stage(runId, {
      requestFingerprint,
      retryInterrupted: !restart,
      prepareMessageAfterIdempotencyCheck: prepare,
    });
    expect(renewed.inputId).toBe(receipt.inputId);
    expect(renewed.message).toEqual(receipt.message);
    expect(prepare).not.toHaveBeenCalled();
    if (disposition === "collected-consumed") {
      expect(renewed.state).toBe("consumed");
      expect(() => renewed.run(execute)).toThrow("already been consumed");
      expect(readStoredSource()).toEqual(storedSource);
      expect(await readTranscript()).toEqual(transcript);
    } else {
      expect(renewed.state).toBe("queued");
      const appended = await renewed.run(async () => {
        execute();
        return append(renewed.message);
      });
      expect(appended).toMatchObject({
        ...appendResult(receipt.inputId),
        message: receipt.message,
      });
      const committed = await readTranscript();
      expect(
        committed.filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "message",
        ),
      ).toEqual([expect.objectContaining({ id: receipt.inputId, message: receipt.message })]);
      expect(await promote(renewed)).toMatchObject(appendResult(receipt.inputId, false));
      expect(await readTranscript()).toEqual(committed);
    }
    expect(execute).toHaveBeenCalledTimes(disposition === "interrupted" ? 1 : 0);
    expect(await pendingInputs()).toEqual({ total: 0, items: [] });
  },
);

it("rolls transcript promotion and custody consumption back together", async () => {
  const receipt = await stage("atomic");
  const before = await readTranscript();
  custodyFault.enable();
  await expect(promote(receipt)).rejects.toThrow("consume failed");
  expect(await readTranscript()).toEqual(before);
  expect((await readPending(receipt.inputId))?.state).toBe("queued");
  custodyFault.disable();
  expect(await promote(receipt)).toMatchObject(appendResult(receipt.inputId));
  expect(await readPending(receipt.inputId)).toBeUndefined();
});

it("moves transcript custody only after an authorized relocation commits", async () => {
  const receipt = await stage("relocation");
  await promote(receipt);
  const { copy: appendCopy, move } = createRelocation(receipt);

  expect(
    receipt.run(() =>
      appendSync(receipt.message, {
        eventId: "unauthorized-copy",
        idempotencyLookup: "caller-checked",
      }),
    ),
  ).toMatchObject(nativeResult(receipt.inputId, false));

  await withWriteAdmission(databaseOptions(), () => {
    database().db.exec(
      "CREATE TRIGGER reject_relocation BEFORE INSERT ON transcript_events WHEN NEW.event_json LIKE '%relocation-copy%' BEGIN SELECT RAISE(ABORT, 'relocation failed'); END",
    );
  });
  expect(() => move(receipt.inputId, "relocation-copy")).toThrow("relocation failed");
  await withWriteAdmission(databaseOptions(), () => {
    database().db.exec("DROP TRIGGER reject_relocation");
  });
  expect(await promote(receipt)).toMatchObject(appendResult(receipt.inputId, false));

  expect(move(receipt.inputId, "relocated-user")).toMatchObject(nativeResult("relocated-user"));
  expect(() => move(receipt.inputId, "stale-source-copy")).toThrow("does not match");
  receipt.finish("cancelled");
  expect(appendCopy("relocated-user", "closed-owner-copy")).toMatchObject(
    nativeResult("closed-owner-copy"),
  );
  await expect(withPersistence(receipt, () => append(receipt.message))).rejects.toThrow(
    "conflicts with the admitted message",
  );
});

it("publishes committed relocation before fallible post-commit observers", async () => {
  const receipt = await stage("relocation-observer");
  await promote(receipt);
  const { move } = createRelocation(receipt);
  setLoggerOverride({ level: "silent", consoleLevel: "error" });
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => {
    errorLog.mockRestore();
    resetLogger();
  });

  expect(() =>
    writeTransaction((current) => {
      deferOpenClawAgentPostCommitPublication(current, () => {
        throw new Error("injected observer failure");
      });
      move(receipt.inputId, "relocated-before-observer");
    }, databaseOptions()),
  ).not.toThrow();
  expect(errorLog).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("SQLite post-commit notification failed"),
  );

  expect(() => move(receipt.inputId, "stale-source-after-observer")).toThrow("does not match");
  expect(promoteSync(receipt)).toMatchObject({ ok: true, value: { appended: false } });
});

it("stages repeated relocation through savepoints and restores it on rollback", async () => {
  const receipt = await stage("relocation-savepoints");
  await promote(receipt);
  const options = databaseOptions();
  await waitForSessionTranscriptIndexReconcile(options);
  const { copy: appendCopy, move } = createRelocation(receipt);

  await runExclusiveSqliteSessionWrite(
    resolveSqliteScope(scope()),
    async () => {
      expect(() =>
        writeTransaction(() => {
          move(receipt.inputId, "rolled-back-outer");
          throw new Error("outer rollback");
        }, options),
      ).toThrow("outer rollback");

      writeTransaction(() => {
        receipt.run(() => {
          expect(appendCopy(receipt.inputId, "first-savepoint-copy")).toMatchObject(
            nativeResult("first-savepoint-copy"),
          );
          expect(() =>
            writeTransaction(() => {
              appendCopy("first-savepoint-copy", "rolled-back-savepoint");
              throw new Error("savepoint rollback");
            }, options),
          ).toThrow("savepoint rollback");
          expect(appendCopy("first-savepoint-copy", "final-savepoint-copy")).toMatchObject(
            nativeResult("final-savepoint-copy"),
          );
        });
      }, options);
    },
    "session.pending-input.stage",
  );

  for (const eventId of ["rolled-back-outer", "rolled-back-savepoint"]) {
    expect(await readTranscript()).not.toContainEqual(expect.objectContaining({ id: eventId }));
  }
  await withWriteAdmission(options, () => {
    expect(() => move("first-savepoint-copy", "stale-savepoint-source")).toThrow("does not match");
    expect(promoteSync(receipt)).toMatchObject({ ok: true, value: { appended: false } });
  });
});

it("rejects a split-cursor replay before and after projection reconciliation", async () => {
  const visible = await append(message("visible", "Visible history"));
  const receipt = await stage("split-cursor");
  await promote(receipt);
  expect(
    appendTranscriptEventSync(scope(), {
      type: "leaf",
      id: "select-visible",
      parentId: receipt.inputId,
      targetId: visible?.messageId ?? null,
      appendParentId: receipt.inputId,
      appendMode: "side",
    }),
  ).toMatchObject({ ok: true, value: true });
  expect(
    appendSync(message("continued", "Continued visible history"), {
      eventId: "continued",
      parentId: receipt.inputId,
    }),
  ).toMatchObject(nativeResult("continued"));

  const replay = () => promoteSync(receipt);
  expect(anchor(receipt.inputId)).toBeUndefined();
  expect(replay).toThrow("no longer active");
  await waitForSessionTranscriptProjection(scope());
  expect(anchor(receipt.inputId)).toBeUndefined();
  expect(replay).toThrow("no longer active");
});

it("promotes a queued input with its own custody after another receipt releases the writer", async () => {
  const first = await stage("writer-first");
  const second = await stage("writer-second");
  const gate = createDeferred();
  const held = first.run(() =>
    runExclusiveSqliteSessionWrite(
      resolveSqliteScope(scope()),
      async () => gate.promise,
      "session.pending-input.stage",
    ),
  );
  const queued = promote(second);
  gate.resolve();
  await held;
  expect(await queued).toMatchObject(appendResult(second.inputId));
  const pendingIds = (await pendingInputs()).items.map((input) => input.id);
  expect(pendingIds).toEqual([first.inputId]);
});

it("rolls aggregate append and every source consumption back as one transaction", async () => {
  const first = await stage("atomic-a");
  const second = await stage("atomic-b");
  const aggregate = bind([first, second], "atomic-c");
  const before = await readTranscript();
  custodyFault.enable(1);
  await expect(promote(aggregate)).rejects.toThrow("collect consume failed");
  expect(await readTranscript()).toEqual(before);
  expect((await pendingInputs()).total).toBe(2);
  expect(
    await listSessionPendingInputReceipts(scope(), { runIds: ["atomic-a", "atomic-b"] }),
  ).toEqual([
    { runId: "atomic-a", state: "pending" },
    { runId: "atomic-b", state: "pending" },
  ]);
  custodyFault.disable();
  expect(await promote(aggregate)).toMatchObject(appendResult(aggregate.inputId));
  expect((await pendingInputs()).total).toBe(0);
});

it("revalidates every collected source after an await and rejects copied receipt fields", async () => {
  const first = await stage("fence-a");
  const second = await stage("fence-b");
  const aggregate = bind([first, second], "fence-c");
  expect(bindSessionPendingInputSources([{ ...first }], message("forged-c"))).toBeUndefined();
  const promotion = aggregate.run(async () => {
    await Promise.resolve();
    first.finish("cancelled");
    return append(aggregate.message);
  });
  await expect(promotion).rejects.toThrow("custody ended");
  await expect(promotion).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
  await first.settled?.();
  expect(await readTranscript()).toEqual([]);
  expect((await pendingInputs()).items.map((input) => input.state)).toEqual([
    "cancelled",
    "queued",
  ]);
});

it("binds lazy recorder collection to approved sources and reports consumed source retry without execution", async () => {
  const target = { ...scope(), sessionEntry: undefined, config: {} };
  const hook = vi.fn(({ message: input }: { message: PersistedUserTurnMessage }) => ({
    ...input,
    content: "Approved source",
  }));
  const source = createUserTurnTranscriptRecorder({
    target,
    message: message("recorder-source", "Original source"),
    beforeMessageWrite: hook,
  });
  expect(await source.stageApproved?.({ runId: "recorder-source", assertCurrent: () => {} })).toBe(
    true,
  );
  const aggregate = createUserTurnTranscriptRecorder({
    target,
    input: { text: "Unresolved collection" },
    resolveInput: async () => {
      const content = (await source.resolveMessage())?.content;
      if (typeof content !== "string") {
        throw new Error("Expected approved text input");
      }
      return {
        text: `Collected: ${content}`,
        idempotencyKey: "recorder-aggregate:user",
        timestamp: 100,
      };
    },
    pendingInputSources: [source],
    beforeMessageWrite: hook,
  });
  try {
    const unstaged = createUserTurnTranscriptRecorder({
      target,
      message: message("unstaged-source"),
    });
    const mixed = createUserTurnTranscriptRecorder({
      target,
      message: message("mixed-aggregate"),
      pendingInputSources: [source, unstaged],
      onPersistenceError: () => {},
    });
    await expect(mixed.persistApproved()).rejects.toThrow("cannot mix staged and unstaged");
    expect(await readTranscript()).toEqual([]);
    expect((await pendingInputs()).total).toBe(1);
    const appended = await aggregate.persistApproved();
    expect(appended).toMatchObject({
      appended: true,
      message: { content: "Collected: Approved source" },
    });
    expect(hook).toHaveBeenCalledOnce();
    expect((await pendingInputs()).total).toBe(0);
    const duplicate = createUserTurnTranscriptRecorder({
      target,
      message: message("recorder-source", "Original source"),
      assertOriginalInputCommit: () => {
        throw new Error("Consumed input no longer belongs to its original source");
      },
    });
    expect(
      await duplicate.stageApproved?.({ runId: "recorder-source", assertCurrent: () => {} }),
    ).toBe(false);
    expect(duplicate.isPendingInputConsumed?.()).toBe(true);
    expect(() =>
      duplicate.withPendingInput?.(() => {
        throw new Error("must not execute");
      }),
    ).toThrow("already been consumed");
  } finally {
    aggregate.finishPendingInput?.("interrupted");
    await aggregate.waitForPendingInputSettlement?.();
  }
});

it.each(["cancelled", "interrupted"] as const)(
  "retains %s input visibly without permitting the old run to execute",
  async (disposition) => {
    const receipt = await stage("closed");
    receipt.finish(disposition);
    await receipt.settled?.();
    expect((await readPending(receipt.inputId))?.state).toBe(disposition);
    expect(() => promote(receipt)).toThrow("ownership ended");
    await expect(stage("closed")).rejects.toThrow("submit a new turn");
    await expect(append(receipt.message)).rejects.toThrow("outside its admitted turn");
    expect(await promote(await stage("new-authorized-run"))).toMatchObject({ appended: true });
  },
);

it("fences authority loss after an await without overriding the owner's terminal disposition", async () => {
  let current = true;
  const receipt = await stage("authority", {
    assertCurrent: () => {
      if (!current) {
        throw new Error("run authority closed");
      }
    },
  });
  await expect(
    receipt.run(async () => {
      await Promise.resolve();
      current = false;
      return append(receipt.message);
    }),
  ).rejects.toThrow("run authority closed");
  await expect(stage("authority")).rejects.toThrow("already admitted");
  expect((await pendingInputs()).items[0]?.state).toBe("queued");
  receipt.finish("cancelled");
  await receipt.settled?.();
  expect((await pendingInputs()).items[0]?.state).toBe("cancelled");
  expect(database().db.prepare("SELECT state FROM session_pending_inputs").get()).toEqual({
    state: "cancelled",
  });
});

it.each(["receipt-entry", "persistence-only"] as const)(
  "retires current-process custody on lifecycle rotation and fences %s after reopening",
  async (entry) => {
    const receipt = await stage("restart");
    rotateAgentEventLifecycleGeneration();
    await receipt.settled?.();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const retained = await readPending(receipt.inputId);
    expect(retained?.state).toBe("interrupted");
    expect(await readTranscript()).toEqual([]);
    if (entry === "receipt-entry") {
      const execute = vi.fn();
      expect(() => receipt.run(execute)).toThrow(SessionPendingInputCustodyError);
      expect(execute).not.toHaveBeenCalled();
      expect(() => promote(receipt)).toThrow("ownership ended");
    } else {
      const promotion = withPersistence(receipt, () => append(receipt.message));
      await expect(promotion).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
      await expect(promotion).rejects.toThrow("outside its admitted turn");
    }
    expect(await readTranscript()).toEqual([]);
    expect(await readPending(receipt.inputId)).toEqual(retained);
  },
);

it("allows terminal mirroring to read a promoted user after cancellation without a new append", async () => {
  const receipt = await stage("terminal-mirror");
  await receipt.run(async () => {
    await append(receipt.message);
    const before = await readTranscript();
    receipt.finish("cancelled");
    expect(await append(receipt.message)).toMatchObject({ appended: false });
    expect(await readTranscript()).toEqual(before);
  });
});

it.each(["deleted", "rebound", "replaced"] as const)(
  "rejects terminal mirroring after the promoted transcript is %s",
  async (change) => {
    const receipt = await stage(`terminal-${change}`);
    await receipt.run(async () => {
      await append(receipt.message);
      if (change === "deleted") {
        await replaceTranscriptEvents(scope(), []);
      } else if (change === "rebound") {
        await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
      } else {
        await replaceTranscriptEvents(scope(), [
          timedMessageEvent("rewritten-user", null, new Date(100).toISOString(), receipt.message),
        ]);
        expect(anchor("rewritten-user")).toMatchObject({
          entryId: "rewritten-user",
        });
      }
      receipt.finish("cancelled");
      const before = await readTranscript();
      await expect(append(receipt.message)).rejects.toThrow(
        change === "deleted"
          ? "custody ended"
          : change === "rebound"
            ? "session changed"
            : "conflicts",
      );
      expect(await readTranscript()).toEqual(before);
    });
  },
);

it.each([false, true])(
  "rejects retained custody on an inactive branch with context exclusion %s",
  async (excludeFromContext) => {
    const receipt = await stage("terminal-off-path", {
      message: {
        ...message("terminal-off-path"),
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
      },
    });
    let replacementId: string;
    await receipt.run(async () => {
      await append(receipt.message);
      const replacement = await append(message("replacement"), { parentId: null });
      replacementId = replacement.messageId;
      expect(replacement.effectiveParentId).toBeNull();
      expect(anchor(receipt.inputId)).toBeUndefined();
      expect(anchor(replacementId)).toBeUndefined();
      receipt.finish("cancelled");
      await expect(append(receipt.message)).rejects.toThrow("no longer active");
    });
    await waitForSessionTranscriptProjection(scope());
    expect(anchor(receipt.inputId)).toBeUndefined();
    expect(anchor(replacementId!)).toMatchObject({
      entryId: replacementId!,
    });
    expect(await append(receipt.message)).toMatchObject({ appended: false });
  },
);

it.each([
  { destination: "same", consumed: false },
  { destination: "other", consumed: false },
  { destination: "other", consumed: true },
] as const)(
  "copies input to $destination agent without reviving custody (consumed: $consumed)",
  async ({ destination, consumed }) => {
    const receipt = await stage("repair");
    let aggregate: SessionPendingInputReceipt | undefined;
    if (consumed) {
      aggregate = bind([receipt], "repair-aggregate");
      await promote(aggregate);
    }
    const source = database();
    const target =
      destination === "same"
        ? { ...scope(), sessionKey: "agent:main:repaired-pending" }
        : {
            agentId: "other",
            sessionKey: "agent:other:repaired-pending",
            sessionId,
            storePath: path.join(path.dirname(source.path), "other-agent.sqlite"),
          };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 2 });
    if (destination === "same") {
      copySessionNodeArtifactsForRepair(source, source, [sessionKey], target.sessionKey);
    } else {
      writeTransaction(
        (destinationDatabase) => {
          const copy = () =>
            copySessionNodeArtifactsForRepair(
              source,
              destinationDatabase,
              [sessionKey],
              target.sessionKey,
            );
          copy();
          copy();
        },
        toDatabaseOptions(resolveSqliteScope(target)),
      );
    }
    expect(await listSessionPendingInputs(target)).toMatchObject(
      destination === "same"
        ? pendingPage([receipt], "interrupted")
        : consumed
          ? { total: 0, items: [] }
          : { total: 1, items: [{ state: "interrupted", message: receipt.message }] },
    );
    if (consumed) {
      const duplicate = await stageSessionPendingInput(target, {
        runId: "repair",
        message: message("repair"),
        assertCurrent: () => {},
      });
      expect(duplicate?.state).toBe("consumed");
      expect(await listSessionPendingInputReceipts(target, { runIds: ["repair"] })).toEqual([
        { runId: "repair", state: "consumed", consumedByEventId: aggregate!.inputId },
      ]);
    }
    await expect(
      receipt.run(() => appendMessage(target, { message: receipt.message })),
    ).rejects.toThrow("outside its admitted turn");
  },
);

it("reconciles reset input without host reads and removes custody on logical deletion that retains transcript windows", async () => {
  const receipt = await stage("reset", {
    message: message("reset", "accepted input ".repeat(4096)),
  });
  const second = await stage("reset-second");
  expect((await pendingInputs()).items.map((input) => input.state)).toEqual(["queued", "queued"]);
  await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
  await expect(promote(receipt)).rejects.toThrow("session changed");
  const storedBefore = storedInputs();
  expect(storedBefore.map((row) => row.state)).toEqual(["queued", "queued"]);
  const counter = trackPendingReads();
  try {
    expect(await pendingInputs()).toMatchObject(pendingPage([receipt, second], "interrupted"));
    expect(counter).toMatchObject({ counts: { pending: 0 }, textBytes: { pending: 0 } });
  } finally {
    counter.restore();
  }
  expect(storedInputs()).toEqual(
    storedBefore.map((row) => Object.assign({}, row, { state: "interrupted" })),
  );
  await deleteSessionEntryLifecycle({
    archiveTranscript: false,
    storePath: fixture.storePath(),
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
  });
  expect(await pendingInputs()).toEqual({ items: [], total: 0 });
  expect(
    database().db.prepare("SELECT count(*) AS total FROM session_pending_inputs").get(),
  ).toEqual({ total: 0 });
});

it("reads retained inputs off-thread and paginates with stable cursors while another input is promoted", async () => {
  const first = await stage("first");
  const second = await stage("second");
  const third = await stage("third");
  const storedBefore = storedInputs();
  const counter = trackPendingReads();
  try {
    expect(await readPending(first.inputId)).toMatchObject({
      id: first.inputId,
      runId: "first",
      state: "queued",
      message: first.message,
    });
    expect(await readPending("missing-input")).toBeUndefined();
    expect(
      await readSessionPendingInput({ ...scope(), sessionId: "other-session" }, first.inputId),
    ).toBeUndefined();
    expect(counter).toMatchObject({ counts: { pending: 0 }, rowCounts: { pending: 0 } });
  } finally {
    counter.restore();
  }
  expect(storedInputs()).toEqual(storedBefore);
  const page = await pendingInputs({ limit: 2 });
  expect(page.items.map((input) => input.id)).toEqual([second.inputId, third.inputId]);
  expect(page.total).toBe(3);
  expect(page.nextBefore).toBeDefined();
  await promote(third);
  const older = await pendingInputs({ limit: 2, before: page.nextBefore });
  expect(older.items.map((input) => input.id)).toEqual([first.inputId]);
  for (const idempotencyKey of ["first:user", "third:user"]) {
    expect(
      await readSessionSubmittedInput({ ...scope(), sessionId: "other-session" }, idempotencyKey),
    ).toBeUndefined();
    expect(
      await readSessionSubmittedInput(
        { ...scope(), sessionKey: "agent:main:other" },
        idempotencyKey,
      ),
    ).toBeUndefined();
  }
});
