import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  deleteSessionEntryLifecycle,
  ensureSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  publishEncodedSessionTranscriptArchive,
  resolveSqliteTranscriptArchivePath,
} from "../config/sessions/session-accessor.sqlite-archive-artifact.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { appendSessionTranscriptMessageByIdentity } from "../plugin-sdk/session-transcript-runtime.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../shared/assistant-display-content.js";
import { withChannelReadAuthority } from "../shared/channel-read-authority.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  attachManagedOutgoingMediaToMessage,
  cleanupManagedOutgoingMediaRecords,
  createManagedOutgoingMediaBlocks,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  parseManagedOutgoingRoute,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  createFixture,
  interceptManagedImageMutationReplies,
} from "./managed-image-attachments.test-support.js";
import {
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  type ManagedImageRecord,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import {
  readSessionMessageCountAsync,
  readSessionMessagesAsync,
  readSessionMessagesMatchingIdAsync,
  readSessionMessagesWithSourceAsync,
} from "./session-transcript-readers.js";
import { iterateSessionTranscriptSourcePages } from "./session-transcript-source-pages.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const timestamp = "2026-09-04T00:00:00.000Z";
let stateDir: string;
let savedEnv: ReturnType<typeof captureEnv>;

function message(id: string, parentId: string | null, content: unknown) {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant", content } };
}

async function fixture(messageId = "attached") {
  const agentId = "main";
  const sessionId = `managed-visibility-${randomUUID()}`;
  const sessionKey = `agent:${agentId}:${sessionId}`;
  const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  const scope = { agentId, sessionId, sessionKey, storePath };
  // This fixture owns the competing writer; background entry maintenance must not join it.
  expect(ensureSessionEntrySync(scope, { sessionId, updatedAt: Date.now() })).toBe(true);
  const { attachmentId, originalPath } = await createFixture(stateDir, {
    attachmentId: randomUUID(),
    sessionKey,
    agentId,
    messageId,
    createdAt: timestamp,
    body: Buffer.from("synthetic managed original\n"),
    filename: "fixture.png",
  });
  const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
  const block = { type: "image", url, openUrl: url };
  const download = () =>
    resolveManagedOutgoingMediaArtifactDownload({
      sessionKey,
      agentId,
      stateDir,
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
    });
  return { scope, attachmentId, messageId, originalPath, block, download };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seed(f: Fixture, events: unknown[], source: "sqlite" | "archive" = "sqlite") {
  await replaceTranscriptEvents(f.scope, [
    { type: "session", version: 3, id: f.scope.sessionId, timestamp, cwd: stateDir },
    ...(source === "sqlite" ? events : []),
  ]);
  await readSessionMessageCountAsync(f.scope);
  if (source === "archive") {
    archive(f, events);
  }
}

function archive(f: Fixture, events: unknown[] = [message(f.messageId, null, [f.block])]) {
  const bytes = Buffer.from(
    [{ type: "session", version: 3, id: f.scope.sessionId, timestamp, cwd: stateDir }, ...events]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const archiveDirectory = path.dirname(f.scope.storePath);
  const archiveName = path.basename(
    resolveSqliteTranscriptArchivePath({
      archiveDirectory,
      identityOwner: "filename",
      sessionId: f.scope.sessionId,
      reason: "reset",
      nowMs: Date.parse(timestamp),
    }),
  );
  return publishEncodedSessionTranscriptArchive({
    archiveDirectory,
    archiveName,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const cleanup = (
  options: Omit<
    NonNullable<Parameters<typeof cleanupManagedOutgoingMediaRecords>[0]>,
    "stateDir"
  > = {},
) => cleanupManagedOutgoingMediaRecords({ stateDir, ...options });

async function expectRetained(f: Pick<Fixture, "attachmentId" | "originalPath">) {
  expect(await readManagedImageRecord(f.attachmentId, stateDir)).not.toBeNull();
  expect(fs.existsSync(f.originalPath)).toBe(true);
}

describe("managed attachment SQLite visibility", () => {
  beforeEach(() => {
    savedEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = fs.realpathSync(tempDirs.make("managed-visibility-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    savedEnv.restore();
  });

  it("loads original IDs only when a regular file is old enough for orphan cleanup", async ({
    onTestFinished,
  }) => {
    const nowMs = 2_000_000;
    const originals = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR);
    const { originalPath: kept } = await createFixture(stateDir, {
      messageId: null,
      createdAt: new Date(nowMs).toISOString(),
      body: Buffer.from("kept"),
      filename: "kept.png",
    });
    await fsAsync.unlink(kept);
    await fsAsync.rmdir(originals);
    const reads: string[] = [];
    onTestFinished(
      onInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "worker.request" &&
            event.phase === "queued" &&
            event.kind === "stateRead" &&
            event.requestClass === "managedImages"
          ) {
            reads.push(event.kind);
          }
        },
        { include: ["worker.request"] },
      ),
    );
    const cleanAndCountReads = async (expectedReads: number) => {
      reads.length = 0;
      await cleanupManagedOutgoingMediaRecords({ stateDir, nowMs });
      await waitForDiagnosticEventsDrained();
      expect(reads).toHaveLength(expectedReads);
    };

    await cleanAndCountReads(1);
    await fsAsync.mkdir(originals, { recursive: true });
    await cleanAndCountReads(1);
    await fsAsync.writeFile(kept, "kept");
    await fsAsync.utimes(kept, new Date(nowMs), new Date(nowMs));
    await cleanAndCountReads(1);

    const orphan = path.join(originals, "orphan.png");
    await fsAsync.writeFile(orphan, "orphan");
    await fsAsync.utimes(orphan, new Date(0), new Date(0));
    await fsAsync.utimes(kept, new Date(0), new Date(0));
    await cleanAndCountReads(2);
    expect(await fsAsync.readFile(kept, "utf8")).toBe("kept");
    await expect(fsAsync.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing", "invalid-row", "ambiguous"] as const)(
    "refuses a %s ownership source",
    async (source) => {
      const f = await fixture();
      await seed(f, [message(f.messageId, null, [f.block])]);
      if (source === "missing") {
        setRuntimeConfigSnapshot({ session: { store: path.join(stateDir, "missing.sqlite") } });
      } else if (source === "invalid-row") {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        database.db
          .prepare(
            "UPDATE session_nodes SET entry_json = ?, entry_valid = -1 WHERE session_key = ?",
          )
          .run("{invalid", f.scope.sessionKey);
      } else {
        const template = path.join(stateDir, "custom", "{agentId}", "sessions.json");
        ensureSessionEntrySync(
          { ...f.scope, storePath: template.replace("{agentId}", "main") },
          { sessionId: f.scope.sessionId, updatedAt: 1 },
        );
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {} } },
          session: { store: template },
        });
      }
      expect(await f.download()).toBeNull();
      await cleanup({ sessionKey: f.scope.sessionKey });
      await expectRetained(f);
    },
  );

  it.each(["main", "secondary"] as const)(
    "retains committed image history across healthy custom session store switches for %s",
    async (agentId) => {
      const sessionKey = `agent:${agentId}:main`;
      const storeA = path.join(stateDir, "custom-a", "sessions.sqlite");
      const storeB = path.join(stateDir, "custom-b", "sessions.sqlite");
      const configA: OpenClawConfig = {
        agents: { entries: { main: {}, secondary: {} } },
        session: { store: storeA },
      };
      const configB: OpenClawConfig = {
        agents: { entries: { main: {}, secondary: {} } },
        session: { store: storeB },
      };
      const countReferences = (messages: unknown[], artifactId: string, url: string) =>
        messages.filter((transcriptMessage) =>
          readAssistantDisplayContent(transcriptMessage).some(
            (block) => block.artifactId === artifactId && block.url === url,
          ),
        ).length;
      const commitImage = async (storePath: string, name: string, cfg: OpenClawConfig) => {
        const sessionId = randomUUID();
        // A fixed shared store's physical owner need not be the message's logical agent.
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        const scope = { agentId, sessionKey, sessionId, storePath };
        expect(ensureSessionEntrySync(scope, { sessionId, updatedAt: Date.now() })).toBe(true);
        const manager = await SessionManager.openAsync(scope, stateDir);
        await manager.appendMessageAsync({
          role: "user",
          content: `Synthetic ${name} image history`,
          timestamp: 1,
        });
        const originalBytes = createSolidPngBuffer(1, 1, {
          r: name === "A" ? 17 : 51,
          g: 34,
          b: name === "A" ? 51 : 17,
        });
        const blocks = await createManagedOutgoingMediaBlocks({
          sessionKey,
          agentId,
          stateDir,
          items: [
            {
              url: `data:image/png;base64,${originalBytes.toString("base64")}`,
              trustedLocal: false,
            },
          ],
        });
        expect(blocks).toHaveLength(1);
        const block = blocks[0];
        if (block?.type !== "image" || typeof block.url !== "string") {
          throw new Error(`Expected a real managed image block for store ${name}`);
        }
        if (typeof block.artifactId !== "string") {
          throw new Error(`Expected a managed artifact identity for store ${name}`);
        }
        const artifactId = block.artifactId;
        const url = block.url;
        const route = parseManagedOutgoingRoute(url);
        if (!route || route.sessionKey !== sessionKey) {
          throw new Error(`Expected a session-owned managed URL for store ${name}`);
        }
        const messageId = await manager.appendMessageAsync(
          Object.assign(
            makeAssistantMessageFixture({
              content: [{ type: "text", text: `Committed synthetic image ${name}` }],
              stopReason: "stop",
              errorMessage: undefined,
            }),
            { [ASSISTANT_DISPLAY_CONTENT_FIELD]: blocks },
          ),
          { config: cfg },
        );
        if (!messageId) {
          throw new Error(`Store ${name} did not commit a canonical assistant message`);
        }
        expect(await attachManagedOutgoingMediaToMessage({ messageId, blocks, stateDir })).toBe(
          true,
        );
        const record = await readManagedImageRecord(route.attachmentId, stateDir);
        expect(record).toMatchObject({ messageId, retentionClass: "history" });
        if (!record) {
          throw new Error(`Missing committed managed record for store ${name}`);
        }
        const originalPath = recordPath(record);
        const messages = await readSessionMessagesAsync(scope, {
          mode: "full",
          reason: "healthy custom-store managed-media baseline",
        });
        const artifact = () =>
          resolveManagedOutgoingMediaArtifactDownload({
            sessionKey,
            agentId,
            artifactId,
            stateDir,
          });
        expect(messages).toHaveLength(2);
        expect(messages).toContainEqual(
          expect.objectContaining({ __openclaw: expect.objectContaining({ id: messageId }) }),
        );
        const references = countReferences(messages, artifactId, url);
        expect(references).toBe(1);
        expect(await artifact()).not.toBeNull();
        const committedBytes = await fsAsync.readFile(originalPath);
        expect(committedBytes).toEqual(originalBytes);
        expect((await fsAsync.stat(storePath)).isFile()).toBe(true);
        return {
          scope,
          messageId,
          attachmentId: route.attachmentId,
          originalPath,
          originalBytes,
          messages,
          artifact,
        };
      };

      // Both locators are genuinely custom and healthy, not missing/invalid/ambiguous controls.
      setRuntimeConfigSnapshot(configA);
      const a = await commitImage(storeA, "A", configA);
      await cleanup({ sessionKey });
      const retainedA = await readManagedImageRecord(a.attachmentId, stateDir);
      expect(retainedA).toMatchObject({
        messageId: a.messageId,
        retentionClass: "history",
      });
      const artifactA = await a.artifact();
      const retainedBytesA = await fsAsync.readFile(a.originalPath);
      expect(artifactA).not.toBeNull();
      expect(retainedBytesA).toEqual(a.originalBytes);

      setRuntimeConfigSnapshot(configB);
      const b = await commitImage(storeB, "B", configB);
      expect(a.scope.sessionId).not.toBe(b.scope.sessionId);
      expect(a.messageId).not.toBe(b.messageId);
      expect(a.attachmentId).not.toBe(b.attachmentId);
      expect(await fsAsync.realpath(storeA)).not.toBe(await fsAsync.realpath(storeB));
      // Retention must not make another physical store's media visible in the selected session.
      expect(await readManagedImageRecord(a.attachmentId, stateDir)).not.toBeNull();
      expect(await fsAsync.readFile(a.originalPath)).toEqual(a.originalBytes);
      expect(await a.artifact()).toBeNull();
      // Run the actual destructive owner with ordinary options while healthy B is selected.
      await cleanup({ sessionKey });
      for (const f of [a, b]) {
        expect((await fsAsync.stat(f.scope.storePath)).isFile()).toBe(true);
        expect(
          await readSessionMessagesAsync(f.scope, {
            mode: "full",
            reason: "retained physical store managed-media reference",
          }),
        ).toEqual(f.messages);
      }
      expect(await readManagedImageRecord(b.attachmentId, stateDir)).not.toBeNull();
      expect(await fsAsync.readFile(b.originalPath)).toEqual(b.originalBytes);
      expect(await b.artifact()).not.toBeNull();
      setRuntimeConfigSnapshot(configA);
      expect(await readManagedImageRecord(a.attachmentId, stateDir)).not.toBeNull();
      expect(await fsAsync.readFile(a.originalPath)).toEqual(a.originalBytes);
      expect(await a.artifact()).not.toBeNull();

      // A real source deletion must still release its unreferenced media; retaining every
      // record whenever another store is registered would hide the bug but leak originals.
      expect(
        await deleteSessionEntryLifecycle({
          agentId: a.scope.agentId,
          storePath: storeA,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          expectedSessionId: a.scope.sessionId,
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        }),
      ).toMatchObject({ deleted: true, archivedTranscripts: [] });
      expect(
        await readSessionMessagesAsync(a.scope, {
          mode: "full",
          reason: "deleted physical store A",
        }),
      ).toEqual([]);
      setRuntimeConfigSnapshot(configB);
      const unavailableStoreA = `${storeA}.temporarily-unavailable`;
      await closeOpenClawAgentDatabaseByPathAsync(storeA, "main");
      await fsAsync.rename(storeA, unavailableStoreA);
      try {
        // A registry row without a readable database is uncertainty, not proof of absence.
        await cleanup({ sessionKey });
        expect(await readManagedImageRecord(a.attachmentId, stateDir)).not.toBeNull();
        expect(await fsAsync.readFile(a.originalPath)).toEqual(a.originalBytes);
        await expect(fsAsync.stat(storeA)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await b.artifact()).not.toBeNull();
      } finally {
        await closeOpenClawAgentDatabaseByPathAsync(storeA, "main");
        await fsAsync.rename(unavailableStoreA, storeA);
      }
      await cleanup({ sessionKey });
      expect(await readManagedImageRecord(a.attachmentId, stateDir)).toBeNull();
      await expect(fsAsync.readFile(a.originalPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readManagedImageRecord(b.attachmentId, stateDir)).not.toBeNull();
      expect(await fsAsync.readFile(b.originalPath)).toEqual(b.originalBytes);
      expect(await b.artifact()).not.toBeNull();
    },
  );

  it.each(["sqlite", "archive"] as const)(
    "retains media owned by oversized %s history while cleaning other sessions",
    async (source) => {
      const oversized = await fixture();
      const orphan = await fixture("missing");
      const history = [
        message(oversized.messageId, null, [
          oversized.block,
          { type: "text", text: "x".repeat(8 * 1024 * 1024) },
        ]),
      ];
      await seed(oversized, history, source);
      const original = await readManagedImageRecord(oversized.attachmentId, stateDir);
      expect(original).not.toBeNull();
      await insertManagedImageRecord(
        { ...original!, attachmentId: randomUUID(), messageId: "unverified" },
        stateDir,
      );
      await seed(orphan, [message("different", null, "no attachment")]);

      await cleanup();
      await expectRetained(oversized);
      expect(await readManagedImageRecord(orphan.attachmentId, stateDir)).toBeNull();
      expect(fs.existsSync(orphan.originalPath)).toBe(false);
    },
  );

  it.each(["active", "off-path", "archive"] as const)(
    "selects recorded attachment messages without returning unrelated %s payloads",
    async (source) => {
      const f = await fixture();
      const second = await createFixture(stateDir, {
        attachmentId: randomUUID(),
        sessionKey: f.scope.sessionKey,
        agentId: "main",
        messageId: "second",
        createdAt: timestamp,
        body: Buffer.from("second managed original"),
        filename: "second.png",
      });
      const secondBlock = {
        type: "image",
        url: `/api/chat/media/outgoing/${encodeURIComponent(f.scope.sessionKey)}/${second.attachmentId}/full`,
      };
      const events = [
        message("root", null, "root"),
        ...Array.from({ length: 129 }, (_, index) =>
          message(
            `unrelated-${index}`,
            index ? `unrelated-${index - 1}` : "root",
            "x".repeat(1024),
          ),
        ),
        message(f.messageId, "unrelated-128", [f.block]),
        message("second", source === "off-path" ? "root" : f.messageId, [secondBlock]),
      ];
      await seed(f, events, source === "archive" ? "archive" : "sqlite");
      const selected: unknown[] = [];
      for await (const page of iterateSessionTranscriptSourcePages(
        readSessionMessagesWithSourceAsync,
        f.scope,
        {
          allowResetArchiveFallback: true,
          includeOffPathMessages: true,
          messageIds: [f.messageId, "second"],
        },
      )) {
        selected.push(...page.messages);
      }
      expect(selected).toHaveLength(2);
      expect(selected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ __openclaw: expect.objectContaining({ id: f.messageId }) }),
          expect.objectContaining({ __openclaw: expect.objectContaining({ id: "second" }) }),
        ]),
      );
      await cleanup({ sessionKey: f.scope.sessionKey });
      await expectRetained(f);
      await expectRetained(second);
    },
  );

  it.each(["sqlite", "archive"] as const)(
    "retains attachments whose %s message ID comes from legacy metadata",
    async (source) => {
      const f = await fixture();
      const legacy = {
        type: "message",
        timestamp,
        message: { role: "assistant", content: [f.block], __openclaw: { id: f.messageId } },
      };
      await seed(f, [legacy], source);
      await cleanup({ sessionKey: f.scope.sessionKey });
      await expectRetained(f);
    },
  );

  it("preserves archive duplicates and full-reader oversized recovery", async () => {
    const f = await fixture("   ");
    await seed(f, []);
    // Parentless duplicate records remain in the archive's flat selected history.
    const { parentId: _parent, ...attached } = message(f.messageId, null, [f.block]);
    archive(f, [
      {
        ...attached,
        message: {
          role: "assistant",
          content: [
            f.block,
            {
              type: "image",
              data: Buffer.alloc(300_000, 97).toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
      },
      {
        ...attached,
        message: { role: "assistant", content: "later duplicate without attachment" },
      },
    ]);
    const full = await readSessionMessagesAsync(f.scope, {
      mode: "full",
      reason: "retained archive duplicate and image recovery",
      allowResetArchiveFallback: true,
    });
    expect(full).toHaveLength(2);
    expect(await readSessionMessagesMatchingIdAsync(f.scope, f.messageId)).toEqual(full);
    expect(await f.download()).not.toBeNull();
    await cleanup({ sessionKey: f.scope.sessionKey });
    expect(await readManagedImageRecord(f.attachmentId, stateDir)).not.toBeNull();
  });

  it("uses the admitted bounds for both matching and missing IDs", async () => {
    const f = await fixture();
    await seed(f, [message(f.messageId, null, [f.block])]);
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...f.scope,
      message: { role: "user", content: "current admission" },
      parentId: f.messageId,
    });
    if (!admitted?.anchor) {
      throw new Error("expected admitted transcript anchor");
    }
    const receipt = { ...admitted.anchor, logicalTurnId: "membership-turn", role: "user" as const };
    for (const id of [f.messageId, "missing"]) {
      await runWithSessionTranscriptReadFence(receipt, async () => {
        const full = await readSessionMessagesWithSourceAsync(f.scope, {
          mode: "page",
          allowResetArchiveFallback: true,
        });
        expect(await readSessionMessagesMatchingIdAsync(f.scope, id)).toEqual(
          full.messages.filter(
            (row) => (row as { __openclaw: { id: string } })["__openclaw"].id === id,
          ),
        );
      });
    }
    expect(openOpenClawAgentDatabase({ agentId: "main" }).db.isTransaction).toBe(false);
  });

  it.each(["visible", "retained"] as const)(
    "keeps %s content on one snapshot across a writer",
    async (kind) => {
      const f = await fixture();
      const other = message("other", null, "snapshot writer trigger");
      const attached = message(f.messageId, "other", [f.block]);
      await seed(f, [
        other,
        attached,
        ...(kind === "retained" ? [message("active", "other", [])] : []),
      ]);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const row = database.db
        .prepare(
          "SELECT seq, event_json FROM transcript_events WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
        )
        .get(f.scope.sessionId, f.scope.sessionId, f.messageId) as {
        seq: number;
        event_json: string;
      };
      // Match runtime connection admission instead of failing immediately on an
      // unrelated transient lock. The write still commits inside the read snapshot.
      const writer = openNodeSqliteDatabase(database.path, {
        timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
      admitSqliteSchema(writer);
      const parse = JSON.parse;
      let rewrote = false;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        if (!rewrote && value === JSON.stringify(other)) {
          rewrote = true;
          writer.exec("BEGIN IMMEDIATE");
          try {
            rewriteSqliteTranscriptEventRowsInTransaction({ ...database, db: writer }, f.scope, [
              {
                seq: row.seq,
                expectedEventJson: row.event_json,
                event: message(f.messageId, "other", []),
              },
            ]);
            writer.exec("COMMIT");
          } catch (error) {
            writer.exec("ROLLBACK");
            throw error;
          }
        }
        return parse(value, reviver);
      });
      try {
        // Run the worker's reader kernel here so this deterministic competing writer
        // fires inside its read snapshot; the other cases exercise actual dispatch.
        const reader = createReadonlySessionHistoryReader({
          database: { agentId: "main", path: database.path },
          transcript: { ...f.scope, sessionFile: f.scope.sessionKey },
        });
        const selected =
          kind === "visible"
            ? await reader.readSessionMessagesMatchingIdAsync(f.scope, f.messageId)
            : (
                await reader.readSessionMessagesWithSourceAsync(f.scope, {
                  mode: "page",
                  includeOffPathMessages: true,
                })
              ).messages;
        expect(
          selected?.filter(
            (candidate) =>
              (candidate as { __openclaw: { id: string } })["__openclaw"].id === f.messageId,
          ),
        ).toMatchObject([{ content: [f.block], __openclaw: { id: f.messageId } }]);
        expect(rewrote).toBe(true);
        expect(database.db.isTransaction).toBe(false);
      } finally {
        spy.mockRestore();
        writer.close();
      }
      expect(await f.download()).toBeNull();
    },
  );

  it("rechecks archive membership after the active history becomes reset-only", async () => {
    const f = await fixture();
    await seed(f, []);
    const archivePath = archive(f);
    const archiveBefore = fs.readFileSync(archivePath);
    expect(await f.download()).not.toBeNull();
    await seed(f, [
      message(f.messageId, null, [f.block]),
      { type: "reset", id: "reset", parentId: f.messageId, timestamp, reason: "new" },
    ]);
    expect(await f.download()).toBeNull();
    const hostSql = observeHostDataSql();
    try {
      await cleanup({ sessionKey: f.scope.sessionKey });
      expect(hostSql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    } finally {
      hostSql.restore();
    }
    expect(await readManagedImageRecord(f.attachmentId, stateDir)).toBeNull();
    expect(fs.existsSync(f.originalPath)).toBe(false);
    expect(await f.download()).toBeNull();
    expect(fs.readFileSync(archivePath)).toEqual(archiveBefore);
  });

  it("ignores NUL-corrupt history in another session", async () => {
    const f = await fixture();
    const corrupt = await fixture("hidden");
    await seed(corrupt, [message("hidden", null, "hidden history")]);
    await seed(f, [message(f.messageId, null, [f.block])]);
    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare(`UPDATE transcript_events SET event_json = event_json || ? WHERE session_id = ? AND seq = (
        SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = 'hidden'
      )`)
      .run("\u0000trailing", corrupt.scope.sessionId, corrupt.scope.sessionId);
    expect(await f.download()).not.toBeNull();
    await cleanup({ sessionKey: f.scope.sessionKey });
    await expectRetained(f);
    await expectRetained(corrupt);
  });
});

const bytes = createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 });

function createMedia(custodyStateDir: string, assertCurrent?: () => void) {
  return createManagedOutgoingMediaBlocks({
    sessionKey: "agent:main:custody",
    agentId: "main",
    stateDir: custodyStateDir,
    items: [{ url: `data:image/png;base64,${bytes.toString("base64")}`, trustedLocal: false }],
    assertCurrent,
  });
}

function recordPath(record: ManagedImageRecord) {
  return path.join(record.original.mediaRoot, record.original.mediaSubdir, record.original.mediaId);
}

describe("managed media worker custody", () => {
  it.each([
    "closed database",
    "replaced original",
    "refused commit",
    "revoked after commit",
    "lost ordinary reply",
    "lost native receipt",
  ] as const)("settles file, record and authority after %s", async (failure) => {
    await withOpenClawTestState(
      { layout: "state-only", label: "managed-media-custody" },
      async (state) => {
        const entries = () => listManagedImageRecordEntries({ stateDir: state.stateDir });
        const scopedOnly = failure === "closed database" || failure === "replaced original";
        if (!scopedOnly) {
          await entries();
        }
        const revoked = new Error("Synthetic channel authority revoked");
        let active = true;
        let nativeReplies = 0;
        let refused = false;
        const accepted = vi.fn();
        const assertCurrent = () => {
          if (!active) {
            throw revoked;
          }
        };
        const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
        const admissionSpy = scopedOnly
          ? undefined
          : vi
              .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
              .mockImplementation((admit, attachment) => {
                const admission = createAdmission((request, grant) => {
                  if (failure === "refused commit" && request.stage === "commit") {
                    refused = true;
                    active = false;
                  }
                  admit(request, grant);
                }, attachment);
                if (failure !== "lost native receipt") {
                  return admission;
                }
                // Keep native execution, but lose its retained facts as well as the ordinary reply.
                return new Proxy(admission, {
                  get(target, key, receiver) {
                    return key === "committed" || key === "settlement"
                      ? undefined
                      : Reflect.get(target, key, receiver);
                  },
                });
              });
        const restoreReplies = scopedOnly
          ? () => {}
          : interceptManagedImageMutationReplies((commandType) => {
              if (commandType !== "managedImages.insert") {
                return false;
              }
              nativeReplies++;
              if (failure === "revoked after commit") {
                active = false;
              }
              return failure === "lost ordinary reply" || failure === "lost native receipt";
            });
        const displaced = state.statePath("displaced-original.png");
        try {
          const result = withChannelReadAuthority(
            assertCurrent,
            async () => {
              const blocks = await createMedia(
                state.stateDir,
                scopedOnly ? undefined : assertCurrent,
              );
              if (failure === "closed database") {
                await closeOpenClawStateDatabaseByPathAsync(
                  state.statePath("state", "openclaw.sqlite"),
                );
              } else if (failure === "replaced original") {
                const records = await entries();
                expect(records).toHaveLength(1);
                const original = recordPath(records[0]!.record);
                await fsAsync.rename(original, displaced);
                await fsAsync.writeFile(original, "synthetic replacement");
              }
              return blocks;
            },
            undefined,
            accepted,
          );
          const outcome = await result.then(
            (blocks) => ({ blocks }),
            (error: unknown) => ({ error }),
          );
          // Read persisted state only after disabling transport fault injection.
          restoreReplies();
          admissionSpy?.mockRestore();
          const records = await entries();
          if (failure === "refused commit" || failure === "revoked after commit") {
            expect(outcome).toEqual({ error: revoked });
            expect(records).toEqual([]);
            expect(
              await fsAsync.readdir(state.statePath("media", "outgoing", "originals")),
            ).toEqual([]);
            expect(refused).toBe(failure === "refused commit");
            expect(nativeReplies).toBe(failure === "refused commit" ? 0 : 1);
          } else {
            expect(records).toHaveLength(1);
            const record = records[0]!.record;
            if (failure === "closed database") {
              expect(
                "error" in outcome && isStateDatabaseReadAdmissionInvalidatedError(outcome.error),
              ).toBe(true);
              expect(records[0]?.cleanupPending).toBe(false);
            } else {
              expect(record).toMatchObject({ retentionClass: "transient", messageId: null });
              if (failure === "replaced original") {
                await expect(result).rejects.toThrow(
                  "Media output no longer names the created file",
                );
                expect(records[0]?.cleanupPending).toBe(true);
              } else {
                expect(nativeReplies).toBe(1);
                expect(outcome).toHaveProperty(
                  failure === "lost ordinary reply" ? "blocks" : "error",
                );
              }
            }
            if (failure === "replaced original") {
              expect(await fsAsync.readFile(recordPath(record), "utf8")).toBe(
                "synthetic replacement",
              );
              expect(await fsAsync.readFile(displaced)).toEqual(bytes);
            } else {
              expect(await fsAsync.readFile(recordPath(record))).toEqual(bytes);
            }
          }
          expect(accepted).toHaveBeenCalledTimes(failure === "lost ordinary reply" ? 1 : 0);
        } finally {
          restoreReplies();
          admissionSpy?.mockRestore();
        }
      },
    );
  });
});
