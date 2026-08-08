import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const videoPayload = Buffer.concat([
  Buffer.from("000000186674797069736f6d00000200", "hex"),
  Buffer.from("secret-video".repeat(8_192)),
]).toString("base64");
const videoBlock = { type: "video" as const, data: videoPayload, mimeType: "video/mp4" };
const videoFact = {
  path: "/private/inbound/recording.mp4",
  url: "media://inbound/recording.mp4",
  contentType: "video/mp4",
  kind: "video" as const,
};

describe("SQLite transcript native video claim checks", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    scope = {
      agentId: "main",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("openclaw-transcript-video-"),
      },
      sessionId: "native-video-transcript",
      sessionKey: "agent:main:native-video-transcript",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  const persistMessage = async (message: Record<string, unknown>, eventId = "video-turn") => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId, parentId: null, message }],
      touchSessionEntry: false,
    });
  };

  const readStoredRow = () => {
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const row = database.db
      .prepare(
        "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(scope.sessionId) as { event_json: string; seq: number } | undefined;
    if (!row) {
      throw new Error("expected a persisted transcript event");
    }
    return {
      ...row,
      event: JSON.parse(row.event_json) as {
        id: string;
        message: { content: unknown; role: string; __openclaw?: { media?: unknown[] } };
      },
    };
  };

  it("stores only the durable video reference without changing live input", async () => {
    const content = [{ type: "text", text: "describe this recording" }, videoBlock];
    const message = {
      role: "user",
      content,
      __openclaw: { media: [videoFact] },
    };

    await persistMessage(message);

    const stored = readStoredRow();
    expect(stored.event.message).toEqual({
      role: "user",
      content: "describe this recording",
      __openclaw: { media: [videoFact] },
    });
    expect(stored.event_json).not.toContain(videoPayload);
    expect(Buffer.byteLength(stored.event_json)).toBeLessThan(1_024);
    expect(message.content).toBe(content);
    expect(message.content[1]).toBe(videoBlock);
  });

  it("preserves images, interleaved text, and video without a matching reference", async () => {
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const unstagedVideo = { type: "video", data: "bG9jYWw=", mimeType: "video/webm" };
    const message = {
      role: "user",
      content: [
        { type: "text", text: "before" },
        image,
        videoBlock,
        { type: "text", text: "after" },
        unstagedVideo,
      ],
      __openclaw: {
        media: [{ path: "/private/inbound/still.png", contentType: "image/png" }, videoFact],
      },
    };

    await persistMessage(message);

    expect(readStoredRow().event.message.content).toEqual([
      { type: "text", text: "before" },
      image,
      { type: "text", text: "after" },
      unstagedVideo,
    ]);
    expect(message.content).toHaveLength(5);
  });

  it("keeps captionless video turns empty while retaining their claim check", async () => {
    await persistMessage({
      role: "user",
      content: [videoBlock],
      __openclaw: { media: [videoFact] },
    });

    expect(readStoredRow().event.message).toEqual({
      role: "user",
      content: "",
      __openclaw: { media: [videoFact] },
    });
  });

  it("deduplicates native video retries against the persisted claim-check shape", async () => {
    const content = [{ type: "text", text: "retry this recording" }, videoBlock];
    const message = {
      role: "user",
      content,
      idempotencyKey: "native-video-retry",
      __openclaw: { media: [videoFact] },
    };
    const first = await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "first-video-turn", message }],
      touchSessionEntry: false,
    });

    const retry = await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "retried-video-turn", message }],
      touchSessionEntry: false,
    });

    expect(first.messages[0]).toMatchObject({ appended: true, messageId: "first-video-turn" });
    expect(retry.messages[0]).toMatchObject({
      appended: false,
      message: { content: "retry this recording", idempotencyKey: "native-video-retry" },
      messageId: "first-video-turn",
    });
    expect(message.content).toBe(content);
    expect(message.content[1]).toBe(videoBlock);
  });

  it.each([
    {
      name: "direct SDK video without a durable fact",
      message: { role: "user", content: [videoBlock] },
    },
    {
      name: "a fact with a different video MIME type",
      message: {
        role: "user",
        content: [videoBlock],
        __openclaw: {
          media: [{ ...videoFact, contentType: "video/webm" }],
        },
      },
    },
    {
      name: "an externally hosted URL without a managed local reference",
      message: {
        role: "user",
        content: [videoBlock],
        __openclaw: {
          media: [{ url: "https://example.com/recording.mp4", contentType: "video/mp4" }],
        },
      },
    },
    {
      name: "assistant-owned video content",
      message: {
        role: "assistant",
        content: [videoBlock],
        __openclaw: { media: [videoFact] },
      },
    },
  ])("preserves $name", async ({ message }) => {
    await persistMessage(message);

    expect(readStoredRow().event.message.content).toEqual([videoBlock]);
  });

  it("projects video claim checks when an entire transcript is replaced", async () => {
    await persistMessage({ role: "user", content: "before replacement" }, "before");
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const header = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1")
      .get(scope.sessionId) as { event_json: string };
    const replacement = {
      type: "message",
      id: "replacement",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "replacement" }, videoBlock],
        __openclaw: { media: [videoFact] },
      },
    };

    runOpenClawAgentWriteTransaction(
      (writeDatabase) =>
        replaceSqliteTranscriptEventsInTransaction(writeDatabase, scope, [
          JSON.parse(header.event_json),
          replacement,
        ]),
      { agentId: scope.agentId, env: scope.env },
    );

    expect(readStoredRow().event.message.content).toBe("replacement");
    expect(replacement.message.content[1]).toBe(videoBlock);
  });

  it("projects video claim checks during an exact transcript row rewrite", async () => {
    await persistMessage({ role: "user", content: "before rewrite" }, "rewrite");
    const previous = readStoredRow();
    const replacement = {
      ...previous.event,
      message: {
        role: "user",
        content: [{ type: "text", text: "rewritten" }, videoBlock],
        __openclaw: { media: [videoFact] },
      },
    };

    runOpenClawAgentWriteTransaction(
      (writeDatabase) =>
        rewriteSqliteTranscriptEventRowsInTransaction(writeDatabase, scope, [
          {
            event: replacement,
            expectedEventJson: previous.event_json,
            seq: previous.seq,
          },
        ]),
      { agentId: scope.agentId, env: scope.env },
    );

    expect(readStoredRow().event.message.content).toBe("rewritten");
    expect(replacement.message.content[1]).toBe(videoBlock);
  });
});
