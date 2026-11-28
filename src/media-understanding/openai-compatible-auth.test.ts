import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";
import { describeOpenAiCompatibleVideo } from "./openai-compatible-video.js";
import type { AudioTranscriptionRequest } from "./types.js";

installPinnedHostnameTestHooks();

const noAuth = { kind: "none", source: "local provider" } as const;
const typedAuth = { kind: "api-key", apiKey: "typed-key" } as const;
const bearerRequest = { auth: { mode: "authorization-bearer", token: "request-key" } } as const;
type AuthCase = [
  request: Partial<Pick<AudioTranscriptionRequest, "apiKey" | "auth" | "headers" | "request">>,
  authorization: string | null,
  customHeader?: string,
];

describe.each([
  ["audio", transcribeOpenAiCompatibleAudio, "Audio transcription"],
  ["video", describeOpenAiCompatibleVideo, "Local media video description"],
] as const)("OpenAI-compatible %s authentication", (_capability, send, errorLabel) => {
  const defaults = {
    buffer: Buffer.from("media"),
    fileName: "media.bin",
    apiKey: "legacy-key",
    timeoutMs: 1000,
    provider: "local-media",
    defaultBaseUrl: "https://media.example.com/v1",
    defaultModel: "local-model",
    defaultPrompt: "Describe the media.",
    providerLabel: "Local media",
  };
  it.each<AuthCase>([
    [{ apiKey: CUSTOM_LOCAL_AUTH_MARKER, auth: noAuth }, null],
    [{ auth: typedAuth }, "Bearer typed-key"],
    [{}, "Bearer legacy-key"],
    [{ apiKey: "" }, null],
    [
      {
        auth: noAuth,
        headers: { Authorization: "Bearer caller-key" },
        request: bearerRequest,
      },
      "Bearer caller-key",
    ],
    [{ auth: noAuth, request: bearerRequest }, "Bearer request-key"],
    [
      {
        auth: typedAuth,
        request: { auth: { mode: "header", headerName: "X-Custom-Key", value: "custom-key" } },
      },
      null,
      "custom-key",
    ],
  ])("auth precedence for %j yields %s", async (request, authorization, customHeader) => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      text: "ok",
      choices: [{ message: { content: "ok" } }],
    });
    const result = await send({ ...defaults, fetchFn, ...request });

    expect(result.text).toBe("ok");
    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("authorization")).toBe(authorization);
    expect(headers.get("x-custom-key")).toBe(customHeader ?? null);
  });

  it.each([400, 200])("redacts credentials in HTTP %s diagnostics", async (status) => {
    const credential = "synthetic-only";
    const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      return new Response(
        status === 400
          ? JSON.stringify({ error: { message: `Rejected ${credential}`, code: credential } })
          : credential,
        { status, headers: { "x-request-id": credential } },
      );
    });

    const error = await send({
      ...defaults,
      headers: { authorization: `Bearer ${credential}` },
      fetchFn,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message:
        status === 400
          ? `${errorLabel} failed (HTTP 400): Rejected *** [code=***] [request_id=***]`
          : `${errorLabel} failed: malformed JSON response`,
    });
    expect(inspect(error)).not.toContain(credential);
  });
});
