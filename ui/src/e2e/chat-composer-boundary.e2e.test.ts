import { writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat composer boundary" });

suite.define(() => {
  it.each([
    { width: 390, mode: "light" },
    { width: 390, mode: "dark" },
  ] as const)(
    "leaves no painted strip above the composer at $width px in $mode mode",
    async ({ width, mode }) => {
      await suite.withPage(
        {
          viewport: { width, height: 844 },
          colorScheme: mode,
          isMobile: width === 390,
          hasTouch: width === 390,
        },
        async ({ page }) => {
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Ready to review the next change." }],
              },
            ],
          });
          await page.goto(suite.server.baseUrl + "chat");
          const footer = page.locator(".chat-footer");
          const input = footer.locator("textarea");
          await input.waitFor();
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
          const frame = await takeControlUiScreenshotFrame(page, footer, [input], {
            animations: "disabled",
          });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await writeFile(path.join(suite.artifactDir, `${width}-${mode}.png`), frame.png);
          }
          const bounds = (await footer.boundingBox())!;
          const image = photon.PhotonImage.new_from_byteslice(frame.png);
          try {
            const scale = image.get_width() / width;
            const pixels = image.get_raw_pixels();
            const x = Math.floor((bounds.x + bounds.width / 2) * scale);
            const top = Math.floor(bounds.y * scale);
            const sample = (y: number) => {
              const offset = (y * image.get_width() + x) * 4;
              return [...pixels.subarray(offset, offset + 3)];
            };
            const background = sample(top - Math.ceil(32 * scale));
            // The composer outline can rasterize outside its box; probe the canvas, not that edge.
            const differences = Array.from({ length: Math.ceil(22 * scale) }, (_, index) =>
              Math.max(
                ...sample(top - Math.ceil(3 * scale) - index).map((value, channel) =>
                  Math.abs(value - background[channel]!),
                ),
              ),
            );
            expect(
              Math.max(...differences),
              "blank transcript canvas stays uniform up to the composer",
            ).toBeLessThanOrEqual(1);
          } finally {
            image.free();
          }
        },
      );
    },
  );
});
