import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveSessionLifecycleTimestampsAsync } from "./lifecycle-read.js";
import { upsertSessionEntryCore } from "./session-accessor.entry.js";
import {
  replaceTranscriptEvents,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as transcriptReaders from "./session-transcript-execution-read.js";

function scopeFor(state: OpenClawTestState) {
  return {
    agentId: "main",
    sessionId: "lifecycle-header",
    sessionKey: "agent:main:lifecycle-header",
    storePath: state.statePath("transcript.sqlite"),
  };
}

const header = { type: "session", id: "lifecycle-header", version: 3, timestamp: "2026" };

it("recovers lifecycle timestamps without caller SQL and observes foreign header commits", async () => {
  await withOpenClawTestState({ label: "lifecycle-header-worker" }, async (state) => {
    const scope = scopeFor(state);
    await replaceTranscriptEvents(scope, [header]);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const entry = { sessionId: scope.sessionId, updatedAt: 42, lastInteractionAt: 7 };
    const read = async () => {
      const sql = observeHostDataSql();
      try {
        const result = await resolveSessionLifecycleTimestampsAsync({ ...scope, entry });
        expect(sql.queries).toEqual([]);
        return result;
      } finally {
        sql.restore();
      }
    };
    await expect(read()).resolves.toEqual({
      sessionStartedAt: Date.parse(header.timestamp),
      lastInteractionAt: 7,
    });
    const foreign = new DatabaseSync(scope.storePath);
    try {
      foreign
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 0")
        .run(JSON.stringify({ ...header, timestamp: "2027" }), scope.sessionId);
    } finally {
      foreign.close();
    }
    await expect(read()).resolves.toEqual({
      sessionStartedAt: Date.parse("2027"),
      lastInteractionAt: 7,
    });
    await expect(
      resolveSessionLifecycleTimestampsAsync({
        ...scope,
        entry: { ...entry, sessionStartedAt: 10 },
      }),
    ).resolves.toEqual({ sessionStartedAt: 10, lastInteractionAt: 7 });
  });
});

it.each(["rewrite", "close"] as const)(
  "rejects lifecycle header disclosure after an intervening %s",
  async (intervention) => {
    await withOpenClawTestState({ label: "lifecycle-header-revocation" }, async (state) => {
      const scope = scopeFor(state);
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 42 });
      await replaceTranscriptEvents(scope, [header]);
      const createReaders = transcriptReaders.createPreparedSessionTranscriptReads;
      let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
      let intercepted = false;
      const spy = vi
        .spyOn(transcriptReaders, "createPreparedSessionTranscriptReads")
        .mockImplementation((params) => {
          const readers = createReaders(params);
          return {
            ...readers,
            readAnchors: async (input, signal) => {
              const facts = await readers.readAnchors(input, signal);
              if (input.selection.includeHeader) {
                intercepted = true;
                if (intervention === "rewrite") {
                  expect(
                    replaceTranscriptEventsSync(scope, [{ ...header, timestamp: "2027" }]),
                  ).toBe(true);
                } else {
                  // The independent close revokes now, then joins the read after disclosure is refused.
                  closing = runInDetachedAsyncContext(() =>
                    closeOpenClawAgentDatabaseByPathAsync(scope.storePath),
                  );
                }
              }
              return facts;
            },
          };
        });
      try {
        await expect(
          resolveSessionLifecycleTimestampsAsync({
            ...scope,
            entry: { sessionId: scope.sessionId, updatedAt: 42 },
          }),
        ).rejects.toThrow(/transcript|revoked|closed|current|admission/i);
        expect(intercepted).toBe(true);
      } finally {
        spy.mockRestore();
        await closing;
      }
    });
  },
);
