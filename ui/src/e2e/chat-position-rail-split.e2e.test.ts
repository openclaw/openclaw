import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Split rail Escape ownership" });
suite.define(() => {
  it.each([0, 1])(
    "returns Escape to the focused pane when pane %i owns an older hover",
    async (hoverPane) => {
      // Each transcript must exceed the CSS 960px rail threshold after sidebar/split chrome.
      await suite.withPage({ viewport: { width: 2560, height: 1000 } }, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const keys = ["agent:main:main", "agent:main:notes"];
        await page.addInitScript(
          ({ key, keys: sessionKeys }) =>
            localStorage.setItem(
              key,
              JSON.stringify({
                chatSplitLayout: {
                  activePaneId: "p1",
                  columnWeights: [0.5, 0.5],
                  columns: sessionKeys.map((sessionKey, i) => ({
                    id: `c${i + 1}`,
                    paneWeights: [1],
                    panes: [{ id: `p${i + 1}`, sessionKey }],
                  })),
                },
              }),
            ),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), keys },
        );
        const gateway = await installMockGateway(page, {
          sessionKey: keys[0],
          sessions: keys.map((key) => ({ key, kind: "direct", updatedAt: 1 })),
          historyMessages: Array.from({ length: 30 }, (_, index) => ({
            __openclaw: { id: `split-rail-${index}`, seq: index + 1 },
            role: index % 2 ? "assistant" : "user",
            content: `Visible split checkpoint ${index}`,
            timestamp: 1000 + index,
          })),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const a = page
          .locator("openclaw-chat-pane")
          .filter({ has: page.locator('[data-position-marker-id="split-rail-0"]') })
          .nth(hoverPane);
        const b = page
          .locator("openclaw-chat-pane")
          .filter({ has: page.locator('[data-position-marker-id="split-rail-0"]') })
          .nth(1 - hoverPane);
        const railA = a.locator(".chat-position-rail");
        const railB = b.locator(".chat-position-rail");
        await railA.locator(".chat-position-rail__marker").last().waitFor({ state: "visible" });
        await railB.locator(".chat-position-rail__marker").last().waitFor({ state: "visible" });
        const threadB = b.locator(".chat-thread");
        const previewA = railA.locator(".chat-position-rail__preview");
        const previewB = railB.locator(".chat-position-rail__preview");
        // Park the real pointer on A, then enter B with the established transcript→Tab path.
        await railA.locator(".chat-position-rail__marker").last().hover();
        await previewA.waitFor({ state: "visible" });
        await threadB.focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => railB.evaluate((el) => el.contains(document.activeElement)))
          .toBe(true);
        await previewB.waitFor({ state: "visible" });
        await expect.poll(() => previewA.isVisible()).toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, `pane-${hoverPane}-before-escape.png`),
        });
        await page.keyboard.press("Escape");
        await page.screenshot({
          path: path.join(suite.artifactDir, `pane-${hoverPane}-after-escape.png`),
        });
        await expect.poll(() => threadB.evaluate((el) => el === document.activeElement)).toBe(true);
        await expect.poll(() => previewB.count()).toBe(0);
        await expect.poll(() => previewA.isVisible()).toBe(true);
        // With no focused marker, Escape still dismisses the remaining hover without moving focus.
        await page.keyboard.press("Escape");
        await expect.poll(() => previewA.count()).toBe(0);
        expect(await threadB.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(
          (await gateway.getRequests()).filter(({ method }) => method === "chat.send"),
        ).toEqual([]);
        expect(errors).toEqual([]);
      });
    },
  );
});
