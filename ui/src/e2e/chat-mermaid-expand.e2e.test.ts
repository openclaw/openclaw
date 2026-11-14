import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { textMessage } from "./chat-flow-fixtures.test-support.ts";
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
  it("opens the viewer by touch and from source view without losing clipboard controls", async () => {
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
          historyMessages: [textMessage("assistant", `${fence}mermaid\n${source}\n${fence}`)],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("sessions.messages.subscribe");
        const diagram = page.locator("openclaw-mermaid");
        const image = diagram.locator(".preview img");
        await image.waitFor({ timeout: 25_000 });
        await image.evaluate((element: HTMLImageElement) => element.decode());
        const src = await image.getAttribute("src");
        const viewer = page.locator("openclaw-image-lightbox");
        const closeViewer = async () => {
          await page.keyboard.press("Escape");
          await viewer.waitFor({ state: "detached" });
        };
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
        const preview = diagram.getByRole("button", { name: "Expand diagram", exact: true });
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
        await closeViewer();
        await options.click();
        await diagram.getByRole("menuitem", { name: "Show diagram", exact: true }).click();
        expect(await image.getAttribute("src")).toBe(src);
      },
    );
  });
});
