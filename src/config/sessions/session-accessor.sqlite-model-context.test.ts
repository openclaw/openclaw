import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
  waitForSessionTranscriptProjection,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import {
  prepareTranscriptContextSnapshot,
  readSessionTranscriptModelContext,
} from "./session-accessor.sqlite-model-context.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";

async function seedScope(state: { statePath(name: string): string }, sessionId: string) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: state.statePath("transcript.sqlite"),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return scope;
}

it("does not size unbounded snapshots until model byte accounting is requested", () =>
  withOpenClawTestState({ label: "unbounded-context-sizing" }, async (state) => {
    const scope = await seedScope(state, "unbounded-sizing");
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync({ role: "user", content: "First question", timestamp: 1 });
    await manager.appendMessageAsync({ role: "user", content: "Second question", timestamp: 2 });
    const stored = loadTranscriptEventsSync(scope).filter(
      (entry) => isIndexedSessionEntry(entry) && entry.type === "message",
    );
    const resolved = resolveSqliteTranscriptReadScope(scope);
    const read = withOpenClawAgentDatabaseReadOnly((database) => {
      const { db } = database;
      assert(!isPostgresSqlConnection(db));
      let sizedRows = 0;
      db.function("octet_length", (value) => {
        sizedRows++;
        return Buffer.byteLength(String(value));
      });
      return runSqliteReadSnapshotSync(db, () => {
        const snapshot = prepareTranscriptContextSnapshot(database, resolved);
        expect(sizedRows).toBe(0);
        const entries = snapshot.entries.filter((entry) => entry.type === "message");
        expect(entries.map((entry) => snapshot.readEntry(entry))).toEqual(stored);
        const requests = entries.map((entry) => ({ entry, omitCheckpoint: false }));
        expect([...snapshot.readModelEntrySizes(requests).values()]).toEqual(
          stored.map((entry) => Buffer.byteLength(JSON.stringify(entry))),
        );
        expect(sizedRows).toBe(entries.length);
      });
    }, toDatabaseOptions(resolved));
    expect(read.found).toBe(true);
  }));

it("retains accepted background artifacts across bounded placement and compaction without rewriting legacy history", () =>
  withOpenClawTestState({ label: "background-result-placement" }, async (state) => {
    const scope = await seedScope(state, "placement");
    const manager = await SessionManager.openAsync(scope);
    const legacy = makeAgentAssistantMessage({
      provider: "openclaw",
      model: "automation-result",
      content: [{ type: "text", text: "Legacy result" }],
    });
    await manager.appendMessageAsync(legacy);
    const pending = {
      ...legacy,
      content: [{ type: "text" as const, text: "Deferred result" }],
      excludeFromContext: true,
      openclawModelPlacement: "pending",
    };
    const resultId = await manager.appendMessageAsync(pending);
    assert(resultId);
    const signed = makeAgentAssistantMessage({
      content: [{ type: "text", text: "Provider output" }],
    });
    const afterEntryId = await manager.appendMessageAsync(signed);
    assert(afterEntryId);
    for (const round of [0, 1]) {
      for (const limits of [undefined, { maxBytes: 16384, maxEvents: 1 }]) {
        const recovered = await SessionManager.openModelContextAsync(scope, { limits });
        const artifact = recovered.getEntry(resultId);
        assert(artifact?.type === "message");
        expect(artifact.message).toEqual(pending);
        expect(recovered.buildSessionContext().messages).toEqual(
          limits ? [signed] : [legacy, signed],
        );
      }
      if (round === 0) {
        // An ordinary append refreshes the warm navigation cache before recovery places the result.
        await manager.appendCustomEntryAsync("recovery-checkpoint", {});
      }
    }
    const before = JSON.stringify(loadTranscriptEventsSync(scope));
    const bounded = await SessionManager.openBoundedAsync(scope, { maxBytes: 16384, maxEvents: 2 });
    expect(bounded.getBranch().some((entry) => entry.id === resultId)).toBe(true);
    expect(bounded.buildSessionContext().messages).toEqual([signed]);
    expect((await SessionManager.openAsync(scope)).buildSessionContext().messages).toEqual([
      legacy,
      signed,
    ]);
    expect(JSON.stringify(loadTranscriptEventsSync(scope))).toBe(before);
    const marker = await manager.appendCustomEntryAsync(BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE, {
      afterEntryId,
      resultEntryIds: [resultId],
    });
    const next = { role: "user" as const, content: "Continue", timestamp: 1 };
    await manager.appendMessageAsync(next);
    const placed = { ...legacy, content: pending.content };
    for (const read of [
      () => SessionManager.openAsync(scope),
      () => SessionManager.openModelContextAsync(scope),
      () =>
        SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 16384, maxEvents: 100 },
        }),
    ]) {
      expect((await read()).buildSessionContext().messages).toEqual([legacy, signed, placed, next]);
    }
    const tail = { maxBytes: 16384, maxEvents: 2 };
    // The second model-context read reuses the navigation cache after the source's physical row
    // left its retained suffix.
    for (const read of [
      () => SessionManager.openBoundedAsync(scope, tail),
      () => SessionManager.openModelContextAsync(scope, { limits: tail }),
      () => SessionManager.openModelContextAsync(scope, { limits: tail }),
    ]) {
      expect((await read()).buildSessionContext().messages).toEqual([placed, next]);
    }
    await manager.appendCompactionAsync("Earlier conversation", marker, 100);
    const compacted = (await SessionManager.openModelContextAsync(scope)).buildSessionContext()
      .messages;
    expect(compacted.slice(1)).toEqual([placed, next]);
    expect(
      JSON.stringify(loadTranscriptEventsSync(scope).slice(0, JSON.parse(before).length)),
    ).toBe(before);
  }));

it.each(["missing", "unknown"] as const)(
  "honors resets with %s identity facts when bounding background results",
  (identity) =>
    withOpenClawTestState({ label: `background-reset-${identity}` }, async (state) => {
      const scope = await seedScope(state, "placement");
      await SessionManager.openAsync(scope);
      await appendTranscriptMessage(scope, {
        eventId: "pending",
        message: {
          ...makeAgentAssistantMessage({
            provider: "openclaw",
            model: "automation-result",
            content: [{ type: "text", text: "Result before reset" }],
          }),
          excludeFromContext: true,
          openclawModelPlacement: "pending",
        },
      });
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: identity === "unknown" ? "reset" : undefined,
        reason: "new",
      });
      await appendTranscriptMessage(scope, {
        eventId: "tail",
        message: { role: "user", content: "Later request", timestamp: 1 },
      });
      await waitForSessionTranscriptProjection(scope);
      if (identity === "unknown") {
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            const changed = db
              .prepare(
                "UPDATE transcript_event_identities SET event_type=NULL WHERE session_id=? AND event_id=?",
              )
              .run(scope.sessionId, "reset");
            expect(changed.changes).toBe(1);
          },
          toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
        );
      }
      const context = readSessionTranscriptBoundedActiveContextCore(scope, {
        maxBytes: 16_384,
        maxEvents: 1,
      });
      expect(context.events).toMatchObject([{ type: "session" }, { id: "tail" }]);
      expect(context.totalEvents).toBe(3);
    }),
);

it("reuses freshly decoded model payloads while keeping stored and subsequent contexts detached", () =>
  withOpenClawTestState({ label: "model-context-payload-ownership" }, async (state) => {
    const scope = await seedScope(state, "payload-ownership");
    const manager = await SessionManager.openAsync(scope);
    const retainedId = await manager.appendMessageAsync({
      role: "user",
      content: "retained question",
      timestamp: 1,
    });
    assert(retainedId);
    const compactionId = await manager.appendCompactionAsync("earlier context", retainedId, 100);
    const latestId = await manager.appendMessageAsync({
      role: "user",
      content: "latest question",
      timestamp: 2,
    });
    const stored = JSON.stringify(loadTranscriptEventsSync(scope));
    const parse = vi.spyOn(JSON, "parse");
    let context: ReturnType<typeof readSessionTranscriptModelContext>;
    let decoded: unknown[];
    try {
      context = readSessionTranscriptModelContext(scope, undefined, {
        maxBytes: 8192,
        maxEvents: 2,
      });
      decoded = parse.mock.results.map((result) => result.value);
    } finally {
      parse.mockRestore();
    }
    expect(context.events.slice(1)).toMatchObject([
      {
        type: "compaction",
        id: compactionId,
        parentId: null,
        firstKeptEntryId: compactionId,
        summary: "earlier context",
      },
      {
        type: "message",
        id: latestId,
        parentId: compactionId,
        message: { role: "user", content: "latest question", timestamp: 2 },
      },
    ]);
    const serialized = JSON.stringify(context);
    const message = context.events.at(-1);
    assert(message && typeof message === "object" && "message" in message);
    assert(message.message && typeof message.message === "object");
    Object.assign(message.message, { content: "caller mutation" });
    expect(
      JSON.stringify(
        readSessionTranscriptModelContext(scope, undefined, { maxBytes: 8192, maxEvents: 2 }),
      ),
    ).toBe(serialized);
    expect(JSON.stringify(loadTranscriptEventsSync(scope))).toBe(stored);
    for (const event of context.events) {
      expect(decoded).toContain(event);
    }
  }));
