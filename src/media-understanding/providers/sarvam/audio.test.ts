import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../../infra/net/ssrf.js";
import { transcribeSarvamAudio } from "./audio.js";

const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;
const lookupMock = vi.fn();
let resolvePinnedHostnameSpy: ReturnType<typeof vi.spyOn> = null;
let resolvePinnedHostnameWithPolicySpy: ReturnType<typeof vi.spyOn> = null;

const resolveRequestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

describe("transcribeSarvamAudio", () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    resolvePinnedHostnameSpy = vi
      .spyOn(ssrf, "resolvePinnedHostname")
      .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
    resolvePinnedHostnameWithPolicySpy = vi
      .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockImplementation((hostname, params) =>
        resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupMock }),
      );
  });

  afterEach(() => {
    lookupMock.mockReset();
    resolvePinnedHostnameSpy?.mockRestore();
    resolvePinnedHostnameWithPolicySpy?.mockRestore();
    resolvePinnedHostnameSpy = null;
    resolvePinnedHostnameWithPolicySpy = null;
  });

  it("uses a safe fallback file name when fileName is missing", async () => {
    let seenInit: RequestInit | undefined;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return new Response(
        JSON.stringify({
          transcript: "hello",
          language_code: "kn-IN",
          model: "saaras:v2.5",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
    });

    const form = seenInit?.body as FormData;
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("audio");
    expect(result.text).toBe("hello");
  });

  it("respects api-subscription-key header overrides", async () => {
    let seenKey: string | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenKey = headers.get("api-subscription-key");
      return new Response(
        JSON.stringify({
          transcript: "hello",
          language_code: "kn-IN",
          model: "saaras:v2.5",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { "api-subscription-key": "override-key" },
      fetchFn,
    });

    expect(seenKey).toBe("override-key");
    expect(result.text).toBe("hello");
  });

  it("builds the expected request payload", async () => {
    let seenUrl: string | null = null;
    let seenInit: RequestInit | undefined;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      seenInit = init;
      return new Response(
        JSON.stringify({
          transcript: "translated transcript",
          language_code: "te-IN",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeSarvamAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/",
      model: " ",
      language: " te-IN ",
      prompt: " keep names as-is ",
      mime: "audio/wav",
      query: { with_timestamps: true },
      headers: { "X-Custom": "1" },
      fetchFn,
    });

    expect(result.model).toBe("saaras:v2.5");
    expect(result.text).toBe("translated transcript");
    expect(seenUrl).toBe("https://api.example.com/speech-to-text-translate");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("api-subscription-key")).toBe("test-key");
    expect(headers.get("x-custom")).toBe("1");

    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("saaras:v2.5");
    expect(form.get("language_code")).toBe("te-IN");
    expect(form.get("prompt")).toBe("keep names as-is");
    expect(form.get("with_timestamps")).toBe("true");
  });

  it("normalizes unsupported mime types to application/octet-stream", async () => {
    let seenMime = "";
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file");
      if (file instanceof File) {
        seenMime = file.type;
      }
      return new Response(
        JSON.stringify({
          transcript: "ok",
          language_code: "te-IN",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await transcribeSarvamAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      apiKey: "test-key",
      timeoutMs: 1234,
      mime: "audio/ogg; codecs=opus",
      fetchFn,
    });

    expect(seenMime).toBe("application/octet-stream");
  });
});
