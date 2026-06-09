// Audio-speech HTTP tests cover OpenAI-compatible `/v1/audio/speech` request
// parsing, provider resolution, parameter pass-through, Content-Type selection,
// and validation/error paths. The TTS data layer is mocked so the suite asserts
// the bridge contract without a live provider.
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleGatewayPostJsonEndpoint = vi.fn();
const synthesizeSpeech = vi.fn();
const isTtsProviderConfigured = vi.fn();
const resolveTtsConfig = vi.fn();
const getTtsProvider = vi.fn();
const resolveTtsPrefsPath = vi.fn();
const listSpeechProviders = vi.fn();
const canonicalizeSpeechProviderId = vi.fn();

vi.mock("./http-endpoint-helpers.js", () => ({
  handleGatewayPostJsonEndpoint: (...args: unknown[]) => handleGatewayPostJsonEndpoint(...args),
}));
vi.mock("./http-utils.js", () => ({
  resolveAgentIdForRequest: () => "default",
  resolveOpenAiCompatibleHttpOperatorScopes: () => [],
}));
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({}),
}));
vi.mock("../tts/tts.js", () => ({
  synthesizeSpeech: (...args: unknown[]) => synthesizeSpeech(...args),
  isTtsProviderConfigured: (...args: unknown[]) => isTtsProviderConfigured(...args),
  resolveTtsConfig: (...args: unknown[]) => resolveTtsConfig(...args),
  getTtsProvider: (...args: unknown[]) => getTtsProvider(...args),
  resolveTtsPrefsPath: (...args: unknown[]) => resolveTtsPrefsPath(...args),
}));
vi.mock("../tts/provider-registry.js", () => ({
  listSpeechProviders: (...args: unknown[]) => listSpeechProviders(...args),
  canonicalizeSpeechProviderId: (...args: unknown[]) => canonicalizeSpeechProviderId(...args),
}));

const { handleOpenAiAudioSpeechHttpRequest } = await import("./audio-speech-http.js");

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
};

function createResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string | number) {
      captured.headers[name.toLowerCase()] = String(value);
    },
    end(chunk?: string | Buffer) {
      captured.statusCode = res.statusCode;
      if (chunk !== undefined) {
        captured.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function jsonBody(captured: CapturedResponse): { error?: { message?: string; type?: string } } {
  return JSON.parse(captured.body.toString("utf8"));
}

async function callEndpoint(body: unknown): Promise<CapturedResponse> {
  handleGatewayPostJsonEndpoint.mockResolvedValue({ body, requestAuth: {} });
  const { res, captured } = createResponse();
  await handleOpenAiAudioSpeechHttpRequest({} as IncomingMessage, res, {
    auth: {} as never,
  });
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveTtsConfig.mockReturnValue({});
  resolveTtsPrefsPath.mockReturnValue("");
  getTtsProvider.mockReturnValue("openai");
  isTtsProviderConfigured.mockReturnValue(true);
  canonicalizeSpeechProviderId.mockImplementation((id: string) =>
    ["openai", "elevenlabs"].includes(id) ? id : undefined,
  );
  listSpeechProviders.mockReturnValue([{ id: "openai" }, { id: "elevenlabs" }]);
  synthesizeSpeech.mockResolvedValue({
    success: true,
    audioBuffer: Buffer.from("AUDIO"),
    outputFormat: "mp3",
    fileExtension: ".mp3",
  });
});

describe("handleOpenAiAudioSpeechHttpRequest", () => {
  it("returns false for unrelated paths", async () => {
    handleGatewayPostJsonEndpoint.mockResolvedValue(false);
    const { res } = createResponse();
    const handled = await handleOpenAiAudioSpeechHttpRequest({} as IncomingMessage, res, {
      auth: {} as never,
    });
    expect(handled).toBe(false);
  });

  it("synthesizes audio and sets Content-Type from the produced format", async () => {
    const captured = await callEndpoint({ model: "tts/openai", input: "hello world" });
    expect(captured.statusCode).toBe(200);
    expect(captured.headers["content-type"]).toBe("audio/mpeg");
    expect(captured.headers["content-length"]).toBe("5");
    expect(captured.body.toString("utf8")).toBe("AUDIO");
    const call = synthesizeSpeech.mock.calls[0]?.[0];
    expect(call.text).toBe("hello world");
    expect(call.disableFallback).toBe(true);
    expect(call.overrides.provider).toBe("openai");
  });

  it("passes voice, clamped speed, and response_format into provider overrides", async () => {
    synthesizeSpeech.mockResolvedValue({
      success: true,
      audioBuffer: Buffer.from("OPUS"),
      outputFormat: "opus",
      fileExtension: ".opus",
    });
    const captured = await callEndpoint({
      model: "tts/openai",
      input: "hi",
      voice: "nova",
      speed: 9,
      response_format: "opus",
    });
    expect(captured.statusCode).toBe(200);
    expect(captured.headers["content-type"]).toBe("audio/opus");
    const overrides = synthesizeSpeech.mock.calls[0]?.[0].overrides.providerOverrides.openai;
    expect(overrides).toEqual({ voice: "nova", speed: 4, responseFormat: "opus" });
  });

  it("clamps speed up to the minimum bound", async () => {
    await callEndpoint({ model: "tts/openai", input: "hi", speed: 0.05 });
    const overrides = synthesizeSpeech.mock.calls[0]?.[0].overrides.providerOverrides.openai;
    expect(overrides.speed).toBe(0.25);
  });

  it("accepts a bare provider name without the tts/ prefix", async () => {
    await callEndpoint({ model: "openai", input: "hi" });
    expect(synthesizeSpeech.mock.calls[0]?.[0].overrides.provider).toBe("openai");
  });

  it("falls back to the configured default provider when model is omitted", async () => {
    getTtsProvider.mockReturnValue("elevenlabs");
    await callEndpoint({ input: "hi" });
    expect(canonicalizeSpeechProviderId).not.toHaveBeenCalled();
    expect(synthesizeSpeech.mock.calls[0]?.[0].overrides.provider).toBe("elevenlabs");
  });

  it("rejects a missing input", async () => {
    const captured = await callEndpoint({ model: "tts/openai" });
    expect(captured.statusCode).toBe(400);
    expect(jsonBody(captured).error?.type).toBe("invalid_request_error");
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("rejects input over the character cap", async () => {
    const captured = await callEndpoint({ model: "tts/openai", input: "x".repeat(4097) });
    expect(captured.statusCode).toBe(400);
    expect(jsonBody(captured).error?.message).toMatch(/4096/);
  });

  it("rejects an unsupported response_format and lists the supported set", async () => {
    const captured = await callEndpoint({
      model: "tts/openai",
      input: "hi",
      response_format: "ogg",
    });
    expect(captured.statusCode).toBe(400);
    expect(jsonBody(captured).error?.message).toMatch(/mp3, opus, wav/);
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider with the configured provider list", async () => {
    const captured = await callEndpoint({ model: "tts/does-not-exist", input: "hi" });
    expect(captured.statusCode).toBe(400);
    expect(jsonBody(captured).error?.message).toMatch(/tts\/openai/);
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("rejects a known-but-unconfigured provider", async () => {
    isTtsProviderConfigured.mockReturnValue(false);
    const captured = await callEndpoint({ model: "tts/elevenlabs", input: "hi" });
    expect(captured.statusCode).toBe(400);
    expect(jsonBody(captured).error?.message).toMatch(/not available/);
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("rejects when the provider ignored the requested response_format", async () => {
    // Provider honored its own default (mp3) instead of the requested opus.
    synthesizeSpeech.mockResolvedValue({
      success: true,
      audioBuffer: Buffer.from("AUDIO"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
    });
    const captured = await callEndpoint({
      model: "tts/elevenlabs",
      input: "hi",
      response_format: "opus",
    });
    expect(captured.statusCode).toBe(400);
    expect(jsonBody(captured).error?.message).toMatch(/does not support response_format 'opus'/);
    expect(synthesizeSpeech).toHaveBeenCalled();
  });

  it("maps synthesis failure to a 502 api_error", async () => {
    synthesizeSpeech.mockResolvedValue({ success: false, error: "provider exploded" });
    const captured = await callEndpoint({ model: "tts/openai", input: "hi" });
    expect(captured.statusCode).toBe(502);
    expect(jsonBody(captured).error?.type).toBe("api_error");
  });

  it("sanitizes unexpected synthesis errors to a 500", async () => {
    synthesizeSpeech.mockRejectedValue(new Error("secret upstream detail"));
    const captured = await callEndpoint({ model: "tts/openai", input: "hi" });
    expect(captured.statusCode).toBe(500);
    expect(jsonBody(captured).error).toEqual({ message: "internal error", type: "api_error" });
  });
});
