import { describe, expect, it } from "vitest";
import { MeetingSessionTranscriptStore } from "./session-transcript-store.js";
import type { MeetingSessionRecord } from "./session-types.js";

describe("MeetingSessionTranscriptStore", () => {
  it("trims an oversized initial snapshot to the retained tail", async () => {
    const session: MeetingSessionRecord<"chrome", "transcribe"> = {
      id: "session-1",
      url: "https://meeting.example/room",
      transport: "chrome",
      mode: "transcribe",
      agentId: "main",
      state: "active",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      participantIdentity: "OpenClaw",
      realtime: { enabled: false, toolPolicy: "none" },
      notes: [],
    };
    const store = new MeetingSessionTranscriptStore({
      getSession: (sessionId) => (sessionId === session.id ? session : undefined),
      isBrowserSession: () => true,
      isTranscribeSession: () => true,
      hasBrowserTab: () => true,
      capture: async () => ({
        droppedLines: 7,
        epoch: "page-1",
        lines: Array.from({ length: 2_005 }, (_, index) => ({ text: `line-${index}` })),
      }),
    });

    const result = await store.read(session.id);

    expect(result).toMatchObject({
      found: true,
      startIndex: 12,
      nextIndex: 2_012,
      droppedLines: 12,
    });
    expect(result.lines).toHaveLength(2_000);
    expect(result.lines?.[0]?.text).toBe("line-5");
    expect(result.lines?.at(-1)?.text).toBe("line-2004");
  });
});
