import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  persistSessionTranscriptTurn,
  replaceTranscriptEvents,
  type SessionTranscriptMessageEvent,
} from "../config/sessions/session-accessor.js";
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
import {
  readSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";
import { readSessionTitleFieldsFromTranscript } from "./session-transcript-title-reader.js";

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    readSessionTranscriptBoundedMessageTailPage: vi.fn(
      actual.readSessionTranscriptBoundedMessageTailPage,
    ),
    readSessionTranscriptMessageEventPage: vi.fn(actual.readSessionTranscriptMessageEventPage),
    readSessionTranscriptMessageEvents: vi.fn(actual.readSessionTranscriptMessageEvents),
    readSessionTranscriptWatermark: vi.fn(actual.readSessionTranscriptWatermark),
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
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  envSnapshot.restore();
});

async function writeTranscript(sessionId: string, events: unknown[]) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
  };
  await replaceTranscriptEvents(scope, events);
  return scope;
}

async function writeSqliteMessages(
  sessionId: string,
  messages: Array<{ content: unknown; provenance?: unknown; role: string }>,
) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
  };
  await persistSessionTranscriptTurn(scope, {
    messages: messages.map((message) => ({ message })),
    touchSessionEntry: false,
  });
  return scope;
}

function markProjectionNeedsRebuild(sessionId: string): void {
  openOpenClawAgentDatabase({
    agentId: "main",
    path: path.join(tempDir, "openclaw-agent.sqlite"),
  })
    .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(sessionId);
}

function extractReferenceText(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text
        : "",
    )
    .filter((part) => part.trim())
    .join("\n")
    .trim();
  return text || null;
}

async function readFullScanTitleFields(scope: SessionTranscriptReadScope) {
  const messages = await readSessionMessagesAsync(scope, {
    mode: "full",
    reason: "title probe parity reference",
  });
  const firstUser = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { role?: unknown }).role === "user" &&
      (message as { provenance?: { kind?: unknown } }).provenance?.kind !== "inter_session",
  );
  return {
    firstUserMessage: firstUser ? extractReferenceText(firstUser) : null,
    lastMessagePreview: messages.toReversed().map(extractReferenceText).find(Boolean) ?? null,
  };
}

function boundedTitleEventReadCount(): number {
  return [
    ...vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage).mock.results,
    ...vi.mocked(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).mock.results,
  ].reduce(
    (total, result) => total + (result.type === "return" ? result.value.events.length : 0),
    0,
  );
}

test.each([
  "src/gateway/session-transcript-title-reader.ts",
  "src/gateway/session-transcript-read-kernel.ts",
])("keeps %s independent of the host transcript reader", (entry) => {
  expect(findSourceImportBackedges(entry, ["src/gateway/session-transcript-readers.ts"])).toEqual(
    [],
  );
});

describe("session transcript title hydration", () => {
  test("keeps cold transcripts archived while reading mixed title rows and heals after restoration", async () => {
    const cold = await writeTranscript("reader-title-archived", [
      { type: "session", version: 3, id: "reader-title-archived" },
      {
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: "Archived prompt" },
      },
      {
        type: "message",
        id: "reply",
        parentId: "user",
        message: { role: "assistant", content: "Archived reply" },
      },
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
            agents: { list: [{ id: "main" }] },
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
      { role: "user", content: "Hot prompt" },
      { role: "assistant", content: "Hot reply" },
    ]);
    const empty = { firstUserMessage: null, lastMessagePreview: null };
    expect(readSessionTitleFieldsFromTranscript(cold)).toEqual(empty);
    expect(readSessionTitleFieldsFromTranscript(hot)).toEqual({
      firstUserMessage: "Hot prompt",
      lastMessagePreview: "Hot reply",
    });
    expect(readSessionTitleFieldsFromTranscript(cold)).toEqual(empty);
    expect(readSessionColdTranscript(database.db, cold.sessionId)).toEqual(archive);

    await restoreSessionColdTranscript(cold);
    expect(readSessionTitleFieldsFromTranscript(cold)).toEqual({
      firstUserMessage: "Archived prompt",
      lastMessagePreview: "Archived reply",
    });
  });

  test("keeps bounded title fields at full-scan parity", async () => {
    const scope = await writeSqliteMessages(
      "reader-title-parity",
      Array.from({ length: 105 }, (_, index) => {
        if (index === 60) {
          return { role: "user", content: "late prompt" };
        }
        if (index === 102) {
          return { role: "assistant", content: "last visible" };
        }
        return { role: "assistant", content: index > 102 ? " " : `reply ${String(index)}` };
      }),
    );
    const reference = await readFullScanTitleFields(scope);
    expect(reference).toEqual({
      firstUserMessage: "late prompt",
      lastMessagePreview: "last visible",
    });
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual(reference);
    expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
  });

  test("keeps inter-session title variants independent through cache reuse and append", async () => {
    const scope = await writeSqliteMessages("reader-title-provenance-variants", [
      { role: "user", content: "Routed work", provenance: { kind: "inter_session" } },
      { role: "user", content: "Human question" },
      { role: "assistant", content: "**Initial** answer" },
    ]);
    const readVariants = (preview: string) => {
      for (const includeInterSession of [false, true, false, true]) {
        const fields = readSessionTitleFieldsFromTranscript(scope, { includeInterSession });
        expect(fields.firstUserMessage).toBe(
          includeInterSession ? "Routed work" : "Human question",
        );
        expect(fields.lastMessagePreview).toBe(preview);
      }
    };
    readVariants("Initial answer");
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId: scope.sessionId, sessionKey: scope.sessionKey, storePath },
      {
        messages: [{ message: { role: "assistant", content: "**Latest** answer" } }],
        touchSessionEntry: false,
      },
    );
    vi.clearAllMocks();
    readVariants("Latest answer");
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])(
    "invalidates both cached title variants after an appended reset (keep=%s)",
    async (keep) => {
      const sessionId = "reader-title-reset-window";
      const scope = await writeTranscript(sessionId, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "old",
          parentId: null,
          message: { role: "user", content: "hidden old prompt" },
        },
        {
          type: "message",
          id: "kept-routed",
          parentId: "old",
          message: {
            role: "user",
            content: "kept routed prompt",
            provenance: { kind: "inter_session" },
          },
        },
        {
          type: "message",
          id: "kept-user",
          parentId: "kept-routed",
          message: { role: "user", content: "kept prompt" },
        },
        {
          type: "message",
          id: "kept-assistant",
          parentId: "kept-user",
          message: { role: "assistant", content: "kept answer" },
        },
      ]);
      const before = sessionAccessor.readSessionTranscriptWatermark(scope);
      for (const includeInterSession of [false, true]) {
        expect(readSessionTitleFieldsFromTranscript(scope, { includeInterSession })).toEqual({
          firstUserMessage: "hidden old prompt",
          lastMessagePreview: "kept answer",
        });
      }
      await sessionAccessor.appendTranscriptEvent(scope, {
        type: "reset",
        id: "reset-boundary",
        parentId: "kept-assistant",
        ...(keep ? { firstKeptEntryId: "kept-routed" } : {}),
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          {
            eventId: "post-reset",
            parentId: "reset-boundary",
            message: { role: "user", content: "new question" },
          },
          {
            eventId: "newest",
            parentId: "post-reset",
            message: { role: "assistant", content: "newest answer" },
          },
        ],
        touchSessionEntry: false,
      });
      expect(sessionAccessor.readSessionTranscriptWatermark(scope).generation).toBe(
        before.generation,
      );
      for (const includeInterSession of [false, true, false, true]) {
        expect(readSessionTitleFieldsFromTranscript(scope, { includeInterSession })).toEqual({
          firstUserMessage: keep
            ? includeInterSession
              ? "kept routed prompt"
              : "kept prompt"
            : "new question",
          lastMessagePreview: "newest answer",
        });
      }
    },
  );

  test.each(["stale", "unclassified"] as const)(
    "degrades single title reads for a %s projection",
    async (projection) => {
      const scope = await writeSqliteMessages("reader-title-single-rebuilding", [
        { role: "user", content: "single prompt" },
        { role: "assistant", content: "single reply" },
      ]);
      if (projection === "stale") {
        markProjectionNeedsRebuild(scope.sessionId);
      } else {
        openOpenClawAgentDatabase({
          agentId: "main",
          path: path.join(tempDir, "openclaw-agent.sqlite"),
        })
          .db.prepare(
            "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
          )
          .run(scope.sessionId);
      }

      let fields: ReturnType<typeof readSessionTitleFieldsFromTranscript> | undefined;
      try {
        fields = readSessionTitleFieldsFromTranscript(scope);
      } finally {
        await waitForSessionTranscriptIndexReconcile({
          agentId: "main",
          path: path.join(tempDir, "openclaw-agent.sqlite"),
        });
      }
      expect(fields).toEqual({
        firstUserMessage: null,
        lastMessagePreview: null,
      });
      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: "single prompt",
        lastMessagePreview: "single reply",
      });
    },
  );

  test.each(["watermark", "messageEventPage", "boundedTailPage"] as const)(
    "degrades title fields when %s is unavailable and heals on refresh",
    async (faultSource) => {
      const scope = await writeSqliteMessages(`reader-title-${faultSource}`, [
        { role: "user", content: "Recovered prompt" },
        { role: "assistant", content: "Recovered reply" },
      ]);
      const reader = vi.mocked(
        faultSource === "watermark"
          ? sessionAccessor.readSessionTranscriptWatermark
          : faultSource === "messageEventPage"
            ? sessionAccessor.readSessionTranscriptMessageEventPage
            : sessionAccessor.readSessionTranscriptBoundedMessageTailPage,
      );
      reader.mockImplementationOnce(() => {
        throw new sessionAccessor.SessionTranscriptProjectionUnavailableError(scope.sessionId);
      });

      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: null,
        lastMessagePreview: null,
      });
      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: "Recovered prompt",
        lastMessagePreview: "Recovered reply",
      });
    },
  );

  test("keeps cached title fields independent when agents share a session id", async () => {
    const sessionId = "reader-title-duplicate-session-id";
    const scopes = [
      { agentId: "main", sessionId, sessionKey: "agent:main:duplicate-title" },
      { agentId: "work", sessionId, sessionKey: "agent:work:duplicate-title" },
    ];
    for (const [index, scope] of scopes.entries()) {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { message: { role: "user", content: `prompt ${index}` } },
          { message: { role: "assistant", content: `reply ${index}` } },
        ],
        touchSessionEntry: false,
      });
    }
    for (const [index, scope] of [...scopes.entries(), ...scopes.entries()]) {
      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: `prompt ${index}`,
        lastMessagePreview: `reply ${index}`,
      });
    }
  });

  test("bounds title probes without rereading their initial window", async () => {
    const probeReadCount = async (sessionId: string, messageCount: number) => {
      const scope = await writeSqliteMessages(
        sessionId,
        Array.from({ length: messageCount }, () => ({ role: "assistant", content: " " })),
      );
      vi.clearAllMocks();

      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: null,
        lastMessagePreview: null,
      });
      expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
      return boundedTitleEventReadCount();
    };

    await expect(probeReadCount("reader-title-bounded-101", 101)).resolves.toBe(200);
    await expect(probeReadCount("reader-title-bounded-201", 201)).resolves.toBe(200);
  });

  test("reuses cached SQLite title fields while the transcript watermark is unchanged", async () => {
    const scope = await writeSqliteMessages("reader-title-cache-warm", [
      { role: "user", content: "cached prompt" },
      { role: "assistant", content: "cached reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "cached prompt",
      lastMessagePreview: "cached reply",
    });
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "cached prompt",
      lastMessagePreview: "cached reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).not.toHaveBeenCalled();
  });

  test("reuses the cached head after an append while refreshing the preview", async () => {
    const sessionId = "reader-title-cache-append";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "append prompt" },
      ...Array.from({ length: 25 }, () => ({ role: "assistant", content: "older reply" })),
      { role: "assistant", content: "first reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("first reply");
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath },
      {
        messages: [{ message: { role: "assistant", content: "appended reply" } }],
        touchSessionEntry: false,
      },
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "append prompt",
      lastMessagePreview: "appended reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).toHaveBeenCalledTimes(1);
  });

  test("keeps the first user title when an append lands between tail and head probes", async () => {
    const scope = await writeSqliteMessages("reader-title-concurrent-append", [
      { role: "user", content: "Original question" },
      { role: "user", content: "Later question" },
      ...Array.from({ length: 18 }, () => ({ role: "assistant", content: "Older reply" })),
    ]);
    await sessionAccessor.replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const actual = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
      "../config/sessions/session-accessor.js",
    );
    const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
    pageReader.mockImplementationOnce((readScope, options) => {
      expect(
        sessionAccessor.appendTranscriptMessageSync(scope, {
          message: { role: "assistant", content: "Concurrent reply" },
        }),
      ).toMatchObject({ ok: true, value: { appended: true } });
      return actual.readSessionTranscriptMessageEventPage(readScope, options);
    });

    const first = readSessionTitleFieldsFromTranscript(scope);
    const next = readSessionTitleFieldsFromTranscript(scope);
    expect([first.firstUserMessage, next.firstUserMessage]).toEqual([
      "Original question",
      "Original question",
    ]);
    expect(next.lastMessagePreview).toBe("Concurrent reply");
    expect(pageReader).toHaveBeenCalledTimes(1);
  });

  test("retains cached title fields across more than 256 sessions", async () => {
    const scopes: SessionTranscriptReadScope[] = [];
    for (let index = 0; index < 300; index += 1) {
      const scope = await writeSqliteMessages(`reader-title-capacity-${index}`, [
        { role: "user", content: `prompt ${index}` },
      ]);
      scopes.push(scope);
      expect(readSessionTitleFieldsFromTranscript(scope).firstUserMessage).toBe(`prompt ${index}`);
    }
    vi.clearAllMocks();

    for (const [index, scope] of scopes.entries()) {
      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: `prompt ${index}`,
        lastMessagePreview: `prompt ${index}`,
      });
    }
    expect(vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage).mock.calls.length).toBe(
      0,
    );
    expect(
      vi.mocked(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).mock.calls.length,
    ).toBe(0);
  });

  test("invalidates cached SQLite title fields after the rewrite generation changes", async () => {
    const sessionId = "reader-title-cache-generation";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "generation prompt" },
      ...Array.from({ length: 25 }, () => ({ role: "assistant", content: "older reply" })),
      { role: "assistant", content: "generation reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).firstUserMessage).toBe("generation prompt");
    const before = sessionAccessor.readSessionTranscriptWatermark(scope);
    await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      ...Array.from({ length: 27 }, (_, index) => ({
        type: "message",
        id: `rewritten-${index}`,
        parentId: index === 0 ? null : `rewritten-${index - 1}`,
        message:
          index === 0
            ? { role: "user", content: "rewritten prompt" }
            : { role: "assistant", content: "rewritten reply" },
      })),
    ]);
    expect(sessionAccessor.readSessionTranscriptWatermark(scope).generation).not.toBe(
      before.generation,
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "rewritten prompt",
      lastMessagePreview: "rewritten reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      { maxMessages: 20, offset: 0, offsetFrom: "start" },
    );
  });

  test.each([2, 25, 100])(
    "extends a missing title probe only into new head messages after %s rows",
    async (messageCount) => {
      const sessionId = `reader-title-late-user-${messageCount}`;
      const scope = await writeSqliteMessages(sessionId, [
        { role: "user", content: "Routed work", provenance: { kind: "inter_session" } },
        ...Array.from({ length: messageCount - 1 }, () => ({
          role: "assistant",
          content: "reply",
        })),
      ]);
      expect(readSessionTitleFieldsFromTranscript(scope).firstUserMessage).toBeNull();
      expect(
        readSessionTitleFieldsFromTranscript(scope, { includeInterSession: true }).firstUserMessage,
      ).toBe("Routed work");
      await writeSqliteMessages(sessionId, [{ role: "user", content: "First human question" }]);
      vi.clearAllMocks();

      expect(
        readSessionTitleFieldsFromTranscript(scope, { includeInterSession: true }).firstUserMessage,
      ).toBe("Routed work");
      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: messageCount < 100 ? "First human question" : null,
        lastMessagePreview: "First human question",
      });
      const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
      expect(pageReader.mock.calls.map(([, options]) => options)).toEqual(
        messageCount < 100 ? [{ maxMessages: 1, offset: messageCount, offsetFrom: "start" }] : [],
      );
      expect(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    { role: "assistant", newestReply: false },
    { role: "toolResult", newestReply: false },
    { role: "toolResult", newestReply: true },
  ])("preserves previews across oversized tail messages (%j)", async ({ role, newestReply }) => {
    const sessionId = `reader-title-oversized-${role}-${newestReply}`;
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "Original question" },
      ...Array.from({ length: 25 }, () => ({ role: "assistant", content: "Earlier reply" })),
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).firstUserMessage).toBe("Original question");
    await writeSqliteMessages(sessionId, [
      { role, content: "x".repeat(70 * 1024) },
      ...(newestReply ? [{ role: "assistant", content: "Latest reply" }] : []),
    ]);
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "Original question",
      lastMessagePreview: newestReply
        ? "Latest reply"
        : role === "assistant"
          ? `${"x".repeat(237)}...`
          : "Earlier reply",
    });
    expect(sessionAccessor.readSessionTranscriptBoundedMessageTailPage).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(sessionAccessor.readSessionTranscriptMessageEventPage)
        .mock.calls.map(([, options]) => options),
    ).toEqual(newestReply ? [] : [{ maxMessages: 20, offset: 0 }]);
  });

  test("returns missing title fields when the bounded head and tail caps miss", async () => {
    const scope = await writeSqliteMessages(
      "reader-title-cap-miss",
      Array.from({ length: 201 }, (_, index) =>
        index === 100
          ? { role: "user", content: "outside both probes" }
          : { role: "assistant", content: " " },
      ),
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
    expect(boundedTitleEventReadCount()).toBe(200);
  });
});

describe("session transcript Markdown title previews", () => {
  test("flattens last-message Markdown without changing title Markdown", async () => {
    const scope = await writeSqliteMessages("reader-title-markdown", [
      { role: "user", content: "Keep **title Markdown** unchanged" },
      {
        role: "assistant",
        content:
          "# Done\n\nLanded [PR #124879](https://github.com/openclaw/openclaw/pull/124879) with **green** CI. Use foo_bar_baz from ~/.openclaw.",
      },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "Keep **title Markdown** unchanged",
      lastMessagePreview: "Done Landed PR #124879 with green CI. Use foo_bar_baz from ~/.openclaw.",
    });
  });

  test("returns no title preview when Markdown flattens to empty", async () => {
    const scope = await writeSqliteMessages("reader-title-empty-markdown", [
      { role: "assistant", content: "```ts\nconst hidden = true;\n```" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBeNull();
  });

  test.each([false, true])(
    "stops reading older content after the newest visible preview (widen=%s)",
    async (widen) => {
      const hiddenMessages = [
        { role: "toolResult", content: "tool output" },
        { role: "system", content: "system event" },
        { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }] },
        { role: "assistant", content: "NO_REPLY" },
        { role: "assistant", content: "ANNOUNCE_SKIP" },
        { role: "assistant", content: "REPLY_SKIP" },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        { role: "assistant", content: "```ts\nconst hidden = true;\n```" },
      ];
      const olderText = "Earlier **reply**";
      // Keep the observed row outside the first-user head probe, including after widening.
      const prefix = [
        { role: "user", content: "Keep **title Markdown** unchanged" },
        ...Array.from({ length: 100 }, () => ({ role: "toolResult", content: "tool output" })),
      ];
      const olderSeq = prefix.length + 1;
      const scope = await writeSqliteMessages(`reader-title-short-circuit-${widen}`, [
        ...prefix,
        { role: "assistant", content: [{ type: "text", text: olderText }] },
        { role: "assistant", content: "# Latest\n\nRead the [guide](https://example.com)." },
        ...(widen ? Array.from({ length: 3 }, () => hiddenMessages).flat() : []),
      ]);
      const actual = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
        "../config/sessions/session-accessor.js",
      );
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
        const fields = readSessionTitleFieldsFromTranscript(scope);

        expect(fields).toEqual({
          firstUserMessage: "Keep **title Markdown** unchanged",
          lastMessagePreview: "Latest Read the guide.",
        });
        expect(observedRows).toBe(1);
        expect(readOlderText).not.toHaveBeenCalled();
      } finally {
        pageReader.mockImplementation(actual.readSessionTranscriptBoundedMessageTailPage);
      }
    },
  );
});

test("resolves placeholder store paths before title reads", async () => {
  const sessionId = "reader-placeholder-title";
  const sessionKey = `agent:main:${sessionId}`;
  const defaultStorePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  await persistSessionTranscriptTurn(
    { agentId: "main", sessionId, sessionKey, storePath: defaultStorePath },
    {
      messages: [
        { message: { role: "user", content: "real prompt" } },
        { message: { role: "assistant", content: "real reply" } },
      ],
      touchSessionEntry: false,
    },
  );

  expect(
    readSessionTitleFieldsFromTranscript({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: "(multiple)",
    }),
  ).toEqual({ firstUserMessage: "real prompt", lastMessagePreview: "real reply" });
});
