import assert from "node:assert/strict";
import { StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { readSessionTranscriptModelContextInWorker } from "./session-transcript-read-worker-runtime.js";

it("reuses freshly decoded model payloads while keeping stored and subsequent contexts detached", () =>
  withOpenClawTestState({ label: "model-context-payload-ownership" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "payload-ownership",
      sessionKey: "agent:main:payload-ownership",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
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

it("preserves canonical event bytes across compaction/reset retention and bounded fallback", () =>
  withOpenClawTestState({ label: "model-context-projection-parity" }, async (state) => {
    const { importSqliteSessionRowsBatch } = await import("./session-accessor.sqlite-import.js");
    const { readActiveTranscriptEntryAnchor } = await import("./session-accessor.js");
    const { runWithSessionTranscriptReadFence } =
      await import("./session-transcript-read-fence.js");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const user = (id: string, parentId: string | null) => ({
      type: "message",
      id,
      parentId,
      timestamp,
      message: { role: "user", content: `Question ${id} 🦞`, timestamp: 1 },
    });
    const assistant = (id: string, parentId: string | null) => ({
      type: "message",
      id,
      parentId,
      timestamp,
      message: {
        role: "assistant",
        provider: "openai",
        model: "synthetic",
        content: [{ type: "text", text: "Answer" }],
        timestamp: 2,
      },
    });
    for (const boundaryType of ["reset", "compaction"] as const) {
      for (const retained of [false, true]) {
        const sessionId = `${boundaryType}-${retained}`;
        const scope = {
          agentId: "main",
          sessionId,
          sessionKey: `agent:main:${sessionId}`,
          storePath: state.statePath("transcript.sqlite"),
        };
        const events = [
          { type: "session", version: 3, id: sessionId, cwd: "/synthetic", timestamp },
          {
            type: "model_change",
            id: "model",
            parentId: null,
            timestamp,
            provider: "openai",
            modelId: "synthetic",
          },
          {
            type: "thinking_level_change",
            id: "thinking",
            parentId: "model",
            timestamp,
            thinkingLevel: "high",
          },
          user("old", "thinking"),
          {
            ...assistant("kept", "old"),
            message: {
              role: "assistant",
              provider: "openai",
              model: "synthetic",
              content: [{ type: "toolCall", id: "read-call", name: "read", arguments: {} }],
              timestamp: 2,
            },
          },
          {
            type: "message",
            id: "result",
            parentId: "kept",
            timestamp,
            message: {
              role: "toolResult",
              toolCallId: "read-call",
              toolName: "read",
              content: [{ type: "text", text: "Synthetic result ".repeat(100) }],
              isError: false,
              timestamp: 3,
            },
          },
          {
            type: boundaryType,
            id: "boundary",
            parentId: "result",
            timestamp,
            ...(boundaryType === "compaction"
              ? {
                  summary: "Synthetic summary",
                  tokensBefore: 100,
                  firstKeptEntryId: retained ? "kept" : "boundary",
                }
              : { reason: "new", ...(retained ? { firstKeptEntryId: "kept" } : {}) }),
          },
          user("next", "boundary"),
          { ...user("side", "next"), appendMode: "side" },
          user("latest", "next"),
        ];
        await importSqliteSessionRowsBatch([
          {
            ...scope,
            entry: { sessionId, updatedAt: 1 },
            transcriptMtimeMs: 1,
            readTranscriptEvents: (append) => {
              for (const event of events) {
                append(event);
              }
            },
          },
        ]);
        const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "latest" });
        assert(anchor);
        const stored = JSON.stringify(loadTranscriptEventsSync(scope));
        for (const [maxEvents, maxBytes] of [
          [2, 8 * 1024 * 1024],
          [8, 8 * 1024 * 1024],
          [8, 1800],
        ]) {
          const limits = { maxBytes: maxBytes!, maxEvents: maxEvents! };
          // Historical reads independently replay canonical navigation, even at the current leaf.
          const canonical = readSessionTranscriptModelContext(scope, anchor, limits);
          const hostReads = observeSqliteReadSql(StatementSync.prototype);
          let projected: ReturnType<typeof readSessionTranscriptModelContext>;
          try {
            projected = readSessionTranscriptModelContext(scope, undefined, limits);
          } finally {
            hostReads.restore();
          }
          if (isMainThread) {
            expect(
              hostReads.queries.filter((query) =>
                query.includes("session_transcript_active_events"),
              ),
            ).toEqual([]);
          }
          expect(JSON.stringify(projected)).toBe(JSON.stringify(canonical));
          const workerContext = await readSessionTranscriptModelContextInWorker(
            scope,
            undefined,
            undefined,
            undefined,
            limits,
          );
          expect(JSON.stringify(workerContext)).toBe(JSON.stringify(canonical));
          expect(JSON.stringify(readSessionTranscriptModelContext(scope, undefined, limits))).toBe(
            JSON.stringify(canonical),
          );
        }
        expect(JSON.stringify(loadTranscriptEventsSync(scope))).toBe(stored);
        const manager = await SessionManager.openAsync(scope);
        const appended = await manager.appendMessageAsync({
          role: "user",
          content: "Appended synthetic turn",
          timestamp: 4,
        });
        assert(appended);
        const appendedAnchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: appended });
        assert(appendedAnchor);
        const appendLimits = { maxBytes: 8 * 1024 * 1024, maxEvents: 8 };
        expect(
          JSON.stringify(readSessionTranscriptModelContext(scope, undefined, appendLimits)),
        ).toBe(
          JSON.stringify(readSessionTranscriptModelContext(scope, appendedAnchor, appendLimits)),
        );
        const admitted = runWithSessionTranscriptReadFence(
          { ...appendedAnchor, logicalTurnId: "synthetic-turn", role: "user" },
          () => readSessionTranscriptModelContext(scope, undefined, appendLimits),
        );
        expect(JSON.stringify(admitted)).toBe(
          JSON.stringify(readSessionTranscriptModelContext(scope, anchor, appendLimits)),
        );
        const unknownKeyScope = { ...scope, sessionKey: "unknown" };
        expect(
          JSON.stringify(
            await readSessionTranscriptModelContextInWorker(
              unknownKeyScope,
              undefined,
              undefined,
              undefined,
              appendLimits,
            ),
          ),
        ).toBe(
          JSON.stringify(
            readSessionTranscriptModelContext(unknownKeyScope, undefined, appendLimits),
          ),
        );
      }
    }
  }));
