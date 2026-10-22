import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mermaid inline expansion" });
const source = [
  "flowchart LR",
  "  A[Draft proposal] --> B[Team review]",
  "  B --> C{Ready?}",
  "  C -- Revise --> A",
  "  C -- Yes --> D[Ship small change]",
].join("\n");

suite.define(() => {
  it("opens the existing viewer by click, keyboard, touch and menu without losing source controls", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        viewport: { width: 1100, height: 780 },
        hasTouch: true,
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        const fence = String.fromCharCode(96).repeat(3);
        const gateway = await installMockGateway(page, {
          agentModel: "example/example-model",
          models: [{ id: "example-model", name: "Example model", provider: "example" }],
          historyMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text:
                    "Here is the proposed release workflow:\n\n" +
                    fence +
                    "mermaid\n" +
                    source +
                    "\n" +
                    fence,
                },
              ],
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("chat.startup");
        const diagram = page.locator("openclaw-mermaid");
        const image = diagram.locator(".preview img");
        await image.waitFor({ timeout: 25_000 });
        await image.evaluate((element: HTMLImageElement) => element.decode());
        const src = await image.getAttribute("src");
        const before = await takeControlUiScreenshotFrame(page, diagram, [image], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "inline.png"), before.png);

        const viewer = page.locator("openclaw-image-lightbox");
        const expectViewer = async () => {
          await viewer.getByRole("dialog").waitFor();
          expect(
            await viewer.evaluate(
              (element: HTMLElementTagNameMap["openclaw-image-lightbox"]) => element.src,
            ),
          ).toBe(src);
          expect(
            await viewer.getByRole("button", { name: "Zoom in", exact: true }).isVisible(),
          ).toBe(true);
        };
        await image.click();
        await expectViewer();
        const after = await takeControlUiScreenshotFrame(
          page,
          viewer.getByRole("dialog"),
          [viewer.getByRole("dialog")],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "expanded.png"), after.png);
        await page.keyboard.press("Escape");
        await viewer.waitFor({ state: "detached" });

        const preview = diagram.getByRole("button", { name: "Expand diagram", exact: true });
        expect(await preview.evaluate((element) => element.tagName)).toBe("BUTTON");
        expect(await preview.evaluate((element) => element === document.activeElement)).toBe(true);
        for (const key of ["Enter", "Space"]) {
          await preview.press(key);
          await expectViewer();
          await page.keyboard.press("Escape");
          await viewer.waitFor({ state: "detached" });
          expect(await preview.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
        }
        expect(
          await preview.evaluate((element) => {
            const style = getComputedStyle(element);
            return (
              element.matches(":focus-visible") &&
              style.outlineStyle !== "none" &&
              Number.parseFloat(style.outlineWidth) >= 2
            );
          }),
        ).toBe(true);
        const focus = await takeControlUiScreenshotFrame(page, diagram, [image], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "keyboard-focus.png"), focus.png);

        await preview.tap();
        await expectViewer();
        await viewer.getByRole("button", { name: "Close image preview", exact: true }).click();
        await viewer.waitFor({ state: "detached" });
        await diagram.hover();
        await diagram.getByRole("button", { name: "Copy source", exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source + "\n");
        expect(await viewer.count()).toBe(0);
        const options = diagram.getByRole("button", { name: "Diagram options", exact: true });
        await options.click();
        await diagram.getByRole("menuitem", { name: "Show source", exact: true }).click();
        expect(await diagram.locator("pre code").textContent()).toBe(source + "\n");
        expect(await diagram.locator(".preview").count()).toBe(0);
        await options.click();
        await diagram.getByRole("menuitem", { name: "Expand diagram", exact: true }).click();
        await expectViewer();
        await page.keyboard.press("Escape");
        await viewer.waitFor({ state: "detached" });
        await options.click();
        await diagram.getByRole("menuitem", { name: "Show diagram", exact: true }).click();
        expect(await image.getAttribute("src")).toBe(src);
      },
    );
  });
});
