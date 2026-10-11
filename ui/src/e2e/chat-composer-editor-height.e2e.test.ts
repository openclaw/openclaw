// Control UI E2E tests cover how tall the chat composer editor may grow.
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer editor height",
});

const longDraft = Array.from(
  { length: 60 },
  (_, index) => `Line ${index + 1} of a long prompt that needs room to read back.`,
).join("\n");

suite.define(() => {
  it.each([
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    { name: "mobile", viewport: { width: 393, height: 852 } },
    { name: "short mobile", viewport: { width: 393, height: 460 } },
  ])(
    "grows a long draft to about half the $name chat pane, then scrolls",
    async ({ name, viewport }) => {
      const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactRoot
        ? createControlUiE2eArtifactDir("chat-composer-editor-height", artifactRoot)
        : undefined;
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => textarea.isDisabled()).toBe(false);
        await textarea.fill(longDraft);

        const measure = () =>
          textarea.evaluate((element) => {
            const pane = element.closest(".chat-main__conversation") ?? document.documentElement;
            return {
              height: element.getBoundingClientRect().height,
              pane: pane.getBoundingClientRect().height,
              scrolls: element.scrollHeight > element.clientHeight,
            };
          });
        await expect.poll(async () => (await measure()).scrolls).toBe(true);
        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            path: `${artifactDir}/${name.replace(" ", "-")}.png`,
          });
        }
        const { height, pane } = await measure();
        expect(height).toBeGreaterThan(pane * 0.4);
        expect(height).toBeLessThanOrEqual(Math.min(pane, viewport.height) * 0.5 + 1);
      });
    },
  );
});
