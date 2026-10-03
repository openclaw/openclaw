import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as llmStream from "../../llm/stream.js";
import * as imageModelRuntime from "../../media-understanding/image-model-runtime.js";
import { describeImageWithModelCore } from "../../media-understanding/image.js";
import * as providerStream from "../provider-stream.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createImageTool } from "./image-tool.js";
import { ONE_PIXEL_PNG_B64, testing } from "./image-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("image tool response validation", () => {
  beforeEach(() => {
    testing.setProviderDepsForTest({
      buildProviderRegistry: () => new Map(),
      getMediaUnderstandingProvider: () => undefined,
      resolveRegisteredMediaUnderstandingProvider: () => undefined,
      describeImageWithModel: describeImageWithModelCore,
      resolveImageCompressionPolicy: async ({ imageCount }) => ({ imageCount }),
    });
    vi.spyOn(imageModelRuntime, "resolveImageRuntime").mockResolvedValue({
      runtimeValue: "test-key",
      model: makeProviderModelFixture({
        id: "gpt-5.4-mini",
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
        baseUrl: "https://image-fixture.invalid/v1",
      }),
    });
    vi.spyOn(providerStream, "registerProviderStreamForModel").mockReturnValue(undefined);
    vi.spyOn(llmStream, "complete");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testing.setProviderDepsForTest();
  });

  async function executeImage() {
    const tool = createImageTool({
      agentDir: tempDirs.make("openclaw-image-response-"),
      config: { agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } } },
    });
    if (!tool) {
      throw new Error("expected image tool");
    }
    return await tool.execute("image", { path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}` });
  }

  it.each([
    {
      name: "rejects image-model responses with no final text",
      message: makeAssistantMessageFixture({
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "thinking", thinking: "hmm" }],
      }),
      expectedError: "Image model returned no text (openai/gpt-5.4-mini).",
    },
    {
      name: "surfaces provider errors from image-model responses",
      message: makeAssistantMessageFixture({
        stopReason: "stop",
        errorMessage: "  boom  ",
        content: [{ type: "text", text: "must not hide the failure" }],
      }),
      expectedError: "Image model failed (openai/gpt-5.4-mini): boom",
    },
    ...(["error", "aborted"] as const).map((stopReason) => ({
      name: `does not retry reasoning-only responses stopped with ${stopReason}`,
      message: makeAssistantMessageFixture({
        stopReason,
        errorMessage: undefined,
        content: [{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" }],
      }),
      expectedError: "Image model failed (openai/gpt-5.4-mini)",
    })),
  ])("$name", async ({ message, expectedError }) => {
    vi.mocked(llmStream.complete).mockResolvedValue(message);
    await expect(executeImage()).rejects.toThrow(expectedError);
    expect(llmStream.complete).toHaveBeenCalledOnce();
  });

  it("returns trimmed image text after a reasoning-only retry", async () => {
    vi.mocked(llmStream.complete)
      .mockResolvedValueOnce(
        makeAssistantMessageFixture({
          stopReason: "stop",
          errorMessage: undefined,
          content: [{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" }],
        }),
      )
      .mockResolvedValueOnce(
        makeAssistantMessageFixture({
          stopReason: "length",
          errorMessage: "  ",
          content: [{ type: "text", text: "  hello  " }],
        }),
      );
    const result = await executeImage();
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.details).toMatchObject({ model: "openai/gpt-5.4-mini", text: "hello" });
    expect(llmStream.complete).toHaveBeenCalledTimes(2);
  });
});
