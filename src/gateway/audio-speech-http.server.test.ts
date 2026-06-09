// Audio-speech HTTP integration tests boot a real gateway to cover routing, the
// `audioSpeech` enable gate, auth, and request validation end-to-end. Synthesis
// output is covered deterministically by the mocked unit suite, so these cases
// stay independent of which speech providers happen to be configured.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startOpenAiCompatGatewayServer } from "./openai-compatible-http.test-helpers.js";
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let enabledServer: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
  enabledPort = await getFreePort();
  enabledServer = await startOpenAiCompatGatewayServer({
    startGatewayServer,
    port: enabledPort,
    auth: { mode: "token", token: "secret" },
    openAiChatCompletionsEnabled: true,
    audioSpeechEnabled: true,
  });
});

afterAll(async () => {
  await enabledServer.close({ reason: "audio speech integration suite done" });
});

async function postSpeech(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/audio/speech`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("OpenAI-compatible audio speech HTTP API (integration)", () => {
  it("requires authentication", async () => {
    const res = await fetch(`http://127.0.0.1:${enabledPort}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tts/openai", input: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with no input", async () => {
    const res = await postSpeech({ model: "tts/openai" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
  });

  it("rejects an unsupported response_format and lists the supported set", async () => {
    const res = await postSpeech({ model: "tts/openai", input: "hi", response_format: "ogg" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toMatch(/mp3, opus, wav/);
  });

  it("rejects an unknown TTS provider", async () => {
    const res = await postSpeech({ model: "tts/definitely-not-a-provider", input: "hi" });
    expect(res.status).toBe(400);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await fetch(`http://127.0.0.1:${enabledPort}/v1/audio/speech`, {
      method: "GET",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.status).toBe(405);
  });

  it("does not serve /v1/audio/speech when the endpoint is disabled", async () => {
    const port = await getFreePort();
    const server = await startOpenAiCompatGatewayServer({
      startGatewayServer,
      port,
      auth: { mode: "token", token: "secret" },
      openAiChatCompletionsEnabled: true,
      audioSpeechEnabled: false,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ model: "tts/openai", input: "hi" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close({ reason: "audio speech disabled integration done" });
    }
  });
});
