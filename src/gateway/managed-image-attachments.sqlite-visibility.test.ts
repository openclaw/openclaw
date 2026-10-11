import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { ensureSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  publishEncodedSessionTranscriptArchive,
  resolveSqliteTranscriptArchivePath,
} from "../config/sessions/session-accessor.sqlite-archive-artifact.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import * as brokerReply from "../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { appendSessionTranscriptMessageByIdentity } from "../plugin-sdk/session-transcript-runtime.js";
import { withChannelReadAuthority } from "../shared/channel-read-authority.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  withScopedOpenClawAgentDatabaseReadOnly,
} from "../state/openclaw-agent-db-readonly-scope.js";
import {
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
  cleanupManagedOutgoingMediaRecords,
  createManagedOutgoingMediaBlocks,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  type ManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import {
  readSessionMessageCountAsync,
  readSessionMessagesAsync,
  readSessionMessagesMatchingIdAsync,
  readSessionMessagesWithSourceAsync,
} from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const timestamp = "2026-09-04T00:00:00.000Z";
let stateDir: string;
let savedEnv: ReturnType<typeof captureEnv>;

function message(id: string, parentId: string | null, content: unknown) {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant", content } };
}

async function fixture(messageId = "attached", incognito = false) {
  const agentId = "main";
  const sessionId = `managed-visibility-${randomUUID()}`;
  const sessionKey = incognito
    ? `agent:${agentId}:dashboard:incognito-${sessionId}`
    : `agent:${agentId}:${sessionId}`;
  const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  const scope = { agentId, sessionId, sessionKey, storePath };
  // This fixture owns the competing writer; background entry maintenance must not join it.
  expect(
    ensureSessionEntrySync(scope, {
      sessionId,
      updatedAt: Date.now(),
      ...(incognito ? { incognito } : {}),
    }),
  ).toBe(true);
  const attachmentId = randomUUID();
  const body = Buffer.from("synthetic managed original\n");
  const mediaRoot = path.join(stateDir, "media");
  const mediaId = `${attachmentId}.png`;
  const originalPath = path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.writeFileSync(originalPath, body);
  await insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      agentId,
      messageId,
      createdAt: timestamp,
      alt: "Synthetic attachment",
      original: {
        mediaRoot,
        mediaId,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: "image/png",
        width: 1,
        height: 1,
        sizeBytes: body.length,
        filename: "fixture.png",
      },
    },
    stateDir,
  );
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

async function seed(f: Awaited<ReturnType<typeof fixture>>, events: unknown[]) {
  await replaceTranscriptEvents(f.scope, [
    { type: "session", version: 3, id: f.scope.sessionId, timestamp, cwd: stateDir },
    ...events,
  ]);
  await readSessionMessageCountAsync(f.scope);
}

function archive(
  f: Awaited<ReturnType<typeof fixture>>,
  events: unknown[] = [message(f.messageId, null, [f.block])],
) {
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

  it.each(["missing", "invalid-row", "ambiguous"] as const)(
    "refuses a %s ownership source without collecting its media",
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
      expect(await cleanupManagedOutgoingMediaRecords({ stateDir })).toMatchObject({
        deletedRecordCount: 0,
        retainedCount: 1,
      });
      expect(await readManagedImageRecord(f.attachmentId, stateDir)).not.toBeNull();
      expect(fs.existsSync(f.originalPath)).toBe(true);
    },
  );

  it("collects media after an in-process session replacement invalidates the selected entry", async () => {
    const f = await fixture();
    await seed(f, [message(f.messageId, null, [f.block])]);
    expect(await cleanupManagedOutgoingMediaRecords({ stateDir })).toMatchObject({
      deletedRecordCount: 0,
      retainedCount: 1,
    });

    await replaceSessionEntry(f.scope, { sessionId: "replacement-session", updatedAt: Date.now() });

    expect(await cleanupManagedOutgoingMediaRecords({ stateDir })).toMatchObject({
      deletedRecordCount: 1,
      retainedCount: 0,
    });
    expect(await readManagedImageRecord(f.attachmentId, stateDir)).toBeNull();
    expect(fs.existsSync(f.originalPath)).toBe(false);
  });

  it("retains and serves media owned by an unbound process-held incognito session", async () => {
    // The running Gateway already owns a durable store beside its process-held sessions.
    openOpenClawAgentDatabase({ agentId: "main" });
    const f = await fixture("attached", true);
    await seed(f, [message(f.messageId, null, [f.block])]);

    expect(await f.download()).not.toBeNull();
    expect(await cleanupManagedOutgoingMediaRecords({ stateDir })).toMatchObject({
      deletedRecordCount: 0,
      retainedCount: 1,
    });
    expect(await readManagedImageRecord(f.attachmentId, stateDir)).not.toBeNull();
    expect(fs.existsSync(f.originalPath)).toBe(true);
  });

  it("reads managed attachment membership without validating unrelated payloads", async () => {
    const f = await fixture();
    const marker = "unrelated-managed-download-payload";
    await seed(f, [
      message("first", null, "first visible content"),
      message("unrelated", "first", marker.repeat(1024)),
      message(f.messageId, "unrelated", [f.block]),
    ]);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const native = new DatabaseSync(":memory:");
    const validate = native.prepare("SELECT json_valid(?) AS valid");
    const readScope = new OpenClawAgentDatabaseReadOnlyScope();
    const target = { agentId: "main", path: database.path };
    let inspectedUnrelatedPayloads = 0;
    try {
      // Observe the managed-media reader's native queries without crossing a worker boundary.
      await readScope.run(target, async () => {
        const observed = withScopedOpenClawAgentDatabaseReadOnly(({ db }) => {
          db.function("json_valid", { deterministic: true }, (value) => {
            if (typeof value === "string" && value.includes(marker)) {
              inspectedUnrelatedPayloads += 1;
            }
            return Number(validate.get(value)!.valid);
          });
        }, target);
        expect(observed.found).toBe(true);
        const reader = createReadonlySessionHistoryReader({
          database: target,
          transcript: { ...f.scope, sessionFile: f.scope.sessionKey },
        });
        expect(await reader.readSessionMessagesMatchingIdAsync(f.scope, f.messageId)).toMatchObject(
          [{ content: [f.block], __openclaw: { id: f.messageId } }],
        );
        expect(inspectedUnrelatedPayloads).toBe(0);
      });
    } finally {
      readScope.close();
      native.close();
    }
  });

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
  });

  it("validates the admitted generation on both matching and missing IDs", async () => {
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
      await expect(
        runWithSessionTranscriptReadFence({ ...receipt, generation: "stale" }, () =>
          readSessionMessagesMatchingIdAsync(f.scope, id),
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
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
      const writer = new DatabaseSync(database.path, { timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS });
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
    expect(
      await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: f.scope.sessionKey }),
    ).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
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
    expect(
      await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: f.scope.sessionKey }),
    ).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 2 });
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
  it("retains committed bytes without accepting a result after its database admission closes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", label: "managed-media-retirement" },
      async (state) => {
        const accepted = vi.fn();
        const result = withChannelReadAuthority(
          () => {},
          async () => {
            const blocks = await createMedia(state.stateDir);
            await closeOpenClawStateDatabaseByPathAsync(
              state.statePath("state", "openclaw.sqlite"),
            );
            return blocks;
          },
          undefined,
          accepted,
        );
        const outcome = await result.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isStateDatabaseReadAdmissionInvalidatedError(outcome)).toBe(true);
        expect(accepted).not.toHaveBeenCalled();
        const entries = await listManagedImageRecordEntries({ stateDir: state.stateDir });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.cleanupPending).toBe(false);
        const record = entries[0]!.record;
        expect(await fsAsync.readFile(recordPath(record))).toEqual(bytes);
      },
    );
  });

  it("rejects a replaced file without deleting either inode after record custody is delegated", async () => {
    await withOpenClawTestState(
      { layout: "state-only", label: "managed-media-replacement" },
      async (state) => {
        const accepted = vi.fn();
        const displaced = state.statePath("displaced-original.png");
        let originalPath: string | undefined;
        const result = withChannelReadAuthority(
          () => {},
          async () => {
            const blocks = await createMedia(state.stateDir);
            const entries = await listManagedImageRecordEntries({ stateDir: state.stateDir });
            expect(entries).toHaveLength(1);
            const record = entries[0]!.record;
            originalPath = recordPath(record);
            await fsAsync.rename(originalPath, displaced);
            await fsAsync.writeFile(originalPath, "synthetic replacement");
            return blocks;
          },
          undefined,
          accepted,
        );
        await expect(result).rejects.toThrow("Media output no longer names the created file");
        expect(accepted).not.toHaveBeenCalled();
        expect(originalPath).toBeDefined();
        if (!originalPath) {
          throw new Error("Managed media fixture did not commit a file");
        }
        expect(await fsAsync.readFile(originalPath, "utf8")).toBe("synthetic replacement");
        expect(await fsAsync.readFile(displaced)).toEqual(bytes);
        expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
          { cleanupPending: true, record: { retentionClass: "transient", messageId: null } },
        ]);
      },
    );
  });

  it.each([
    "refused commit",
    "revoked after commit",
    "lost ordinary reply",
    "lost native receipt",
  ] as const)("settles the original file and record after a %s", async (failure) => {
    await withOpenClawTestState(
      { layout: "state-only", label: "managed-media-custody" },
      async (state) => {
        await listManagedImageRecordEntries({ stateDir: state.stateDir });
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
        const admissionSpy = vi
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
            // Native work still executes and joins; only its retained facts are unavailable
            // to the media owner, alongside the independently corrupted ordinary reply.
            return new Proxy(admission, {
              get(target, key, receiver) {
                if (key === "committed" || key === "settlement") {
                  return undefined;
                }
                return Reflect.get(target, key, receiver);
              },
            });
          });
        const receive = brokerReply.receiveSqliteWorkerReply;
        const replySpy = vi
          .spyOn(brokerReply, "receiveSqliteWorkerReply")
          .mockImplementation((slot, reply, owner) => {
            if (
              slot.current?.request.type === "execute" &&
              reply.ok &&
              !reply.transfer &&
              !reply.input
            ) {
              const command: unknown = deserialize(slot.current.request.input);
              if (isRecord(command) && command.type === "managedImages.insert") {
                nativeReplies++;
                if (failure === "revoked after commit") {
                  active = false;
                }
                if (failure === "lost ordinary reply" || failure === "lost native receipt") {
                  return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
                }
              }
            }
            return receive(slot, reply, owner);
          });
        try {
          const outcome = await withChannelReadAuthority(
            assertCurrent,
            () => createMedia(state.stateDir, assertCurrent),
            undefined,
            accepted,
          ).then(
            (blocks) => ({ blocks }),
            (error: unknown) => ({ error }),
          );
          // Stop injecting transport faults before independently reading the persisted result.
          replySpy.mockRestore();
          admissionSpy.mockRestore();
          const entries = await listManagedImageRecordEntries({ stateDir: state.stateDir });
          const originals = state.statePath("media", "outgoing", "originals");
          if (failure === "lost ordinary reply" || failure === "lost native receipt") {
            expect(nativeReplies).toBe(1);
            expect(entries).toHaveLength(1);
            const record = entries[0]!.record;
            expect(record).toMatchObject({ retentionClass: "transient", messageId: null });
            expect(await fsAsync.readFile(recordPath(record))).toEqual(bytes);
            if (failure === "lost ordinary reply") {
              expect(outcome).toHaveProperty("blocks");
              expect(accepted).toHaveBeenCalledOnce();
            } else {
              expect(outcome).toHaveProperty("error");
              expect(accepted).not.toHaveBeenCalled();
            }
          } else {
            expect(outcome).toEqual({ error: revoked });
            expect(accepted).not.toHaveBeenCalled();
            expect(entries).toEqual([]);
            expect(await fsAsync.readdir(originals)).toEqual([]);
            expect(refused).toBe(failure === "refused commit");
            expect(nativeReplies).toBe(failure === "refused commit" ? 0 : 1);
          }
        } finally {
          replySpy.mockRestore();
          admissionSpy.mockRestore();
        }
      },
    );
  });
});
