import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Uploaded image request recovery" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

suite.define(() => {
  it.each(["404", "503", "network", "decode", "revoked", "removed"] as const)(
    "recovers an uploaded image after %s only with an authorized explicit retry",
    async (failure) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.clock.install();
          const source = "media://inbound/uploaded-image.png";
          let metadataRequests = 0;
          let imageRequests = 0;
          let retry = false;
          await page.route("**/__openclaw__/assistant-media?**", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            expect(url.searchParams.get("source")).toBe(source);
            expect(request.method()).toBe("GET");
            expect(url.searchParams.has("allow")).toBe(false);
            if (url.searchParams.get("meta") === "1") {
              metadataRequests += 1;
              if (retry && (failure === "revoked" || failure === "removed")) {
                await route.fulfill({
                  status: failure === "revoked" ? 403 : 404,
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
                status: failure === "503" ? 503 : failure === "revoked" ? 403 : 404,
              });
            }
          });
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "user",
                content: [{ type: "text", text: "Please inspect this uploaded image." }],
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
          const row = page
            .locator(".chat-bubble")
            .filter({ hasText: "Please inspect this uploaded image." });
          const card = row.locator(".chat-assistant-attachment-card");
          const proofDir =
            captureProof && failure === "404"
              ? createControlUiE2eArtifactDir("uploaded-image-recovery")
              : undefined;
          await expect.poll(() => imageRequests).toBe(1);
          try {
            await card.waitFor({ timeout: 5_000 });
          } finally {
            if (proofDir) {
              const stage = (await card.count()) ? "after" : "before";
              // The baseline deliberately has a broken IMG; use viewport capture,
              // not the decoded-image readiness gate used for successful images.
              await writeFile(
                path.join(proofDir, stage + ".png"),
                await takeControlUiViewportScreenshot(page, row, [row]),
              );
            }
          }
          expect(await card.textContent()).toContain("Could not load this image. Try again.");
          expect(await row.locator("img.chat-message-image").count()).toBe(0);
          await page.clock.fastForward(15_000);
          expect(metadataRequests).toBe(1);
          expect(imageRequests).toBe(1);
          retry = true;
          await card.getByRole("button", { name: "Retry", exact: true }).click();
          await expect.poll(() => metadataRequests).toBe(2);
          if (failure === "revoked" || failure === "removed") {
            await expect.poll(() => card.textContent()).toContain("Unavailable");
            await page.clock.fastForward(15_000);
            expect(imageRequests).toBe(1);
            expect(metadataRequests).toBe(2);
            expect(await row.locator("img.chat-message-image").count()).toBe(0);
          } else {
            const image = row.locator("img.chat-message-image");
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
      );
    },
  );
});
