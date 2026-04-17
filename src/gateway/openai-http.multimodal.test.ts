import { beforeEach, describe, expect, it, vi } from "vitest";

const extractFileContentFromSourceMock = vi.fn();
const transcribeFirstAudioMock = vi.fn();
const loadConfigMock = vi.fn();

vi.mock("../media/input-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../media/input-files.js")>("../media/input-files.js");
  return {
    ...actual,
    extractFileContentFromSource: (...args: unknown[]) => extractFileContentFromSourceMock(...args),
  };
});

vi.mock("../media-understanding/audio-preflight.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

vi.mock("../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

import { __testOnlyOpenAiHttp } from "./openai-http.js";

describe("openai-http multimodal content-block parsers", () => {
  it("extracts input_audio parts and normalizes mime", () => {
    const parts = __testOnlyOpenAiHttp.extractAudioParts([
      { type: "text", text: "listen" },
      { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
      { type: "input_audio", input_audio: { data: "BBBB", format: "audio/mpeg" } },
    ]);
    expect(parts).toEqual([
      { data: "AAAA", mime: "audio/wav" },
      { data: "BBBB", mime: "audio/mpeg" },
    ]);
  });

  it("falls back to audio/wav when format is missing", () => {
    const parts = __testOnlyOpenAiHttp.extractAudioParts([
      { type: "input_audio", input_audio: { data: "ZZZZ" } },
    ]);
    expect(parts).toEqual([{ data: "ZZZZ", mime: "audio/wav" }]);
  });

  it("ignores audio parts with no data", () => {
    expect(
      __testOnlyOpenAiHttp.extractAudioParts([
        { type: "input_audio", input_audio: { format: "wav" } },
        { type: "input_audio" },
      ]),
    ).toEqual([]);
  });

  it("extracts file parts with mime_type and filename", () => {
    const parts = __testOnlyOpenAiHttp.extractFileParts([
      {
        type: "file",
        file: { file_data: "SGVsbG8=", mime_type: "text/plain", filename: "hi.txt" },
      },
    ]);
    expect(parts).toEqual([{ data: "SGVsbG8=", mediaType: "text/plain", filename: "hi.txt" }]);
  });

  it("parses data URI file_data and extracts mime from metadata", () => {
    const parts = __testOnlyOpenAiHttp.extractFileParts([
      {
        type: "file",
        file: { file_data: "data:text/markdown;base64,SGVsbG8=", filename: "doc.md" },
      },
    ]);
    expect(parts).toEqual([{ data: "SGVsbG8=", mediaType: "text/markdown", filename: "doc.md" }]);
  });

  it("rejects non-base64 file data URIs", () => {
    expect(() =>
      __testOnlyOpenAiHttp.extractFileParts([
        {
          type: "file",
          file: { file_data: "data:text/plain,SGVsbG8=", filename: "a.txt" },
        },
      ]),
    ).toThrow(/must be base64 encoded/);
  });

  it("detects video_url content parts", () => {
    expect(
      __testOnlyOpenAiHttp.hasVideoUrlPart([
        { type: "text", text: "describe" },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
      ]),
    ).toBe(true);
    expect(__testOnlyOpenAiHttp.hasVideoUrlPart([{ type: "text", text: "hi" }])).toBe(false);
  });
});

describe("openai-http audio resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ tools: { media: { audio: { enabled: true } } } });
  });

  it("transcribes audio parts and returns transcripts", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("Hello from user");

    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits(undefined);
    const transcripts = await __testOnlyOpenAiHttp.resolveAudiosForRequest(
      {
        audioParts: [{ data: Buffer.from("ignored").toString("base64"), mime: "audio/wav" }],
      },
      limits,
    );
    expect(transcripts).toEqual(["Hello from user"]);
    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
  });

  it("rejects audio parts with unsupported MIME", async () => {
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits(undefined);
    await expect(
      __testOnlyOpenAiHttp.resolveAudiosForRequest(
        {
          audioParts: [{ data: Buffer.from("x").toString("base64"), mime: "audio/weird" }],
        },
        limits,
      ),
    ).rejects.toThrow(/Unsupported audio MIME type/);
  });

  it("enforces maxParts", async () => {
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      audio: { maxParts: 1 },
    });
    await expect(
      __testOnlyOpenAiHttp.resolveAudiosForRequest(
        {
          audioParts: [
            { data: "AAAA", mime: "audio/wav" },
            { data: "BBBB", mime: "audio/wav" },
          ],
        },
        limits,
      ),
    ).rejects.toThrow(/Too many input_audio parts/);
  });
});

describe("openai-http file resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts text file and wraps it as a file context block", async () => {
    extractFileContentFromSourceMock.mockResolvedValueOnce({
      filename: "note.txt",
      text: "secret=BANANA",
    });

    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits(undefined);
    const result = await __testOnlyOpenAiHttp.resolveFilesForRequest(
      {
        fileParts: [
          { data: "c2VjcmV0PUJBTkFOQQ==", mediaType: "text/plain", filename: "note.txt" },
        ],
      },
      limits,
    );

    expect(result.images).toEqual([]);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]).toMatch(/<file name="note.txt">/);
    expect(result.contexts[0]).toContain("secret=BANANA");
  });

  it("merges PDF-extracted images into the images result", async () => {
    extractFileContentFromSourceMock.mockResolvedValueOnce({
      filename: "report.pdf",
      text: "",
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });

    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits(undefined);
    const result = await __testOnlyOpenAiHttp.resolveFilesForRequest(
      {
        fileParts: [{ data: "AAAA", mediaType: "application/pdf", filename: "report.pdf" }],
      },
      limits,
    );

    expect(result.images).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]).toContain("[PDF content rendered to images]");
  });

  it("enforces maxParts for file content", async () => {
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      files: { maxParts: 1 },
    });
    await expect(
      __testOnlyOpenAiHttp.resolveFilesForRequest(
        {
          fileParts: [
            { data: "AAAA", mediaType: "text/plain", filename: "a.txt" },
            { data: "BBBB", mediaType: "text/plain", filename: "b.txt" },
          ],
        },
        limits,
      ),
    ).rejects.toThrow(/Too many file parts/);
  });
});

describe("openai-http limits resolution for multimodal config", () => {
  it("applies default audio and file limits when config is absent", () => {
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits(undefined);
    expect(limits.audio.enabled).toBe(true);
    expect(limits.audio.maxParts).toBeGreaterThan(0);
    expect(limits.files.enabled).toBe(true);
    expect(limits.files.maxParts).toBeGreaterThan(0);
  });

  it("honours audio.enabled=false to disable audio content blocks", () => {
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      audio: { enabled: false },
    });
    expect(limits.audio.enabled).toBe(false);
  });

  it("honours files.enabled=false to disable file content blocks", () => {
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      files: { enabled: false },
    });
    expect(limits.files.enabled).toBe(false);
  });
});
