import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const observeAppearance = (thread: Locator, selector: string, includeTargets = false) =>
  thread.evaluateHandle(
    (element, options) => {
      let appeared = false;
      const observer = new MutationObserver((records) => {
        appeared ||= records.some((record) =>
          [...record.addedNodes, ...(options.includeTargets ? [record.target] : [])].some(
            (node) =>
              node instanceof Element &&
              (node.matches(options.selector) || node.querySelector(options.selector) !== null),
          ),
        );
      });
      observer.observe(element, {
        childList: true,
        subtree: true,
        attributes: options.includeTargets,
      });
      return {
        stop: () => {
          observer.disconnect();
          return appeared;
        },
      };
    },
    { selector, includeTargets },
  );

async function scrollToBottom(thread: Locator) {
  await thread.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

suite.define(() => {
  it.each(["unchanged", "sharing", "role assignment", "role definition"] as const)(
    "reuses loaded images on scroll and respects %s access changes",
    async (change) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const source = "media://inbound/virtual-remount.png";
        let metadataRequests = 0;
        let imageRequests = 0;
        let revoked = false;
        await page.route("**/__openclaw__/assistant-media?**", async (route) => {
          const url = new URL(route.request().url());
          expect(url.searchParams.get("source")).toBe(source);
          if (url.searchParams.get("meta") === "1") {
            metadataRequests += 1;
            if (revoked) {
              await route.fulfill({ status: 403, json: { error: "Access revoked" } });
              return;
            }
            await route.fulfill({
              json: {
                available: true,
                mediaTicket: `remount-ticket-${metadataRequests}`,
                mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            });
          } else {
            imageRequests += 1;
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
        const gateway = await installMockGateway(page, {
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
        const thread = page.locator(".chat-thread");
        const trace = await observeAppearance(thread, '.chat-image-frame[aria-busy="true"]', true);
        await scrollToBottom(thread);
        await expect.poll(() => image.count()).toBe(0);
        await expect.poll(() => row.evaluate((element) => element.isConnected)).toBe(false);
        await waitForChatScrollIdle(page);
        await scrollChatThreadToTop(page);
        await waitForLoadedImage();
        await waitForChatScrollIdle(page);
        expect(await trace.evaluate((observer) => observer.stop())).toBe(false);
        expect(metadataRequests).toBe(1);
        expect(imageRequests).toBe(1);
        if (change === "unchanged") {
          return;
        }
        await scrollToBottom(thread);
        await expect.poll(() => image.count()).toBe(0);
        await waitForChatScrollIdle(page);
        const withdrawn = await observeAppearance(thread, 'img[alt="Remounted image"]');
        revoked = true;
        if (change === "sharing") {
          // Revoked readers receive the redacted catalog invalidation, not a private row.
          await gateway.emitGatewayEvent("sessions.changed", { reason: "sharing" });
        } else if (change === "role definition") {
          await gateway.emitGatewayEvent("config.changed", {});
        } else {
          // users.setRole closes the named reader through the Gateway policy owner.
          const sockets = await gateway.getSocketCount();
          await gateway.closeLatest(4001, "operator role changed");
          await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(sockets);
          await page.getByText("History 79", { exact: false }).waitFor();
        }
        await scrollChatThreadToTop(page);
        await page.locator(".chat-image-frame--compact").waitFor();
        expect(await image.count()).toBe(0);
        expect(await withdrawn.evaluate((observer) => observer.stop())).toBe(false);
        expect(metadataRequests).toBeGreaterThanOrEqual(2);
        expect(imageRequests).toBe(1);
      });
    },
  );
});
