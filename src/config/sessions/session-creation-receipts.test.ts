import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, cleanupTempDirs } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  writeSessionEntry,
  deleteSessionEntryRows,
  readExactSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import {
  prepareSessionCreationOperation,
  CREATION_OPERATION_VALIDITY_MS,
} from "./session-creation-operation.js";
import { commitSessionCreationReceipt } from "./session-creation-receipts.js";

const tempDirs: string[] = [];
const now = 1_800_000_000_000;
function uuidAt(time: number) {
  const hex = time.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7c62-bef8-f26bc2e8c724`;
}
const sessionId = uuidAt(now);
const key = `agent:main:dashboard:${sessionId}`;
const operation = (principal = "profile", label = "work") =>
  prepareSessionCreationOperation(
    principal,
    `v1:${now}:0123456789abcdef0123456789abcdef`,
    sessionId,
    { label },
    now,
  );
function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-receipt-") },
  };
  const database = openOpenClawAgentDatabase(options);
  const write = <T>(run: (db: OpenClawAgentDatabase) => T) =>
    runOpenClawAgentWriteTransaction(run, options);
  const create = () =>
    write((db) => {
      expect(commitSessionCreationReceipt(db, key, operation())).toBe(false);
      ensureTranscriptHeader(
        db,
        { agentId: "main", path: db.path, sessionKey: key, sessionId },
        undefined,
      );
      writeSessionEntry(db, key, { sessionId, lifecycleRevision: sessionId, updatedAt: now });
    });
  return { options, database, write, create };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  cleanupTempDirs(tempDirs);
});

describe("retained creation receipt transaction", () => {
  it("rolls back receipt and session together and resolves exact retries after reopen", async () => {
    const { options, database, write, create } = fixture();
    expect(() =>
      write((db) => {
        commitSessionCreationReceipt(db, key, operation());
        ensureTranscriptHeader(
          db,
          { agentId: "main", path: db.path, sessionKey: key, sessionId },
          undefined,
        );
        writeSessionEntry(db, key, { sessionId, lifecycleRevision: sessionId, updatedAt: now });
        throw new Error("synthetic transaction failure");
      }),
    ).toThrow(/synthetic/);
    expect(readExactSessionEntryRow(database, key)).toBeUndefined();
    expect(database.db.prepare("SELECT * FROM session_creation_operations").all()).toEqual([]);
    expect(database.db.prepare("SELECT * FROM transcript_events").all()).toEqual([]);
    create();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    expect(
      runOpenClawAgentWriteTransaction(
        (db) => commitSessionCreationReceipt(db, key, operation()),
        options,
      ),
    ).toBe(true);
  });
  it("rejects changed arguments and another caller rather than adopting its physical UUID", () => {
    const { write, create } = fixture();
    create();
    const otherOperation = prepareSessionCreationOperation(
      "profile",
      `v1:${now}:fedcba9876543210fedcba9876543210`,
      sessionId,
      { label: "work" },
      now,
    );
    expect(() => write((db) => commitSessionCreationReceipt(db, key, otherOperation))).toThrow(
      /existing/,
    );
    expect(() =>
      write((db) => commitSessionCreationReceipt(db, key, operation("profile", "changed"))),
    ).toThrow(/different arguments/);
    expect(() => write((db) => commitSessionCreationReceipt(db, key, operation("other")))).toThrow(
      /existing/,
    );
    expect(() =>
      write((db) => commitSessionCreationReceipt(db, "agent:main:other", operation("other"))),
    ).toThrow(/existing physical/);
  });
  it("retains the receipt after reset or deletion, never recreates a successor, and rejects after expiry", () => {
    const { database, write, create } = fixture();
    create();
    write((db) =>
      writeSessionEntry(db, key, { sessionId: "reset-incarnation", updatedAt: now + 1 }),
    );
    expect(() => write((db) => commitSessionCreationReceipt(db, key, operation()))).toThrow(
      /no longer available/,
    );
    write((db) => deleteSessionEntryRows(db, key, { deleteOwnedWindows: true }));
    expect(() => write((db) => commitSessionCreationReceipt(db, key, operation()))).toThrow(
      /no longer available/,
    );
    expect(readExactSessionEntryRow(database, key)).toBeUndefined();
    const expiredNow = now + CREATION_OPERATION_VALIDITY_MS;
    vi.mocked(Date.now).mockReturnValue(expiredNow);
    // The next admitted creation prunes expired native receipts; no timer or
    // separate service is required, and admission still rejects the original ID.
    const nextSessionId = uuidAt(expiredNow);
    const nextKey = `agent:main:dashboard:${nextSessionId}`;
    expect(() =>
      prepareSessionCreationOperation(
        "profile",
        `v1:${expiredNow}:fedcba9876543210fedcba9876543210`,
        sessionId,
        {},
        expiredNow,
      ),
    ).toThrow(/UUIDv7/);
    const next = prepareSessionCreationOperation(
      "profile",
      `v1:${expiredNow}:fedcba9876543210fedcba9876543210`,
      nextSessionId,
      { label: "next" },
      expiredNow,
    );
    write((db) => {
      commitSessionCreationReceipt(db, nextKey, next);
      writeSessionEntry(db, nextKey, {
        sessionId: nextSessionId,
        lifecycleRevision: nextSessionId,
        updatedAt: expiredNow,
      });
    });
    expect(
      database.db
        .prepare(
          "SELECT operation_digest FROM session_creation_operations WHERE operation_digest = ?",
        )
        .get(operation().digest),
    ).toBeUndefined();
    expect(() =>
      prepareSessionCreationOperation(
        "profile",
        `v1:${expiredNow}:fedcba9876543210fedcba9876543210`,
        sessionId,
        {},
        expiredNow,
      ),
    ).toThrow(/UUIDv7/);
    expect(() => write((db) => commitSessionCreationReceipt(db, key, operation()))).toThrow(
      /expired/,
    );
  });
});
