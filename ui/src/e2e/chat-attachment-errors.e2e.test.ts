import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { attachmentImage } from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment errors" });

suite.define(() => {
  it.each([
    { route: "chat", device: "desktop", viewport: { width: 1280, height: 900 }, mobile: false },
    { route: "chat", device: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
    { route: "new", device: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
  ])(
    "keeps rejected files readable and removable while $route is idle on $device",
    ({ route, device, viewport, mobile }) =>
      suite.withPage(
        { viewport, isMobile: mobile, hasTouch: mobile, colorScheme: "dark" },
        async ({ page }) => {
          await page.clock.install();
          const gateway = await installMockGateway(page, {
            attachmentMaxBytes: 1024,
            agentModel: "demo/model",
            models: [{ id: "model", name: "Demo", provider: "demo" }],
            historyMessages: [{ role: "assistant", content: "Ready for attachments." }],
          });
          await page.goto(suite.server.baseUrl + route);
          if (route === "chat") {
            await page.getByText("Ready for attachments.", { exact: true }).waitFor();
          }
          await pauseVirtualClock(page);
          const input = page.locator(".agent-chat__file-input").first();
          await input.setInputFiles({
            name: "holiday-photo.jpg",
            mimeType: "image/jpeg",
            buffer: Buffer.alloc(2048),
          });
          await page
            .locator(".app-toast__message")
            .getByText("Too large to send: holiday-photo.jpg", { exact: true })
            .waitFor();
          const failure = page.locator(".chat-attachment-failures");
          await expect.poll(() => failure.count()).toBe(1);
          await page.locator(".chat-attachment-thumb--error").waitFor();
          expect(
            await page.locator(".agent-chat__composer-combobox textarea").first().inputValue(),
          ).toBe("");
          expect(await failure.getAttribute("role")).toBe("alert");
          await page.clock.fastForward(7_000);
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `${device}-${route}-idle.png`),
            });
          }
          expect(await failure.textContent()).toContain("Too large to send: holiday-photo.jpg");
          expect(await failure.textContent()).toContain("Choose a smaller file");
          expect(await page.locator(".chat-attachments-preview img").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          await page.getByRole("button", { name: "Remove holiday-photo.jpg", exact: true }).click();
          await expect.poll(() => failure.count()).toBe(0);
          await expect.poll(() => page.locator(".chat-attachment-thumb--error").count()).toBe(0);
          await input.setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Small accepted attachment"),
          });
          await page.getByRole("button", { name: "Remove notes.txt", exact: true }).waitFor();
          await expect
            .poll(() => page.locator('.chat-attachment-thumb[aria-busy="false"]').count())
            .toBe(1);
          expect(await failure.count()).toBe(0);
          await page.getByRole("button", { name: "Remove notes.txt", exact: true }).click();
          await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
        },
      ),
  );
  it("downloads the original only on request when a preview is unavailable", () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        const id = crypto.randomUUID();
        const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full`;
        const artifactId = `artifact_managed_image_${id}`;
        const image = {
          type: "image",
          artifactId,
          url: source,
          alt: "Holiday photo",
          mimeType: "image/png",
          width: 1600,
          height: 1000,
        };
        const bytes = attachmentImage("original.png").buffer;
        const requests: string[] = [];
        await page.route("**/api/chat/media/outgoing/**", async (route) => {
          const variant = new URL(route.request().url()).pathname.split("/").at(-1)!;
          requests.push(variant);
          await route.fulfill(
            variant === "thumbnail"
              ? { status: 404, body: "Not Found" }
              : { body: bytes, contentType: "image/png" },
          );
        });
        await installMockGateway(page, {
          agentModel: "demo/model",
          models: [{ id: "model", name: "Demo", provider: "demo" }],
          historyMessages: [{ role: "assistant", content: [image], timestamp: 1 }],
          methodResponses: {
            "artifacts.download": {
              artifact: {
                id: artifactId,
                type: "image",
                title: "Holiday photo",
                mimeType: "image/png",
                download: { mode: "url" },
              },
              url: `${source}?mediaTicket=demo-ticket`,
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const card = page.locator(".chat-image-frame--compact");
        await card.waitFor({ state: "visible" });
        expect(requests).toEqual(["thumbnail"]);
        await card.getByRole("button", { name: "Image actions" }).click();
        const download = page.waitForEvent("download");
        await card.getByRole("menuitem", { name: "Download image" }).click();
        expect((await download).suggestedFilename()).toBe("Holiday photo.png");
        expect(requests).toEqual(["thumbnail", "full"]);
      },
    ));
});
