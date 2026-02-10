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
    // File is now saved as markdown (wrapped in code block for plain text)
    const content = file.buffer.toString();
    expect(content).toContain("test content");
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

  describe("saveFile with markdown", () => {
    it("saves CSV file as .md instead of .raw", async () => {
      const csvBuffer = Buffer.from("id,name\n1,Test", "utf-8");
      const fileId = await saveFile({
        sessionId,
        agentId,
        filename: "test.csv",
        type: "csv",
        buffer: csvBuffer,
        filesDir: testDir,
      });

      const mdPath = path.join(testDir, `${fileId}-test.csv.md`);
      const rawPath = path.join(testDir, `${fileId}-test.csv.raw`);

      // .md file should exist
      const mdExists = await fs
        .access(mdPath)
        .then(() => true)
        .catch(() => false);
      expect(mdExists).toBe(true);

      // .raw file should NOT exist
      const rawExists = await fs
        .access(rawPath)
        .then(() => true)
        .catch(() => false);
      expect(rawExists).toBe(false);

      // Content should be markdown table
      const mdContent = await fs.readFile(mdPath, "utf-8");
      expect(mdContent).toContain("| id | name |");
    });

    it("saves JSON file as .md", async () => {
      const jsonBuffer = Buffer.from('{"key":"value"}', "utf-8");
      const fileId = await saveFile({
        sessionId,
        agentId,
        filename: "test.json",
        type: "json",
        buffer: jsonBuffer,
        filesDir: testDir,
      });

      const mdPath = path.join(testDir, `${fileId}-test.json.md`);
      const mdContent = await fs.readFile(mdPath, "utf-8");
      expect(mdContent).toContain("```json");
      expect(mdContent).toContain('"key": "value"');
    });

    it("saves text file as .md", async () => {
      const textBuffer = Buffer.from("Plain text content", "utf-8");
      const fileId = await saveFile({
        sessionId,
        agentId,
        filename: "test.txt",
        type: "text",
        buffer: textBuffer,
        filesDir: testDir,
      });

      const mdPath = path.join(testDir, `${fileId}-test.txt.md`);
      const mdContent = await fs.readFile(mdPath, "utf-8");
      expect(mdContent).toContain("```");
      expect(mdContent).toContain("Plain text content");
    });
  });
});
