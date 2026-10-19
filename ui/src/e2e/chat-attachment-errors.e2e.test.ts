import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile attachment errors" });

suite.define(() => {
  it.each(["chat", "new"])("keeps rejected files readable and removable in %s", async (route) => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        await page.clock.install();
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          attachmentMaxBytes: 1024,
          agentModel: "demo/model",
          models: [{ id: "model", name: "Demo", provider: "demo" }],
        });
        await page.goto(suite.server.baseUrl + route);
        const composer = page
          .locator(route === "new" ? ".new-session-page__composer" : ".agent-chat__input")
          .first();
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
        await page.clock.fastForward(7_000);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, composer, [composer], {
            animations: "disabled",
          });
          const screenshot = path.join(suite.artifactDir, `${route}-attachment-error.png`);
          await writeFile(screenshot, frame.png);
          console.log(JSON.stringify({ screenshot }));
        }
        const failure = page.locator(".chat-attachment-failures");
        expect(await failure.count()).toBe(1);
        expect(await failure.textContent()).toContain("Too large to send: holiday-photo.jpg");
        expect(await failure.textContent()).toContain("Choose a smaller file");
        expect(await page.locator(".chat-attachments-preview img").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        await page.getByRole("button", { name: "Remove holiday-photo.jpg", exact: true }).click();
        expect(await failure.count()).toBe(0);
      },
    );
  });
  it("downloads the original only on request when a preview is unavailable", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        const id = crypto.randomUUID();
        const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full`;
        const artifactId = `artifact_managed_image_${id}`;
        const bytes = await readFile(
          path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
        );
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
          historyMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "image",
                  artifactId,
                  url: source,
                  alt: "Holiday photo",
                  mimeType: "image/png",
                  width: 1600,
                  height: 1000,
                },
              ],
              timestamp: 1,
            },
          ],
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
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, card, [card], {
            animations: "disabled",
          });
          const screenshot = path.join(suite.artifactDir, "unavailable-preview.png");
          await writeFile(screenshot, frame.png);
          console.log(JSON.stringify({ screenshot }));
        }
        expect(await card.getByRole("button", { name: "Image actions" }).count()).toBe(1);
        await card.getByRole("button", { name: "Image actions" }).click();
        const download = page.waitForEvent("download");
        await card.getByRole("menuitem", { name: "Download image" }).click();
        expect((await download).suggestedFilename()).toBe("Holiday photo.png");
        expect(requests).toEqual(["thumbnail", "full"]);
      },
    );
  });
});
