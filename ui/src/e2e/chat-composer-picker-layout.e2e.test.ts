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
  it("keeps Send and Stop equally sized and reachable across active-run draft states", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 729 } }, async ({ page }) => {
      const runId = "composer-layout-active-run";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        sessionInfo: { key: "agent:main:main", activeRunIds: [runId], hasActiveRun: true },
        inFlightRun: { runId, text: "Reviewing the composer layout." },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__input");
      for (const width of [1280, 1100, 393, 560, 320]) {
        await page.setViewportSize({ width, height: 729 });
        if (width === 1100) {
          await openChatSidePanelType(page, "Files");
          await page.locator('[data-panel-slot="workspace"]').waitFor();
          await expect
            .poll(() => composer.evaluate((node) => node.getBoundingClientRect().width))
            .toBeLessThan(360);
        }
        const measureAction = async (action: "stop" | "send") => {
          await composer.locator("textarea").fill(action === "send" ? "Review this follow-up" : "");
          const primary = composer.locator(`.chat-send-btn--${action}`);
          await expect.poll(() => primary.isVisible()).toBe(true);
          await expect.poll(() => primary.isEnabled()).toBe(true);
          const geometry = await primary.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const icon = node.querySelector("svg")!.getBoundingClientRect();
            const footer = node.closest(".agent-chat__composer-footer")!.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              iconWidth: icon.width,
              iconHeight: icon.height,
              centerY: rect.y + rect.height / 2,
              contained:
                rect.left >= footer.left - 1 &&
                rect.right <= footer.right + 1 &&
                rect.top >= footer.top - 1 &&
                rect.bottom <= footer.bottom + 1,
              reachable: node.contains(
                document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
              ),
            };
          });
          expect(geometry.contained, `${action} stays in the footer at ${width}px`).toBe(true);
          expect(geometry.reachable, `${action} hit target at ${width}px`).toBe(true);
          if (width !== 1280 && action === "stop") {
            expect(geometry.iconWidth, `compact Stop glyph at ${width}px`).toBeCloseTo(18, 2);
            expect(geometry.iconHeight, `compact Stop glyph at ${width}px`).toBeCloseTo(18, 2);
          }
          return geometry;
        };
        // The primary slot changes action with the draft. Compare its rendered
        // bounds across states; the smaller square stop glyph is intentional.
        const stop = await measureAction("stop");
        const send = await measureAction("send");
        expect(stop.width, `primary width at ${width}px`).toBeCloseTo(send.width, 2);
        expect(stop.height, `primary height at ${width}px`).toBeCloseTo(send.height, 2);
        expect(stop.width, `square primary control at ${width}px`).toBeCloseTo(stop.height, 2);
        expect(
          Math.abs(stop.centerY - send.centerY),
          `primary center at ${width}px`,
        ).toBeLessThanOrEqual(1);
        if (width === 1100) {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
          await page.locator('[data-panel-slot="workspace"]').waitFor({ state: "hidden" });
        }
      }
    });
  });

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
      const workspace = page.locator('[data-panel-slot="workspace"]');
      await workspace.waitFor({ state: "visible" });
      await expect
        .poll(() => composer.evaluate((node) => node.getBoundingClientRect().width))
        .toBeLessThan(360);

      for (const width of [1100, 1280, 560, 393, 320]) {
        if (width === 560) {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
          await workspace.waitFor({ state: "hidden" });
        }
        await page.setViewportSize({ width, height: 729 });
        await composer.locator("textarea").click();
        await page.mouse.move(0, 0);
        await expect
          .poll(() =>
            composer.locator(".agent-chat__composer-footer").evaluate((footer, viewportWidth) => {
              const bounds = footer.getBoundingClientRect();
              const buttons = [
                ...footer.querySelectorAll<HTMLElement>(
                  ".agent-chat__input-btn--attach, [data-chat-permission-select], .context-ring, " +
                    "[data-chat-model-select], [data-chat-thinking-select], .chat-send-btn",
                ),
              ].filter((node) => node.checkVisibility());
              const controls = buttons
                .map((node) => node.getBoundingClientRect())
                .filter((rect) => rect.width > 0);
              const overlaps = (a: DOMRect, b: DOMRect) =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
              return {
                uniformSizes:
                  viewportWidth > 560 ||
                  buttons.every((node) => {
                    if (node.matches("[data-chat-model-select], [data-chat-thinking-select]")) {
                      return true;
                    }
                    const rect = node.getBoundingClientRect();
                    const icon = node.querySelector("svg")?.getBoundingClientRect();
                    return (
                      Math.abs(rect.width - 36) <= 1 &&
                      Math.abs(rect.height - 36) <= 1 &&
                      icon !== undefined &&
                      Math.abs(icon.width - 20) <= 1 &&
                      Math.abs(icon.height - 20) <= 1
                    );
                  }),
                inside: controls.every(
                  (rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
                ),
                separate: !controls.some((a, index) =>
                  controls.slice(index + 1).some((b) => overlaps(a, b)),
                ),
              };
            }, width),
          )
          .toEqual({ inside: true, separate: true, uniformSizes: true });
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
