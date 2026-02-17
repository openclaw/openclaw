import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleVertexProvider } from "./index.js";
import * as piAi from "@mariozechner/pi-ai";

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(() => ({ provider: "google-vertex", model: "gemini-3-flash-preview" })),
  completeSimple: vi.fn(),
}));

describe("googleVertexProvider", () => {
  const mockBuffer = Buffer.from("test");
  const mockParams = {
    buffer: mockBuffer,
    timeoutMs: 5000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transcribes audio successfully", async () => {
    vi.mocked(piAi.completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "Transcribed text" }],
      model: "gemini-3-flash-preview",
    } as any);

    const result = await googleVertexProvider.transcribeAudio(mockParams);

    expect(result.text).toBe("Transcribed text");
    expect(piAi.completeSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              { type: "text", text: "Transcribe the audio." },
              { type: "image", data: mockBuffer.toString("base64"), mimeType: "audio/wav" },
            ]),
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it("describes images successfully", async () => {
    vi.mocked(piAi.completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "Image description" }],
      model: "gemini-3-flash-preview",
    } as any);

    const result = await googleVertexProvider.describeImage(mockParams);

    expect(result.text).toBe("Image description");
    expect(piAi.completeSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              { type: "text", text: "Describe the image." },
              { type: "image", data: mockBuffer.toString("base64"), mimeType: "image/jpeg" },
            ]),
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it("describes videos successfully", async () => {
    vi.mocked(piAi.completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "Video description" }],
      model: "gemini-3-flash-preview",
    } as any);

    const result = await googleVertexProvider.describeVideo(mockParams);

    expect(result.text).toBe("Video description");
    expect(piAi.completeSimple).toHaveBeenCalledTimes(1);
    expect(piAi.completeSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              { type: "text", text: "Describe the video." },
              { type: "image", data: mockBuffer.toString("base64"), mimeType: "video/mp4" },
            ]),
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it("handles empty response text", async () => {
    vi.mocked(piAi.completeSimple).mockResolvedValueOnce({
      content: [],
    } as any);

    await expect(googleVertexProvider.transcribeAudio(mockParams)).rejects.toThrow(
      "Audio transcription response missing text",
    );
  });

  it("handles timeouts", async () => {
    vi.mocked(piAi.completeSimple).mockImplementationOnce(() => {
      const error = new Error("Abort");
      error.name = "AbortError";
      return Promise.reject(error);
    });

    await expect(googleVertexProvider.transcribeAudio(mockParams)).rejects.toThrow(
      "Audio transcription timed out after 5000ms",
    );
  });
});
