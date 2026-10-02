// Image description routing-identity tests cover the OpenCode session header that a vision
// completion needs; OpenCode rejects an image request that carries none.
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

const SESSION_HEADER = "x-opencode-session";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_GO_IMAGE = {
  provider: "opencode-go",
  model: "gemini-3-flash",
  baseUrl: "https://opencode.ai/zen/go/v1",
};

function stubProviderStream(text = "vision ok") {
  const streamResult = {
    result: vi.fn(async () =>
      imageCompletion(
        "openai-completions",
        OPENCODE_GO_IMAGE.provider,
        OPENCODE_GO_IMAGE.model,
        text,
      ),
    ),
  };
  const streamFn = vi.fn(() => streamResult);
  registerProviderStreamForModelMock.mockReturnValue(streamFn);
  return streamFn;
}

function capturedStreamOptions(streamFn: ReturnType<typeof stubProviderStream>, index: number) {
  const call = (streamFn.mock.calls as unknown[][]).at(index);
  if (!call) {
    throw new Error(`Expected provider stream call ${index}`);
  }
  return call[2] as CapturedStreamOptions;
}

function requestImage(
  endpoint: { provider: string; model: string; baseUrl: string },
  modelExtras: Record<string, unknown> = {},
) {
  mockImageModel({
    provider: endpoint.provider,
    id: endpoint.model,
    api: "openai-completions",
    baseUrl: endpoint.baseUrl,
    ...modelExtras,
  });
  return describeImageWithModelCore({
    ...imageRequestDefaults(),
    provider: endpoint.provider,
    model: endpoint.model,
    prompt: "Describe the image.",
  });
}

describe("describeImageWithModelCore OpenCode routing identity", () => {
  installImageRuntimeTestHooks({ apiKey: "test-api-key" });

  it("sends the OpenCode session header without claiming a stream session", async () => {
    const streamFn = stubProviderStream();

    await requestImage(OPENCODE_GO_IMAGE);

    const options = capturedStreamOptions(streamFn, 0);
    expect(options.headers?.[SESSION_HEADER]).toMatch(UUID_PATTERN);
    expect(options.sessionId).toBeUndefined();
  });

  it("uses a fresh routing identity for each image request", async () => {
    const streamFn = stubProviderStream();

    await requestImage(OPENCODE_GO_IMAGE);
    await requestImage(OPENCODE_GO_IMAGE);

    const first = capturedStreamOptions(streamFn, 0).headers?.[SESSION_HEADER];
    const second = capturedStreamOptions(streamFn, 1).headers?.[SESSION_HEADER];
    expect(first).toMatch(UUID_PATTERN);
    expect(second).toMatch(UUID_PATTERN);
    expect(first).not.toBe(second);
  });

  it("reuses one routing identity across the reasoning-only retry", async () => {
    const streamResult = {
      result: vi
        .fn()
        .mockResolvedValueOnce({
          role: "assistant",
          api: "openai-completions",
          provider: OPENCODE_GO_IMAGE.provider,
          model: OPENCODE_GO_IMAGE.model,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "examining the image",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockResolvedValueOnce(
          imageCompletion(
            "openai-completions",
            OPENCODE_GO_IMAGE.provider,
            OPENCODE_GO_IMAGE.model,
            "vision ok",
          ),
        ),
    };
    const streamFn = vi.fn(() => streamResult);
    registerProviderStreamForModelMock.mockReturnValue(streamFn);

    await requestImage(OPENCODE_GO_IMAGE);

    expect(streamFn).toHaveBeenCalledTimes(2);
    const first = capturedStreamOptions(streamFn, 0).headers?.[SESSION_HEADER];
    expect(first).toMatch(UUID_PATTERN);
    expect(capturedStreamOptions(streamFn, 1).headers?.[SESSION_HEADER]).toBe(first);
  });

  it("leaves an unrelated provider's request options untouched", async () => {
    const streamFn = stubProviderStream();

    await requestImage({
      provider: "openai",
      model: "gpt-5-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const options = capturedStreamOptions(streamFn, 0);
    expect(options.sessionId).toBeUndefined();
    expect(options.headers?.[SESSION_HEADER]).toBeUndefined();
  });

  it("keeps a model-level routing header instead of replacing it", async () => {
    const streamFn = stubProviderStream();

    await requestImage(OPENCODE_GO_IMAGE, {
      headers: { "X-OpenCode-Session": "model-session" },
    });

    const options = capturedStreamOptions(streamFn, 0);
    expect(options.headers?.[SESSION_HEADER]).toBeUndefined();
    expect(options.sessionId).toBeUndefined();
  });
});
