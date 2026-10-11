import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createNativeSessionBindingAuthority } from "../agents/harness/native-session/binding-authority.js";
import { recordChannelFeedbackEvent } from "../channels/feedback-reflection.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntry,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { withTranscriptWriteLock } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withSessionTranscriptWriteAssertion,
} from "../config/sessions/transcript-write-context.js";
import { createGatewayMetadataCloseFixture } from "../gateway/server-close.metadata.test-support.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  withCodexSessionTranscriptMirrorWrite,
  withCodexSessionTranscriptMirrorWriteLock,
} from "./codex-session-transcript-runtime.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  composeSessionTranscriptWriteAssertion,
  withSessionTranscriptWrite,
  withSessionTranscriptWriteLock,
  type SessionTranscriptWriteLockContext,
} from "./session-transcript-runtime.js";

async function seed(env: NodeJS.ProcessEnv, locator: "physical" | "logical" = "physical") {
  const target = {
    agentId: "main",
    sessionId: "append-session",
    sessionKey: "agent:main:append",
    env,
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  return {
    ...target,
    storePath:
      locator === "logical"
        ? resolveSessionStorePathCore(undefined, { agentId: target.agentId, env })
        : openOpenClawAgentDatabase(target).path,
  };
}

const messageIds = (scope: Awaited<ReturnType<typeof seed>>) =>
  loadTranscriptEventsSync(scope).flatMap((event) =>
    isRecord(event) && event.type === "message" ? [event.id] : [],
  );

it("creates the first transcript in an absent custom store through the SDK", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "first-transcript",
      sessionKey: "agent:main:first-transcript",
      storePath: state.statePath("first-write", "openclaw-agent.sqlite"),
      env: state.env,
    };
    expect(existsSync(scope.storePath)).toBe(false);
    await expect(
      appendSessionTranscriptMessageByIdentity({
        ...scope,
        eventId: "first",
        message: { role: "assistant", content: "first persisted row" },
      }),
    ).resolves.toMatchObject({ appended: true, messageId: "first" });
    expect(existsSync(scope.storePath)).toBe(true);
    expect(messageIds(scope)).toEqual(["first"]);
  });
});

it.each([false, true])(
  "preserves custom JSON across locked worker writes (prepared=%s)",
  async (prepared) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env);
      const message = {
        role: "assistant",
        content: "custom payload",
        idempotencyKey: "custom-json",
        custom: { toJSON: () => "stored value" },
      };
      const prepare = prepared
        ? async (input: typeof message) => ({
            ...input,
            custom: { toJSON: () => "prepared value" },
          })
        : undefined;
      const expected = { ...message, custom: prepared ? "prepared value" : "stored value" };
      const result = await withSessionTranscriptWrite(scope, (locked) =>
        locked.appendMessage({
          eventId: "custom-json",
          message,
          ...(prepare ? { preparation: { prepareMessage: prepare } } : {}),
        }),
      );
      expect(result).toMatchObject({ appended: true, message: expected });
      expect(loadTranscriptEventsSync(scope)).toContainEqual(
        expect.objectContaining({ id: "custom-json", message: expected }),
      );
      await expect(
        withSessionTranscriptWrite(scope, (locked) =>
          locked.appendMessage({
            message,
            ...(prepare ? { preparation: { prepareMessage: prepare } } : {}),
          }),
        ),
      ).resolves.toMatchObject({ appended: false, message: expected });
    });
  },
);

it("prepares Codex guard reads and rechecks authority at the worker commit grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = await seed(env);
    let current = true;
    let inCommit = false;
    let checkedCommit = false;
    using _ = probe.admission(admission, (request, grant, authorize) => {
      const publication = isRecord(request.facts) ? request.facts.publication : undefined;
      inCommit =
        request.stage === "commit" &&
        isRecord(publication) &&
        publication.kind === "session-entry-patch-committed";
      if (inCommit) {
        current = false;
      }
      try {
        authorize(request, grant);
      } finally {
        inCommit = false;
      }
    });
    const binding = createNativeSessionBindingAuthority(
      [
        {
          read: scope,
          sessionId: scope.sessionId,
          createSupersededError: () => new Error("Codex session superseded"),
        },
      ],
      () => {},
    );
    const guard = composeSessionTranscriptWriteAssertion([binding.assertLegacyCurrent], () => {
      checkedCommit ||= inCommit;
      if (!current) {
        throw new Error("Codex write authority revoked");
      }
    });
    const sql = observeHostDataSql();
    try {
      await expect(
        withCodexSessionTranscriptMirrorWrite(scope, (locked) =>
          locked.appendMessageWithMessageSequence({
            message: { role: "assistant", content: "revoked" },
            preparation: { source: guard },
          }),
        ),
      ).rejects.toThrow("Codex write authority revoked");
      expect(checkedCommit).toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(messageIds(scope)).toEqual([]);
  });
});

it.each(["physical", "logical"] as const)(
  "retains the prepared owner's %s target binding for writes and facts queries",
  async (locator) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env, locator);
      const other = { ...scope, sessionId: "other-session", sessionKey: "agent:main:other" };
      await replaceSessionEntry(other, { sessionId: other.sessionId, updatedAt: 1 });
      await expect(
        withSessionTranscriptWriteAssertion(scope, composeSessionTranscriptWriteAssertion([]), () =>
          withSessionTranscriptWriteLock(other, (locked) =>
            locked.appendMessage({ message: { role: "assistant", content: "wrong target" } }),
          ),
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      expect(messageIds(other)).toEqual([]);
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        eventId: "captured-facts",
        message: { role: "assistant", content: "captured target", idempotencyKey: "captured" },
      });
      await appendSessionTranscriptMessageByIdentity({
        ...other,
        eventId: "foreign-facts",
        message: { role: "assistant", content: "foreign target", idempotencyKey: "foreign" },
      });
      const query = {
        idempotencyKeys: ["captured", "foreign"],
        scope: { ...other, path: openOpenClawAgentDatabase(other).path },
        sessionKey: other.sessionKey,
        sessionId: other.sessionId,
      };
      await withCodexSessionTranscriptMirrorWrite(scope, async (transcript) => {
        const facts = await transcript.readMessageFacts(query);
        expect(
          [...facts.existingIdempotencyKeys],
          "Facts queries must retain their captured transcript target",
        ).toEqual(["captured"]);
        expect(facts.messagesByIdempotencyKey.get("captured")).toMatchObject({
          content: "captured target",
        });
        expect(facts.anchorsByIdempotencyKey.get("captured")).toMatchObject({
          entryId: "captured-facts",
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        });
      });
      let retainedFacts: SessionTranscriptWriteLockContext["readMessageFacts"] | undefined;
      await withSessionTranscriptWrite(scope, async (transcript) => {
        retainedFacts = transcript.readMessageFacts;
        const facts = await transcript.readMessageFacts(query);
        expect([...facts.existingIdempotencyKeys]).toEqual(["captured"]);
        expect(facts.messagesByIdempotencyKey.get("captured")).toMatchObject({
          content: "captured target",
        });
      });
      assert(retainedFacts);
      await expect(retainedFacts(query)).rejects.toThrow("Transcript write context is closed");
    });
  },
);

it.each(["locked", "mirror"] as const)(
  "persists %s through its real entry without MAIN SQL",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env);
      const request = { ...scope, read: async () => [] };
      const sql = observeHostDataSql();
      try {
        if (kind === "locked") {
          await withSessionTranscriptWriteLock(request, async (locked) => {
            expect(await locked.readEvents()).toEqual([]);
            await locked.appendMessage({ message: { role: "assistant", content: "locked" } });
          });
        } else if (kind === "mirror") {
          expect(
            await appendAssistantMirrorMessageByIdentity({
              ...scope,
              text: "mirror",
              idempotencyKey: "mirror-key",
              deliveryMirror: { kind: "channel-final" },
            }),
          ).toMatchObject({ ok: true });
        }
        const executions = sql.calls
          .slice(1)
          .reduce((sum, call) => sum + call.mock.calls.length, 0);
        expect(sql.queries, `MAIN ${kind}: ${executions} SQL executions`).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(loadTranscriptEventsSync(scope).length).toBeGreaterThan(0);
    });
  },
);

it.each([
  { locator: "physical", adapter: "source" },
  { locator: "logical", adapter: "source" },
  { locator: "physical", adapter: "preparer" },
  { locator: "logical", adapter: "preparer" },
] as const)(
  "retains the $locator owner through the native $adapter adapter",
  async ({ locator, adapter }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env, locator);
      const databasePath = openOpenClawAgentDatabase(scope).path;
      const assertCurrent = () => {};
      const authority =
        adapter === "source" ? assertCurrent : composeSessionTranscriptWriteAssertion([]);
      const updates: unknown[] = [];
      const off = onInternalSessionTranscriptUpdate((update) => updates.push(update));
      try {
        await withSessionTranscriptWriteAssertion(scope, authority, () =>
          withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
            const appended = await locked.appendMessageWithMessageSequence({
              eventId: "owned",
              message: { role: "assistant", content: "owned", idempotencyKey: "owned" },
              ...(adapter === "preparer"
                ? { prepareMessageAfterIdempotencyCheck: (message: unknown) => message }
                : {}),
            });
            expect(appended.result?.messageId).toBe("owned");
            expect(appended.messageSeq).toEqual(expect.any(Number));
            const facts = await locked.readMessageFacts({ idempotencyKeys: ["owned"] });
            expect(facts.existingIdempotencyKeys.has("owned")).toBe(true);
            await locked.publishUpdate({ messageId: "owned" });
          }),
        );
        expect(messageIds(scope)).toEqual(["owned"]);
        expect(updates).toEqual([
          expect.objectContaining({
            target: expect.objectContaining({ storePath: databasePath }),
            messageId: "owned",
          }),
        ]);
      } finally {
        off();
      }
    });
  },
);

it.each([
  { path: "locked", stale: false, replay: false },
  { path: "locked", stale: true, replay: false },
  { path: "locked", stale: true, replay: true },
] as const)(
  "uses prepared grant facts for $path (stale=$stale, replay=$replay)",
  async ({ stale, replay }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env);
      const prepared = await withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read, owner) => {
          assert(read.ok && read.value);
          const captured = captureSessionEntryCurrentRead(scope, owner);
          assert(captured.kind === "file");
          return {
            assertCurrent: captured.assertSourceCurrent,
            checks: [
              {
                predicate: {
                  source: captured.source,
                  sessionKey: captured.source.sessionKey,
                  fields: ["sessionId", "label"],
                  expected: read.value,
                },
                refuse: () => {
                  throw new Error("Prepared transcript source changed");
                },
              },
            ],
          } satisfies PreparedSessionSourceAuthority;
        },
      );
      const message = {
        role: "assistant",
        content: "authorized",
        idempotencyKey: "prepared-grant",
      };
      if (replay) {
        await withSessionTranscriptWriteLock(scope, (locked) =>
          locked.appendMessage({ eventId: "prepared-grant", message }),
        );
      }
      if (stale) {
        await replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          updatedAt: 2,
          label: "foreign",
        });
      }
      const legacyGuard = vi.fn(() => {
        loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
        throw new Error("Legacy rereading guard invoked");
      });
      const beforeFreshMessageCommit: SessionSourceAssertion = Object.assign(legacyGuard, {
        prepareSessionSource: async () => {
          if (replay) {
            throw new Error("Fresh source preparation is no longer available");
          }
          return prepared;
        },
      });
      const options = {
        eventId: "prepared-grant",
        message,
        preparation: { source: beforeFreshMessageCommit },
      };
      const sql = observeHostDataSql();
      try {
        const operation = withSessionTranscriptWrite(scope, (locked) =>
          locked.appendMessage(options),
        );
        if (stale && !replay) {
          await expect(operation).rejects.toThrow("Prepared transcript source changed");
        } else {
          await operation;
        }
        expect(legacyGuard).not.toHaveBeenCalled();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(messageIds(scope)).toEqual(stale && !replay ? [] : ["prepared-grant"]);
    });
  },
);

it.each(["owned", "fresh"] as const)(
  "accepts worker conversation matches before checking %s locked authority",
  async (authorityKind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env);
      const conversationRef = buildConversationRef({
        channel: "reef",
        accountId: "default",
        kind: "direct",
        peerId: "locked-unbound",
      });
      let inSourceGrant = false;
      let checkedSourceGrant = false;
      let acceptedMatches: readonly number[] | undefined;
      const prepared = await withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read, owner) => {
          assert(read.ok && read.value);
          const captured = captureSessionEntryCurrentRead(scope, owner);
          assert(captured.kind === "file");
          return {
            assertCurrent() {
              captured.assertSourceCurrent();
              if (inSourceGrant && acceptedMatches) {
                expect(acceptedMatches).toEqual([1]);
                checkedSourceGrant = true;
              }
            },
            checks: [
              {
                predicate: {
                  source: captured.source,
                  sessionKey: captured.source.sessionKey,
                  fields: ["sessionId"],
                  expected: read.value,
                  conversationAlternatives: [
                    [{ conversationRef, sessionKey: scope.sessionKey }],
                    [{ conversationRef, sessionKey: null }],
                  ],
                },
                acceptConversationMatches(matches: readonly number[]) {
                  acceptedMatches = matches;
                  return [...matches];
                },
                refuse() {
                  throw new Error("Locked conversation source changed");
                },
              },
            ],
          } satisfies PreparedSessionSourceAuthority;
        },
      );
      const create = admission.createSqliteWorkerOperationAdmission;
      using _ = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((authorize, attachment) =>
          create((request, grant) => {
            const publication = isRecord(request.facts) ? request.facts.publication : undefined;
            inSourceGrant =
              request.stage === "transaction" &&
              isRecord(publication) &&
              publication.kind === "session-transcript-lock-source" &&
              publication.fresh === (authorityKind === "fresh");
            if (inSourceGrant) {
              acceptedMatches = undefined;
              checkedSourceGrant = false;
            }
            try {
              authorize(request, () => {
                if (inSourceGrant) {
                  expect(acceptedMatches).toEqual([1]);
                  expect(checkedSourceGrant).toBe(true);
                }
                return grant();
              });
            } finally {
              inSourceGrant = false;
            }
          }, attachment),
        );
      let sourcePrepared = false;
      const guard: SessionSourceAssertion = Object.assign(
        () => {
          if (sourcePrepared) {
            throw new Error("Locked source used its native callback after preparation");
          }
          prepared.assertCurrent();
        },
        {
          prepareSessionSource: async () => {
            sourcePrepared = true;
            return prepared;
          },
        },
      );
      const write = () =>
        withSessionTranscriptWriteLock(scope, (locked) =>
          locked.appendMessage({
            eventId: "matched-source",
            message: { role: "assistant", content: "authorized conversation" },
            ...(authorityKind === "fresh" ? { beforeFreshMessageCommit: guard } : {}),
          }),
        );
      const sql = observeHostDataSql();
      try {
        await (authorityKind === "owned"
          ? withSessionTranscriptWriteAssertion(scope, guard, write)
          : write());
        expect(checkedSourceGrant).toBe(true);
        expect(acceptedMatches).toEqual([1]);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(messageIds(scope)).toEqual(["matched-source"]);
    });
  },
);

it("refuses a read-only locked result after its database owner is revoked", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = await seed(env);
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      eventId: "before-close",
      message: { role: "assistant", content: "Read before owner revocation" },
    });
    const entered = createDeferred();
    const release = createDeferred();
    let closing: Promise<boolean> | undefined;
    const reading = withSessionTranscriptWriteLock(scope, async (locked) => {
      const events = await locked.readEvents();
      expect(events).toContainEqual(expect.objectContaining({ id: "before-close" }));
      entered.resolve();
      await release.promise;
      return events;
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, reading, "Locked reader did not reach its gate"),
        signal,
      );
      closing = closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
      release.resolve();
      await expect(withinTest(reading, signal)).rejects.toThrow(
        "Agent database execution admission is closed",
      );
      await withinTest(closing, signal);
    } finally {
      release.resolve();
      await Promise.allSettled([reading, closing]);
    }
  });
});

it("joins accepted appends in FIFO order before admitting feedback after the callback returns", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = await seed(env);
    const entered = createDeferred();
    const release = createDeferred();
    const accepted: Promise<unknown>[] = [];
    let feedback: Promise<boolean> | undefined;
    const writing = withSessionTranscriptWriteLock(scope, (locked) => {
      accepted.push(
        locked.appendMessage({
          eventId: "first",
          message: { role: "assistant", content: "first" },
          prepareMessageAfterIdempotencyCheckAsync: async (message) => {
            entered.resolve();
            await release.promise;
            return message;
          },
        }),
      );
      accepted.push(
        locked.appendMessage({
          eventId: "second",
          message: { role: "assistant", content: "second" },
        }),
      );
      return "callback returned";
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, writing, "Append was not retained"),
        signal,
      );
      feedback = recordChannelFeedbackEvent({
        cfg: { session: { store: scope.storePath } },
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        event: { type: "feedback", id: "after-lock", value: "negative" },
      });
      expect(messageIds(scope)).toEqual([]);
      release.resolve();
      expect(await withinTest(writing, signal)).toBe("callback returned");
      await Promise.all(accepted);
      expect(await withinTest(feedback, signal)).toBe(true);
      expect(
        loadTranscriptEventsSync(scope)
          .filter(isRecord)
          .map((event) => event.id),
      ).toEqual([scope.sessionId, "first", "second", "after-lock"]);
    } finally {
      release.resolve();
      await Promise.allSettled([writing, feedback, ...accepted]);
    }
  });
});

it.each(["physical", "logical"] as const)(
  "refuses an append when its retained %s writer authority is revoked during preparation",
  async (locator) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env, locator);
      let current = true;
      await expect(
        withSessionTranscriptWriteAssertion(
          scope,
          composeSessionSourceAssertion([], () => {
            if (!current) {
              throw new Error("Writer revoked");
            }
          }),
          () =>
            withSessionTranscriptWriteLock(scope, (locked) =>
              locked.appendMessage({
                eventId: "revoked",
                message: { role: "assistant", content: "must not persist" },
                prepareMessageAfterIdempotencyCheckAsync: async (message) => {
                  current = false;
                  return message;
                },
              }),
            ),
        ),
      ).rejects.toThrow("Writer revoked");
      expect(messageIds(scope)).toEqual([]);
    });
  },
);

it.each(["worker", "released sync callback"] as const)(
  "refreshes its own %s append snapshot without accepting an external byte rewrite",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = await seed(env);
      const prepare = mode === "released sync callback" ? (message: unknown) => message : undefined;
      await withTranscriptWriteLock(scope, async (locked) => {
        await locked.readEvents();
        const appended = await locked.appendMessage({
          eventId: "own",
          message: { role: "assistant", content: "original" },
          prepareMessageAfterIdempotencyCheck: prepare,
        });
        expect(appended?.anchor).toMatchObject({ entryId: "own" });
        expect(Object.isFrozen(appended?.anchor)).toBe(true);
        await locked.replaceEvents(loadTranscriptEventsSync(scope));
      });
      expect(messageIds(scope)).toEqual(["own"]);
      const external = new DatabaseSync(scope.storePath);
      try {
        await expect(
          withTranscriptWriteLock(scope, async (locked) => {
            await locked.readEvents();
            // Preserve every watermark and parsed value; only the stored source bytes change.
            external
              .prepare(
                "UPDATE transcript_events SET event_json = event_json || ' ' WHERE session_id = ? AND json_extract(event_json, '$.id') = ?",
              )
              .run(scope.sessionId, "own");
            await locked.appendMessage({
              eventId: "after-external",
              message: { role: "assistant", content: "own later append" },
              prepareMessageAfterIdempotencyCheck: prepare,
            });
            await locked.replaceEvents(loadTranscriptEventsSync(scope));
          }),
        ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
        const row = external
          .prepare(
            "SELECT event_json FROM transcript_events WHERE session_id = ? AND json_extract(event_json, '$.id') = ?",
          )
          .get(scope.sessionId, "own");
        assert(typeof row?.event_json === "string");
        expect(row.event_json.endsWith(" ")).toBe(true);
        expect(messageIds(scope)).toEqual(["own", "after-external"]);
      } finally {
        external.close();
      }
    });
  },
);

it("retains a committed append but suppresses queued publication when its callback fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = await seed(env);
    const updates: unknown[] = [];
    const off = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      await expect(
        withSessionTranscriptWriteLock(scope, async (locked) => {
          await locked.appendMessage({
            eventId: "committed",
            message: { role: "assistant", content: "durable but failed" },
          });
          await locked.publishUpdate({ messageId: "committed" });
          throw new Error("Callback failed after append");
        }),
      ).rejects.toThrow("Callback failed after append");
      expect(messageIds(scope)).toEqual(["committed"]);
      expect(updates).toEqual([]);
    } finally {
      off();
    }
  });
});

it.for(["worker", "native"] as const)(
  "settles two unawaited %s appends FIFO across the real Gateway close prelude",
  async (kind, { signal }) => {
    const fixture = await createGatewayMetadataCloseFixture(`gateway-${kind}-locked-close`);
    const entered = createDeferred();
    const release = createDeferred();
    const prelude = createDeferred();
    const accepted: Promise<unknown>[] = [];
    let writing: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    let retained: SessionTranscriptWriteLockContext | undefined;
    try {
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      const scope = await seed(fixture.state.env);
      const database = openOpenClawAgentDatabase(scope);
      const order: string[] = [];
      let checkedAfterAbort = false;
      const assertCurrent = () => {
        expect(database.db.isOpen).toBe(true);
        checkedAfterAbort ||= kernel.scheduler.signal.aborted;
      };
      // Opaque released SDK authority retains the native adapter; prepared authority uses the worker.
      const authority =
        kind === "native"
          ? assertCurrent
          : composeSessionTranscriptWriteAssertion([], assertCurrent);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      kernel.scheduler.schedule({
        id: "accepted-locked-append",
        delayMs: 0,
        async run() {
          writing = withSessionTranscriptWriteAssertion(scope, authority, () =>
            withSessionTranscriptWriteLock(scope, (locked) => {
              retained = locked;
              const prepareFirst = async (message: unknown) => {
                if (kind === "native") {
                  expect(database.db.isTransaction).toBe(false);
                }
                entered.resolve();
                await release.promise;
                return message;
              };
              for (const eventId of ["first", "second"]) {
                accepted.push(
                  locked
                    .appendMessage({
                      eventId,
                      message: { role: "assistant", content: eventId },
                      prepareMessageAfterIdempotencyCheckAsync:
                        eventId === "first" ? prepareFirst : undefined,
                      ...(kind === "native"
                        ? {
                            beforeFreshMessageCommit: () => {
                              expect(database.db.isTransaction).toBe(true);
                              order.push(eventId);
                            },
                          }
                        : {}),
                    })
                    .then((result) => {
                      if (kind === "worker") {
                        order.push(eventId);
                      }
                      return result;
                    }),
                );
              }
              return "callback returned";
            }),
          );
          expect(await writing).toBe("callback returned");
          expect(database.db.isOpen).toBe(true);
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      assert(writing);
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, writing, "Lock was not admitted"),
        signal,
      );
      kernel.scheduler.signal.addEventListener("abort", () => prelude.resolve(), { once: true });
      closing = server.close({ reason: "accepted locked append close proof" });
      await withinTest(
        awaitGateBeforeSettlement(prelude.promise, closing, "Gateway skipped close prelude"),
        signal,
      );
      expect(kernel.scheduler.signal.aborted).toBe(true);
      assert(retained);
      await expect(retained.publishUpdate()).rejects.toThrow("context is closed");
      await expect(retained.readEvents()).rejects.toThrow("context is closed");
      expect(order).toEqual([]);
      expect(database.db.isOpen).toBe(true);
      release.resolve();
      await withinTest(Promise.all([writing, closing, ...accepted]), signal);
      if (kind === "worker") {
        expect(checkedAfterAbort).toBe(true);
      }
      expect(order).toEqual(["first", "second"]);
      expect(database.db.isOpen).toBe(false);
      const reopened = new DatabaseSync(database.path, { readOnly: true });
      try {
        const rows = reopened
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .all(scope.sessionId);
        expect(
          rows.map((row) => {
            assert(typeof row.event_json === "string");
            return JSON.parse(row.event_json).id;
          }),
        ).toEqual([scope.sessionId, "first", "second"]);
      } finally {
        reopened.close();
      }
    } finally {
      vi.useRealTimers();
      release.resolve();
      await Promise.allSettled([writing, closing, ...accepted]);
      await fixture.cleanup();
    }
  },
);

it.each(["live", "revoked", "foreign"] as const)(
  "retains logical mirror writer binding (%s)",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const physical = await seed(env);
      const scope = {
        ...physical,
        storePath: resolveSessionStorePathCore(undefined, { agentId: physical.agentId, env }),
      };
      expect(scope.storePath).not.toBe(physical.storePath);
      const target =
        mode === "foreign"
          ? { ...scope, sessionId: "foreign-mirror", sessionKey: "agent:main:foreign-mirror" }
          : scope;
      if (mode === "foreign") {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      }
      let current = true;
      const guard = composeSessionTranscriptWriteAssertion([], () => {
        if (!current) {
          throw new Error("Logical mirror writer revoked");
        }
      });
      const operation = withSessionTranscriptWriteAssertion(scope, guard, () => {
        if (mode === "revoked") {
          current = false;
        }
        return appendAssistantMirrorMessageByIdentity({
          ...target,
          text: "Owned terminal fallback",
          idempotencyKey: "logical-owned-mirror",
        });
      });
      if (mode === "live") {
        await expect(operation).resolves.toMatchObject({ ok: true });
      } else if (mode === "revoked") {
        await expect(operation).rejects.toThrow("Logical mirror writer revoked");
      } else {
        await expect(operation).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      }
      expect(messageIds(physical)).toHaveLength(mode === "live" ? 1 : 0);
      if (mode === "foreign") {
        expect(messageIds(target)).toEqual([]);
      }
    });
  },
);

it("cannot retarget owned authority by mutating a logical selector after dispatch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const physical = await seed(state.env);
    const requested = {
      ...physical,
      storePath: resolveSessionStorePathCore(undefined, {
        agentId: physical.agentId,
        env: state.env,
      }),
    };
    const owner = {
      ...physical,
      storePath: state.statePath("other-owner", "openclaw-agent.sqlite"),
    };
    await replaceSessionEntry(owner, { sessionId: owner.sessionId, updatedAt: 1 });
    await expect(
      withSessionTranscriptWriteAssertion(owner, composeSessionTranscriptWriteAssertion([]), () => {
        const pending = withTranscriptWriteLock(requested, (locked) =>
          locked.appendMessage({
            message: { role: "assistant", content: "must not cross stores" },
          }),
        );
        requested.storePath = owner.storePath;
        return pending;
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    expect(messageIds(physical)).toEqual([]);
    expect(messageIds(owner)).toEqual([]);
  });
});
