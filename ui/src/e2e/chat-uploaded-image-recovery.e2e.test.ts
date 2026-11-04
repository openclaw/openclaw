import { expect, it } from "vitest";
import { mediaTicketPayload } from "../test-helpers/control-ui-attachment-fixtures.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { installAssistantMediaCacheMiss } from "./chat-media-http-cache.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Uploaded image request recovery" });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

suite.define(() => {
  it.each(["404", "decode", "revoked", "removed"] as const)(
    "recovers an uploaded image after %s only with an authorized explicit retry",
    (failure) =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.clock.install();
          await installAssistantMediaCacheMiss(page);
          const source = "media://inbound/a.png";
          const prompt = "Inspect this image.";
          const denied = failure === "revoked" || failure === "removed";
          const denialStatus = failure === "revoked" ? 403 : 404;
          let metadataRequests = 0;
          let imageRequests = 0;
          let retry = false;
          await page.route("**/__openclaw__/assistant-media?**", async (route) => {
            const request = route.request();
            const query = new URL(request.url()).searchParams;
            const target = [query.get("source"), request.method(), query.has("allow")];
            expect(target).toEqual([source, "GET", false]);
            if (query.get("meta") === "1") {
              metadataRequests += 1;
              return route.fulfill(
                retry && denied
                  ? { status: denialStatus, json: { error: "Attachment unavailable" } }
                  : {
                      json: mediaTicketPayload("upload-ticket-" + metadataRequests, 300_000),
                    },
              );
            }
            imageRequests += 1;
            expect(query.get("mediaTicket")).toBe("upload-ticket-" + metadataRequests);
            await route.fulfill(
              retry || failure === "decode"
                ? { contentType: "image/png", body: retry ? png : "not a PNG" }
                : { status: denialStatus },
            );
          });
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
                __openclaw: {
                  id: "upload",
                  seq: 1,
                  media: [{ path: source, contentType: "image/png", fileName: "a.png" }],
                  mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
                },
                timestamp: 1,
              },
            ],
          });
          await page.goto(suite.server.baseUrl + "chat");
          const row = page.locator(".chat-bubble").filter({ hasText: prompt });
          const card = row.locator(".chat-assistant-attachment-card");
          const image = row.locator("img.chat-message-image");
          await expect.poll(() => imageRequests).toBe(1);
          await card.waitFor({ timeout: 5_000 });
          expect(await card.textContent()).toContain("Could not load this image. Try again.");
          expect(await image.count()).toBe(0);
          await page.clock.fastForward(15_000);
          expect([metadataRequests, imageRequests]).toEqual([1, 1]);
          retry = true;
          await card.getByRole("button", { name: "Retry", exact: true }).click();
          await expect.poll(() => metadataRequests).toBe(2);
          if (denied) {
            await expect.poll(() => card.textContent()).toContain("Unavailable");
            await page.clock.fastForward(15_000);
            expect([metadataRequests, imageRequests, await image.count()]).toEqual([2, 1, 0]);
          } else {
            await expect
              .poll(() =>
                image.evaluate((img: HTMLImageElement) => [img.complete, img.naturalWidth]),
              )
              .toEqual([true, 1]);
            await expect
              .poll(() => page.evaluate(() => document.documentElement.dataset.mediaCacheRead))
              .toBe(
                JSON.stringify({
                  cache: "only-if-cached",
                  mode: "same-origin",
                  credentials: "same-origin",
                }),
              );
            expect([imageRequests, await card.count()]).toEqual([2, 0]);
          }
        },
      ),
  );
});
