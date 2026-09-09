import { describe, expect, it } from "vitest";
import { generateImage } from "./runtime.js";
import type { ImageGenerationProvider } from "./types.js";

describe("image-generation output capabilities", () => {
  it.each([
    { model: "extended", accepted: true },
    { model: "legacy", accepted: false },
    { model: "restricted", accepted: false },
  ])("filters quality against $model model capabilities", async ({ model, accepted }) => {
    let seenQuality: string | undefined;
    const provider: ImageGenerationProvider = {
      id: "test",
      capabilities: {
        generate: {},
        edit: { enabled: true },
        output: {
          qualities: ["low"],
          qualitiesByModel: { extended: ["xhigh", "max"], restricted: [] },
        },
      },
      async generateImage(req) {
        seenQuality = req.quality;
        return { images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }] };
      },
    };
    const result = await generateImage(
      {
        cfg: {},
        modelOverride: `test/${model}`,
        prompt: "A sticker",
        quality: "max",
      },
      {
        getProvider: (id) => (id === provider.id ? provider : undefined),
        listProviders: () => [provider],
      },
    );
    expect(seenQuality).toBe(accepted ? "max" : undefined);
    expect(result.ignoredOverrides).toEqual(accepted ? [] : [{ key: "quality", value: "max" }]);
  });
});
