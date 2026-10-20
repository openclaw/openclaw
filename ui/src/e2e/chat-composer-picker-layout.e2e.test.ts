import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { thinkingLevels } from "./chat-flow.test-support.ts";
import { layoutBox } from "./chat-presentation.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer picker layout" });

suite.define(() => {
  it("fits a tall model catalog above the mobile new-session composer", async () => {
    await suite.withPage(
      { viewport: { width: 393, height: 500 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await installMockGateway(page, {
          models: Array.from({ length: 24 }, (_, index) => ({
            id: "model-" + index,
            name: "Example Model " + index,
            provider: "example",
          })),
        });
        await page.goto(suite.server.baseUrl + "new?agent=main");
        const trigger = page.locator("[data-chat-model-select]");
        await trigger.click();
        const search = page.locator("[data-chat-model-search]");
        await search.waitFor();
        await page.locator("[data-chat-model-provider-toggle]").first().click();
        const composer = await page.locator(".agent-chat__input").boundingBox();
        const panel = await page.locator(".chat-picker-overlay:popover-open").boundingBox();
        expect(panel!.y).toBeGreaterThanOrEqual(0);
        expect(panel!.y + panel!.height).toBeLessThan(composer!.y);
        expect(panel!.height).toBeGreaterThan(200);
        // Filtering and selection remain reachable without dismissing the picker.
        await search.fill("Model 23");
        await page.locator('[data-chat-model-option="example/model-23"]').click();
        expect(await trigger.textContent()).toContain("Model 23");
        expect(await search.isVisible()).toBe(false);
      },
    );
  });

  it("keeps model and effort targets separate when Files narrows the composer", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 729 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", reasoning: true }],
        sessions: [
          createControlUiSessionRow("agent:main:main", "Main", 1, {
            contextTokens: 200_000,
            thinkingLevel: "medium",
            thinkingLevels: thinkingLevels("low", "medium", "high"),
            totalTokens: 21_000,
            totalTokensFresh: true,
          }),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__input");
      await composer.locator('[data-chat-thinking-select="true"]').waitFor();
      await openChatSidePanelType(page, "Files");
      await page.locator(".chat-workspace-rail").waitFor();
      await expect
        .poll(() => composer.evaluate((node) => node.getBoundingClientRect().width))
        .toBeLessThan(360);

      for (const width of [1100, 1280, 560, 393, 320]) {
        if (width === 560) {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
          await page.locator(".chat-workspace-rail").waitFor({ state: "hidden" });
        }
        await page.setViewportSize({ width, height: 729 });
        await page.mouse.move(0, 0);
        await expect
          .poll(() =>
            composer.locator(".agent-chat__composer-footer").evaluate((footer) => {
              const bounds = footer.getBoundingClientRect();
              const controls = [
                ...footer.querySelectorAll<HTMLElement>(
                  ".agent-chat__input-btn--attach, [data-chat-permission-select], .context-ring, " +
                    "[data-chat-model-select], [data-chat-thinking-select], .chat-send-btn",
                ),
              ]
                .filter((node) => node.checkVisibility())
                .map((node) => node.getBoundingClientRect())
                .filter((rect) => rect.width > 0);
              const overlaps = (a: DOMRect, b: DOMRect) =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
              return {
                inside: controls.every(
                  (rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
                ),
                separate: !controls.some((a, index) =>
                  controls.slice(index + 1).some((b) => overlaps(a, b)),
                ),
              };
            }),
          )
          .toEqual({ inside: true, separate: true });
        const layout = await composer.evaluate((node) => {
          const ring = node.querySelector<HTMLElement>(".context-ring")!;
          const ringBox = ring.getBoundingClientRect();
          const modelBox = node.querySelector("[data-chat-model-select]")!.getBoundingClientRect();
          return {
            label: ring.textContent?.trim(),
            accessibleName: ring.getAttribute("aria-label"),
            gap: modelBox.left - ringBox.right,
            centerOffset: Math.abs(
              ringBox.y + ringBox.height / 2 - (modelBox.y + modelBox.height / 2),
            ),
          };
        });
        expect(layout).toMatchObject({
          label: "",
          accessibleName: "Session context usage: 21k of 200k (11%)",
        });
        expect(layout.gap).toBeGreaterThanOrEqual(0);
        expect(layout.gap).toBeLessThanOrEqual(8);
        expect(layout.centerOffset).toBeLessThanOrEqual(1);
        for (const [triggerSelector, menuSelector, otherMenuSelector] of [
          ["model", ".chat-controls__model-menu", ".chat-controls__effort-menu"],
          ["thinking", ".chat-controls__effort-menu", ".chat-controls__model-menu"],
        ] as const) {
          const trigger = composer.locator(`[data-chat-${triggerSelector}-select="true"]`);
          await expect
            .poll(() =>
              trigger.evaluate((node) => {
                const { x, y, width: w, height: h } = node.getBoundingClientRect();
                return node.contains(document.elementFromPoint(x + w / 2, y + h / 2));
              }),
            )
            .toBe(true);
          const box = await layoutBox(trigger);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await expect.poll(() => composer.locator(menuSelector).isVisible()).toBe(true);
          expect(await composer.locator(otherMenuSelector).isVisible()).toBe(false);
          await page.keyboard.press("Escape");
          await expect.poll(() => composer.locator(menuSelector).isVisible()).toBe(false);
        }
      }
    });
  });
});
