import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mermaid text alternatives" });
const title = "Message delivery — 送信 🦞";

suite.define(() => {
  it("names the preview action and shares the authored image description", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: `\`\`\`mermaid\nflowchart LR\naccTitle: ${title}\naccDescr {\n  Gateway delivers messages.\n}\nA --> B\n\`\`\``,
          },
        ],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const diagram = page.locator("openclaw-mermaid");
      const preview = diagram.getByRole("button", {
        name: `Expand diagram: ${title}`,
        exact: true,
      });
      await preview.waitFor();
      const descriptionId = await diagram.locator(".preview img").getAttribute("aria-describedby");
      expect(await diagram.locator(".description").textContent()).toBe(
        "Gateway delivers messages.",
      );
      expect(await preview.getAttribute("aria-describedby")).toBe(descriptionId);
    });
  });
});
