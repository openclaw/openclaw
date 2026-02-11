import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../../infra/net/ssrf.js";
import { transcribeAssemblyAiAudio } from "./audio.js";

const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;
const lookupMock = vi.fn();
let resolvePinnedHostnameSpy: ReturnType<typeof vi.spyOn> = null;
let resolvePinnedHostnameWithPolicySpy: ReturnType<typeof vi.spyOn> = null;

const resolveRequestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

describe("transcribeAssemblyAiAudio", () => {
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

  it("completes the upload → submit → poll flow", async () => {
    let callCount = 0;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const url = resolveRequestUrl(input);

      // Call 1: upload
      if (url.endsWith("/upload")) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/abc123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Call 2: submit transcript
      if (url.endsWith("/transcript") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.audio_url).toBe("https://cdn.assemblyai.com/upload/abc123");
        return new Response(JSON.stringify({ id: "tx_001", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Call 3+: poll — return completed immediately
      if (url.includes("/transcript/tx_001")) {
        return new Response(
          JSON.stringify({
            id: "tx_001",
            status: "completed",
            text: "hello world",
            speech_model: "best",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await transcribeAssemblyAiAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 10_000,
      fetchFn,
    });

    expect(result.text).toBe("hello world");
    expect(result.model).toBe("best");
    expect(callCount).toBe(3); // upload + submit + poll
  });

  it("polls multiple times before completion", async () => {
    let pollCount = 0;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveRequestUrl(input);

      if (url.endsWith("/upload")) {
        return new Response(
          JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/xyz" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/transcript") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "tx_002", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/transcript/tx_002")) {
        pollCount++;
        // First two polls: still processing
        if (pollCount <= 2) {
          return new Response(JSON.stringify({ id: "tx_002", status: "processing" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // Third poll: done
        return new Response(
          JSON.stringify({ id: "tx_002", status: "completed", text: "the transcript" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await transcribeAssemblyAiAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.ogg",
      apiKey: "test-key",
      timeoutMs: 30_000,
      fetchFn,
    });

    expect(result.text).toBe("the transcript");
    expect(pollCount).toBe(3);
  });

  it("throws on transcription error status", async () => {
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveRequestUrl(input);

      if (url.endsWith("/upload")) {
        return new Response(
          JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/err" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/transcript") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "tx_err", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/transcript/tx_err")) {
        return new Response(
          JSON.stringify({ id: "tx_err", status: "error", error: "Audio too short" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    await expect(
      transcribeAssemblyAiAudio({
        buffer: Buffer.from("x"),
        fileName: "short.mp3",
        apiKey: "test-key",
        timeoutMs: 10_000,
        fetchFn,
      }),
    ).rejects.toThrow("Audio too short");
  });

  it("throws on upload HTTP error", async () => {
    const fetchFn = async () => new Response("Unauthorized", { status: 401 });

    await expect(
      transcribeAssemblyAiAudio({
        buffer: Buffer.from("audio"),
        fileName: "note.mp3",
        apiKey: "bad-key",
        timeoutMs: 5_000,
        fetchFn,
      }),
    ).rejects.toThrow("AssemblyAI upload failed (HTTP 401)");
  });

  it("passes language and custom model to submit body", async () => {
    let submitBody: Record<string, unknown> | null = null;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveRequestUrl(input);

      if (url.endsWith("/upload")) {
        return new Response(
          JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/lang" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/transcript") && init?.method === "POST") {
        submitBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ id: "tx_lang", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/transcript/tx_lang")) {
        return new Response(
          JSON.stringify({
            id: "tx_lang",
            status: "completed",
            text: "bonjour",
            speech_model: "nano",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await transcribeAssemblyAiAudio({
      buffer: Buffer.from("audio"),
      fileName: "fr.mp3",
      apiKey: "test-key",
      timeoutMs: 10_000,
      model: "nano",
      language: " fr ",
      fetchFn,
    });

    expect(result.text).toBe("bonjour");
    expect(result.model).toBe("nano");
    expect(submitBody?.speech_model).toBe("nano");
    expect(submitBody?.language_code).toBe("fr");
    expect(submitBody?.audio_url).toBe("https://cdn.assemblyai.com/upload/lang");
  });

  it("sets authorization header correctly", async () => {
    let seenAuth: string | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization");
      // Return upload response for simplicity — we only check the first call's header
      return new Response(
        JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/auth" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    // We catch the error from the second call (submit gets upload response format)
    // but the important thing is checking the auth header
    try {
      await transcribeAssemblyAiAudio({
        buffer: Buffer.from("audio"),
        fileName: "note.mp3",
        apiKey: "my-secret-key",
        timeoutMs: 5_000,
        fetchFn,
      });
    } catch {
      // Expected — submit call gets wrong response shape
    }

    expect(seenAuth).toBe("my-secret-key");
  });
});
