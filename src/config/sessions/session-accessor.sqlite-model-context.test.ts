import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
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
  readSessionTranscriptContextMessages,
  readSessionTranscriptModelContext,
} from "./session-accessor.sqlite-model-context.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";

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

it("streams long full-fidelity contexts with bounded statement counts and closes early readers", () =>
  withOpenClawTestState({ label: "context-payload-cursors" }, async (state) => {
    const scope = await seedScope(state, "cursors");
    const messages = Array.from({ length: 820 }, (_, index) => ({
      role: "user" as const,
      content: `Question ${index}`,
      timestamp: index,
    }));
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      ...messages.map((message, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        message,
      })),
    ]);
    const statements: unknown[] = [];
    const observe = (event: unknown) => statements.push(event);
    const events = channel("openclaw.database.statement");
    events.subscribe(observe);
    try {
      expect(readSessionTranscriptContextMessages(scope, (context) => [...context])).toEqual(
        messages,
      );
      expect(statements.length).toBeLessThan(20);
    } finally {
      events.unsubscribe(observe);
    }
    await appendTranscriptEvent(scope, {
      type: "custom",
      id: "bad-placement",
      parentId: "entry-819",
      customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
      data: { afterEntryId: "entry-819", resultEntryIds: ["missing-result"] },
    });
    let retained: Iterator<unknown> | undefined;
    readSessionTranscriptContextMessages(scope, (context) => {
      retained = context[Symbol.iterator]();
      expect(retained.next().value).toEqual(messages[0]);
    });
    expect(retained?.next().done).toBe(true);
    expect(() => readSessionTranscriptContextMessages(scope, (context) => [...context])).toThrow(
      "Background result placement payload is unavailable",
    );
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
    expect(readSessionTranscriptContextMessages(scope, (messages) => [...messages])).toEqual([
      legacy,
      signed,
      placed,
      next,
    ]);
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
    expect(readSessionTranscriptContextMessages(scope, (messages) => [...messages])).toEqual(
      compacted,
    );
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
