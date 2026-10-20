import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Uploaded image request recovery" });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

suite.define(() => {
  it.each(["404", "503", "network", "decode", "revoked", "removed"] as const)(
    "recovers an uploaded image after %s only with an authorized explicit retry",
    (failure) =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.clock.install();
          const source = "media://inbound/uploaded-image.png";
          const prompt = "Please inspect this uploaded image.";
          const denied = failure === "revoked" || failure === "removed";
          const denialStatus = failure === "revoked" ? 403 : 404;
          let metadataRequests = 0;
          let imageRequests = 0;
          let retry = false;
          await page.route("**/__openclaw__/assistant-media?**", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            const query = url.searchParams;
            expect([query.get("source"), request.method(), query.has("allow")]).toEqual([
              source,
              "GET",
              false,
            ]);
            if (url.searchParams.get("meta") === "1") {
              metadataRequests += 1;
              if (retry && denied) {
                await route.fulfill({
                  status: denialStatus,
                  json: { error: "Attachment unavailable" },
                });
              } else {
                await route.fulfill({
                  json: {
                    available: true,
                    mediaTicket: "upload-ticket-" + metadataRequests,
                    mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
                  },
                });
              }
              return;
            }
            imageRequests += 1;
            expect(url.searchParams.get("mediaTicket")).toBe("upload-ticket-" + metadataRequests);
            if (retry) {
              await route.fulfill({ contentType: "image/png", body: png });
            } else if (failure === "network") {
              await route.abort("connectionreset");
            } else if (failure === "decode") {
              await route.fulfill({ contentType: "image/png", body: "not a PNG" });
            } else {
              await route.fulfill({
                status: failure === "503" ? 503 : denialStatus,
              });
            }
          });
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
                __openclaw: {
                  id: "uploaded-image-message",
                  seq: 1,
                  media: [
                    { path: source, contentType: "image/png", fileName: "uploaded-image.png" },
                  ],
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
                image.evaluate((element: HTMLImageElement) =>
                  element.complete ? element.naturalWidth : 0,
                ),
              )
              .toBe(1);
            expect(imageRequests).toBe(2);
            expect(await card.count()).toBe(0);
          }
        },
      ),
  );
});
