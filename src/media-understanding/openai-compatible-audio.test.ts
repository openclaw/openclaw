import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

installPinnedHostnameTestHooks();

type AudioParams = Parameters<typeof transcribeOpenAiCompatibleAudio>[0];
function transcribe(fetchFn: typeof fetch, overrides: Partial<AudioParams> = {}) {
  return transcribeOpenAiCompatibleAudio({
    buffer: Buffer.from("audio"),
    fileName: "note.mp3",
    apiKey: "test-key",
    timeoutMs: 1000,
    fetchFn,
    provider: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-transcribe",
    ...overrides,
  });
}

describe("transcribeOpenAiCompatibleAudio", () => {
  it.each([
    { baseUrl: undefined, attribution: ["openclaw", VERSION, `openclaw/${VERSION}`] },
    { baseUrl: "https://proxy.example.com/v1", attribution: [null, null, null] },
  ])(
    "limits hidden attribution headers to the native host (baseUrl=$baseUrl)",
    async ({ baseUrl, attribution }) => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

      await transcribe(fetchFn, { baseUrl });

      const headers = new Headers(getRequest().init?.headers);
      expect(["originator", "version", "user-agent"].map((name) => headers.get(name))).toEqual(
        attribution,
      );
    },
  );

  it("remaps AAC uploads to an M4A filename before submitting the form", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribe(fetchFn, {
      fileName: "voice-note.aac",
      mime: "audio/aac",
    });

    const form = getRequest().init?.body;
    expect(form).toBeInstanceOf(FormData);
    const file = (form as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("voice-note.m4a");
  });

  it.each([undefined, "ru"])("omits prompt with language %j", async (language) => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribe(fetchFn, {
      fileName: "note.ogg",
      mime: "audio/ogg",
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "whisper-large-v3-turbo",
      language,
    });

    const form = getRequest().init?.body;
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("language")).toBe(language ?? null);
    expect((form as FormData).get("prompt")).toBeNull();
  });

  it("rejects non-object successful transcription JSON with a stable provider error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([])));

    await expect(transcribe(fetchFn)).rejects.toThrow(
      "Audio transcription failed: malformed JSON response",
    );
  });
});
