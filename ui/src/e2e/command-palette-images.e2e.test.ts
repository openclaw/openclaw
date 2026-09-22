import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  expectForegroundUnchanged,
  openFromForeground,
  scenario,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette pasted images" });

async function pasteImages(input: Locator, count = 1) {
  return input.evaluate((element, fileCount) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const content = canvas.toDataURL("image/png").split(",")[1]!;
    const clipboard = new DataTransfer();
    const attachments = Array.from({ length: fileCount }, (_, index) => {
      const fileName = "image-" + index + ".png";
      const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
      clipboard.items.add(new File([bytes], fileName, { type: "image/png" }));
      return { type: "image", mimeType: "image/png", fileName, content };
    });
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
    return attachments;
  }, count);
}

function anchors(palette: Locator) {
  return palette.evaluate((element) =>
    [
      ".cmd-palette",
      ".cmd-palette__input",
      ".cmd-palette__create",
      'button[aria-label="New session settings"]',
    ].map((selector) => {
      const node = element.querySelector(selector);
      if (!node) {
        throw new Error("Missing anchor: " + selector);
      }
      const { x, y } = node.getBoundingClientRect();
      return { selector, x, y };
    }),
  );
}

suite.define(() => {
  it.each([1280, 390])(
    "keeps the input and actions anchored through paste and removal at %s px",
    async (width) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          await installMockGateway(page, scenario());
          const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
          await page.evaluate(() => document.fonts.ready);
          const images = palette.locator(".chat-attachment-thumb img");
          const start = palette.getByRole("button", {
            name: "Start new session in background",
            exact: true,
          });
          const remove = palette.getByRole("button", { name: /^Remove image-/ });
          for (const message of [
            "",
            "Compare these images",
            "First line\nSecond line\nThird line\nFourth line",
          ]) {
            await input.fill(message);
            await expect.poll(() => start.isEnabled()).toBe(Boolean(message));
            const initial = await anchors(palette);
            await pasteImages(input, 2);
            await expect.poll(() => images.count()).toBe(2);
            expect(await anchors(palette)).toEqual(initial);
            await pasteImages(input, 10);
            await expect.poll(() => images.count()).toBe(12);
            expect(await anchors(palette)).toEqual(initial);
            expect(
              await palette
                .locator(".chat-attachments-preview")
                .evaluate((element) => element.scrollWidth > element.clientWidth),
            ).toBe(true);
            await remove.first().click();
            await expect.poll(() => images.count()).toBe(11);
            expect(await anchors(palette)).toEqual(initial);
            for (let index = 0; index < 11; index += 1) {
              await remove.first().click();
            }
            await expect.poll(() => images.count()).toBe(0);
            expect(await start.isEnabled()).toBe(Boolean(message));
            expect(await anchors(palette)).toEqual(initial);
          }
        },
      );
    },
  );

  it("submits an image-only prompt once and retries the same images after creation fails", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        scenario({
          "sessions.create": {
            key: "agent:main:dashboard:palette-image-created",
            runStarted: true,
          },
        }),
      );
      const { palette, input, composer, url } = await openFromForeground(
        page,
        suite.server.baseUrl,
      );
      const attachments = await pasteImages(input, 2);
      const images = palette.locator(".chat-attachment-thumb img");
      const start = palette.getByRole("button", {
        name: "Start new session in background",
        exact: true,
      });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await gateway.deferNext("sessions.create");
      await input.press("ControlOrMeta+Enter");
      expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
        message: "",
        attachments,
      });
      expect(await input.isDisabled()).toBe(true);
      await page.keyboard.press("ControlOrMeta+Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      await gateway.rejectDeferred("sessions.create", {
        code: "INVALID_REQUEST",
        message: "Could not create session",
      });
      await expect
        .poll(() => palette.getByRole("alert").textContent())
        .toContain("Could not create session");
      expect(await images.count()).toBe(2);
      await input.press("Escape");
      await input.waitFor({ state: "hidden" });
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "visible" });
      expect(await images.count()).toBe(2);
      await expect.poll(() => start.isEnabled()).toBe(true);
      await input.press("ControlOrMeta+Enter");
      expect((await gateway.waitForRequest("sessions.create", { after: 1 })).params).toMatchObject({
        message: "",
        attachments,
      });
      await input.waitFor({ state: "hidden" });
      await expectForegroundUnchanged(page, composer, url);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });
});
