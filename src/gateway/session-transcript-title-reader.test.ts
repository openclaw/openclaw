import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  persistSessionTranscriptTurn,
  type SessionTranscriptMessageEvent,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readSessionTitleFieldsFromTranscriptAsync as readTitlesAsync } from "./session-transcript-title-reader.js";
import { readSessionTitleFieldsFromTranscript as readTitles } from "./session-transcript-title-reader.worker.js";

vi.mock("../config/sessions/session-accessor.sqlite-active-events.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../config/sessions/session-accessor.sqlite-active-events.js")
    >();
  return {
    ...actual,
    readSessionTranscriptBoundedMessageTailPage: vi.fn(
      actual.readSessionTranscriptBoundedMessageTailPage,
    ),
    readSessionTranscriptMessageEventPage: vi.fn(actual.readSessionTranscriptMessageEventPage),
    readSessionTranscriptMessageEvents: vi.fn(actual.readSessionTranscriptMessageEvents),
  };
});

const tempDirs = createTempDirTracker();

let tempDir: string;
let storePath: string;
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(() => {
  vi.clearAllMocks();
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  tempDir = tempDirs.make("openclaw-transcript-titles-");
  storePath = path.join(tempDir, "sessions.json");
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  tempDirs.cleanup();
  envSnapshot.restore();
});

function expectTitle(
  scope: Parameters<typeof readTitles>[0],
  firstUserMessage: string | null,
  lastMessagePreview: string | null,
  options?: Parameters<typeof readTitles>[1],
) {
  expect(readTitles(scope, options)).toEqual({ firstUserMessage, lastMessagePreview });
}
const user = (content: unknown, fields = {}) => ({ role: "user", content, ...fields });
const assistant = (content: unknown) => ({ role: "assistant", content });
const repeatedReplies = (count: number, content: string) =>
  Array.from({ length: count }, () => assistant(content));
function scopeFor(sessionId: string) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}
function event(id: string, parentId: string | null, message: Record<string, unknown>) {
  return { type: "message", id, parentId, message };
}
async function writeTranscript(sessionId: string, events: unknown[]) {
  const scope = scopeFor(sessionId);
  await replaceTranscriptEvents(scope, events);
  return scope;
}

async function appendMessages(
  scope: Parameters<typeof persistSessionTranscriptTurn>[0],
  messages: Array<{ content: unknown; display?: boolean; provenance?: unknown; role: string }>,
) {
  await persistSessionTranscriptTurn(scope, {
    messages: messages.map((message) => ({ message })),
    touchSessionEntry: false,
  });
}
async function writeSqliteMessages(
  sessionId: string,
  messages: Array<{ content: unknown; display?: boolean; provenance?: unknown; role: string }>,
) {
  const scope = scopeFor(sessionId);
  await appendMessages(scope, messages);
  return scope;
}

describe("session transcript title hydration", () => {
  test("selects usable tasks without contaminating the list cache with command metadata", async () => {
    const scope = await writeSqliteMessages("reader-title-command-source", [
      user("/status"),
      user("[Mon 2026-08-10 12:00 UTC] /topic_proof /api routing needs repair"),
      user("[Mon 2026-08-10 12:01 UTC] Later ordinary task"),
    ]);
    const skillCommands = [
      { name: "topic_proof", skillName: "topic-proof", description: "Review a task" },
    ];
    expect(readTitles(scope).firstUserMessage).toBe("Later ordinary task");
    expect((await readTitlesAsync(scope, { skillCommands })).firstUserMessage).toBe(
      "/api routing needs repair",
    );
    expect(readTitles(scope, { skillCommands }).firstUserMessage).toBe("/api routing needs repair");
    expect((await readTitlesAsync(scope)).firstUserMessage).toBe("Later ordinary task");
  });

  test("reads fresh title fields in the worker after in-process appends and rewrites", async () => {
    const scope = await writeSqliteMessages("reader-title-worker", [
      user("Original question"),
      assistant("Initial answer"),
    ]);
    await readTitlesAsync(scope);
    const read = async (firstUserMessage: string, lastMessagePreview: string) => {
      const sql = observeHostDataSql();
      try {
        await expect(readTitlesAsync(scope)).resolves.toEqual({
          firstUserMessage,
          lastMessagePreview,
        });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    };
    await appendMessages(scope, [assistant("Latest answer")]);
    await read("Original question", "Latest answer");
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      event("replacement", null, user("Replacement question")),
    ]);
    await read("Replacement question", "Replacement question");
  });

  test("keeps cold transcripts archived while reading mixed title rows and heals after restoration", async () => {
    const cold = await writeTranscript("reader-title-archived", [
      { type: "session", version: 3, id: "reader-title-archived" },
      event("user", null, user("Archived prompt")),
      event("reply", "user", assistant("Archived reply")),
    ]);
    await sessionAccessor.replaceSessionEntry(cold, {
      sessionId: cold.sessionId,
      updatedAt: Date.now(),
    });
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: database.path });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 40 * 24 * 60 * 60 * 1000);
    try {
      await expect(
        runSessionColdStorageMaintenance({
          config: {
            agents: { entries: { main: {} } },
            session: {
              store: storePath,
              maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
            },
          },
        }),
      ).resolves.toMatchObject({ archivedTranscripts: 1 });
    } finally {
      clock.mockRestore();
    }
    const archive = readSessionColdTranscript(database.db, cold.sessionId);
    expect(archive).toBeDefined();
    const hot = await writeSqliteMessages("reader-title-hot", [
      user("Hot prompt"),
      assistant("Hot reply"),
    ]);
    expectTitle(cold, null, null);
    expectTitle(hot, "Hot prompt", "Hot reply");
    expectTitle(cold, null, null);
    expect(readSessionColdTranscript(database.db, cold.sessionId)).toEqual(archive);

    await restoreSessionColdTranscript(cold);
    expectTitle(cold, "Archived prompt", "Archived reply");
  });

  test("finds the late first user and last nonblank reply with bounded probes", async () => {
    const scope = await writeSqliteMessages(
      "reader-title-parity",
      Array.from({ length: 105 }, (_, index) => {
        if (index === 60) {
          return user("late prompt");
        }
        if (index === 102) {
          return assistant("last visible");
        }
        return { role: "assistant", content: index > 102 ? " " : `reply ${String(index)}` };
      }),
    );
    vi.clearAllMocks();
    expectTitle(scope, "late prompt", "last visible");
    expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
  });

  test("invalidates both cached title variants after an appended reset", async () => {
    const sessionId = "reader-title-reset-window";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      event("old", null, user("hidden old prompt")),
      event("kept-routed", "old", {
        role: "user",
        content: "kept routed prompt",
        provenance: { kind: "inter_session" },
      }),
      event("kept-user", "kept-routed", user("kept prompt")),
      event("kept-assistant", "kept-user", assistant("kept answer")),
    ]);
    const before = sessionAccessor.readSessionTranscriptWatermark(scope);
    for (const includeInterSession of [false, true]) {
      expectTitle(scope, "hidden old prompt", "kept answer", { includeInterSession });
    }
    await sessionAccessor.appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      firstKeptEntryId: "kept-routed",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "post-reset", parentId: "reset-boundary", message: user("new question") },
        { eventId: "newest", parentId: "post-reset", message: assistant("newest answer") },
      ],
      touchSessionEntry: false,
    });
    expect(sessionAccessor.readSessionTranscriptWatermark(scope).generation).toBe(
      before.generation,
    );
    for (const includeInterSession of [false, true, false, true]) {
      expectTitle(
        scope,
        includeInterSession ? "kept routed prompt" : "kept prompt",
        "newest answer",
        { includeInterSession },
      );
    }
  });

  test("keeps cached title fields independent when agents share a session id", async () => {
    const sessionId = "reader-title-duplicate-session-id";
    const scopes = [
      { agentId: "main", sessionId, sessionKey: "agent:main:duplicate-title" },
      { agentId: "work", sessionId, sessionKey: "agent:work:duplicate-title" },
    ];
    for (const [index, scope] of scopes.entries()) {
      await appendMessages(scope, [user(`prompt ${index}`), assistant(`reply ${index}`)]);
    }
    for (const [index, scope] of [...scopes.entries(), ...scopes.entries()]) {
      expectTitle(scope, `prompt ${index}`, `reply ${index}`);
    }
  });

  test("keeps the first user title when an append lands between tail and head probes", async () => {
    const scope = await writeSqliteMessages("reader-title-concurrent-append", [
      user("Original question"),
      user("Later question"),
      ...Array.from({ length: 18 }, () => assistant("Older reply")),
    ]);
    await sessionAccessor.replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const actual = await vi.importActual<
      typeof import("../config/sessions/session-accessor.sqlite-active-events.js")
    >("../config/sessions/session-accessor.sqlite-active-events.js");
    const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
    pageReader.mockImplementationOnce((readScope, options) => {
      expect(
        sessionAccessor.appendTranscriptMessageSync(scope, {
          message: assistant("Concurrent reply"),
        }),
      ).toMatchObject({ ok: true, value: { appended: true } });
      return actual.readSessionTranscriptMessageEventPage(readScope, options);
    });

    const first = readTitles(scope);
    const next = readTitles(scope);
    expect([first.firstUserMessage, next.firstUserMessage]).toEqual([
      "Original question",
      "Original question",
    ]);
    expect(next.lastMessagePreview).toBe("Concurrent reply");
    expect(pageReader).toHaveBeenCalledTimes(1);
  });

  test("caps a missing title probe at 100 rows after an append", async () => {
    const messageCount = 100;
    const sessionId = `reader-title-late-user-${messageCount}`;
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "Routed work", provenance: { kind: "inter_session" } },
      ...repeatedReplies(messageCount - 1, "reply"),
    ]);
    expect(readTitles(scope).firstUserMessage).toBeNull();
    expect(readTitles(scope, { includeInterSession: true }).firstUserMessage).toBe("Routed work");
    await writeSqliteMessages(sessionId, [user("First human question")]);
    vi.clearAllMocks();

    expect(readTitles(scope, { includeInterSession: true }).firstUserMessage).toBe("Routed work");
    expectTitle(scope, null, "First human question");
    const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
    expect(pageReader).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).toHaveBeenCalledTimes(1);
  });

  test("preserves previews across an oversized assistant tail message", async () => {
    const sessionId = "reader-title-oversized-assistant-false";
    const scope = await writeSqliteMessages(sessionId, [
      user("Original question"),
      ...Array.from({ length: 25 }, () => assistant("Earlier reply")),
    ]);
    expect(readTitles(scope).firstUserMessage).toBe("Original question");
    await writeSqliteMessages(sessionId, [assistant("x".repeat(70 * 1024))]);
    vi.clearAllMocks();

    expectTitle(scope, "Original question", `${"x".repeat(237)}...`);
    expect(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(sessionAccessor.readSessionTranscriptMessageEventPage)
        .mock.calls.map(([, options]) => options),
    ).toEqual([{ maxMessages: 20, offset: 0 }]);
  });
});

describe("session transcript Markdown title previews", () => {
  test("stops reading older content after widening to the newest visible preview", async () => {
    const hiddenMessages = [
      { role: "toolResult", content: "tool output" },
      { role: "system", content: "system event" },
      { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }] },
      assistant("NO_REPLY"),
      { role: "assistant", content: "ANNOUNCE_SKIP", display: false },
      { role: "assistant", content: "REPLY_SKIP", display: false },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      assistant("```ts\nconst hidden = true;\n```"),
    ];
    const olderText = "Earlier **reply**";
    // Keep the observed row outside the first-user head probe, including after widening.
    const prefix = [
      user("Keep **title Markdown** unchanged"),
      ...Array.from({ length: 100 }, () => ({ role: "toolResult", content: "tool output" })),
    ];
    const olderSeq = prefix.length + 1;
    const scope = await writeSqliteMessages("reader-title-short-circuit-true", [
      ...prefix,
      { role: "assistant", content: [{ type: "text", text: olderText }] },
      {
        role: "assistant",
        content: "# Latest\n\nRead the [guide](https://example.com).",
        display: true,
      },
      ...Array.from({ length: 3 }, () => hiddenMessages).flat(),
    ]);
    const actual = await vi.importActual<
      typeof import("../config/sessions/session-accessor.sqlite-active-events.js")
    >("../config/sessions/session-accessor.sqlite-active-events.js");
    const readOlderText = vi.fn(() => olderText);
    let observedRows = 0;
    const observeOlderContent = (
      entries: Pick<SessionTranscriptMessageEvent, "event" | "seq">[],
    ) => {
      for (const entry of entries) {
        if (entry.seq !== olderSeq) {
          continue;
        }
        observedRows += 1;
        entry.event = {
          ...asOptionalRecord(entry.event),
          message: {
            role: "assistant",
            // Nested text survives transcript metadata normalization; only projection reads it.
            content: [
              {
                type: "text",
                get text() {
                  return readOlderText();
                },
              },
            ],
          },
        };
      }
    };
    const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptBoundedMessageTailPage);
    try {
      pageReader.mockImplementation((readScope, options) => {
        const page = actual.readSessionTranscriptBoundedMessageTailPage(readScope, options);
        observeOlderContent(page.events);
        return page;
      });
      expectTitle(scope, "Keep **title Markdown** unchanged", "Latest Read the guide.");
      expect(observedRows).toBe(1);
      expect(readOlderText).not.toHaveBeenCalled();
    } finally {
      pageReader.mockImplementation(actual.readSessionTranscriptBoundedMessageTailPage);
    }
  });
});
