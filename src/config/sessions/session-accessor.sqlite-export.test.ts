import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { readTranscriptExportSnapshotReadOnlySync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

it("omits tool payloads from memory exports without changing identity, provenance, or durable bytes", async () => {
  await withOpenClawTestState({ label: "transcript-export-payloads" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "export-session",
      sessionKey: "agent:main:export-session",
    };
    const events = [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "user", message: { role: "user", content: "Question" } },
      {
        type: "message",
        id: "result",
        parentId: "user",
        timestamp: 2,
        message: {
          role: "toolResult",
          toolCallId: "call",
          content: [{ type: "text", text: "x".repeat(256 * 1024) }],
          details: { opaque: "y".repeat(256 * 1024) },
          __openclaw: { runId: "dreaming-narrative:fixture" },
        },
      },
      { type: "reset", id: "reset", firstKeptEntryId: "result" },
      { type: "message", id: "answer", message: { role: "assistant", content: "Answer" } },
    ];
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, events);
    const full = readTranscriptExportSnapshotReadOnlySync(scope)!;
    const projected = readTranscriptExportSnapshotReadOnlySync(scope, {
      omitToolResultPayloads: true,
    })!;
    const { content: _content, details: _details, ...metadata } = events[2]!.message!;
    expect(projected).toEqual({
      ...full,
      events: full.events.map((event, index) =>
        index === 2 ? { ...events[2], message: metadata } : event,
      ),
    });
    expect(JSON.stringify(projected.events).length).toBeLessThan(2048);
    expect(readTranscriptExportSnapshotReadOnlySync(scope)).toEqual(full);
    expect(() =>
      readTranscriptExportSnapshotReadOnlySync(
        { ...scope, maxEventBytes: 1024 },
        { omitToolResultPayloads: true },
      ),
    ).toThrow();
  });
});
