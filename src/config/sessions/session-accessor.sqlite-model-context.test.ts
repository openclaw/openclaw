import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";

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
