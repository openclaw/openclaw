import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { attachmentImage } from "./chat-attachment-menu.test-support.ts";
import { expectAttachmentErrorToast } from "./chat-attachment-toast.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment errors" });
const desktop = { width: 1280, height: 900 };
const mobileViewport = { width: 390, height: 844 };
const attachmentFile = (name: string, content: string | number) => ({
  name,
  mimeType: name.endsWith(".jpg") ? "image/jpeg" : "text/plain",
  buffer: typeof content === "number" ? Buffer.alloc(content) : Buffer.from(content),
});
async function expectToastPosition(toast: Locator, viewport: { width: number; height: number }) {
  const bounds = await toast.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width / 2).toBeCloseTo(viewport.width / 2, 0);
  expect(bounds!.y).toBeLessThan(viewport.height / 4);
}

suite.define(() => {
  it.each([
    ["chat", "desktop", desktop, "claw", "dark"],
    ["chat", "mobile", mobileViewport, "claw", "dark"],
    ["new", "mobile", mobileViewport, "claw", "dark"],
    ["chat", "desktop-light", desktop, "claw", "light"],
    ["chat", "mobile-beacon", mobileViewport, "beacon", "dark"],
  ] as const)(
    "rejects oversized files with a centered toast and preserves the %s composer on %s",
    (route, _device, viewport, theme, mode) =>
      suite.withPage(
        {
          viewport,
          isMobile: viewport.width === 390,
          hasTouch: viewport.width === 390,
          colorScheme: mode,
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            attachmentMaxBytes: 1024,
            methodResponses: { "config.get": themeConfigResponse(theme, mode) },
            agentModel: "demo/model",
            models: [{ id: "model", name: "Demo", provider: "demo" }],
            historyMessages: [{ role: "assistant", content: "Ready for attachments." }],
          });
          await page.goto(suite.server.baseUrl + route);
          await expect
            .poll(() => page.locator("html").getAttribute("data-theme"))
            .toBe(theme === "claw" ? mode : theme);
          if (route === "chat") {
            await page.getByText("Ready for attachments.", { exact: true }).waitFor();
          }
          const composer = page.locator(".agent-chat__composer-combobox textarea").first();
          const input = page.locator(".agent-chat__file-input").first();
          const oversized = attachmentFile("holiday-photo.jpg", 2048);
          await input.setInputFiles(oversized);
          const toast = page.locator(".app-toast");
          await toast.waitFor();
          await expectAttachmentErrorToast(toast, theme === "beacon" ? 7 : 4.5);
          expect(await toast.locator(".app-toast__message").textContent()).toBe(
            "File too large. Try a smaller file.",
          );
          await expectToastPosition(toast, viewport);
          expect(await toast.getAttribute("role")).toBe("status");
          expect(await toast.getAttribute("aria-live")).toBe("polite");
          expect(await composer.inputValue()).toBe("");
          expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
          expect(await page.locator(".chat-attachment-failures").count()).toBe(0);
          await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
          await toast.waitFor({ state: "detached" });

          await composer.fill("Keep my draft and valid attachments.");
          await input.setInputFiles(attachmentFile("kept.txt", "keep"));
          await page.getByRole("button", { name: "Remove kept.txt", exact: true }).waitFor();
          await input.setInputFiles([oversized, attachmentFile("next.txt", "next")]);
          await toast.waitFor();
          await page.getByRole("button", { name: "Remove next.txt", exact: true }).waitFor();
          await expect
            .poll(() => page.locator('.chat-attachment-thumb[aria-busy="false"]').count())
            .toBe(2);
          expect(await composer.inputValue()).toBe("Keep my draft and valid attachments.");
          expect(
            await page.getByRole("button", { name: "Remove kept.txt", exact: true }).count(),
          ).toBe(1);
          expect(
            await page
              .getByRole("button", { name: "Remove holiday-photo.jpg", exact: true })
              .count(),
          ).toBe(0);
          expect(await page.locator(".chat-attachment-failures").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          if (route === "chat") {
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const request = await gateway.waitForRequest("chat.send");
            expect(request.params).toMatchObject({
              message: "Keep my draft and valid attachments.",
              attachments: [{ fileName: "kept.txt" }, { fileName: "next.txt" }],
            });
          }
        },
      ),
  );
  it.each([
    { device: "desktop", viewport: desktop, mobile: false },
    { device: "mobile", viewport: mobileViewport, mobile: true },
  ])("reports a read failure only in a toast on $device", ({ viewport, mobile }) =>
    suite.withPage(
      { viewport, isMobile: mobile, hasTouch: mobile, colorScheme: "dark" },
      async ({ page }) => {
        await page.addInitScript(() => {
          const NativeFileReader = FileReader;
          window.FileReader = class extends NativeFileReader {
            override readAsDataURL(file: Blob) {
              if (file instanceof File && file.name === "unreadable.txt") {
                queueMicrotask(() => this.dispatchEvent(new ProgressEvent("error")));
              } else {
                super.readAsDataURL(file);
              }
            }
          };
        });
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: "Ready for attachments." }],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const send = page.getByRole("button", { name: "Send message", exact: true });
        const input = page.locator(".agent-chat__file-input");
        await composer.fill("Keep this draft after the read fails.");
        await input.setInputFiles(attachmentFile("unreadable.txt", "unreadable"));
        await expect.poll(() => send.isEnabled()).toBe(true);
        const toast = page.locator(".app-toast");
        await toast.getByText("Could not attach file. Try again.", { exact: true }).waitFor();
        await expectAttachmentErrorToast(toast);
        await expectToastPosition(toast, viewport);
        expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
        expect(await page.locator(".chat-attachment-failures").count()).toBe(0);
        expect(await composer.inputValue()).toBe("Keep this draft after the read fails.");
        await input.setInputFiles(attachmentFile("valid.txt", "valid"));
        await page.getByRole("button", { name: "Remove valid.txt", exact: true }).waitFor();
        await expect.poll(() => send.isEnabled()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
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
