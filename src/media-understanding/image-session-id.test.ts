// Image description session-identity tests cover the conversation id forwarded to
// session-affine providers; OpenCode rejects an image completion that carries none.
import { describe, expect, it, vi } from "vitest";
import {
  imageCompletion,
  imageRequestDefaults,
  imageRuntimeMocks,
  installImageRuntimeTestHooks,
  mockImageModel,
} from "./image.test-support.js";

const { registerProviderStreamForModelMock } = imageRuntimeMocks;

const { describeImageWithModelCore } = await import("./image.js");

type CapturedStreamOptions = {
  sessionId?: string;
  headers?: Record<string, string>;
};

function stubProviderStream() {
  const streamResult = {
    result: vi.fn(async () =>
      imageCompletion("openai-completions", "opencode", "gemini-2.5-flash", "vision ok"),
    ),
  };
  const streamFn = vi.fn(() => streamResult);
  registerProviderStreamForModelMock.mockReturnValue(streamFn);
  return streamFn;
}

function capturedStreamOptions(streamFn: ReturnType<typeof stubProviderStream>, index: number) {
  const call = streamFn.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected provider stream call ${index}`);
  }
  return call[2] as CapturedStreamOptions;
}

describe("describeImageWithModelCore session identity", () => {
  installImageRuntimeTestHooks({ apiKey: "test-api-key" });

  function requestOpenCodeImage(overrides: Record<string, unknown> = {}) {
    mockImageModel({
      provider: "opencode",
      id: "gemini-2.5-flash",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/proxy/v1",
    });
    return describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "opencode",
      model: "gemini-2.5-flash",
      prompt: "Describe the image.",
      ...overrides,
    });
  }

  it("sends a session id so OpenCode does not reject the image completion", async () => {
    const streamFn = stubProviderStream();

    await requestOpenCodeImage();

    expect(capturedStreamOptions(streamFn, 0).sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("uses a fresh ephemeral session id for each image request", async () => {
    const streamFn = stubProviderStream();

    await requestOpenCodeImage();
    await requestOpenCodeImage();

    const first = capturedStreamOptions(streamFn, 0).sessionId;
    const second = capturedStreamOptions(streamFn, 1).sessionId;
    expect(second).toEqual(expect.any(String));
    expect(first).not.toBe(second);
  });

  it("keeps the caller's session id through the single-image entry point", async () => {
    const streamFn = stubProviderStream();

    await requestOpenCodeImage({ sessionId: "sess-agent-turn-1" });

    expect(capturedStreamOptions(streamFn, 0).sessionId).toBe("sess-agent-turn-1");
  });
});
