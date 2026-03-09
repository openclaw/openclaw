import { describe, expect, it } from "vitest";
import { withFetchPreconnect } from "../../../test-utils/fetch-mock.js";
import { installPinnedHostnameTestHooks } from "../audio.test-helpers.js";
import {
  DEFAULT_ASSEMBLYAI_BASE_URL,
  DEFAULT_ASSEMBLYAI_MODEL,
  transcribeAssemblyAIAudio,
} from "./audio.js";

installPinnedHostnameTestHooks();

/**
 * AssemblyAI uses a 3-step async flow: upload → create transcript job → poll until done.
 * The mock fetchFn must route all three request types.
 */
function createAssemblyAIFetchMock(opts: {
  transcriptText: string;
  transcriptId?: string;
  pollSteps?: number; // how many "processing" responses before "completed"
}) {
  const { transcriptText, transcriptId = "test-id-123", pollSteps = 0 } = opts;
  let pollCount = 0;
  let seenRequests: Array<{ url: string; method: string; auth: string | null }> = [];

  const fetchFn = withFetchPreconnect(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const auth = new Headers(init?.headers).get("authorization");
      seenRequests.push({ url, method, auth });

      // Step 1: upload
      if (url.endsWith("/upload") && method === "POST") {
        return new Response(
          JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/test" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Step 2: create transcript
      if (url.endsWith("/transcript") && method === "POST") {
        return new Response(JSON.stringify({ id: transcriptId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Step 3: poll
      if (url.includes(`/transcript/${transcriptId}`) && method === "GET") {
        if (pollCount < pollSteps) {
          pollCount++;
          return new Response(JSON.stringify({ id: transcriptId, status: "processing" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ id: transcriptId, status: "completed", text: transcriptText }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    },
  );

  return { fetchFn, getRequests: () => seenRequests };
}

describe("transcribeAssemblyAIAudio", () => {
  it("returns transcript text on success", async () => {
    const { fetchFn } = createAssemblyAIFetchMock({ transcriptText: "hello world" });

    const result = await transcribeAssemblyAIAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      apiKey: "test-key",
      timeoutMs: 30_000,
      fetchFn,
    });

    expect(result.text).toBe("hello world");
    expect(result.model).toBe(DEFAULT_ASSEMBLYAI_MODEL);
  });

  it("sets default base URL correctly", () => {
    expect(DEFAULT_ASSEMBLYAI_BASE_URL).toBe("https://api.assemblyai.com/v2");
  });

  it("uses api key as authorization header", async () => {
    const { fetchFn, getRequests } = createAssemblyAIFetchMock({ transcriptText: "hi" });

    await transcribeAssemblyAIAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      apiKey: "my-secret-key",
      timeoutMs: 30_000,
      fetchFn,
    });

    const requests = getRequests();
    for (const req of requests) {
      expect(req.auth).toBe("my-secret-key");
    }
  });

  it("respects authorization header override", async () => {
    const { fetchFn, getRequests } = createAssemblyAIFetchMock({ transcriptText: "ok" });

    await transcribeAssemblyAIAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      apiKey: "ignored-key",
      headers: { authorization: "Bearer override" },
      timeoutMs: 30_000,
      fetchFn,
    });

    const requests = getRequests();
    for (const req of requests) {
      expect(req.auth).toBe("Bearer override");
    }
  });

  it("sends language_code when language is provided", async () => {
    let capturedBody: unknown;
    const fetchFn = withFetchPreconnect(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/upload")) {
          return new Response(
            JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/x" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/transcript") && (init?.method ?? "").toUpperCase() === "POST") {
          capturedBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ id: "lang-id" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ id: "lang-id", status: "completed", text: "olá mundo" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const result = await transcribeAssemblyAIAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      apiKey: "key",
      language: "pt",
      timeoutMs: 30_000,
      fetchFn,
    });

    expect(result.text).toBe("olá mundo");
    expect((capturedBody as Record<string, unknown>).language_code).toBe("pt");
  });

  it("handles polling through processing state", async () => {
    const { fetchFn } = createAssemblyAIFetchMock({
      transcriptText: "eventually done",
      pollSteps: 2,
    });

    const result = await transcribeAssemblyAIAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      apiKey: "key",
      timeoutMs: 30_000,
      fetchFn,
    });

    expect(result.text).toBe("eventually done");
  });

  it("throws on transcript error status", async () => {
    const fetchFn = withFetchPreconnect(
      async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/upload")) {
          return new Response(
            JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/e" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/transcript")) {
          return new Response(JSON.stringify({ id: "err-id" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ id: "err-id", status: "error", error: "audio too short" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    await expect(
      transcribeAssemblyAIAudio({
        buffer: Buffer.from("audio"),
        fileName: "voice.mp3",
        apiKey: "key",
        timeoutMs: 30_000,
        fetchFn,
      }),
    ).rejects.toThrow("AssemblyAI transcript error: audio too short");
  });
});
