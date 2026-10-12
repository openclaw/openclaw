import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  readActiveTranscriptEntryAnchor,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { listSessionPendingInputReceipts } from "./session-accessor.sqlite-pending-input-receipts.js";
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
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { useTempSessionsFixture } from "./test-helpers.js";

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

describe("accepted input custody", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-");
  const sessionKey = "agent:main:pending-inputs";
  const sessionId = "pending-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
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
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));
  const createRelocation =
    (receipt: SessionPendingInputReceipt) => (sourceInputId: string, eventId: string) =>
      withSessionPendingInputRelocation(sourceInputId, receipt.message, () =>
        appendTranscriptMessageSync(scope(), {
          eventId,
          idempotencyLookup: "caller-checked",
          message: receipt.message,
          parentId: null,
        }),
      );

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    const retained = receipts.splice(0);
    for (const receipt of retained) {
      receipt.finish("interrupted");
    }
    await Promise.allSettled(retained.map(async (receipt) => receipt.settled?.()));
    closeOpenClawAgentDatabasesForTest();
  });

  it("keeps accepted input outside the active transcript and applies its hook once across replay and promotion", async () => {
    await appendTranscriptMessage(scope(), { message: message("active", "First task") });
    expect(await readSessionSubmittedInput(scope(), "active:user")).toEqual(
      message("active", "First task"),
    );
    const before = await loadTranscriptEvents(scope());
    const prepare = vi.fn((input: PersistedUserTurnMessage) => ({
      ...input,
      content: typeof input.content === "string" ? `${input.content} (approved)` : input.content,
    }));
    const receipt = await stage("queued", { prepareMessageAfterIdempotencyCheck: prepare });
    expect(await readSessionSubmittedInput(scope(), "queued:user")).toEqual(receipt.message);
    await expect(
      stage("queued", {
        message: { ...message("queued"), timestamp: 200 },
        prepareMessageAfterIdempotencyCheck: prepare,
      }),
    ).rejects.toThrow("already admitted");
    expect(prepare).toHaveBeenCalledOnce();
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect(await listSessionPendingInputs(scope())).toMatchObject({
      total: 1,
      items: [{ id: receipt.inputId, state: "queued", message: receipt.message }],
    });
    await expect(stage("queued", { message: message("queued", "Changed input") })).rejects.toThrow(
      "conflicts",
    );
    await expect(appendTranscriptMessage(scope(), { message: receipt.message })).rejects.toThrow(
      "outside its admitted turn",
    );
    const secondHook = vi.fn(() => undefined);
    const appended = await receipt.run(() =>
      appendTranscriptMessage(scope(), {
        message: receipt.message,
        prepareMessageAfterIdempotencyCheck: secondHook,
      }),
    );
    expect(secondHook).not.toHaveBeenCalled();
    expect(appended).toMatchObject({
      appended: true,
      messageId: receipt.inputId,
      message: receipt.message,
    });
    expect(await listSessionPendingInputs(scope())).toEqual({ total: 0, items: [] });
    expect(await readSessionSubmittedInput(scope(), "queued:user")).toEqual(receipt.message);
    const committedReplay = await stage("queued", { prepareMessageAfterIdempotencyCheck: prepare });
    expect(committedReplay.message).toEqual(receipt.message);
    expect(prepare).toHaveBeenCalledOnce();
    receipt.finish("interrupted");
    expect(() => receipt.run(() => {})).toThrow("ownership ended");
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
    const pending = await listSessionPendingInputs(scope());
    const sourceTranscript = await loadTranscriptEvents(scope());
    const mirrored = await receipt.run(() =>
      appendTranscriptMessage(target, { message: receipt.message }),
    );
    expect(mirrored).toMatchObject({ appended: true, message: receipt.message });
    expect(mirrored?.messageId).not.toBe(receipt.inputId);
    expect(await listSessionPendingInputs(scope())).toEqual(pending);
    expect(await loadTranscriptEvents(scope())).toEqual(sourceTranscript);
    expect(await readSessionSubmittedInput(target, "bound-mirror:user")).toEqual(receipt.message);
    await expect(appendTranscriptMessage(scope(), { message: receipt.message })).rejects.toThrow(
      "outside its admitted turn",
    );

    expect(await promote(receipt)).toMatchObject({ appended: true, messageId: receipt.inputId });
    expect(await listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    const targetTranscript = await loadTranscriptEvents(target);
    expect(
      await receipt.run(() => appendTranscriptMessage(target, { message: receipt.message })),
    ).toMatchObject({ appended: false, messageId: mirrored?.messageId });
    expect(await loadTranscriptEvents(target)).toEqual(targetTranscript);
  });

  it.each(["interrupted", "collected-consumed"] as const)(
    "preserves request-bound receipts across legacy-hash rejection and re-upgrade (%s)",
    async (disposition) => {
      const runId = "versioned-input";
      const requestFingerprint = "f".repeat(64);
      const receipt = await stage(runId, { requestFingerprint });
      if (disposition === "collected-consumed") {
        const aggregate = bindSessionPendingInputSources([receipt], message("versioned-collect"))!;
        receipts.push(aggregate);
        await promote(aggregate);
      }
      receipt.finish("interrupted");
      await receipt.settled?.();
      rotateAgentEventLifecycleGeneration();
      const readStoredSource = () =>
        database()
          .db.prepare("SELECT * FROM session_pending_inputs WHERE input_id = ?")
          .get(receipt.inputId);
      const storedSource = readStoredSource();
      expect(storedSource).toMatchObject({
        request_hash: `request:${requestFingerprint}`,
        consumed_event_id: disposition === "collected-consumed" ? expect.any(String) : null,
      });
      const transcript = await loadTranscriptEvents(scope());
      const prepare = vi.fn((input: PersistedUserTurnMessage) => input);
      const execute = vi.fn();
      // v2026.9.2 always computes this unprefixed message hash and compares it
      // before consumed-receipt handling. No legacy execution owner is minted.
      await expect(stage(runId, { prepareMessageAfterIdempotencyCheck: prepare })).rejects.toThrow(
        "idempotency key conflicts",
      );
      expect(() => receipt.run(execute)).toThrow();
      expect(readStoredSource()).toEqual(storedSource);
      expect(await loadTranscriptEvents(scope())).toEqual(transcript);
      expect((await listSessionPendingInputs(scope())).total).toBe(
        disposition === "interrupted" ? 1 : 0,
      );

      const renewed = await stage(runId, {
        requestFingerprint,
        prepareMessageAfterIdempotencyCheck: prepare,
      });
      expect(renewed.inputId).toBe(receipt.inputId);
      expect(renewed.message).toEqual(receipt.message);
      expect(prepare).not.toHaveBeenCalled();
      if (disposition === "collected-consumed") {
        expect(renewed.state).toBe("consumed");
        expect(() => renewed.run(execute)).toThrow("already been consumed");
        expect(readStoredSource()).toEqual(storedSource);
        expect(await loadTranscriptEvents(scope())).toEqual(transcript);
      } else {
        expect(renewed.state).toBe("queued");
        const appended = await renewed.run(async () => {
          execute();
          return appendTranscriptMessage(scope(), { message: renewed.message });
        });
        expect(appended).toMatchObject({
          appended: true,
          messageId: receipt.inputId,
          message: receipt.message,
        });
        const committed = await loadTranscriptEvents(scope());
        expect(
          committed.filter(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "type" in event &&
              event.type === "message",
          ),
        ).toEqual([expect.objectContaining({ id: receipt.inputId, message: receipt.message })]);
        expect(await promote(renewed)).toMatchObject({
          appended: false,
          messageId: receipt.inputId,
        });
        expect(await loadTranscriptEvents(scope())).toEqual(committed);
      }
      expect(execute).toHaveBeenCalledTimes(disposition === "interrupted" ? 1 : 0);
      expect(await listSessionPendingInputs(scope())).toEqual({ total: 0, items: [] });
    },
  );

  it("rolls transcript promotion and custody consumption back together", async () => {
    const receipt = await stage("atomic");
    const before = await loadTranscriptEvents(scope());
    custodyFault.enable();
    await expect(promote(receipt)).rejects.toThrow("consume failed");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect((await readSessionPendingInput(scope(), receipt.inputId))?.state).toBe("queued");
    custodyFault.disable();
    expect(await promote(receipt)).toMatchObject({ appended: true, messageId: receipt.inputId });
    expect(await readSessionPendingInput(scope(), receipt.inputId)).toBeUndefined();
  });

  it("moves transcript custody only after an authorized relocation commits", async () => {
    const receipt = await stage("relocation");
    await promote(receipt);
    const appendCopy = createRelocation(receipt);

    expect(
      receipt.run(() =>
        appendTranscriptMessageSync(scope(), {
          eventId: "unauthorized-copy",
          idempotencyLookup: "caller-checked",
          message: receipt.message,
        }),
      ),
    ).toMatchObject({ ok: true, value: { appended: false, messageId: receipt.inputId } });

    await runOpenClawAgentWriteAdmission(toDatabaseOptions(resolveSqliteScope(scope())), () => {
      database().db.exec(
        "CREATE TRIGGER reject_relocation BEFORE INSERT ON transcript_events WHEN NEW.event_json LIKE '%relocation-copy%' BEGIN SELECT RAISE(ABORT, 'relocation failed'); END",
      );
    });
    expect(() => receipt.run(() => appendCopy(receipt.inputId, "relocation-copy"))).toThrow(
      "relocation failed",
    );
    await runOpenClawAgentWriteAdmission(toDatabaseOptions(resolveSqliteScope(scope())), () => {
      database().db.exec("DROP TRIGGER reject_relocation");
    });
    expect(
      await receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message })),
    ).toMatchObject({ appended: false, messageId: receipt.inputId });

    expect(receipt.run(() => appendCopy(receipt.inputId, "relocated-user"))).toMatchObject({
      ok: true,
      value: { appended: true, messageId: "relocated-user" },
    });
    expect(() => receipt.run(() => appendCopy(receipt.inputId, "stale-source-copy"))).toThrow(
      "does not match",
    );
    receipt.finish("cancelled");
    expect(appendCopy("relocated-user", "closed-owner-copy")).toMatchObject({
      ok: true,
      value: { appended: true, messageId: "closed-owner-copy" },
    });
    await expect(
      withSessionPendingInputPersistence(receipt, () =>
        appendTranscriptMessage(scope(), { message: receipt.message }),
      ),
    ).rejects.toThrow("conflicts with the admitted message");
  });

  it("publishes committed relocation before fallible post-commit observers", async () => {
    const receipt = await stage("relocation-observer");
    await promote(receipt);
    const appendCopy = createRelocation(receipt);
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      errorLog.mockRestore();
      resetLogger();
    });

    expect(() =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          deferOpenClawAgentPostCommitPublication(current, () => {
            throw new Error("injected observer failure");
          });
          receipt.run(() => appendCopy(receipt.inputId, "relocated-before-observer"));
        },
        toDatabaseOptions(resolveSqliteScope(scope())),
      ),
    ).not.toThrow();
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("SQLite post-commit notification failed"),
    );

    expect(() =>
      receipt.run(() => appendCopy(receipt.inputId, "stale-source-after-observer")),
    ).toThrow("does not match");
    expect(
      receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
    ).toMatchObject({ ok: true, value: { appended: false } });
  });

  it("stages repeated relocation through savepoints and restores it on rollback", async () => {
    const receipt = await stage("relocation-savepoints");
    await promote(receipt);
    const databaseOptions = toDatabaseOptions(resolveSqliteScope(scope()));
    const appendCopy = createRelocation(receipt);

    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        receipt.run(() => appendCopy(receipt.inputId, "rolled-back-outer"));
        throw new Error("outer rollback");
      }, databaseOptions),
    ).toThrow("outer rollback");

    runOpenClawAgentWriteTransaction(() => {
      receipt.run(() => {
        expect(appendCopy(receipt.inputId, "first-savepoint-copy")).toMatchObject({
          ok: true,
          value: { appended: true, messageId: "first-savepoint-copy" },
        });
        expect(() =>
          runOpenClawAgentWriteTransaction(() => {
            appendCopy("first-savepoint-copy", "rolled-back-savepoint");
            throw new Error("savepoint rollback");
          }, databaseOptions),
        ).toThrow("savepoint rollback");
        expect(appendCopy("first-savepoint-copy", "final-savepoint-copy")).toMatchObject({
          ok: true,
          value: { appended: true, messageId: "final-savepoint-copy" },
        });
      });
    }, databaseOptions);

    for (const eventId of ["rolled-back-outer", "rolled-back-savepoint"]) {
      expect(await loadTranscriptEvents(scope())).not.toContainEqual(
        expect.objectContaining({ id: eventId }),
      );
    }
    expect(() =>
      receipt.run(() => appendCopy("first-savepoint-copy", "stale-savepoint-source")),
    ).toThrow("does not match");
    expect(
      receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
    ).toMatchObject({ ok: true, value: { appended: false } });
  });

  it("rejects a split-cursor replay before and after projection reconciliation", async () => {
    const visible = await appendTranscriptMessage(scope(), {
      message: message("visible", "Visible history"),
    });
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
      appendTranscriptMessageSync(scope(), {
        eventId: "continued",
        message: message("continued", "Continued visible history"),
        parentId: receipt.inputId,
      }),
    ).toMatchObject({ ok: true, value: { appended: true, messageId: "continued" } });

    const replay = () =>
      receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message }));
    expect(
      readActiveTranscriptEntryAnchor({ ...scope(), entryId: receipt.inputId }),
    ).toBeUndefined();
    expect(replay).toThrow("no longer active");
    await waitForSessionTranscriptProjection(scope());
    expect(
      readActiveTranscriptEntryAnchor({ ...scope(), entryId: receipt.inputId }),
    ).toBeUndefined();
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
    expect(await queued).toMatchObject({ appended: true, messageId: second.inputId });
    const pendingIds = (await listSessionPendingInputs(scope())).items.map((input) => input.id);
    expect(pendingIds).toEqual([first.inputId]);
  });

  it("rolls aggregate append and every source consumption back as one transaction", async () => {
    const first = await stage("atomic-a");
    const second = await stage("atomic-b");
    const aggregate = bindSessionPendingInputSources([first, second], message("atomic-c"))!;
    receipts.push(aggregate);
    const before = await loadTranscriptEvents(scope());
    custodyFault.enable(1);
    await expect(promote(aggregate)).rejects.toThrow("collect consume failed");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect((await listSessionPendingInputs(scope())).total).toBe(2);
    expect(listSessionPendingInputReceipts(scope(), { runIds: ["atomic-a", "atomic-b"] })).toEqual([
      { runId: "atomic-a", state: "pending" },
      { runId: "atomic-b", state: "pending" },
    ]);
    custodyFault.disable();
    expect(await promote(aggregate)).toMatchObject({
      appended: true,
      messageId: aggregate.inputId,
    });
    expect((await listSessionPendingInputs(scope())).total).toBe(0);
  });

  it("revalidates every collected source after an await and rejects copied receipt fields", async () => {
    const first = await stage("fence-a");
    const second = await stage("fence-b");
    const aggregate = bindSessionPendingInputSources([first, second], message("fence-c"))!;
    receipts.push(aggregate);
    expect(bindSessionPendingInputSources([{ ...first }], message("forged-c"))).toBeUndefined();
    const promotion = aggregate.run(async () => {
      await Promise.resolve();
      first.finish("cancelled");
      return appendTranscriptMessage(scope(), { message: aggregate.message });
    });
    await expect(promotion).rejects.toThrow("custody ended");
    await expect(promotion).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
    await first.settled?.();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect((await listSessionPendingInputs(scope())).items.map((input) => input.state)).toEqual([
      "cancelled",
      "queued",
    ]);
  });

  it("binds lazy recorder collection to approved sources and reports consumed source retry without execution", async () => {
    const target = { ...scope(), sessionEntry: undefined };
    const hook = vi.fn(({ message: input }: { message: PersistedUserTurnMessage }) => ({
      ...input,
      content: "Approved source",
    }));
    const source = createUserTurnTranscriptRecorder({
      target,
      message: message("recorder-source", "Original source"),
      beforeMessageWrite: hook,
    });
    expect(
      await source.stageApproved?.({ runId: "recorder-source", assertCurrent: () => {} }),
    ).toBe(true);
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
      expect(await loadTranscriptEvents(scope())).toEqual([]);
      expect((await listSessionPendingInputs(scope())).total).toBe(1);
      const appended = await aggregate.persistApproved();
      expect(appended).toMatchObject({
        appended: true,
        message: { content: "Collected: Approved source" },
      });
      expect(hook).toHaveBeenCalledOnce();
      expect((await listSessionPendingInputs(scope())).total).toBe(0);
      const duplicate = createUserTurnTranscriptRecorder({
        target,
        message: message("recorder-source", "Original source"),
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
      expect((await readSessionPendingInput(scope(), receipt.inputId))?.state).toBe(disposition);
      expect(() => promote(receipt)).toThrow("ownership ended");
      await expect(stage("closed")).rejects.toThrow("submit a new turn");
      await expect(appendTranscriptMessage(scope(), { message: receipt.message })).rejects.toThrow(
        "outside its admitted turn",
      );
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
        return appendTranscriptMessage(scope(), { message: receipt.message });
      }),
    ).rejects.toThrow("run authority closed");
    await expect(stage("authority")).rejects.toThrow("already admitted");
    expect((await listSessionPendingInputs(scope())).items[0]?.state).toBe("queued");
    receipt.finish("cancelled");
    await receipt.settled?.();
    expect((await listSessionPendingInputs(scope())).items[0]?.state).toBe("cancelled");
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
      const retained = await readSessionPendingInput(scope(), receipt.inputId);
      expect(retained?.state).toBe("interrupted");
      expect(await loadTranscriptEvents(scope())).toEqual([]);
      if (entry === "receipt-entry") {
        const execute = vi.fn();
        expect(() => receipt.run(execute)).toThrow(SessionPendingInputCustodyError);
        expect(execute).not.toHaveBeenCalled();
        expect(() => promote(receipt)).toThrow("ownership ended");
      } else {
        const promotion = withSessionPendingInputPersistence(receipt, () =>
          appendTranscriptMessage(scope(), { message: receipt.message }),
        );
        await expect(promotion).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
        await expect(promotion).rejects.toThrow("outside its admitted turn");
      }
      expect(await loadTranscriptEvents(scope())).toEqual([]);
      expect(await readSessionPendingInput(scope(), receipt.inputId)).toEqual(retained);
    },
  );

  it("allows terminal mirroring to read a promoted user after cancellation without a new append", async () => {
    const receipt = await stage("terminal-mirror");
    await receipt.run(async () => {
      await appendTranscriptMessage(scope(), { message: receipt.message });
      const before = await loadTranscriptEvents(scope());
      receipt.finish("cancelled");
      expect(await appendTranscriptMessage(scope(), { message: receipt.message })).toMatchObject({
        appended: false,
      });
      expect(await loadTranscriptEvents(scope())).toEqual(before);
    });
  });

  it.each(["deleted", "rebound", "replaced"] as const)(
    "rejects terminal mirroring after the promoted transcript is %s",
    async (change) => {
      const receipt = await stage(`terminal-${change}`);
      await receipt.run(async () => {
        await appendTranscriptMessage(scope(), { message: receipt.message });
        if (change === "deleted") {
          await replaceTranscriptEvents(scope(), []);
        } else if (change === "rebound") {
          await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
        } else {
          await replaceTranscriptEvents(scope(), [
            {
              type: "message",
              id: "rewritten-user",
              parentId: null,
              timestamp: new Date(100).toISOString(),
              message: receipt.message,
            },
          ]);
          expect(
            readActiveTranscriptEntryAnchor({ ...scope(), entryId: "rewritten-user" }),
          ).toMatchObject({ entryId: "rewritten-user" });
        }
        receipt.finish("cancelled");
        const before = await loadTranscriptEvents(scope());
        await expect(
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ).rejects.toThrow(
          change === "deleted"
            ? "custody ended"
            : change === "rebound"
              ? "session changed"
              : "conflicts",
        );
        expect(await loadTranscriptEvents(scope())).toEqual(before);
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
        await appendTranscriptMessage(scope(), { message: receipt.message });
        const replacement = await appendTranscriptMessage(scope(), {
          message: message("replacement"),
          parentId: null,
        });
        replacementId = replacement.messageId;
        expect(replacement.effectiveParentId).toBeNull();
        expect(
          readActiveTranscriptEntryAnchor({ ...scope(), entryId: receipt.inputId }),
        ).toBeUndefined();
        expect(
          readActiveTranscriptEntryAnchor({ ...scope(), entryId: replacementId }),
        ).toBeUndefined();
        receipt.finish("cancelled");
        await expect(
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ).rejects.toThrow("no longer active");
      });
      await waitForSessionTranscriptProjection(scope());
      expect(
        readActiveTranscriptEntryAnchor({ ...scope(), entryId: receipt.inputId }),
      ).toBeUndefined();
      expect(
        readActiveTranscriptEntryAnchor({ ...scope(), entryId: replacementId! }),
      ).toMatchObject({
        entryId: replacementId!,
      });
      expect(await appendTranscriptMessage(scope(), { message: receipt.message })).toMatchObject({
        appended: false,
      });
    },
  );

  it("retains repaired pending input as interrupted and never transfers live custody", async () => {
    const receipt = await stage("repair");
    const canonical = "agent:main:repaired-pending";
    await upsertSessionEntryCore(
      { ...scope(), sessionKey: canonical },
      { sessionId, updatedAt: 2 },
    );
    const current = database();
    copySessionNodeArtifactsForRepair(current, current, [sessionKey], canonical);
    expect(await listSessionPendingInputs({ ...scope(), sessionKey: canonical })).toMatchObject({
      total: 1,
      items: [{ id: receipt.inputId, state: "interrupted", message: receipt.message }],
    });
    await expect(
      receipt.run(() =>
        appendTranscriptMessage(
          { ...scope(), sessionKey: canonical },
          { message: receipt.message },
        ),
      ),
    ).rejects.toThrow("outside its admitted turn");
  });

  it.each([false, true])(
    "copies accepted input across agent stores without reviving custody (consumed: %s)",
    async (consumed) => {
      const receipt = await stage("cross-agent");
      let aggregate: SessionPendingInputReceipt | undefined;
      if (consumed) {
        aggregate = bindSessionPendingInputSources([receipt], message("cross-agent-aggregate"))!;
        receipts.push(aggregate);
        await promote(aggregate);
      }
      const source = database();
      const destinationScope = {
        agentId: "other",
        sessionKey: "agent:other:repaired-pending",
        sessionId,
        storePath: path.join(path.dirname(source.path), "other-agent.sqlite"),
      };
      await upsertSessionEntryCore(destinationScope, { sessionId, updatedAt: 2 });
      const destinationOptions = toDatabaseOptions(resolveSqliteScope(destinationScope));
      runOpenClawAgentWriteTransaction((destination) => {
        copySessionNodeArtifactsForRepair(
          source,
          destination,
          [sessionKey],
          destinationScope.sessionKey,
        );
        copySessionNodeArtifactsForRepair(
          source,
          destination,
          [sessionKey],
          destinationScope.sessionKey,
        );
      }, destinationOptions);
      expect(await listSessionPendingInputs(destinationScope)).toMatchObject(
        consumed
          ? { total: 0, items: [] }
          : {
              total: 1,
              items: [{ state: "interrupted", message: receipt.message }],
            },
      );
      if (consumed) {
        const duplicate = await stageSessionPendingInput(destinationScope, {
          runId: "cross-agent",
          message: message("cross-agent"),
          assertCurrent: () => {},
        });
        expect(duplicate?.state).toBe("consumed");
        expect(
          listSessionPendingInputReceipts(destinationScope, { runIds: ["cross-agent"] }),
        ).toEqual([
          {
            runId: "cross-agent",
            state: "consumed",
            consumedByEventId: aggregate!.inputId,
          },
        ]);
      }
      await expect(
        receipt.run(() => appendTranscriptMessage(destinationScope, { message: receipt.message })),
      ).rejects.toThrow("outside its admitted turn");
    },
  );

  it("reconciles reset input without host reads and removes custody on logical deletion that retains transcript windows", async () => {
    const receipt = await stage("reset", {
      message: message("reset", "accepted input ".repeat(4096)),
    });
    const second = await stage("reset-second");
    expect((await listSessionPendingInputs(scope())).items.map((input) => input.state)).toEqual([
      "queued",
      "queued",
    ]);
    await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
    await expect(promote(receipt)).rejects.toThrow("session changed");
    const current = database();
    const storedBefore = current.db
      .prepare("SELECT * FROM session_pending_inputs ORDER BY seq")
      .all();
    expect(storedBefore.map((row) => row.state)).toEqual(["queued", "queued"]);
    const counter = trackSqliteStatementExecutions(current.db, ["pending"], (sqlText) =>
      sqlText.startsWith("select ") && sqlText.includes('from "session_pending_inputs"')
        ? "pending"
        : null,
    );
    try {
      expect(await listSessionPendingInputs(scope())).toMatchObject({
        total: 2,
        items: [
          { id: receipt.inputId, state: "interrupted", message: receipt.message },
          { id: second.inputId, state: "interrupted", message: second.message },
        ],
      });
      expect(counter.counts.pending).toBe(0);
      expect(counter.textBytes.pending).toBe(0);
    } finally {
      counter.restore();
    }
    expect(current.db.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all()).toEqual(
      storedBefore.map((row) => Object.assign({}, row, { state: "interrupted" })),
    );
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath: fixture.storePath(),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(await listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(
      database().db.prepare("SELECT count(*) AS total FROM session_pending_inputs").get(),
    ).toEqual({ total: 0 });
  });

  it("reads retained inputs off-thread and paginates with stable cursors while another input is promoted", async () => {
    const first = await stage("first");
    const second = await stage("second");
    const third = await stage("third");
    const current = database();
    const storedBefore = current.db
      .prepare("SELECT * FROM session_pending_inputs ORDER BY seq")
      .all();
    const counter = trackSqliteStatementExecutions(current.db, ["pending"], (sqlText) =>
      sqlText.startsWith("select ") && sqlText.includes('from "session_pending_inputs"')
        ? "pending"
        : null,
    );
    try {
      expect(await readSessionPendingInput(scope(), first.inputId)).toMatchObject({
        id: first.inputId,
        runId: "first",
        state: "queued",
        message: first.message,
      });
      expect(await readSessionPendingInput(scope(), "missing-input")).toBeUndefined();
      expect(
        await readSessionPendingInput({ ...scope(), sessionId: "other-session" }, first.inputId),
      ).toBeUndefined();
      expect(counter.counts.pending).toBe(0);
      expect(counter.rowCounts.pending).toBe(0);
    } finally {
      counter.restore();
    }
    expect(current.db.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all()).toEqual(
      storedBefore,
    );
    const page = await listSessionPendingInputs(scope(), { limit: 2 });
    expect(page.items.map((input) => input.id)).toEqual([second.inputId, third.inputId]);
    expect(page.total).toBe(3);
    expect(page.nextBefore).toBeDefined();
    await promote(third);
    const older = await listSessionPendingInputs(scope(), { limit: 2, before: page.nextBefore });
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
});
