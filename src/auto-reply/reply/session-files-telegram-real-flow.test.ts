import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { listFiles, getFile } from "../../sessions/files/storage.js";

describe("Telegram file upload - real flow simulation", () => {
  let testDir: string;
  let testFilesDir: string;
  const sessionKey = "telegram:123456";

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-real-flow-"));
    testFilesDir = path.join(testDir, "files");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create mock Telegram message context (like buildTelegramMessageContext does)
  function createTelegramContext(filePath: string, mimeType: string): MsgContext {
    return {
      Channel: "telegram",
      SessionKey: sessionKey,
      MediaPath: filePath,
      MediaPaths: [filePath],
      MediaType: mimeType,
      MediaTypes: [mimeType],
      Body: "Here's the file",
      From: "telegram:123456",
      To: "telegram:123456",
      Provider: "telegram",
      Surface: "telegram",
    } as MsgContext;
  }

  // Helper to create minimal config
  function createTestConfig(): OpenClawConfig {
    return {
      session: {
        store: { type: "memory" },
      },
    } as OpenClawConfig;
  }

  it("saves CSV file as .md when processed through persistSessionFiles (real Telegram flow)", async () => {
    // RED: Write failing test - expect file to be saved as .md
    // This simulates the EXACT flow that happens when file comes from Telegram:
    // 1. Telegram sets MediaPath and MediaType in context
    // 2. getReplyFromConfig calls persistSessionFiles
    // 3. persistSessionFiles should save as .md

    const csvPath = path.join(process.cwd(), ".cursor/test/bot knowledge test.csv");
    const ctx = createTelegramContext(csvPath, "text/csv");
    const cfg = createTestConfig();

    // This is what getReplyFromConfig does (line 163-173)
    const { persistSessionFiles } = await import("./session-files.js");
    const sessionId = `test-session-${Date.now()}`;

    await persistSessionFiles({
      ctx,
      sessionId,
      agentSessionKey: sessionKey,
      cfg,
      filesDir: testFilesDir,
    });

    // Verify: File should be saved as .md (not .raw)
    const files = await listFiles({ sessionId, agentId: "main", filesDir: testFilesDir });
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("csv");
    expect(files[0].storageFormat).toBe("markdown"); // NEW: verify storageFormat

    const fileId = files[0].id;
    const fileBase = `${fileId}-${files[0].filename}`;
    const mdPath = path.join(testFilesDir, `${fileBase}.md`);
    const rawPath = path.join(testFilesDir, `${fileBase}.raw`);

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

    // Content should be markdown table format
    const { buffer } = await getFile({
      sessionId,
      agentId: "main",
      fileId,
      filesDir: testFilesDir,
    });
    const content = buffer.toString("utf-8");
    expect(content).toContain("|");
    expect(content).toContain("---");
  });

  it("verifies file is saved as .md with correct filename format", async () => {
    const csvPath = path.join(process.cwd(), ".cursor/test/bot knowledge test.csv");
    const ctx = createTelegramContext(csvPath, "text/csv");
    const cfg = createTestConfig();
    const { persistSessionFiles } = await import("./session-files.js");
    const sessionId = `test-session-${Date.now()}`;

    await persistSessionFiles({
      ctx,
      sessionId,
      agentSessionKey: sessionKey,
      cfg,
      filesDir: testFilesDir,
    });

    const files = await listFiles({ sessionId, agentId: "main", filesDir: testFilesDir });
    expect(files).toHaveLength(1);
    expect(files[0].storageFormat).toBe("markdown"); // NEW: verify storageFormat

    const fileId = files[0].id;
    const fileBase = `${fileId}-${files[0].filename}`;
    const mdPath = path.join(testFilesDir, `${fileBase}.md`);

    // Verify .md file exists and has correct content
    const mdContent = await fs.readFile(mdPath, "utf-8");
    expect(mdContent).toContain("|");

    // Verify filename preserves original extension in the stored filename
    // The stored filename should be something like "bot knowledge test.csv"
    expect(files[0].filename).toContain(".csv");
  });
});
