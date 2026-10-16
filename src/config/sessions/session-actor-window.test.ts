import { expect, it, vi } from "vitest";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  canRebasePreparedAssistantInTransaction,
  isTranscriptEntryOnActivePathInTransaction,
  readTranscriptVisibleTailEntryIdInTransaction,
  resolveTranscriptMessageAppendParent,
} from "./session-accessor.sqlite-transcript-parent.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionActorTarget } from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { hydrateSessionActorState } from "./session-actor-hydration.worker.js";
import { createSessionActorResidency } from "./session-actor-residency.worker.js";
import {
  forkSessionActorStoredState,
  withSessionActorTransactionState,
} from "./session-actor-transaction.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";

// mock-isolation: Owner transactions do not exercise background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget eviction is independent of historical append lookup.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

function hydrateActor(f: ReturnType<typeof createSessionCompoundWorkerFixture>) {
  const identity = readOpenClawAgentDatabaseIdentity(f.database);
  if (typeof identity.identity !== "string") {
    throw new Error("Actor window proof requires a physical database");
  }
  const target: SessionActorTarget = {
    sessionKey: f.scope.sessionKey,
    database: {
      kind: "file",
      physicalIdentity: identity.identity,
      birthtime: identity.birthtime,
      nativeLocation: f.database.path,
    },
  };
  return hydrateSessionActorState(f.database, target, { epoch: "window", sequence: 0 }, "");
}

it("preserves historical replay and branch ancestry outside the actor's retained window", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const { database } = f;
    const scope = { ...f.scope, path: database.path };
    const options = { agentId: database.agentId, path: database.path };
    const originalMessage = { role: "user", content: "first", idempotencyKey: "first-once" };
    const write = <T>(run: () => T) => runOpenClawAgentWriteTransaction(run, options);
    write(() => {
      appendTranscriptEventsInTransaction(
        database,
        scope,
        [
          { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
          { type: "message", id: "first", parentId: null, message: originalMessage },
          {
            type: "message",
            id: "answer",
            parentId: "first",
            message: { role: "assistant", content: "answer" },
          },
          {
            type: "message",
            id: "second",
            parentId: "answer",
            message: { role: "user", content: "second" },
          },
          ...Array.from({ length: 520 }, (_, index) => ({
            type: "custom",
            id: `side-${index}`,
            parentId: index === 0 ? "second" : `side-${index - 1}`,
            appendMode: "side",
            data: { synthetic: true },
          })),
        ],
        { scheduleProjectionReconcile: false },
      );
      reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId);
    });
    const state = hydrateActor(f);
    expect(state.transcript.complete).toBe(false);
    expect(state.transcript.identities.has("first")).toBe(false);
    write(() =>
      withSessionActorTransactionState(database, state, () => {
        expect(
          resolveTranscriptMessageAppendParent(database, scope.sessionId, {
            appendIntent: "active-branch",
            parentId: "first",
          }),
        ).toBe("side-519");
        expect(
          readTranscriptVisibleTailEntryIdInTransaction(database, scope.sessionId, "first"),
        ).toBe("second");
        expect(isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "first")).toBe(
          true,
        );
        expect(canRebasePreparedAssistantInTransaction(database, scope.sessionId, "first")).toBe(
          false,
        );
        expect(canRebasePreparedAssistantInTransaction(database, scope.sessionId, "second")).toBe(
          true,
        );
        expect(
          appendTranscriptMessageInTransaction(database, scope, {
            message: originalMessage,
            eventId: "must-not-append",
          })?.result,
        ).toMatchObject({
          appended: false,
          messageId: "first",
          message: originalMessage,
          anchor: { entryId: "first", effectiveParentId: null },
        });

        appendTranscriptEventsInTransaction(database, scope, [
          {
            type: "leaf",
            id: "historical-branch",
            parentId: "side-519",
            targetId: "first",
            appendParentId: "answer",
          },
        ]);
        expect(resolveTranscriptMessageAppendParent(database, scope.sessionId, {})).toBe("answer");
        expect(
          readTranscriptVisibleTailEntryIdInTransaction(database, scope.sessionId, "first"),
        ).toBe("first");
        expect(
          appendTranscriptMessageInTransaction(database, scope, {
            message: {
              role: "assistant",
              content: "continued branch",
              idempotencyKey: "next-once",
            },
            eventId: "next",
          })?.result,
        ).toMatchObject({ appended: true, messageId: "next", effectiveParentId: "answer" });
        expect(resolveTranscriptMessageAppendParent(database, scope.sessionId, {})).toBe("next");
        expect(
          appendTranscriptMessageInTransaction(database, scope, {
            message: {
              role: "assistant",
              content: "continued branch",
              idempotencyKey: "next-once",
            },
            eventId: "also-must-not-append",
          })?.result,
        ).toMatchObject({ appended: false, messageId: "next" });
      }),
    );
    const events = f.events();
    expect(events).toHaveLength(526);
    expect(events.at(-1)).toMatchObject({ id: "next", parentId: "answer" });
  });
});

it("keeps partial actor appends after a reset when a leaf targets older history", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const { database } = f;
    const scope = { ...f.scope, path: database.path };
    const options = { agentId: database.agentId, path: database.path };
    const write = <T>(run: () => T) => runOpenClawAgentWriteTransaction(run, options);
    write(() => {
      appendTranscriptEventsInTransaction(
        database,
        scope,
        [
          { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
          {
            type: "message",
            id: "before-reset",
            parentId: null,
            message: { role: "user", content: "old question" },
          },
          { type: "reset", id: "reset", parentId: "before-reset" },
          {
            type: "message",
            id: "after-reset",
            parentId: "reset",
            message: { role: "user", content: "current question" },
          },
          ...Array.from({ length: 520 }, (_, index) => ({
            type: "custom",
            id: `side-${index}`,
            parentId: index === 0 ? "after-reset" : `side-${index - 1}`,
            appendMode: "side",
          })),
          {
            type: "leaf",
            id: "stale-leaf",
            parentId: "side-519",
            targetId: "before-reset",
          },
        ],
        { scheduleProjectionReconcile: false },
      );
      reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId);
    });
    const state = hydrateActor(f);
    expect(state.transcript.complete).toBe(false);
    write(() =>
      withSessionActorTransactionState(database, state, () => {
        expect(resolveTranscriptMessageAppendParent(database, scope.sessionId, {})).toBe(
          "after-reset",
        );
        expect(
          appendTranscriptMessageInTransaction(database, scope, {
            eventId: "continued",
            message: { role: "assistant", content: "current answer" },
          })?.result,
        ).toMatchObject({ appended: true, effectiveParentId: "after-reset" });
      }),
    );
    expect(f.events().at(-1)).toMatchObject({ id: "continued", parentId: "after-reset" });
  });
});

it("bounds committed actor growth across the window limit without retaining rolled-back events", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const { database } = f;
    const scope = { ...f.scope, path: database.path };
    const options = { agentId: database.agentId, path: database.path };
    const write = <T>(run: () => T) => runOpenClawAgentWriteTransaction(run, options);
    const originalMessage = { role: "assistant", content: "first", idempotencyKey: "first-once" };
    write(() =>
      appendTranscriptEventsInTransaction(database, scope, [
        { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
        ...Array.from({ length: 511 }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          message: index === 0 ? originalMessage : { role: "assistant", content: "synthetic" },
        })),
      ]),
    );
    const resident = hydrateActor(f);
    expect(resident.transcript.complete).toBe(true);
    const residency = createSessionActorResidency();
    residency.remember(resident);
    const append = (state: SessionActorStoredState) =>
      withSessionActorTransactionState(database, state, () => {
        for (const eventId of ["next-one", "next-two"]) {
          expect(
            appendTranscriptMessageInTransaction(database, scope, {
              eventId,
              message: { role: "assistant", content: eventId },
            })?.result.appended,
          ).toBe(true);
        }
      });
    expect(() =>
      write(() => {
        append(forkSessionActorStoredState(resident));
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    expect(residency.get(scope.sessionKey)).toBe(resident);
    expect(resident.transcript.complete).toBe(true);
    expect(resident.transcript.navigation).toHaveLength(512);
    expect(resident.transcript.identities.has("next-one")).toBe(false);
    expect(f.events()).toHaveLength(512);

    const committed = forkSessionActorStoredState(resident);
    write(() => append(committed));
    residency.remember(committed);
    expect(committed.transcript.complete).toBe(false);
    expect(committed.transcript.navigation).toHaveLength(512);
    expect(committed.transcript.identities.size).toBeLessThanOrEqual(512);
    expect(committed.transcript.active.size).toBeLessThanOrEqual(512);
    expect(committed.transcript.identities.has("message-0")).toBe(false);
    write(() =>
      withSessionActorTransactionState(database, committed, () => {
        expect(
          appendTranscriptMessageInTransaction(database, scope, {
            eventId: "must-not-append",
            message: originalMessage,
          })?.result,
        ).toMatchObject({ appended: false, messageId: "message-0" });
      }),
    );
    expect(f.events()).toHaveLength(514);
    residency.clear();
  });
});
