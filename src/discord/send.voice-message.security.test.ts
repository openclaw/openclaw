import path from "node:path";
import { describe, expect, it } from "vitest";
import { sendVoiceMessageDiscord } from "./send.js";

describe("sendVoiceMessageDiscord - media hardening", () => {
  it("rejects local paths outside allowed media roots (prevents local file exfiltration)", async () => {
    const candidate = path.join(process.cwd(), "package.json");
    await expect(sendVoiceMessageDiscord("channel:123", candidate)).rejects.toThrow(
      /Local media path is not under an allowed directory/,
    );
  });

  it("blocks SSRF targets when given a private-network URL", async () => {
    await expect(
      sendVoiceMessageDiscord("channel:123", "http://127.0.0.1/voice.ogg"),
    ).rejects.toThrow(/Failed to fetch media|Blocked/);
  });

  it("does not allow non-http URL schemes to reach ffmpeg/ffprobe", async () => {
    await expect(
      sendVoiceMessageDiscord("channel:123", "rtsp://example.com/voice.ogg"),
    ).rejects.toThrow(/Local media path is not under an allowed directory|ENOENT|no such file/i);
  });
});
