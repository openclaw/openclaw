import { beforeEach, describe, expect, it, vi } from "vitest";

const { postTranscriptionRequestMock } = vi.hoisted(() => ({
  postTranscriptionRequestMock: vi.fn(),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return {
    ...actual,
    postTranscriptionRequest: postTranscriptionRequestMock,
  };
});

import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

function createParams(
  overrides: Partial<Parameters<typeof transcribeOpenAiCompatibleAudio>[0]> = {},
): Parameters<typeof transcribeOpenAiCompatibleAudio>[0] {
  return {
    buffer: Buffer.from("audio-bytes"),
    fileName: "clip.wav",
    apiKey: "test-key",
    timeoutMs: 1_000,
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "whisper-1",
    ...overrides,
  };
}

function expectPostedAudioFileName(): string {
  expect(postTranscriptionRequestMock).toHaveBeenCalledTimes(1);
  const [request] = postTranscriptionRequestMock.mock.calls[0] as [
    { body: FormData; headers: Headers; url: string },
  ];
  expect(request.url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(request.headers.get("authorization")).toBe("Bearer test-key");
  const uploaded = request.body.get("file");
  expect(uploaded instanceof File).toBe(true);
  if (!(uploaded instanceof File)) {
    expect.unreachable("expected multipart upload file");
  }
  return uploaded.name;
}

describe("transcribeOpenAiCompatibleAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postTranscriptionRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: async () => {},
    });
  });

  it("uploads only the basename when fileName contains a host path", async () => {
    const result = await transcribeOpenAiCompatibleAudio(
      createParams({ fileName: "/Users/alice/private/note.wav" }),
    );

    expect(result).toEqual({ text: "hello world", model: "whisper-1" });
    expect(expectPostedAudioFileName()).toBe("note.wav");
  });

  it("falls back to a generic filename when fileName is missing at runtime", async () => {
    const result = await transcribeOpenAiCompatibleAudio(
      createParams({ fileName: undefined as never }),
    );

    expect(result).toEqual({ text: "hello world", model: "whisper-1" });
    expect(expectPostedAudioFileName()).toBe("audio");
  });
});
