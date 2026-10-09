import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { lookupSessionGoalOperation } from "../config/sessions/goals-operations-read.js";
import { mutateSessionGoal } from "../config/sessions/goals-operations.js";
import { trimTranscriptForManualCompact } from "../config/sessions/session-accessor.sqlite-compaction.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { withTranscriptWriteSequence } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { trimSessionTranscriptForManualCompact } from "../config/sessions/session-accessor.transcript.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { withPreparedTranscriptCorrection } from "../config/sessions/session-transcript-correction.js";
import {
  withOwnedSessionTranscriptWrites,
  withSessionTranscriptWriteAssertion,
} from "../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";

export type IncognitoMutationFixture = {
  actor: IncognitoAgentDatabaseExecution;
  env: NodeJS.ProcessEnv;
  authority: IncognitoSessionAuthority;
  key: (name: string, agentId?: string) => string;
  entry: (sessionId: string, createdAt?: number) => SessionEntry;
};

export function registerIncognitoMutationAdmissionTests(
  getFixture: () => IncognitoMutationFixture,
): void {
  it.each(["sequence", "correction"] as const)(
    "rejects new %s access after admission cancellation",
    async (kind) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `${kind}-admission-cancelled`;
      const sessionKey = key(sessionId);
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
      const admission = new AbortController();
      const reason = new Error("transcript admission closed");
      let original: unknown[] = [];
      const cancel = async (write: {
        readEvents(): Promise<unknown[]>;
        replaceEvents(events: readonly unknown[]): Promise<void>;
      }) => {
        original = await write.readEvents();
        admission.abort(reason);
        await expect(
          write.replaceEvents(
            original.map((event) => Object.assign({}, event, { cwd: "cancelled-replacement" })),
          ),
        ).rejects.toBe(reason);
        await expect(write.readEvents()).rejects.toBe(reason);
      };
      await withIncognitoSessionActor(
        actor,
        async () => {
          return kind === "correction"
            ? withPreparedTranscriptCorrection(scope, cancel)
            : withTranscriptWriteSequence(scope, async (write) => {
                await cancel(write);
                await expect(write.readMessageFacts({ idempotencyKeys: [] })).rejects.toBe(reason);
              });
        },
        admission.signal,
      );
      await withIncognitoSessionActor(actor, async () => {
        expect(await withTranscriptWriteSequence(scope, (write) => write.readEvents())).toEqual(
          original,
        );
      });
    },
  );

  it.each(["correction", "rewrite", "turn", "goal-receipt", "assistant"] as const)(
    "cancels the initial actor %s read before preparation",
    async (kind) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `${kind}-initial-cancelled`;
      const sessionKey = key(sessionId);
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
      const seeded = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey,
          sessionId,
          fence: {},
          message: { role: "assistant", content: "original" },
        },
      });
      assert(seeded.ok && seeded.value.append?.anchor);
      const anchor = seeded.value.append.anchor;
      const admission = new AbortController();
      const reason = new Error("initial transcript read cancelled");
      const prepared = vi.fn(() => true);
      let original: unknown[] = [];
      await withIncognitoSessionActor(
        actor,
        async () => {
          original = await withTranscriptWriteSequence(scope, (write) => write.readEvents());
          let pending: Promise<unknown>;
          switch (kind) {
            case "correction":
              pending = withPreparedTranscriptCorrection(scope, async () => {
                prepared();
              });
              break;
            case "rewrite":
              pending = rewritePreparedTranscriptMessageAtAnchor(anchor, (message) => {
                prepared();
                return message;
              });
              break;
            case "turn":
              pending = appendExpectedSessionTranscriptTurn(scope, {
                expectedSessionId: sessionId,
                expectedLifecycleRevision: "initial",
                sessionFile: sessionKey,
                messages: [
                  {
                    message: { role: "assistant", content: "must not persist" },
                    shouldAppend: prepared,
                  },
                ],
              });
              break;
            case "assistant":
              pending = appendAssistantMessageToSessionTranscript({
                ...scope,
                config: {},
                expectedSessionId: sessionId,
                expectedLifecycleRevision: "initial",
                text: "must not persist",
                updateMode: "none",
                beforeMessageWrite({ message }) {
                  prepared();
                  return message;
                },
              });
              break;
            case "goal-receipt":
              pending = lookupSessionGoalOperation({
                ...scope,
                expectedSessionId: sessionId,
                operation: {
                  action: "pause",
                  goalId: "goal",
                  operationId: "read-receipt",
                  requestFingerprint: "read-receipt",
                  issuedAtMs: Date.now(),
                },
              });
              break;
          }
          admission.abort(reason);
          await expect(pending).rejects.toBe(reason);
          expect(prepared).not.toHaveBeenCalled();
        },
        admission.signal,
      );
      await withIncognitoSessionActor(actor, async () => {
        expect(await withTranscriptWriteSequence(scope, (write) => write.readEvents())).toEqual(
          original,
        );
      });
    },
  );

  it.each([false, true])(
    "fences correction to its initially absent lifecycle (changed=%s)",
    async (changed) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `absent-lifecycle-${changed}`;
      const sessionKey = key(sessionId);
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      const initial = entry(sessionId);
      delete initial.lifecycleRevision;
      await actor.sessions.create(authority, { sessionKey, entry: initial });
      await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey,
          sessionId,
          fence: {},
          message: { role: "assistant", content: "original" },
        },
      });
      await withIncognitoSessionActor(actor, async () => {
        const before = await withTranscriptWriteSequence(scope, (write) => write.readEvents());
        const correction = withPreparedTranscriptCorrection(scope, async (write) => {
          const events = await write.readEvents();
          if (changed) {
            await patchSessionEntryCore(scope, () => ({ lifecycleRevision: "successor" }));
          }
          const replacement = events.slice();
          replacement[1] = Object.assign({}, events[1], {
            message: { role: "assistant", content: "corrected" },
          });
          await write.replaceEvents(replacement);
        });
        if (changed) {
          await expect(correction).rejects.toThrow("writer claim changed");
        } else {
          await correction;
        }
        const after = await withTranscriptWriteSequence(scope, (write) => write.readEvents());
        if (changed) {
          expect(after).toEqual(before);
        } else {
          expect(after).toHaveLength(2);
          expect(after[0]).toEqual(before[0]);
          expect(after[1]).toMatchObject({ message: { content: "corrected" } });
        }
      });
    },
  );

  it.each(["during read", "after read"] as const)(
    "cancels replacement %s without committing",
    async (phase) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `implicit-replacement-${phase.replaceAll(" ", "-")}`;
      const sessionKey = key(sessionId);
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
      await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey,
          sessionId,
          fence: {},
          message: { role: "assistant", content: "retained before replacement" },
        },
      });
      const admission = new AbortController();
      const reason = new Error(`implicit replacement cancelled ${phase}`);
      let reading = false;
      let aborted = false;
      let original: unknown[] = [];
      const transcript = actor.sessions.transcript;
      const read = vi.spyOn(actor.sessions, "transcript").mockImplementation((...args) =>
        transcript(...args).then((result) => {
          if (phase === "after read" && reading && args[1].type === "session.lock.events") {
            reading = false;
            aborted = true;
            admission.abort(reason);
          }
          return result;
        }),
      );
      try {
        await withIncognitoSessionActor(
          actor,
          async () => {
            original = await withTranscriptWriteSequence(scope, (write) => write.readEvents());
            await withSessionTranscriptWriteAssertion(
              scope,
              Object.assign(() => {}, {
                async prepareSessionSource() {
                  return {
                    checks: [],
                    assertCurrent() {
                      if (phase === "during read" && reading) {
                        reading = false;
                        aborted = true;
                        admission.abort(reason);
                      }
                    },
                  };
                },
              }),
              () =>
                withTranscriptWriteSequence(scope, async (write) => {
                  reading = true;
                  await expect(
                    write.replaceEvents(
                      original.map((event) =>
                        Object.assign({}, event, { cwd: "must not persist" }),
                      ),
                    ),
                  ).rejects.toBe(reason);
                  expect(aborted).toBe(true);
                }),
            );
          },
          admission.signal,
        );
        await withIncognitoSessionActor(actor, async () => {
          expect(await withTranscriptWriteSequence(scope, (write) => write.readEvents())).toEqual(
            original,
          );
        });
      } finally {
        read.mockRestore();
      }
    },
  );

  it.each(["rewrite", "manual trim"] as const)(
    "cancels actor %s in its selection callback without changing the transcript",
    async (owner) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `selection-cancelled-${owner.replaceAll(" ", "-")}`;
      const sessionKey = key(sessionId);
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
      const seeded = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey,
          sessionId,
          fence: {},
          message: { role: "assistant", content: "retained selection" },
        },
      });
      assert(seeded.ok && seeded.value.append?.anchor);
      const anchor = seeded.value.append.anchor;
      const admission = new AbortController();
      const reason = new Error(`${owner} selection cancelled`);
      const cancel = vi.fn(() => admission.abort(reason));
      let original: unknown[] = [];
      await withIncognitoSessionActor(
        actor,
        async () => {
          original = await withTranscriptWriteSequence(scope, (write) => write.readEvents());
          const pending =
            owner === "rewrite"
              ? rewritePreparedTranscriptMessageAtAnchor(anchor, () => {
                  cancel();
                  return { role: "assistant", content: "must not replace" };
                })
              : trimTranscriptForManualCompact(scope, (lines) => {
                  cancel();
                  return lines.slice(0, 1);
                });
          await expect(pending).rejects.toBe(reason);
          expect(cancel).toHaveBeenCalledTimes(1);
        },
        admission.signal,
      );
      await withIncognitoSessionActor(actor, async () => {
        expect(await withTranscriptWriteSequence(scope, (write) => write.readEvents())).toEqual(
          original,
        );
      });
    },
  );

  it.each(["replay", "read", "replace", "correction-read", "correction-write"] as const)(
    "rechecks prepared owned source before actor %s",
    async (surface) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `owned-source-${surface}`;
      const sessionKey = key(sessionId);
      const allowedLabel = `${sessionId}-allowed`;
      const revokedLabel = `${sessionId}-revoked`;
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      await actor.sessions.create(authority, {
        sessionKey,
        entry: { ...entry(sessionId), label: allowedLabel },
      });
      const message = { role: "assistant", content: "original", idempotencyKey: sessionId };
      await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: { sessionKey, sessionId, fence: {}, message },
      });
      const refused = new Error("prepared owner source revoked");
      const release = vi.fn(async () => {});
      const raw = vi.fn(() => {
        throw new Error("raw owner source must not run");
      });
      const source: SessionSourceAssertion = Object.assign(raw, {
        async prepareSessionSource() {
          return {
            assertCurrent() {},
            checks: [
              {
                predicate: {
                  source: {
                    agentId: actor.agentId,
                    path: actor.path,
                    databaseIdentity: actor.identity.incarnation,
                  },
                  sessionKey,
                  fields: ["label" as const],
                  expected: { label: allowedLabel },
                },
                refuse(): never {
                  throw refused;
                },
              },
            ],
            release,
          };
        },
      });
      await withIncognitoSessionActor(actor, async () => {
        const original = await withTranscriptWriteSequence(scope, (write) => write.readEvents());
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: scope,
            assertCommitAllowed: source,
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            if (surface === "correction-read" || surface === "correction-write") {
              await withPreparedTranscriptCorrection(scope, async (write) => {
                const events = await write.readEvents();
                await patchSessionEntryCore(scope, () => ({ label: revokedLabel }));
                await expect(
                  surface === "correction-read" ? write.readEvents() : write.replaceEvents(events),
                ).rejects.toBe(refused);
              });
            } else {
              await withTranscriptWriteSequence(scope, async (write) => {
                const events = await write.readEvents();
                await patchSessionEntryCore(scope, () => ({ label: revokedLabel }));
                await expect(
                  surface === "replay"
                    ? write.appendMessage({ message })
                    : surface === "read"
                      ? write.readEvents()
                      : write.replaceEvents(events),
                ).rejects.toBe(refused);
                expect(release).not.toHaveBeenCalled();
              });
            }
          },
        );
        expect(raw).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
        expect(await withTranscriptWriteSequence(scope, (write) => write.readEvents())).toEqual(
          original,
        );
      });
    },
  );

  it("refuses an opaque wrapper during actor Goal preparation", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionId = "opaque-goal-source";
    const sessionKey = key(sessionId);
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    const assertion: SessionSourceAssertion = Object.assign(() => {}, {
      async prepareSessionSource() {
        return { hasOpaqueCheck: true, assertCurrent() {}, assertPreparedCurrent() {}, checks: [] };
      },
    });
    await withIncognitoSessionActor(actor, async () => {
      await expect(
        mutateSessionGoal({
          agentId: actor.agentId,
          storePath: actor.path,
          sessionKey,
          expectedSessionId: sessionId,
          operation: {
            action: "pause",
            goalId: "goal",
            operationId: "opaque-pause",
            issuedAtMs: Date.now(),
            requestFingerprint: "opaque-pause",
          },
          assertCurrent: assertion,
        }),
      ).rejects.toThrow("prepared");
      expect((await actor.sessions.read(authority, { sessionKey })).entry).not.toHaveProperty(
        "goal",
      );
    });
  });

  it.each(["Goal", "manual trim"] as const)(
    "preserves the original actor %s source refusal before release",
    async (owner) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `original-refusal-${owner.toLowerCase().replaceAll(" ", "-")}`;
      const sessionKey = key(sessionId);
      const allowedLabel = `${sessionId}-allowed`;
      const revokedLabel = `${sessionId}-revoked`;
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      const now = Date.now();
      await actor.sessions.create(authority, {
        sessionKey,
        entry: {
          ...entry(sessionId),
          label: allowedLabel,
          goal: {
            schemaVersion: 1,
            id: "goal",
            objective: "unchanged",
            status: "active",
            createdAt: now,
            updatedAt: now,
            tokenStart: 0,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      });
      await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey,
          sessionId,
          fence: {},
          message: { role: "assistant", content: "keep this message" },
        },
      });
      const reason = new Error(`${owner} exact source refusal`);
      let live = true;
      const release = vi.fn(async () => {
        live = false;
      });
      const refuse = vi.fn((): never => {
        expect(live).toBe(true);
        throw reason;
      });
      const raw = vi.fn(() => {
        throw new Error("raw source guard must not run");
      });
      const source: SessionSourceAssertion = Object.assign(raw, {
        async prepareSessionSource() {
          await patchSessionEntryCore(scope, () => ({ label: revokedLabel }));
          return {
            assertCurrent() {},
            checks: [
              {
                predicate: {
                  source: {
                    agentId: actor.agentId,
                    path: actor.path,
                    databaseIdentity: actor.identity.incarnation,
                  },
                  sessionKey,
                  fields: ["label" as const],
                  expected: { label: allowedLabel },
                },
                refuse,
              },
            ],
            release,
          };
        },
      });
      await withIncognitoSessionActor(actor, async () => {
        const before = await withTranscriptWriteSequence(scope, (write) => write.readEvents());
        const operation = {
          action: "pause" as const,
          goalId: "goal",
          operationId: "refused-operation",
          issuedAtMs: now,
          requestFingerprint: "refused-operation",
        };
        await expect(
          owner === "Goal"
            ? mutateSessionGoal({
                ...scope,
                expectedSessionId: sessionId,
                operation,
                assertCurrent: source,
              })
            : trimSessionTranscriptForManualCompact(scope, {
                maxLines: 1,
                authority: { source, assertHostCurrent() {}, expectedLifecycleRevision: "initial" },
              }),
        ).rejects.toBe(reason);
        expect(refuse).toHaveBeenCalledWith(
          expect.objectContaining({ entry: expect.objectContaining({ label: revokedLabel }) }),
        );
        expect(release).toHaveBeenCalledTimes(1);
        expect(raw).not.toHaveBeenCalled();
        expect(await withTranscriptWriteSequence(scope, (write) => write.readEvents())).toEqual(
          before,
        );
        expect((await actor.sessions.read(authority, { sessionKey })).entry?.goal?.status).toBe(
          "active",
        );
        expect(
          await lookupSessionGoalOperation({ ...scope, expectedSessionId: sessionId, operation }),
        ).toBeUndefined();
      });
    },
  );

  it.each(["source preparation", "commit publication"] as const)(
    "settles Goal cancellation during %s",
    async (phase) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `goal-cancellation-${phase.replaceAll(" ", "-")}`;
      const sessionKey = key(sessionId);
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      const now = Date.now();
      await actor.sessions.create(authority, {
        sessionKey,
        entry: {
          ...entry(sessionId),
          goal: {
            schemaVersion: 1,
            id: "goal",
            objective: "original",
            status: "active",
            createdAt: now,
            updatedAt: now,
            tokenStart: 0,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      });
      const admission = new AbortController();
      const reason = new Error(`Goal admission cancelled at ${phase}`);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const order: string[] = [];
      const source: SessionSourceAssertion = Object.assign(() => {}, {
        async prepareSessionSource() {
          if (phase === "source preparation") {
            entered.resolve();
            await resume.promise;
          }
          return {
            checks: [],
            assertCurrent() {},
            async release() {
              order.push("released");
            },
          };
        },
      });
      const stop = sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === sessionKey &&
          phase === "commit publication" &&
          !admission.signal.aborted
        ) {
          order.push("published");
          admission.abort(reason);
        }
      });
      const operation = {
        action: "edit" as const,
        goalId: "goal",
        objective: "committed",
        operationId: "cancellation-edit",
        requestFingerprint: "cancellation-edit",
        issuedAtMs: now,
      };
      const input = { ...scope, expectedSessionId: sessionId, operation, assertCurrent: source };
      const pending = withIncognitoSessionActor(
        actor,
        () => mutateSessionGoal(input),
        admission.signal,
      );
      const outcome = pending.catch((error: unknown) => error);
      let committed: Awaited<ReturnType<typeof mutateSessionGoal>> | undefined;
      try {
        if (phase === "source preparation") {
          await awaitGateBeforeSettlement(
            entered.promise,
            outcome,
            "Goal source preparation was not entered",
          );
          admission.abort(reason);
          resume.resolve();
          await expect(pending).rejects.toBe(reason);
        } else {
          committed = await pending;
          expect(admission.signal.aborted).toBe(true);
          expect(committed).toMatchObject({
            replayed: false,
            result: { goal: { objective: "committed" } },
            sessionEntry: { goal: { objective: "committed" } },
          });
        }
        expect(order).toEqual(
          phase === "source preparation" ? ["released"] : ["published", "released"],
        );
        await withIncognitoSessionActor(actor, async () => {
          expect(
            (await actor.sessions.read(authority, { sessionKey })).entry?.goal?.objective,
          ).toBe(phase === "source preparation" ? "original" : "committed");
          expect(await lookupSessionGoalOperation(input)).toEqual(committed?.result);
        });
      } finally {
        resume.resolve();
        stop();
        await Promise.allSettled([pending]);
      }
    },
  );
}
