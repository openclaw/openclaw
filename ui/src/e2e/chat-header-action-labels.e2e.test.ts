import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Chat header group identification",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("shows the full current group and respects enlarged text through group search and dismissal", () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
      async ({ page }) => {
        const key = "agent:main:main",
          category = "Regional accessibility and interpretation services — production rollout";
        await installMockGateway(
          page,
          {
            sessionKey: key,
            methodResponses: {
              "sessions.list": chatSessionListResponse([
                {
                  key,
                  kind: "direct",
                  isMain: true,
                  label: "Molty",
                  category,
                  updatedAt: Date.now(),
                },
              ]),
            },
          },
          {
            afterInitScript:
              ";localStorage.setItem(" +
              JSON.stringify(controlUiBundledSettingsStorageKey(suite.server.baseUrl)) +
              "," +
              JSON.stringify(JSON.stringify({ textScale: 140 })) +
              ");",
          },
        );
        await page.goto(suite.server.baseUrl + "chat/main");
        const trigger = page.locator(".chat-header-session-menu__trigger:visible");
        await trigger.tap();
        const move = page.getByRole("menuitem", { name: /Move to group/ });
        const subtitle = move.locator("small");
        await subtitle.waitFor();
        expect(await subtitle.textContent()).toBe(category);
        const label = await subtitle.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const box = el.getBoundingClientRect();
          return {
            font: parseFloat(getComputedStyle(el).fontSize),
            left: box.left,
            right: box.right,
            lines: Array.from(range.getClientRects(), (r) => [r.left, r.right]),
          };
        });
        expect(label.lines.length).toBeGreaterThan(1);
        for (const [left, right] of label.lines) {
          expect(left).toBeGreaterThanOrEqual(label.left - 1);
          expect(right).toBeLessThanOrEqual(label.right + 1);
        }
        expect(label.font).toBeCloseTo(16.8, 1);
        await move.tap();
        const host = page.locator(".chat-mobile-host:visible");
        await host.getByRole("button", { name: "Search groups", exact: true }).tap();
        await host.getByRole("searchbox").fill("rollout");
        const match = host.getByRole("button", { name: category, exact: true });
        await match.waitFor();
        expect(await match.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(
          19.6,
          1,
        );
        await host.getByRole("button", { name: "Close", exact: true }).tap();
        await expect.poll(() => trigger.evaluate((el) => el === document.activeElement)).toBe(true);
      },
    ));
});
