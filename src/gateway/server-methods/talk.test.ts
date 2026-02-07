import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("../../media-understanding/runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../media-understanding/runner.js")>(
    "../../media-understanding/runner.js",
  );
  return {
    ...actual,
    runCapability: vi.fn(),
  };
});

import { runCapability } from "../../media-understanding/runner.js";
import { talkHandlers } from "./talk.js";

describe("talk.stt", () => {
  it("returns noSpeech=true when provider returns missing transcript", async () => {
    const respond = vi.fn();

    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [],
      decision: {
        capability: "audio",
        outcome: "skipped",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [
              {
                type: "provider",
                provider: "deepgram",
                model: "nova-3",
                outcome: "failed",
                reason: "Error: Audio transcription response missing transcript",
              },
            ],
            chosen: undefined,
          },
        ],
      },
    });

    await talkHandlers["talk.stt"]?.({
      req: { method: "talk.stt" },
      params: { audioB64: "AA==" },
      respond,
      context: undefined as never,
      client: undefined,
      isWebchatConnect: undefined as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ noSpeech: true, text: null }),
      undefined,
    );
  });

  it("returns UNAVAILABLE when transcription is unavailable for other reasons", async () => {
    const respond = vi.fn();

    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [],
      decision: {
        capability: "audio",
        outcome: "skipped",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [
              {
                type: "provider",
                provider: "deepgram",
                model: "nova-3",
                outcome: "failed",
                reason: "Error: Audio transcription failed (HTTP 500)",
              },
            ],
            chosen: undefined,
          },
        ],
      },
    });

    await talkHandlers["talk.stt"]?.({
      req: { method: "talk.stt" },
      params: { audioB64: "AA==" },
      respond,
      context: undefined as never,
      client: undefined,
      isWebchatConnect: undefined as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      expect.anything(),
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });
});
