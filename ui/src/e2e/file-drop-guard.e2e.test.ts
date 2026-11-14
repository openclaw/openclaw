import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI file-drop guard",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}`,
});

function dropFile(target: Locator, name: string) {
  return target.evaluate((element, fileName) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([fileName], fileName, { type: "text/plain" }));
    const beforeUrl = location.href;
    const draft = () =>
      document.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea")?.value;
    const beforeDraft = draft();
    const event = (type: string) =>
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
    const dragOver = event("dragover");
    const drop = event("drop");
    element.dispatchEvent(dragOver);
    element.dispatchEvent(drop);
    return {
      draftUnchanged: draft() === beforeDraft,
      dragOverPrevented: dragOver.defaultPrevented,
      dropEffect: transfer.dropEffect,
      dropPrevented: drop.defaultPrevented,
      urlUnchanged: location.href === beforeUrl,
    };
  }, name);
}

suite.define(() => {
  it("rejects a stray file drop while preserving attachment inputs", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const attachment = (name: string) =>
        page.locator(".chat-attachment-file__name", { hasText: name });
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await composer.fill("draft survives stray drop");

      const stray = await dropFile(page.locator("openclaw-app-shell"), "stray-proof.txt");

      expect(stray).toEqual({
        draftUnchanged: true,
        dragOverPrevented: true,
        dropEffect: "none",
        dropPrevented: true,
        urlUnchanged: true,
      });

      const accepted = await dropFile(page.locator("section.chat"), "accepted-drop.txt");

      expect(accepted).toMatchObject({
        dragOverPrevented: true,
        dropPrevented: true,
      });
      await attachment("accepted-drop.txt").first().waitFor({ timeout: 10_000 });
      await expect.poll(() => attachment("stray-proof.txt").count()).toBe(0);

      const nativeInput = page.locator(".agent-chat__file-input");
      expect(await nativeInput.isEnabled()).toBe(true);
      await nativeInput.setInputFiles({
        name: "native-input.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("native input"),
      });
      await attachment("native-input.txt").first().waitFor({ timeout: 10_000 });
    });
  });
});
