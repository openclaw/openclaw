import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { ImageGenerationProvider } from "../../image-generation/provider-types.js";
import * as imageGenerationRuntime from "../../image-generation/runtime.js";
import * as mediaGenerationRegistry from "../../media-generation/registry.js";
import * as mediaStore from "../../media/store.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import { configWithDefaults } from "./media-config.test-support.js";
import * as mediaGenerationToolProviders from "./media-generation-tool-providers.js";

const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const provider: ImageGenerationProvider = {
  id: "openai",
  defaultModel: "gpt-image-2.6-flare",
  models: ["gpt-image-2.6-flare"],
  capabilities: { generate: { maxCount: 4 }, edit: { enabled: false } },
  generateImage: async () => {
    throw new Error("generateImage is mocked at the runtime boundary");
  },
};

function mockGeneratedGif(buffer = gif) {
  return vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
    provider: "openai",
    model: "gpt-image-2.6-flare",
    attempts: [],
    ignoredOverrides: [],
    images: [{ buffer, mimeType: "image/gif", fileName: "image-1.gif" }],
  });
}

function createTool(mediaMaxMb?: number) {
  const tool = createImageGenerateTool({
    config: configWithDefaults({
      ...(mediaMaxMb !== undefined ? { mediaMaxMb } : {}),
      mediaModels: { image: { primary: "openai/gpt-image-2.6-flare" } },
    }),
    agentDir: "/tmp/agent",
  });
  if (!tool) {
    throw new Error("expected image_generate tool");
  }
  return tool;
}

beforeEach(() => {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    provider,
  ]);
  vi.spyOn(mediaGenerationToolProviders, "acquireMediaGenerationToolProviders").mockResolvedValue({
    providers: [provider],
    assertOpen() {},
    run: async (run) => await run(),
    release: async () => {},
  });
  vi.spyOn(mediaGenerationRegistry, "withImageGenerationProviders").mockImplementation(
    async (_cfg, run) => await run([provider]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

describe("image_generate animated GIF output", () => {
  it("forwards GIF frame controls and reports the returned GIF", async () => {
    const generateImage = mockGeneratedGif();
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/generated.gif",
      id: "generated.gif",
      size: gif.byteLength,
      contentType: "image/gif",
    });

    const result = await createTool().execute("call-gif", {
      prompt: "A blinking cat",
      outputFormat: "gif",
      openai: { frameCount: 12, frameDurationMs: 120 },
    });

    expect(generateImage.mock.calls[0]?.[0]).toMatchObject({
      outputFormat: "gif",
      providerOptions: { openai: { frameCount: 12, frameDurationMs: 120 } },
    });
    expect((result.details as { outputs?: unknown }).outputs).toEqual([
      expect.objectContaining({ size: "1x1", outputFormat: "gif" }),
    ]);
  });

  it.each([
    ["frameCount", 1, "openai.frameCount must be between 2 and 64"],
    ["frameCount", 65, "openai.frameCount must be between 2 and 64"],
    ["frameDurationMs", 10, "openai.frameDurationMs must be between 20 and 2000"],
    ["frameDurationMs", null, "openai.frameDurationMs must be between 20 and 2000"],
  ])("rejects out-of-range %s %s", async (key, value, message) => {
    const generateImage = mockGeneratedGif();
    await expect(
      createTool().execute("call-gif-bounds", {
        prompt: "A blinking cat",
        outputFormat: "gif",
        openai: { [key]: value },
      }),
    ).rejects.toThrow(message);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("fails instead of flattening a GIF over the media cap", async () => {
    mockGeneratedGif(Buffer.concat([gif, Buffer.alloc(2048)]));
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");

    await expect(
      createTool(1 / 1024).execute("call-gif-over-cap", {
        prompt: "A long loop",
        outputFormat: "gif",
      }),
    ).rejects.toThrow(
      /exceeds the 1KB media limit; animated images are not re-encoded\. Request fewer frames/,
    );
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });
});
