import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mermaid text alternatives" });
const title = "Message delivery — 送信 🦞";
const description =
  "The Gateway sends each accepted message to a Worker. The Worker saves the result in State before the reply is delivered.";
const source = `flowchart LR
  accTitle: ${title}
  accDescr {
    ${description}
  }
  Gateway --> Worker
  Worker --> State`;

const alternative = (image: Locator) =>
  image.evaluate((element) => ({
    title: element.getAttribute("alt"),
    description: document
      .getElementById(element.getAttribute("aria-describedby") ?? "")
      ?.textContent?.trim(),
  }));

suite.define(() => {
  it("exposes authored alternatives inline and expanded", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `Here is how a message reaches its destination.\n\n\`\`\`mermaid\n${source}\n\`\`\``,
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
        expect(await alternative(image)).toEqual({ title, description });
        expect(await diagram.locator(".description").isVisible()).toBe(false);
        const options = diagram.getByRole("button", { name: "Diagram options" });
        await options.focus();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        const expanded = page.locator("openclaw-image-lightbox img");
        await expanded.waitFor();
        await expanded.evaluate((element: HTMLImageElement) => element.decode());
        expect(await alternative(expanded)).toEqual({ title, description });
        await page.keyboard.press("Escape");
        await page.locator("openclaw-image-lightbox").waitFor({ state: "detached" });
        expect(await options.evaluate((element) => element === document.activeElement)).toBe(true);
      },
    );
  });
});
