import { describe, expect, it } from "vitest";
import { getImageMetadata } from "../../media/image-ops.js";
import { createSolidPngBuffer } from "../../plugin-sdk/test-helpers/image-fixtures.js";
import { createComputerTool } from "./computer-tool.js";

describe("computer screenshot dimensions", () => {
  it.each([
    [1024, 768, 1200, 1024, 768],
    [1080, 1920, 1280, 720, 1280],
    [1200, 1243, 1200, 1158, 1200],
    [1, 3, 1, 1, 1],
    [32, 16, 1200, 32, 16],
  ] as const)(
    "reports %dx%d at cap %d as the delivered %dx%d image",
    async (width, height, referenceWidth, deliveredWidth, deliveredHeight) => {
      const tool = createComputerTool({
        config: { agents: { defaults: { imageMaxDimensionPx: referenceWidth } } },
        transport: {
          resolveNode: async () => ({ nodeId: "desktop-node" }),
          invoke: async () => ({
            base64: createSolidPngBuffer(width, height, { r: 70, g: 125, b: 180 }).toString(
              "base64",
            ),
            format: "png",
            displayFrameId: "display-frame",
            width,
            height,
            screenIndex: 0,
          }),
        },
      });
      const result = await tool.execute("observe", { action: "screenshot" });
      const image = result.content.find((block) => block.type === "image");
      if (!image) {
        throw new Error("The screenshot image is missing");
      }
      const metadata = await getImageMetadata(Buffer.from(image.data, "base64"));
      expect(metadata).toMatchObject({ width: deliveredWidth, height: deliveredHeight });
      expect(result.details).toMatchObject({
        width: deliveredWidth,
        height: deliveredHeight,
        refWidth: referenceWidth,
      });
      expect(result.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(`screenshot ${deliveredWidth}x${deliveredHeight}`),
      });
    },
  );
});
