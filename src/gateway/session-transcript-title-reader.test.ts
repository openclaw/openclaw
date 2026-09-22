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
): Promise<SessionTranscriptReadScope> {
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
  return vi
    .mocked(sessionAccessor.readSessionTranscriptMessageEventPage)
    .mock.results.reduce(
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
    const readVariants = () => {
      for (const includeInterSession of [false, true, false, true]) {
        const fields = readSessionTitleFieldsFromTranscript(scope, { includeInterSession });
        expect(fields.firstUserMessage).toBe(
          includeInterSession ? "Routed work" : "Human question",
        );
      }
    };
    readVariants();
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId: scope.sessionId, sessionKey: scope.sessionKey, storePath },
      {
        messages: [{ message: { role: "assistant", content: "**Latest** answer" } }],
        touchSessionEntry: false,
      },
    );
    readVariants();
    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("Latest answer");
  });

  test("reads the canonical visible window for reset transcripts", async () => {
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
        id: "kept-user",
        parentId: "old",
        message: { role: "user", content: "kept prompt" },
      },
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-user",
        message: { role: "assistant", content: "kept answer" },
      },
      {
        type: "reset",
        id: "reset-boundary",
        parentId: "kept-assistant",
        firstKeptEntryId: "kept-user",
      },
      {
        type: "message",
        id: "post-reset",
        parentId: "reset-boundary",
        message: { role: "assistant", content: "newest answer" },
      },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "kept prompt",
      lastMessagePreview: "newest answer",
    });
  });

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

  test.each(["watermark", "messageEventPage"] as const)(
    "degrades title fields when %s is unavailable and heals on refresh",
    async (faultSource) => {
      const scope = await writeSqliteMessages(`reader-title-${faultSource}`, [
        { role: "user", content: "Recovered prompt" },
        { role: "assistant", content: "Recovered reply" },
      ]);
      const reader = vi.mocked(
        faultSource === "watermark"
          ? sessionAccessor.readSessionTranscriptWatermark
          : sessionAccessor.readSessionTranscriptMessageEventPage,
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
  });

  test("invalidates cached SQLite title fields after an append advances max seq", async () => {
    const sessionId = "reader-title-cache-append";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "append prompt" },
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

    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("appended reply");
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).toHaveBeenCalled();
  });

  test("invalidates cached SQLite title fields after the rewrite generation changes", async () => {
    const sessionId = "reader-title-cache-generation";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "generation prompt" },
      { role: "assistant", content: "generation reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).firstUserMessage).toBe("generation prompt");
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    })
      .db.prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
      .run("f".repeat(32), sessionId);
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "generation prompt",
      lastMessagePreview: "generation reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).toHaveBeenCalled();
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
      const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
      try {
        pageReader.mockImplementation((readScope, options) => {
          const page = actual.readSessionTranscriptMessageEventPage(readScope, options);
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
        pageReader.mockImplementation(actual.readSessionTranscriptMessageEventPage);
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
