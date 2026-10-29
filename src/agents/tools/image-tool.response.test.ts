import { expect, it } from "vitest";
import * as image from "../../media-understanding/image.test-support.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";

const { describeImageWithModelCore } = await import("../../media-understanding/image.js");

image.installImageRuntimeTestHooks();
it("does not retry an aborted reasoning-only image response", async () => {
  const provider = "openai";
  const model = "gpt-5.4-mini";
  image.mockImageModel({ provider, id: model, api: "openai-responses" });
  image.imageRuntimeMocks.completeMock.mockResolvedValue(
    makeAssistantMessageFixture({
      stopReason: "aborted",
      errorMessage: undefined,
      content: [{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" }],
    }),
  );
  await expect(
    describeImageWithModelCore({ ...image.imageRequestDefaults(), provider, model }),
  ).rejects.toThrow("Image model failed (openai/gpt-5.4-mini)");
  expect(image.imageRuntimeMocks.completeMock).toHaveBeenCalledOnce();
});
