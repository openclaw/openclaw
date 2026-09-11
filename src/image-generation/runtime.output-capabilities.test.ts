import { describe, expect, it } from "vitest";
import { generateImage } from "./runtime.js";
import type { ImageGenerationProvider } from "./types.js";

describe("image-generation output capabilities", () => {
  it.each([
    { model: "extended", accepted: true },
    { model: "legacy", accepted: false },
    { model: "restricted", accepted: false },
  ])("filters output hints against $model model capabilities", async ({ model, accepted }) => {
    let seenRequest: { quality?: string; outputFormat?: string; background?: string } | undefined;
    const provider: ImageGenerationProvider = {
      id: "test",
      capabilities: {
        generate: {},
        edit: { enabled: true },
        output: {
          qualities: ["low"],
          formats: ["png"],
          backgrounds: ["opaque"],
          qualitiesByModel: { extended: ["xhigh", "max"], restricted: [] },
          formatsByModel: { extended: ["webp"], restricted: [] },
          backgroundsByModel: { extended: ["transparent"], restricted: [] },
        },
      },
      async generateImage(req) {
        seenRequest = {
          quality: req.quality,
          outputFormat: req.outputFormat,
          background: req.background,
        };
        return { images: [{ buffer: Buffer.from("image"), mimeType: "image/webp" }] };
      },
    };
    const result = await generateImage(
      {
        cfg: {},
        modelOverride: `test/${model}`,
        prompt: "A sticker",
        quality: "max",
        outputFormat: "webp",
        background: "transparent",
      },
      {
        getProvider: (id) => (id === provider.id ? provider : undefined),
        listProviders: () => [provider],
      },
    );
    expect(seenRequest).toEqual({
      quality: accepted ? "max" : undefined,
      outputFormat: accepted ? "webp" : undefined,
      background: accepted ? "transparent" : undefined,
    });
    expect(result.ignoredOverrides).toEqual(
      accepted
        ? []
        : [
            { key: "quality", value: "max" },
            { key: "outputFormat", value: "webp" },
            { key: "background", value: "transparent" },
          ],
    );
  });
});
