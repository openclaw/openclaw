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

  it("infers mediaType from filename extension when mime_type is omitted (.pdf)", () => {
    const parts = __testOnlyOpenAiHttp.extractFileParts([
      {
        type: "file",
        file: { file_data: "SGVsbG8=", filename: "report.pdf" },
      },
    ]);
    expect(parts).toEqual([
      { data: "SGVsbG8=", mediaType: "application/pdf", filename: "report.pdf" },
    ]);
  });

  it("infers mediaType from filename extension when mime_type is omitted (.txt)", () => {
    const parts = __testOnlyOpenAiHttp.extractFileParts([
      {
        type: "file",
        file: { file_data: "SGVsbG8=", filename: "notes.txt" },
      },
    ]);
    expect(parts).toEqual([{ data: "SGVsbG8=", mediaType: "text/plain", filename: "notes.txt" }]);
  });

  it("leaves mediaType undefined when neither mime_type nor a useful filename extension is given", () => {
    // Downstream extractFileContentFromSource will turn undefined into a
    // "missing media type" 400 — caller surfaces it via the file resolver
    // try/catch. We deliberately don't fabricate a mediaType here.
    const parts = __testOnlyOpenAiHttp.extractFileParts([
      { type: "file", file: { file_data: "SGVsbG8=" } },
    ]);
    expect(parts).toEqual([{ data: "SGVsbG8=", mediaType: undefined, filename: "file" }]);
  });

  it("infers a mediaType even for extensions outside the default allowlist (.docx)", () => {
    // Inference is unconditional so the downstream allowedMimes gate can emit
    // a specific "Unsupported file MIME type: <mime>" instead of the generic
    // "missing media type" error — this gives operators actionable diagnostics.
    const parts = __testOnlyOpenAiHttp.extractFileParts([
      {
        type: "file",
        file: { file_data: "SGVsbG8=", filename: "proposal.docx" },
      },
    ]);
    expect(parts).toEqual([
      {
        data: "SGVsbG8=",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "proposal.docx",
      },
    ]);
  });

  it("prefers explicit mime_type over filename inference", () => {
    const parts = __testOnlyOpenAiHttp.extractFileParts([
      {
        type: "file",
        file: {
          file_data: "SGVsbG8=",
          filename: "note.pdf",
          mime_type: "text/plain",
        },
      },
    ]);
    expect(parts[0].mediaType).toBe("text/plain");
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

  it("rejects audio parts with malformed base64 before staging the tmp file", async () => {
    // Regression: Node's Buffer.from(..., "base64") silently drops invalid
    // characters, so without a canonicalizeBase64 gate a malformed payload
    // produced an empty tmp file and surfaced as a silent 200 with no
    // transcript. The handler wraps this throw in its try/catch → 400.
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits(undefined);
    await expect(
      __testOnlyOpenAiHttp.resolveAudiosForRequest(
        {
          audioParts: [{ data: "not base64 @#$%^&", mime: "audio/wav" }],
        },
        limits,
      ),
    ).rejects.toThrow(/invalid 'data' field|base64/i);
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
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

  it("propagates operator-supplied audio/file byte + mime limits to the resolver", () => {
    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      audio: {
        maxBytes: 1234,
        maxTotalBytes: 5678,
        allowedMimes: ["audio/flac"],
      },
      files: {
        maxBytes: 2468,
        maxTotalBytes: 8642,
        maxChars: 9999,
        allowedMimes: ["text/plain"],
      },
    });
    expect(limits.audio.maxBytes).toBe(1234);
    expect(limits.audio.maxTotalBytes).toBe(5678);
    expect(limits.audio.allowedMimes.has("audio/flac")).toBe(true);
    expect(limits.files.maxBytes).toBe(2468);
    expect(limits.files.maxTotalBytes).toBe(8642);
    expect(limits.files.maxChars).toBe(9999);
    expect(limits.files.allowedMimes.has("text/plain")).toBe(true);
  });
});

describe("openai-http active-turn parsing error handling", () => {
  it("propagates malformed file_data errors so the handler can map them to 400", () => {
    // Regression: resolveActiveTurnContext used to let these exceptions bubble
    // past the handler's try/catch and surface as 500s.
    expect(() =>
      __testOnlyOpenAiHttp.resolveActiveTurnContext([
        {
          role: "user",
          content: [
            {
              type: "file",
              file: { file_data: "data:text/plain,SGVsbG8=", filename: "a.txt" },
            },
          ],
        },
      ]),
    ).toThrow(/must be base64 encoded/);
  });

  it("does not throw on structurally valid but media-only user turns", () => {
    expect(() =>
      __testOnlyOpenAiHttp.resolveActiveTurnContext([
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                file_data: "data:text/plain;base64,SGVsbG8=",
                filename: "note.txt",
              },
            },
          ],
        },
      ]),
    ).not.toThrow();
  });
});

describe("openai-http buildAgentPrompt: media-only active user turns", () => {
  it("first-turn file-only: synthesises a filename-aware placeholder (avoids Missing user message 400)", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { file_data: "data:text/plain;base64,SGVsbG8=", filename: "report.pdf" },
          },
        ],
      },
    ];
    const ctx = __testOnlyOpenAiHttp.resolveActiveTurnContext(messages);
    const { message } = __testOnlyOpenAiHttp.buildAgentPrompt(messages, ctx);
    expect(message).not.toBe("");
    expect(message).toContain("report.pdf");
    expect(message).toMatch(/file|attached/i);
  });

  it("subsequent file-only: placeholder becomes current message (no stale prior text leak)", () => {
    const messages = [
      { role: "user", content: "what did we decide?" },
      { role: "assistant", content: "we agreed to ship on Friday." },
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { file_data: "data:text/plain;base64,SGVsbG8=", filename: "minutes.md" },
          },
        ],
      },
    ];
    const ctx = __testOnlyOpenAiHttp.resolveActiveTurnContext(messages);
    const { message } = __testOnlyOpenAiHttp.buildAgentPrompt(messages, ctx);
    // The current-message portion must reference the file, NOT reuse the prior
    // user's "what did we decide?" as the current question.
    expect(message).toContain("minutes.md");
    // History block may still contain prior text, but it must not be the
    // tail / current message. The current-message block is the synthesised
    // placeholder referencing the filename.
    const tail = message.split(/User:\s*/).pop() ?? "";
    expect(tail).toContain("minutes.md");
    expect(tail).not.toMatch(/^what did we decide\?$/);
  });

  it("subsequent audio-only: placeholder replaces stale prior text as current message", () => {
    const audioData = Buffer.from("audio").toString("base64");
    const messages = [
      { role: "user", content: "status?" },
      { role: "assistant", content: "all green." },
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: audioData, format: "wav" } }],
      },
    ];
    const ctx = __testOnlyOpenAiHttp.resolveActiveTurnContext(messages);
    const { message } = __testOnlyOpenAiHttp.buildAgentPrompt(messages, ctx);
    expect(message).toMatch(/audio/i);
    const tail = message.split(/User:\s*/).pop() ?? "";
    expect(tail).not.toBe("status?");
  });

  it("subsequent image-only: placeholder scopes mention to the active turn only", () => {
    const messages = [
      { role: "user", content: "last question" },
      { role: "assistant", content: "answered." },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      },
    ];
    const ctx = __testOnlyOpenAiHttp.resolveActiveTurnContext(messages);
    const { message } = __testOnlyOpenAiHttp.buildAgentPrompt(messages, ctx);
    expect(message).toMatch(/image/i);
    const tail = message.split(/User:\s*/).pop() ?? "";
    expect(tail).not.toBe("last question");
  });

  it("does not synthesise a placeholder for non-active historical media turns", () => {
    // Only the last user message is treated as active; historical media-only
    // turns should not get mentioned (their bytes are not replayed).
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      },
      { role: "assistant", content: "ok." },
      { role: "user", content: "and this?" },
    ];
    const ctx = __testOnlyOpenAiHttp.resolveActiveTurnContext(messages);
    const { message } = __testOnlyOpenAiHttp.buildAgentPrompt(messages, ctx);
    expect(message).toContain("and this?");
    expect(message).not.toMatch(/image/i);
  });

  it("turns with no text and no media still produce empty prompt (caller surfaces 400)", () => {
    const messages = [{ role: "user", content: "" }];
    const ctx = __testOnlyOpenAiHttp.resolveActiveTurnContext(messages);
    const { message } = __testOnlyOpenAiHttp.buildAgentPrompt(messages, ctx);
    expect(message).toBe("");
  });
});
