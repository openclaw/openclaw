import { readFileSync } from "node:fs";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { recordedToolCall } from "./recorded-tool.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat late preview anchoring" });
const url = "https://example.com/article";
const image = `data:image/png;base64,${readFileSync("docs/assets/openclaw-hero-dark.png").toString("base64")}`;
const filler = (from: number) =>
  Array.from({ length: 8 }, (_, index) => ({
    role: "assistant",
    content: `Synthetic filler message ${from + index}. `.repeat(12),
    timestamp: 1000 + (from + index) * 100,
  }));

/** Wait until native scrolling and row measurement stop moving the transcript. */
function settle(thread: Locator): Promise<void> {
  return thread.evaluate(
    (node) =>
      new Promise<void>((resolve) => {
        let last = Number.NaN;
        let still = 0;
        const tick = () => {
          still = node.scrollTop === last ? still + 1 : 0;
          last = node.scrollTop;
          if (still < 10) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        tick();
      }),
  );
}

suite.define(() => {
  it("keeps visible text still when a preview above it loads its image", async () => {
    await suite.withPage({ viewport: { width: 1000, height: 700 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        automaticallyFetchFavicons: true,
        featureMethods: [],
        deferredMethods: ["controlUi.linkPreview"],
        historyMessages: [
          ...filler(0),
          { ...recordedToolCall("open", "browser", { action: "open", url }), timestamp: 5000 },
          {
            role: "toolResult",
            timestamp: 5100,
            toolCallId: "open",
            toolName: "browser",
            content: [{ type: "text", text: "Opened article" }],
            details: {
              browserTab: { target: "host", profile: "managed", targetId: "tab", url },
            },
          },
          { role: "assistant", content: "Reader text below the preview.", timestamp: 5200 },
          ...filler(10),
        ],
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByText("Synthetic filler message 17.", { exact: false }).first().waitFor();
      const thread = page.locator(".chat-thread");
      const card = page.locator("openclaw-browser-tab-card .card");
      // The transcript opens at its end; the reader scrolls back until the card's row mounts.
      for (let step = 0; step < 30 && (await card.count()) === 0; step++) {
        await thread.hover();
        await page.mouse.wheel(0, -250);
        await settle(thread);
      }
      await gateway.waitForRequest("controlUi.linkPreview", { match: { url } });
      // Put the compact card at the top edge, with the reader's text in view below it.
      await card.evaluate((node) => {
        const scroller = node.closest<HTMLElement>(".chat-thread")!;
        scroller.scrollTop +=
          node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      });
      await settle(thread);
      const threadTop = (await thread.boundingBox())!.y;
      expect(Math.abs((await card.boundingBox())!.y - threadTop)).toBeLessThan(2);
      const text = page.getByText("Reader text below the preview.", { exact: true });
      const before = (await text.boundingBox())!.y;
      expect(before).toBeLessThan(threadTop + 700);

      await gateway.resolveDeferred("controlUi.linkPreview", {
        title: "Synthetic article",
        imageDataUrl: image,
      });
      const shot = page.locator("openclaw-browser-tab-card .shot img");
      await shot.waitFor();
      await shot.evaluate((node: HTMLImageElement) => node.decode());
      await settle(thread);
      expect((await shot.boundingBox())!.height).toBeGreaterThan(100);
      expect(Math.abs((await text.boundingBox())!.y - before)).toBeLessThan(1);
    });
  });
});
