import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "./chat-webchat-media.js";

describe("buildWebchatAudioContentBlocksFromReplyPayloads", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
  });

  it("embeds a local audio file as a base64 gateway chat block", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    const blocks = buildWebchatAudioContentBlocksFromReplyPayloads([{ mediaUrl: audioPath }]);

    expect(blocks).toHaveLength(1);
    const block = blocks[0] as {
      type?: string;
      source?: { type?: string; media_type?: string; data?: string };
    };
    expect(block.type).toBe("audio");
    expect(block.source?.type).toBe("base64");
    expect(block.source?.media_type).toBe("audio/mpeg");
    expect(block.source?.data?.startsWith("data:audio/mpeg;base64,")).toBe(true);
  });

  it("skips remote URLs", () => {
    const blocks = buildWebchatAudioContentBlocksFromReplyPayloads([
      { mediaUrl: "https://example.com/a.mp3" },
    ]);
    expect(blocks).toHaveLength(0);
  });

  it("dedupes repeated paths", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x00]));

    const blocks = buildWebchatAudioContentBlocksFromReplyPayloads([
      { mediaUrl: audioPath },
      { mediaUrl: audioPath },
    ]);
    expect(blocks).toHaveLength(1);
  });
});
