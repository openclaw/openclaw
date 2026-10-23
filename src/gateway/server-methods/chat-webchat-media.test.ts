import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";

async function buildWebchatAudioBlocks(
  ...args: Parameters<typeof buildWebchatAssistantMessageFromReplyPayloads>
): Promise<Array<Record<string, unknown>>> {
  const message = await buildWebchatAssistantMessageFromReplyPayloads(...args);
  return message?.content.filter((block) => block.type === "attachment") ?? [];
}

type Reply = Parameters<typeof buildWebchatAssistantMessageFromReplyPayloads>[0][number];
const buildImage = (mediaUrl: string, reply: Omit<Reply, "mediaUrl"> = {}) =>
  buildWebchatAssistantMessageFromReplyPayloads([{ ...reply, mediaUrl }]);
const imageUrl = "data:image/png;base64,cG5n";
const imageContent = (text: string) => [
  { type: "text", text },
  { type: "input_image", image_url: imageUrl },
];
const localAudio = (mediaUrl: string, localRoot: string, reply: Omit<Reply, "mediaUrl"> = {}) =>
  buildWebchatAudioBlocks([{ mediaUrl, trustedLocalMedia: true, ...reply }], {
    localRoots: [localRoot],
  });

describe("webchat audio blocks through assistant messages", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
  });

  function writeAudioFixture(bytes = [0xff, 0xfb, 0x90, 0x00], extension = ".mp3") {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, `clip${extension}`);
    fs.writeFileSync(audioPath, Buffer.from(bytes));
    return { audioPath, localRoot: tmpDir };
  }

  it("preserves voice-note metadata on local audio attachments", async () => {
    const { audioPath, localRoot } = writeAudioFixture();

    const blocks = await localAudio(audioPath, localRoot, { audioAsVoice: true });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "attachment",
      attachment: { isVoiceNote: true },
    });
  });

  it("skips non-audio local files", async () => {
    const { audioPath, localRoot } = writeAudioFixture([0x89, 0x50, 0x4e, 0x47], ".png");
    const blocks = await localAudio(audioPath, localRoot);
    expect(blocks).toHaveLength(0);
  });

  it("dedupes repeated paths", async () => {
    const { audioPath, localRoot } = writeAudioFixture([0x00]);

    const blocks = await buildWebchatAudioBlocks(
      [
        { mediaUrl: audioPath, trustedLocalMedia: true },
        { mediaUrl: audioPath, trustedLocalMedia: true },
      ],
      { localRoots: [localRoot] },
    );
    expect(blocks).toHaveLength(1);
  });

  it.each(["FiLe://", "FILE:"])(
    "embeds %s URLs pointing at a local file within localRoots",
    async (scheme) => {
      const { audioPath, localRoot } = writeAudioFixture([0x01]);

      const fileUrl = pathToFileURL(audioPath).href.replace(/^file:\/\/\//, `${scheme}/`);
      const blocks = await localAudio(fileUrl, localRoot);
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as { type?: string }).type).toBe("attachment");
    },
  );

  it("drops uppercase file URLs with remote hosts before touching the filesystem", async () => {
    const source = "FILE://attacker/share/probe.mp3";
    const openSpy = vi.spyOn(fsPromises, "open");
    const blocks = await buildWebchatAudioBlocks([
      { text: `MEDIA:${source}`, mediaUrl: source, trustedLocalMedia: true },
    ]);
    expect(blocks).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("rejects a local audio file outside configured localRoots", async () => {
    const { audioPath, localRoot } = writeAudioFixture([0x03]);
    const allowedRoot = path.join(localRoot, "allowed");
    fs.mkdirSync(allowedRoot, { recursive: true });

    const onLocalAudioAccessDenied = vi.fn();
    const blocks = await buildWebchatAudioBlocks(
      [{ mediaUrl: audioPath, trustedLocalMedia: true }],
      {
        localRoots: [allowedRoot],
        onLocalAudioAccessDenied,
      },
    );

    expect(blocks).toHaveLength(0);
    expect(onLocalAudioAccessDenied).toHaveBeenCalledOnce();
  });

  it("skips local audio when the opened file stat is over the cap", async () => {
    const { audioPath, localRoot } = writeAudioFixture([0x02]);
    fs.truncateSync(audioPath, 16 * 1024 * 1024);

    const blocks = await localAudio(audioPath, localRoot);
    expect(blocks).toHaveLength(0);
  });

  it("rejects untrusted local audio paths", async () => {
    const { audioPath, localRoot } = writeAudioFixture();

    const blocks = await buildWebchatAudioBlocks([{ mediaUrl: audioPath }], {
      localRoots: [localRoot],
    });
    expect(blocks).toHaveLength(0);
  });
});

describe("buildWebchatAssistantMessageFromReplyPayloads", () => {
  it("suppresses reasoning payload media transcripts", async () => {
    const message = await buildImage(imageUrl, { text: "Reasoning:\n_step_", isReasoning: true });
    expect(message).toBeNull();
  });

  it("sanitizes reply directive IDs", async () => {
    const transcriptText = "[[reply_to:abcaudio_as_voice]]Image reply";
    const message = await buildImage(imageUrl, { replyToId: "abc]]\n[[audio_as_voice]]" });
    expect(message).toMatchObject({
      transcriptText,
      content: imageContent(transcriptText),
    });
  });

  it("drops oversized data image URLs", async () => {
    const hugeBase64 = "A".repeat(2_100_000);
    const message = await buildImage(`data:image/png;base64,${hugeBase64}`, { text: "too large" });
    expect(message).toBeNull();
  });

  it("keeps valid whitespace in data image payloads", async () => {
    const spacedUrl = "data:image/png;base64,cG 5n\n";
    const message = await buildImage(spacedUrl, { text: "whitespace image" });
    expect(message?.content).toContainEqual({ type: "input_image", image_url: spacedUrl.trim() });
  });

  it.each([
    ["invalid", "data:image/png;base64,cG5n!"],
    ["remote", "https://example.com/final.png"],
    ["svg", "data:image/svg+xml;base64,PHN2Zy8+"],
  ])("rejects %s image payloads", async (text, mediaUrl) => {
    const message = await buildImage(mediaUrl, { text });
    expect(message).toBeNull();
  });
});
