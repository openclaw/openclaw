import path from "node:path";
import type { Message } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  loadTranscriptReadSnapshotSync,
  readTranscriptExportSnapshotReadOnlySync,
} from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";

const holdLogger = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "sqlite/transaction" ? holdLogger : actual.createSubsystemLogger(subsystem),
  };
});

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-transcript-hold-");
const MARKER = "hold-probe-marker";

afterEach(() => {
  vi.restoreAllMocks();
  holdLogger.warn.mockClear();
});

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

describe("SQLite transcript readers release the read snapshot before decoding", () => {
  async function seedSession() {
    const tempDir = sessionDirs.make();
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "session-hold";
    const sessionKey = "agent:main:hold";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    const events = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-04-01T05:46:39.000Z",
        cwd: tempDir,
      },
      // Large and repetitive so the stored form is zstd; small rows stay plain JSON.
      ...Array.from({ length: 4 }, (_, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: "2026-04-01T05:46:40.000Z",
        message: userMessage(
          index % 2 === 0 ? `${MARKER} ${"lobster ".repeat(600)}` : `${MARKER} short`,
        ),
      })),
    ];
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceTranscriptEvents(scope, events);
    return { events, scope };
  }

  /** Each decode and projection advances a virtual clock, so work inside a transaction logs a hold. */
  function chargeWorkToClock(millisecondsPerStep: number) {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const realParse = JSON.parse.bind(JSON);
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes(MARKER)) {
        now += millisecondsPerStep;
      }
      return realParse(text, reviver);
    });
    return () => {
      now += millisecondsPerStep;
    };
  }

  function slowHolds() {
    return holdLogger.warn.mock.calls.filter(
      ([message]) => message === "slow SQLite transaction hold",
    );
  }

  it("decodes and projects export snapshot payloads outside the read transaction", async () => {
    const { events, scope } = await seedSession();
    const charge = chargeWorkToClock(2_000);
    const projectEvent = vi.fn((event: unknown) => {
      charge();
      return event;
    });
    const snapshot = readTranscriptExportSnapshotReadOnlySync(scope, { projectEvent });
    expect(snapshot?.events).toEqual(events);
    expect(projectEvent.mock.calls.map(([event]) => event)).toEqual(events);
    expect(slowHolds()).toEqual([]);
  });

  it("decodes fenced read payloads outside the read transaction", async () => {
    const { events, scope } = await seedSession();
    chargeWorkToClock(2_000);
    const snapshot = loadTranscriptReadSnapshotSync(scope, { readOnly: true });
    expect(snapshot.events).toEqual(events);
    expect(slowHolds()).toEqual([]);
  });

  it.each([
    [
      "export snapshot",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        readTranscriptExportSnapshotReadOnlySync(scope),
    ],
    [
      "fenced read",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        loadTranscriptReadSnapshotSync(scope, { readOnly: true }),
    ],
  ])(
    "surfaces the payload length error from a corrupt compressed row (%s)",
    async (_name, read) => {
      const { scope } = await seedSession();
      const { db } = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      db.prepare(
        "UPDATE transcript_events SET event_utf8_bytes = event_utf8_bytes + 1 WHERE session_id = ? AND event_zstd IS NOT NULL",
      ).run(scope.sessionId);
      expect(() => read(scope)).toThrow(/Compressed transcript payload length does not match/u);
    },
  );
});
