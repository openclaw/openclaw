import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { exactButton } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI JSON tree and source views",
  unavailableMessage: (executable) => `Playwright Chromium is unavailable at ${executable}`,
});
const source = String.raw`{"id":9007199254740993,"status":"ready","status":"verified","escaped":"\u0061","overflow":1e400}`;

suite.define(() => {
  it("copies bare and fenced JSON losslessly through the native clipboard", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(suite.server.baseUrl).origin,
        });
        await installMockGateway(page, {
          historyMessages: (
            [
              ["user", "json-request", "Inspect this receipt."],
              ["assistant", "json-bare", source],
              ["user", "json-fence-request", "And the same JSON inside a code fence."],
              ["assistant", "json-fenced", "```json\n" + source + "\n```"],
            ] as const
          ).map(([role, id, content], index) => ({
            role,
            content,
            timestamp: (index + 1) * 1000,
            __openclaw: { id, seq: index + 1 },
          })),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        for (const id of ["json-bare", "json-fenced"]) {
          const message = page.locator(`[data-entry-id="${id}"]`);
          const tree = message.locator(".code-block-json-tree");
          await tree.waitFor({ state: "visible" });
          await exactButton(message, "Raw").click();
          expect(await tree.isVisible()).toBe(false);
          expect(await message.locator("pre code").textContent()).toBe(
            source + (id === "json-fenced" ? "\n" : ""),
          );
          await exactButton(message, "Copy code").click();
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
          await exactButton(message, "Tree").click();
          expect(await tree.isVisible()).toBe(true);
        }
      },
    );
  });
});
