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

const completion = () =>
  imageCompletion(
    "openai-completions",
    OPENCODE_GO_IMAGE.provider,
    OPENCODE_GO_IMAGE.model,
    "vision ok",
  );
function stubProviderStream(result = vi.fn(async () => completion())) {
  const streamFn = vi.fn(() => ({ result }));
  registerProviderStreamForModelMock.mockReturnValue(streamFn);
  return streamFn;
}

function capturedStreamOptions(streamFn: ReturnType<typeof stubProviderStream>, index: number) {
  const call = (streamFn.mock.calls as unknown[][]).at(index);
  if (!call) {
    throw new Error(`Expected provider stream call ${index}`);
  }
  const options = call[2] as CapturedStreamOptions;
  return { sessionId: options.sessionId, header: options.headers?.[SESSION_HEADER] };
}

function requestImage(
  { provider, model, baseUrl }: typeof OPENCODE_GO_IMAGE,
  modelExtras: Record<string, unknown> = {},
) {
  mockImageModel({ provider, id: model, api: "openai-completions", baseUrl, ...modelExtras });
  return describeImageWithModelCore({
    ...imageRequestDefaults(),
    provider,
    model,
    prompt: "Describe the image.",
  });
}

describe("describeImageWithModelCore OpenCode routing identity", () => {
  installImageRuntimeTestHooks({ apiKey: "test-api-key" });

  it("uses a fresh routing identity for each image request", async () => {
    const streamFn = stubProviderStream();

    await requestImage(OPENCODE_GO_IMAGE);
    await requestImage(OPENCODE_GO_IMAGE);

    const first = capturedStreamOptions(streamFn, 0);
    const second = capturedStreamOptions(streamFn, 1);
    const expected = { sessionId: undefined, header: expect.stringMatching(UUID_PATTERN) };
    expect([first, second]).toEqual([expected, expected]);
    expect(first.header).not.toBe(second.header);
  });

  it("reuses one routing identity across the reasoning-only retry", async () => {
    const streamFn = stubProviderStream(
      vi
        .fn()
        .mockResolvedValueOnce({
          ...completion(),
          content: [
            {
              type: "thinking",
              thinking: "examining the image",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockResolvedValueOnce(completion()),
    );

    await requestImage(OPENCODE_GO_IMAGE);

    expect(streamFn).toHaveBeenCalledTimes(2);
    const first = capturedStreamOptions(streamFn, 0).header;
    expect(first).toMatch(UUID_PATTERN);
    expect(capturedStreamOptions(streamFn, 1).header).toBe(first);
  });

  it.each([
    [
      "unrelated provider",
      { provider: "openai", model: "gpt-5-mini", baseUrl: "https://api.openai.com/v1" },
      {},
    ],
    [
      "model-level header",
      OPENCODE_GO_IMAGE,
      { headers: { "X-OpenCode-Session": "model-session" } },
    ],
  ] as const)("does not inject routing identity for %s", async (_name, endpoint, extras) => {
    const streamFn = stubProviderStream();
    await requestImage(endpoint, extras);
    expect(capturedStreamOptions(streamFn, 0)).toEqual({ sessionId: undefined, header: undefined });
  });
});
