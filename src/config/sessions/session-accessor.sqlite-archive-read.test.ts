import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { encodeSessionArchiveContent } from "./archive-compression.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { findSessionTranscriptArchiveEventReadOnly } from "./session-history.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite transcript archive reads", () => {
  it.each([false, true])(
    "reads committed archive blobs before file publication (compressed=%s)",
    async (compressed) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-archive-blob-read-") };
      const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
      const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
      const sessionKey = "agent:ops:completed";
      const message = (id: string, content = id, runId = "completed-run") => ({
        type: "message",
        id,
        message: { role: "assistant", content, __openclaw: { runId } },
      });
      const answer = message("latest", `${"<result>".repeat(900)}tail`);
      const archives = [
        { sessionId: "old", sessionKey, events: [message("old")] },
        {
          sessionId: "new",
          sessionKey,
          events: [
            message("earlier"),
            answer,
            message("other-run", "unrelated", "other-run"),
            message("silent", "NO_REPLY"),
          ],
        },
        { sessionId: "foreign", sessionKey: "agent:main:other", events: [answer] },
        { sessionId: "invalid", sessionKey: "agent:ops:invalid", events: [answer] },
      ];
      runOpenClawAgentWriteTransaction(
        () => {
          for (const [index, archive] of archives.entries()) {
            const content = [
              {
                type: "session",
                id: archive.sessionId === "invalid" ? "wrong" : archive.sessionId,
              },
              ...archive.events,
            ]
              .map((event) => JSON.stringify(event))
              .join("\n");
            const encoded = compressed
              ? encodeSessionArchiveContent(content)
              : { bytes: Buffer.from(content), suffix: "" };
            executeSqliteQuerySync(
              database.db,
              getSessionKysely(database.db)
                .insertInto("session_transcript_archives")
                .values({
                  session_id: archive.sessionId,
                  session_key: archive.sessionKey,
                  generation: "generation",
                  reason: "deleted",
                  encoding: encoded.suffix ? "zstd" : "identity",
                  archive_blob: encoded.bytes,
                  archive_sha256: createHash("sha256").update(encoded.bytes).digest("hex"),
                  archive_name: `archive-${index}.jsonl${encoded.suffix}`,
                  created_at: index,
                  published_at: null,
                }),
            );
          }
        },
        { agentId: "main", env, path: storePath },
      );
      const scope = { agentId: "ops", env, storePath, sessionKey };
      const filesBefore = fs
        .readdirSync(env.OPENCLAW_STATE_DIR, { recursive: true, encoding: "utf8" })
        .toSorted((left, right) => left.localeCompare(right));

      expect(await findSessionTranscriptArchiveEventReadOnly(scope, "completed-run")).toEqual({
        event: answer,
      });
      expect(
        await findSessionTranscriptArchiveEventReadOnly(
          { ...scope, sessionId: "old" },
          "completed-run",
        ),
      ).toEqual({ event: message("old") });
      expect(
        await findSessionTranscriptArchiveEventReadOnly(
          { ...scope, sessionId: "foreign" },
          "completed-run",
        ),
      ).toBeUndefined();
      expect(await findSessionTranscriptArchiveEventReadOnly(scope, "missing-run")).toBeUndefined();
      await expect(
        findSessionTranscriptArchiveEventReadOnly(
          { ...scope, sessionId: "invalid" },
          "completed-run",
        ),
      ).rejects.toThrow("Archived transcript header does not match its registered session");
      expect(
        fs
          .readdirSync(env.OPENCLAW_STATE_DIR, { recursive: true, encoding: "utf8" })
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(filesBefore);
      expect(
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_transcript_archives")
            .select("published_at"),
        ).rows,
      ).toEqual(archives.map(() => ({ published_at: null })));

      const changedContent = [
        { type: "session", id: "new" },
        message("latest", "changed but valid transcript content"),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");
      const changedBytes = compressed
        ? encodeSessionArchiveContent(changedContent).bytes
        : Buffer.from(changedContent);
      runOpenClawAgentWriteTransaction(
        () => {
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .updateTable("session_transcript_archives")
              .set({ archive_blob: changedBytes })
              .where("session_id", "=", "new"),
          );
        },
        { agentId: "main", env, path: storePath },
      );
      await expect(
        findSessionTranscriptArchiveEventReadOnly({ ...scope, sessionId: "new" }, "completed-run"),
      ).rejects.toThrow("Archived transcript bytes do not match their registered hash");
    },
  );

  it("reads a short final answer beyond the runtime string limit while the caller stays responsive", async () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-large-archive-read-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "archive.sqlite");
    const sessionId = "large-archive";
    const sessionKey = "agent:main:completed";
    const answer = {
      type: "message",
      message: {
        role: "assistant",
        content: "Complete final answer.",
        __openclaw: { runId: "completed-run" },
      },
    };
    const historyLine =
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "x".repeat(64 * 1024) },
      }) + "\n";
    // The September 2026 failure was the runtime's single-string limit, not an archive byte limit.
    const historyRows = Math.ceil((bufferConstants.MAX_STRING_LENGTH + 1) / historyLine.length);
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from(
        (function* () {
          yield JSON.stringify({ type: "session", id: sessionId }) + "\n";
          for (let index = 0; index < historyRows; index += 1) {
            yield historyLine;
          }
          yield JSON.stringify(answer) + "\n";
        })(),
      ),
      zlib.createZstdCompress(),
      async (source) => {
        for await (const chunk of source) {
          chunks.push(Buffer.from(chunk));
        }
      },
    );
    const bytes = Buffer.concat(chunks);
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
    runOpenClawAgentWriteTransaction(
      () => {
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .insertInto("session_transcript_archives")
            .values({
              session_id: sessionId,
              session_key: sessionKey,
              generation: "generation",
              reason: "deleted",
              encoding: "zstd",
              archive_blob: bytes,
              archive_sha256: createHash("sha256").update(bytes).digest("hex"),
              archive_name: "large.jsonl.zst",
              created_at: 1,
              published_at: null,
            }),
        );
      },
      { agentId: "main", env, path: storePath },
    );
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 10);
    try {
      await expect(
        findSessionTranscriptArchiveEventReadOnly(
          { agentId: "main", env, storePath, sessionId, sessionKey },
          "completed-run",
        ),
      ).resolves.toEqual({ event: answer });
      expect(heartbeats).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "large.jsonl.zst"))).toBe(false);
    } finally {
      clearInterval(heartbeat);
    }
  }, 30_000);
});
