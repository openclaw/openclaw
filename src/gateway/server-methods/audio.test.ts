import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";

const mocks = vi.hoisted(() => ({
  runAudioTranscription: vi.fn(async (_params: { attachments: Array<{ path: string }> }) => ({
    transcript: "dictated text",
    attachments: [],
  })),
}));

vi.mock("../../media-understanding/audio-transcription-runner.js", () => ({
  runAudioTranscription: mocks.runAudioTranscription,
}));

describe("audioHandlers", () => {
  beforeEach(() => {
    mocks.runAudioTranscription.mockReset();
    mocks.runAudioTranscription.mockResolvedValue({ transcript: "dictated text", attachments: [] });
  });

  it("transcribes a bounded temporary recording and removes it", async () => {
    const { audioHandlers } = await import("./audio.js");
    const respond = vi.fn();

    await audioHandlers["audio.transcribe"]({
      params: {
        audio: Buffer.from("a".repeat(1200)).toString("base64"),
        mimeType: "audio/webm;codecs=opus",
      },
      respond,
      context: { getRuntimeConfig: () => ({}) },
    } as never);

    expect(respond).toHaveBeenCalledWith(true, { transcript: "dictated text" });
    const capturePath = mocks.runAudioTranscription.mock.calls[0]?.[0].attachments[0].path;
    await expect(import("node:fs/promises").then((fs) => fs.access(capturePath))).rejects.toThrow();
  });

  it("rejects unsupported or oversized request payloads", async () => {
    const { audioHandlers } = await import("./audio.js");
    const respond = vi.fn();

    await audioHandlers["audio.transcribe"]({
      params: { audio: "not base64", mimeType: "text/plain" },
      respond,
      context: { getRuntimeConfig: () => ({}) },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "audio.transcribe requires supported base64 audio no larger than 12 MB",
    });
    expect(mocks.runAudioTranscription).not.toHaveBeenCalled();
  });
});
