import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { lookupReplyContextSync } from "./reply-context-lookup.js";

describe("lookupReplyContextSync", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "imessage-reply-context-"));
    dbPath = path.join(tmpDir, "chat.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createChatDb(): void {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, reply_to_guid TEXT, handle_id INTEGER REFERENCES handle(ROWID));
      INSERT INTO handle (ROWID, id) VALUES (1, '+15559998888');
      INSERT INTO handle (ROWID, id) VALUES (2, '+15550001111');
      INSERT INTO message (ROWID, guid, text, reply_to_guid, handle_id) VALUES (1, 'guid-original', 'Original message', NULL, 1);
      INSERT INTO message (ROWID, guid, text, reply_to_guid, handle_id) VALUES (2, 'guid-reply', 'This is a reply', 'guid-original', 2);
    `);
    db.close();
  }

  it("returns null when dbPath is empty", () => {
    expect(lookupReplyContextSync("", 1)).toBeNull();
    expect(lookupReplyContextSync("   ", 1)).toBeNull();
  });

  it("returns null when db file does not exist", () => {
    expect(lookupReplyContextSync(path.join(tmpDir, "nonexistent.db"), 1)).toBeNull();
  });

  it("returns null when message has no reply_to_guid", () => {
    createChatDb();
    expect(lookupReplyContextSync(dbPath, 1)).toBeNull();
  });

  it("returns reply context when message is a reply", () => {
    createChatDb();
    const ctx = lookupReplyContextSync(dbPath, 2);
    expect(ctx).not.toBeNull();
    expect(ctx!.reply_to_id).toBe("guid-original");
    expect(ctx!.reply_to_text).toBe("Original message");
    expect(ctx!.reply_to_sender).toBe("+15559998888");
  });

  it("returns reply_to_id as guid when quoted row exists", () => {
    createChatDb();
    const ctx = lookupReplyContextSync(dbPath, 2);
    expect(ctx?.reply_to_id).toBe("guid-original");
  });

  it("returns null when quoted message is missing (reply_to_guid points to deleted)", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, reply_to_guid TEXT, handle_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550001111');
      INSERT INTO message (ROWID, guid, text, reply_to_guid, handle_id) VALUES (2, 'guid-reply', 'reply', 'deleted-guid', 1);
    `);
    db.close();
    expect(lookupReplyContextSync(dbPath, 2)).toBeNull();
  });

  it("returns null when message table has no reply_to_guid column (old schema)", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, handle_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550001111');
      INSERT INTO message (ROWID, guid, text, handle_id) VALUES (1, 'guid-one', 'hello', 1);
    `);
    db.close();
    expect(lookupReplyContextSync(dbPath, 1)).toBeNull();
  });
});
