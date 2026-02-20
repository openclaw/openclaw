import { describe, expect, it } from "vitest";
import { withFetchPreconnect } from "../../../test-utils/fetch-mock.js";
import { installPinnedHostnameTestHooks, resolveRequestUrl } from "../audio.test-helpers.js";
import { transcribeSonioxAudio } from "./audio.js";

installPinnedHostnameTestHooks();

/**
 * Build a mock fetch that responds to the four Soniox API calls in sequence:
 * 1. POST /files → { file_id }
 * 2. POST /transcriptions → { id, status: "queued" }
 * 3. GET /transcriptions/:id → { status: "completed" }
 * 4. GET /transcriptions/:id/transcript → { text }
 */
function buildSonioxFetchMock(opts?: {
  transcript?: string;
  pollAttempts?: number;
  failAt?: "upload" | "create" | "poll" | "transcript";
  errorStatus?: number;
  errorBody?: string;
}) {
  const transcript = opts?.transcript ?? "Testni transkript";
  const pollAttempts = opts?.pollAttempts ?? 0; // 0 = complete on first poll
  let pollCount = 0;
  const calls: { url: string; method: string; headers: Headers }[] = [];

  const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveRequestUrl(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ url, method, headers });

    // Upload file
    if (url.endsWith("/files") && method === "POST") {
      if (opts?.failAt === "upload") {
        return new Response(opts.errorBody ?? "upload error", {
          status: opts.errorStatus ?? 500,
        });
      }
      return new Response(JSON.stringify({ file_id: "test-file-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Create transcription
    if (url.endsWith("/transcriptions") && method === "POST") {
      if (opts?.failAt === "create") {
        return new Response(opts.errorBody ?? "create error", {
          status: opts.errorStatus ?? 500,
        });
      }
      return new Response(JSON.stringify({ id: "test-transcription-id", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Get transcript text
    if (url.endsWith("/transcript") && method === "GET") {
      if (opts?.failAt === "transcript") {
        return new Response(opts.errorBody ?? "transcript error", {
          status: opts.errorStatus ?? 500,
        });
      }
      return new Response(JSON.stringify({ text: transcript }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Poll transcription status
    if (url.includes("/transcriptions/") && method === "GET") {
      if (opts?.failAt === "poll") {
        return new Response(JSON.stringify({ status: "error", error_message: "poll failure" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      pollCount++;
      const status = pollCount > pollAttempts ? "completed" : "processing";
      return new Response(JSON.stringify({ id: "test-transcription-id", status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  });

  return { fetchFn, calls };
}

describe("transcribeSonioxAudio", () => {
  it("happy path: upload → create → poll → transcript", async () => {
    const { fetchFn, calls } = buildSonioxFetchMock({
      transcript: "Slovenija je lepa dežela",
    });

    const result = await transcribeSonioxAudio({
      buffer: Buffer.from("fake-audio"),
      fileName: "voice.ogg",
      mime: "audio/ogg",
      apiKey: "test-key",
      language: "sl",
      timeoutMs: 30_000,
      fetchFn,
    });

    expect(result.text).toBe("Slovenija je lepa dežela");
    expect(result.model).toBe("stt-async-v4");
    expect(calls).toHaveLength(4);
    expect(calls[0].method).toBe("POST"); // upload
    expect(calls[0].url).toContain("/files");
    expect(calls[1].method).toBe("POST"); // create
    expect(calls[1].url).toContain("/transcriptions");
    expect(calls[2].method).toBe("GET"); // poll
    expect(calls[3].method).toBe("GET"); // transcript
  });

  it("polls multiple times before completion", async () => {
    const { fetchFn, calls } = buildSonioxFetchMock({
      transcript: "test",
      pollAttempts: 1,
    });

    const result = await transcribeSonioxAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.ogg",
      apiKey: "test-key",
      timeoutMs: 30_000,
      fetchFn,
    });

    expect(result.text).toBe("test");
    // 1 upload + 1 create + 2 polls (1 processing + 1 completed) + 1 transcript = 5
    expect(calls).toHaveLength(5);
  });

  it("multipart body contains correct boundary and filename", async () => {
    let capturedBody: Uint8Array | null = null;
    let capturedContentType: string | null = null;

    const { fetchFn } = buildSonioxFetchMock({ transcript: "ok" });
    // Wrap to capture the upload body
    const wrappedFetch = withFetchPreconnect(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = resolveRequestUrl(input);
        if (url.endsWith("/files") && init?.method === "POST") {
          capturedBody = init.body as Uint8Array;
          capturedContentType = new Headers(init.headers).get("content-type");
        }
        return fetchFn(input, init);
      },
    );

    await transcribeSonioxAudio({
      buffer: Buffer.from("audio-data"),
      fileName: "moj posnetek.ogg",
      mime: "audio/ogg",
      apiKey: "test-key",
      timeoutMs: 30_000,
      fetchFn: wrappedFetch,
    });

    expect(capturedContentType).toContain("multipart/form-data; boundary=");
    const bodyStr = new TextDecoder().decode(capturedBody!);
    expect(bodyStr).toContain('name="file"');
    expect(bodyStr).toContain('filename="moj posnetek.ogg"');
    expect(bodyStr).toContain("audio-data");
  });

  it("escapes special characters in filename", async () => {
    let capturedBody: Uint8Array | null = null;

    const { fetchFn } = buildSonioxFetchMock({ transcript: "ok" });
    const wrappedFetch = withFetchPreconnect(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = resolveRequestUrl(input);
        if (url.endsWith("/files") && init?.method === "POST") {
          capturedBody = init.body as Uint8Array;
        }
        return fetchFn(input, init);
      },
    );

    await transcribeSonioxAudio({
      buffer: Buffer.from("audio"),
      fileName: 'file"with\nnewline.ogg',
      mime: "audio/ogg",
      apiKey: "test-key",
      timeoutMs: 30_000,
      fetchFn: wrappedFetch,
    });

    const bodyStr = new TextDecoder().decode(capturedBody!);
    expect(bodyStr).not.toContain('file"with');
    expect(bodyStr).toContain('file\\"with');
    expect(bodyStr).toContain("_newline.ogg");
  });

  it("sends authorization header with Bearer prefix", async () => {
    const { fetchFn, calls } = buildSonioxFetchMock({ transcript: "ok" });

    await transcribeSonioxAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.ogg",
      apiKey: "my-secret-key",
      timeoutMs: 30_000,
      fetchFn,
    });

    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer my-secret-key");
    }
  });

  it("sends language hints in transcription request", async () => {
    let capturedBody: string | null = null;

    const { fetchFn } = buildSonioxFetchMock({ transcript: "ok" });
    const wrappedFetch = withFetchPreconnect(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = resolveRequestUrl(input);
        if (url.endsWith("/transcriptions") && init?.method === "POST") {
          capturedBody = new TextDecoder().decode(init.body as Uint8Array);
        }
        return fetchFn(input, init);
      },
    );

    await transcribeSonioxAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.ogg",
      apiKey: "test-key",
      language: "sl",
      timeoutMs: 30_000,
      fetchFn: wrappedFetch,
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.language_hints).toEqual(["sl"]);
    expect(parsed.model).toBe("stt-async-v4");
  });

  it("throws on upload failure", async () => {
    const { fetchFn } = buildSonioxFetchMock({
      failAt: "upload",
      errorStatus: 400,
      errorBody: "bad request",
    });

    await expect(
      transcribeSonioxAudio({
        buffer: Buffer.from("audio"),
        fileName: "test.ogg",
        apiKey: "test-key",
        timeoutMs: 30_000,
        fetchFn,
      }),
    ).rejects.toThrow("Soniox file upload failed");
  });

  it("throws on transcription error status", async () => {
    const { fetchFn } = buildSonioxFetchMock({ failAt: "poll" });

    await expect(
      transcribeSonioxAudio({
        buffer: Buffer.from("audio"),
        fileName: "test.ogg",
        apiKey: "test-key",
        timeoutMs: 30_000,
        fetchFn,
      }),
    ).rejects.toThrow("Soniox transcription failed: poll failure");
  });

  it("uses custom model when provided", async () => {
    const { fetchFn } = buildSonioxFetchMock({ transcript: "ok" });
    let capturedBody: string | null = null;

    const wrappedFetch = withFetchPreconnect(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = resolveRequestUrl(input);
        if (url.endsWith("/transcriptions") && init?.method === "POST") {
          capturedBody = new TextDecoder().decode(init.body as Uint8Array);
        }
        return fetchFn(input, init);
      },
    );

    const result = await transcribeSonioxAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.ogg",
      apiKey: "test-key",
      model: "stt-async-v3",
      timeoutMs: 30_000,
      fetchFn: wrappedFetch,
    });

    expect(result.model).toBe("stt-async-v3");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe("stt-async-v3");
  });
});
