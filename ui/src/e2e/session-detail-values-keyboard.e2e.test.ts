import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

// Long enough that the stat column clips it, which is the case the fix covers.
const longKey = "agent:main:dashboard:3f2a91c47e8b4d05a6f1c2e3b4d5f607";
const longModel = "anthropic/claude-sonnet-4-5-20250929-with-a-long-id";

suite.define(() => {
  it("reaches the clipped session detail values by keyboard", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: longKey,
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions: [
              {
                key: longKey,
                kind: "direct",
                label: "Clipped values",
                updatedAt: 6,
                model: longModel,
                modelProvider: "anthropic-enterprise-gateway-eu-west-1",
              },
            ],
            ts: 10,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}sessions`);

      const toggle = page.locator(".session-details-toggle").first();
      await toggle.click();
      await expectBrowser(toggle).toHaveAttribute("aria-expanded", "true");

      const values = page.locator(".session-detail-stat__value");
      await expectBrowser(values.first()).toBeVisible();

      // The key column really does clip, so the tooltip is the only full value.
      const keyStat = values.filter({ hasText: longKey }).first();
      const clipped = await keyStat.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      );
      expect(clipped).toBe(true);

      const state = await keyStat.evaluate((element) => ({
        tabIndex: (element as HTMLElement).tabIndex,
        label: element.getAttribute("aria-label"),
      }));
      expect(state.tabIndex).toBe(0);
      expect(state.label).toBe(`Key: ${longKey}`);

      await captureUiProof(suite, page, "session-detail-values", "clipped-values.png");

      // Walk the real tab order from the expand toggle rather than focusing the
      // value directly: the defect is that it never joins that order.
      const trace: string[] = [];
      await toggle.focus();
      let reachedValue = false;
      for (let press = 0; press < 120; press += 1) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element) {
            return null;
          }
          const label = element.getAttribute("aria-label") ?? "";
          return {
            tag: element.tagName,
            className: element.className.slice(0, 40),
            label: (label || element.textContent || "").trim().slice(0, 40),
            isValue: element.classList.contains("session-detail-stat__value"),
          };
        });
        if (!focused) {
          break;
        }
        trace.push(`${focused.tag}.${focused.className}:${focused.label}`);
        if (focused.isValue) {
          reachedValue = true;
          break;
        }
      }
      expect(reachedValue, `tab trace: ${trace.slice(-8).join(" | ")}`).toBe(true);

      await captureUiProof(suite, page, "session-detail-values", "keyboard-focus.png");
    });
  });
});
