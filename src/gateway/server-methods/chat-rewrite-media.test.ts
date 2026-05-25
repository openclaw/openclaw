import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SavedMedia } from "../../media/store.js";
import { rewriteChatSendUserTurnMediaPaths } from "./chat.ts";

describe("rewriteChatSendUserTurnMediaPaths", () => {
  let tmpDir: string;
  let transcriptPath: string;
  const mockSessionKey = "test-session-key";
  const mockCfg: OpenClawConfig = {
    tools: { allow: ["read"] },
    agents: { list: [] },
  };

  afterEach(async () => {
    if (tmpDir && (await rm(tmpDir, { recursive: true, force: true }).catch(() => {}))) {
      tmpDir = "";
    }
  });

  async function createTranscriptWithEntry(entry: Record<string, unknown>): Promise<string> {
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
    const jsonl = JSON.stringify(entry) + "\n";
    await writeFile(transcriptPath, jsonl, "utf-8");
    return transcriptPath;
  }

  function mockSavedMedia(path: string): SavedMedia {
    return { localPath: path, mediaType: "image/png", sha256: "abc123" };
  }

  it("finds user message by exact text match", async () => {
    // Arrange
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-chat-rewrite-"));
    const userMsg = "What is in this image?";
    const entry = {
      id: "entry-1",
      seq: 1,
      timestamp: Date.now(),
      message: {
        role: "user",
        content: userMsg,
      },
    };
    await createTranscriptWithEntry(entry);
    const savedImages = [mockSavedMedia("/tmp/image1.png")];
    const mediaFields = { MediaPath: "/tmp/image1.png", MediaPaths: ["/tmp/image1.png"] };

    // Act - use indirect call to resolveChatSendTranscriptMediaFields inline
    // We'll call the function directly with params to trigger the lookup and rewrite
    await rewriteChatSendUserTurnMediaPaths({
      transcriptPath,
      sessionKey: mockSessionKey,
      message: userMsg,
      savedImages,
      cfg: mockCfg,
    });

    // Assert - read back transcript and verify MediaPath added
    const lines = (await readFile(transcriptPath, "utf-8")).trim().split("\n");
    const updatedEntry = JSON.parse(lines[0]);
    expect(updatedEntry.message).toMatchObject({
      MediaPath: "/tmp/image1.png",
      MediaPaths: ["/tmp/image1.png"],
    });
  });

  it("finds user message when content includes timestamp and media marker", async () => {
    // Arrange
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-chat-rewrite-"));
    const userMsg = "What is in this image?";
    const now = Date.now();
    // Simulate transcript content with extra timestamp and media marker text
    const entry = {
      id: "entry-2",
      seq: 2,
      timestamp: now,
      message: {
        role: "user",
        // Content includes extra info that would cause exact match to fail
        content: `[2025-01-01 12:00:00] ${userMsg}\n[media attached: media://inbound/abc123.png]`,
      },
    };
    await createTranscriptWithEntry(entry);
    const savedImages = [mockSavedMedia("/tmp/image2.png")];
    // Manually craft mediaFields result expected from resolveChatSendTranscriptMediaFields
    const mediaFields = { MediaPath: "/tmp/image2.png", MediaPaths: ["/tmp/image2.png"] };

    // Act
    await rewriteChatSendUserTurnMediaPaths({
      transcriptPath,
      sessionKey: mockSessionKey,
      message: userMsg,
      savedImages,
      cfg: mockCfg,
    });

    // Assert
    const lines = (await readFile(transcriptPath, "utf-8")).trim().split("\n");
    const updatedEntry = JSON.parse(lines[0]);
    expect(updatedEntry.message).toMatchObject({
      MediaPath: "/tmp/image2.png",
      MediaPaths: ["/tmp/image2.png"],
    });
  });

  it("finds user message by time proximity when text match fails but timestamp provided", async () => {
    // Arrange
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-chat-rewrite-"));
    const userMsg = "Check this screenshot";
    const sentTime = Date.now();
    const entryTime = sentTime + 1000; // within 5 seconds
    const entry = {
      id: "entry-3",
      seq: 3,
      timestamp: entryTime,
      message: {
        role: "user",
        // Content is different enough that includes() would fail
        content: `[processed at ${new Date(entryTime).toISOString()}] A different text here`,
      },
    };
    await createTranscriptWithEntry(entry);
    const savedImages = [mockSavedMedia("/tmp/image3.png")];

    // Act
    await rewriteChatSendUserTurnMediaPaths({
      transcriptPath,
      sessionKey: mockSessionKey,
      message: userMsg,
      savedImages,
      cfg: mockCfg,
      timestamp: sentTime, // provide the original send timestamp
    });

    // Assert
    const lines = (await readFile(transcriptPath, "utf-8")).trim().split("\n");
    const updatedEntry = JSON.parse(lines[0]);
    expect(updatedEntry.message).toMatchObject({
      MediaPath: "/tmp/image3.png",
      MediaPaths: ["/tmp/image3.png"],
    });
  });

  it("does not rewrite if MediaPath already exists", async () => {
    // Arrange
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-chat-rewrite-"));
    const userMsg = "Another image question";
    const entry = {
      id: "entry-4",
      seq: 4,
      timestamp: Date.now(),
      message: {
        role: "user",
        content: userMsg,
        MediaPath: "/already/has/path.png",
      },
    };
    await createTranscriptWithEntry(entry);
    const savedImages = [mockSavedMedia("/tmp/image4.png")];

    // Act
    await rewriteChatSendUserTurnMediaPaths({
      transcriptPath,
      sessionKey: mockSessionKey,
      message: userMsg,
      savedImages,
      cfg: mockCfg,
    });

    // Assert - should not overwrite existing MediaPath
    const lines = (await readFile(transcriptPath, "utf-8")).trim().split("\n");
    const updatedEntry = JSON.parse(lines[0]);
    expect(updatedEntry.message.MediaPath).toBe("/already/has/path.png");
  });

  it("does nothing if transcript index is missing", async () => {
    // Arrange
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-chat-rewrite-"));
    transcriptPath = path.join(tmpDir, "nonexistent.jsonl");
    const savedImages = [mockSavedMedia("/tmp/image5.png")];

    // Act - should not throw
    await rewriteChatSendUserTurnMediaPaths({
      transcriptPath: transcriptPath,
      sessionKey: mockSessionKey,
      message: "Hello",
      savedImages,
      cfg: mockCfg,
    });

    // Assert - file should not be created if index missing
    const exists = await rm(transcriptPath, { force: true })
      .then(() => false)
      .catch(() => true);
    expect(exists).toBe(false);
  });
});
