import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("remounts a loaded image after scrolling without showing a loading skeleton", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const source = "media://inbound/virtual-remount.png";
      let metadataRequests = 0;
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("source")).toBe(source);
        if (url.searchParams.get("meta") === "1") {
          metadataRequests += 1;
          await route.fulfill({
            json: {
              available: true,
              mediaTicket: `remount-ticket-${metadataRequests}`,
              mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          });
        } else {
          await route.fulfill({
            contentType: "image/png",
            headers: { "Cache-Control": "no-cache" },
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
              "base64",
            ),
          });
        }
      });
      await installMockGateway(page, {
        historyMessages: Array.from({ length: 80 }, (_, index) => ({
          role: index % 2 === 0 ? "assistant" : "user",
          content: [
            { type: "text", text: `History ${index}\n${"Transcript line\n".repeat(3)}` },
            ...(index === 2 ? [{ type: "image", url: source, alt: "Remounted image" }] : []),
          ],
          timestamp: Date.now() - 80_000 + index,
        })),
      });
      await page.goto(new URL("chat", suite.server.baseUrl).href);
      await page.getByText("History 79", { exact: false }).waitFor();
      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      const image = page.getByRole("img", { name: "Remounted image", exact: true });
      const waitForLoadedImage = () =>
        expect
          .poll(() =>
            image.evaluate((element: HTMLImageElement) =>
              element.complete ? element.naturalWidth : 0,
            ),
          )
          .toBeGreaterThan(0);
      await waitForLoadedImage();
      await waitForChatScrollIdle(page);
      const row = await image.evaluateHandle((element) => element.closest(".chat-virtual-row")!);
      const trace = await page.locator(".chat-thread").evaluateHandle((thread) => {
        const selector = '.chat-assistant-attachment-card--checking[aria-busy="true"]';
        let showedSkeleton = false;
        const observer = new MutationObserver((records) => {
          // Inspect added subtrees too: a flash may be removed before the callback runs.
          showedSkeleton ||= records.some((record) =>
            [...record.addedNodes, record.target].some(
              (node) =>
                node instanceof Element &&
                (node.matches(selector) || node.querySelector(selector) !== null),
            ),
          );
        });
        observer.observe(thread, { childList: true, subtree: true, attributes: true });
        return {
          stop: () => {
            observer.disconnect();
            return showedSkeleton;
          },
        };
      });
      await page.locator(".chat-thread").evaluate((thread) => {
        thread.scrollTop = thread.scrollHeight;
        thread.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await expect.poll(() => image.count()).toBe(0);
      await expect.poll(() => row.evaluate((element) => element.isConnected)).toBe(false);
      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      await waitForLoadedImage();
      await waitForChatScrollIdle(page);
      expect(await trace.evaluate((observer) => observer.stop())).toBe(false);
      expect(metadataRequests).toBe(1);
    });
  });
});
