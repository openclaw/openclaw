import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { ONE_PIXEL_PNG_B64 } from "./new-session-page.test-support.ts";

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
  it("highlights the new-session message surface, not its context tray, during an image drop", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 1056, height: 740 },
        colorScheme: "dark",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        const shell = page.locator(".new-session-page__composer");
        const input = shell.locator(":scope > .agent-chat__input");
        const message = shell.locator("textarea");
        await message.fill("Describe this image");
        const transfer = await page.evaluateHandle((base64) => {
          const data = new DataTransfer();
          data.items.add(
            new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], "pixel.png", {
              type: "image/png",
            }),
          );
          return data;
        }, ONE_PIXEL_PNG_B64);
        const drag = (target: Locator, type: string) =>
          target.dispatchEvent(type, { dataTransfer: transfer });
        const overlay = () =>
          input.evaluate((element) => {
            const style = getComputedStyle(element, "::after");
            return {
              content: style.content,
              opacity: Number(style.opacity),
              width: Number.parseFloat(style.width),
              height: Number.parseFloat(style.height),
              pointerEvents: style.pointerEvents,
            };
          });
        await drag(message, "dragenter");
        await drag(message, "dragover");
        await expect.poll(() => shell.getAttribute("data-attachment-drop-active")).toBe("");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const stage = process.env.OPENCLAW_PROOF_STAGE ?? "after";
          const surface = page.locator(".new-session-page");
          const target =
            stage === "before" ? shell.locator(".new-session-page__context-tray") : input;
          const frame = await takeControlUiScreenshotFrame(page, surface, [message], {
            elements: [target],
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, stage + "-clean.png"), frame.png);
          const annotated = await rasterizeProofAnnotations(suite.browser, {
            viewport: page.viewportSize()!,
            scale: await page.evaluate(() => devicePixelRatio),
            image: frame.png,
            annotations: [
              {
                kind: "outline",
                rect: frame.elements[0]!.bounds,
                text:
                  stage === "before"
                    ? "Highlight falls behind the message box"
                    : "Message box receives the drop highlight",
                labelAt: { x: 330, y: 510 },
                color: "#F5A66F",
              },
            ],
          });
          await writeFile(path.join(suite.artifactDir, stage + "-annotated.png"), annotated);
          console.log("Composer drop proof:", suite.artifactDir);
        }
        await expect
          .poll(overlay)
          .toMatchObject({ content: '""', opacity: 0.1, pointerEvents: "none" });
        const bounds = await input.boundingBox();
        expect((await overlay()).width).toBeCloseTo(bounds!.width - 2, 0);
        expect((await overlay()).height).toBeCloseTo(bounds!.height - 2, 0);
        expect(
          await shell.evaluate((element) => getComputedStyle(element, "::after").content),
        ).toBe("none");
        // Crossing nested controls must not clear the shared drag depth.
        await drag(input.locator(".agent-chat__composer-footer"), "dragenter");
        await drag(message, "dragleave");
        expect(await shell.getAttribute("data-attachment-drop-active")).toBe("");
        await drag(input.locator(".agent-chat__composer-footer"), "dragleave");
        await expect.poll(() => shell.getAttribute("data-attachment-drop-active")).toBeNull();
        // The whole shell remains a drop target, including the context tray.
        const tray = shell.locator(".new-session-page__context-tray");
        await drag(tray, "dragenter");
        await expect.poll(overlay).toMatchObject({ opacity: 0.1 });
        await drag(tray, "drop");
        await page.getByRole("img", { name: "pixel.png", exact: true }).waitFor();
        await expect.poll(() => shell.getAttribute("data-attachment-drop-active")).toBeNull();
        expect(await message.inputValue()).toBe("Describe this image");
        await transfer.dispose();
      },
    );
  });
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
