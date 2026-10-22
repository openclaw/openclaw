import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mermaid text alternatives" });
const title = "Message delivery — 送信 🦞";
const description =
  "The Gateway sends each accepted message to a Worker. The Worker saves the result in State before the reply is delivered.";
const source = [
  "flowchart LR",
  "  accTitle: " + title,
  "  accDescr {",
  "    " + description,
  "  }",
  "  Gateway --> Worker",
  "  Worker --> State",
].join("\n");

suite.define(() => {
  it.each([
    { mode: "light" as const, width: 1440, height: 900 },
    { mode: "dark" as const, width: 390, height: 844 },
  ])(
    "exposes authored alternatives inline and expanded in $mode",
    async ({ mode, width, height }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width, height },
          colorScheme: mode,
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text:
                      "Here is how a message reaches its destination.\n\n```mermaid\n" +
                      source +
                      "\n```",
                  },
                ],
              },
            ],
          });
          await page.goto(suite.server.baseUrl + "chat");
          await gateway.waitForRequest("chat.startup");
          const diagram = page.locator("openclaw-mermaid");
          const image = diagram.locator(".preview img");
          await image.waitFor();
          await image.evaluate((element: HTMLImageElement) => element.decode());
          const preview = diagram.getByRole("button", {
            name: "Expand diagram: " + title,
            exact: true,
          });
          expect(await preview.getAttribute("aria-describedby")).toBe(
            await image.getAttribute("aria-describedby"),
          );
          const inline = await image.evaluate((element) => ({
            title: element.getAttribute("alt"),
            description: document
              .getElementById(element.getAttribute("aria-describedby") ?? "")
              ?.textContent?.trim(),
          }));
          expect(await diagram.locator(".description").isVisible()).toBe(false);
          const frame = await takeControlUiScreenshotFrame(page, diagram, [image], {
            animations: "disabled",
            elements: [diagram],
          });
          writeFileSync(path.join(suite.artifactDir, mode + "-inline.png"), frame.png);
          const options = diagram.getByRole("button", { name: "Diagram options" });
          await options.focus();
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("End");
          await page.keyboard.press("Enter");
          const expanded = page.locator("openclaw-image-lightbox img");
          await expanded.waitFor();
          await expanded.evaluate((element: HTMLImageElement) => element.decode());
          const expandedAlternative = await expanded.evaluate((element) => ({
            title: element.getAttribute("alt"),
            description: document
              .getElementById(element.getAttribute("aria-describedby") ?? "")
              ?.textContent?.trim(),
          }));
          const expandedFrame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-image-lightbox .lightbox"),
            [expanded],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, mode + "-expanded.png"), expandedFrame.png);
          await page.keyboard.press("Escape");
          await page.locator("openclaw-image-lightbox").waitFor({ state: "detached" });
          expect(await options.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          expect(inline).toEqual({ title, description });
          expect(expandedAlternative).toEqual({ title, description });
        },
      );
    },
  );
});
