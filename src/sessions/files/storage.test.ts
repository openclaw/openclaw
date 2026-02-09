import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveFile, getFile, listFiles, deleteFile } from "./storage.js";

describe("file storage", () => {
  let testDir: string;
  const sessionId = "test-session";
  const agentId = "test-agent";

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-files-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("saves file and creates index", async () => {
    const buffer = Buffer.from("test content");
    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "test.txt",
      type: "text",
      buffer,
      filesDir: testDir,
    });
    expect(fileId).toBeTruthy();
    const file = await getFile({ sessionId, agentId, fileId, filesDir: testDir });
    expect(file.buffer.toString()).toBe("test content");
  });

  it("saves CSV and parses it", async () => {
    const csv = "name,sales\nProduct A,1000";
    const buffer = Buffer.from(csv);
    await saveFile({
      sessionId,
      agentId,
      filename: "test.csv",
      type: "csv",
      buffer,
      filesDir: testDir,
    });
    const files = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(files).toHaveLength(1);
    expect(files[0].csvSchema?.columns).toEqual(["name", "sales"]);
  });

  it("lists all files in session", async () => {
    await saveFile({
      sessionId,
      agentId,
      filename: "file1.txt",
      type: "text",
      buffer: Buffer.from("content1"),
      filesDir: testDir,
    });
    await saveFile({
      sessionId,
      agentId,
      filename: "file2.csv",
      type: "csv",
      buffer: Buffer.from("a,b\n1,2"),
      filesDir: testDir,
    });
    const files = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(files).toHaveLength(2);
  });

  it("deletes file", async () => {
    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "test.txt",
      type: "text",
      buffer: Buffer.from("content"),
      filesDir: testDir,
    });
    await deleteFile({ sessionId, agentId, fileId, filesDir: testDir });
    const files = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(files).toHaveLength(0);
  });
});
