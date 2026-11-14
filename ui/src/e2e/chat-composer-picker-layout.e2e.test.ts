import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiE2eWaitTimeoutMs, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { thinkingLevels } from "./chat-flow.test-support.ts";
import { layoutBox } from "./chat-presentation.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let webkitBrowser: Browser;
const suite = createControlUiE2eSuite({
  name: "Control UI composer picker layout",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch({ headless: true });
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});

suite.define(() => {
  it("centers the composer plus and close icons on mobile and desktop", async () => {
    const offsets: number[] = [];
    for (const width of [393, 1280]) {
      await suite.withPage({ viewport: { width, height: 852 } }, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await installMockGateway(page);
        for (const route of ["new?agent=main", "chat"]) {
          await page.goto(suite.server.baseUrl + route);
          const composer = page.locator(".agent-chat__input");
          const trigger = composer.locator(".agent-chat__input-btn--attach");
          await trigger.waitFor();
          for (const open of [false, true]) {
            if (open) {
              await trigger.click();
              await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
              await page.locator(".agent-chat__capability-menu-panel").waitFor();
            }
            const offset = await trigger.evaluate((button) => {
              const target = button.getBoundingClientRect();
              const icon = button.querySelector("svg")!.getBoundingClientRect();
              return Math.max(
                Math.abs(icon.x + icon.width / 2 - target.x - target.width / 2),
                Math.abs(icon.y + icon.height / 2 - target.y - target.height / 2),
              );
            });
            offsets.push(offset);
            if (open) {
              await page.keyboard.press("Escape");
              await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
            }
          }
        }
      });
    }
    expect(Math.max(...offsets), JSON.stringify(offsets)).toBeLessThanOrEqual(0.5);
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
        await search.fill("Model 23");
        await page.locator('[data-chat-model-option="example/model-23"]').click();
        expect(await trigger.textContent()).toContain("Model 23");
        expect(await search.isVisible()).toBe(false);
      },
    );
  });

  it.each(["chromium", "webkit"] as const)(
    "keeps model and effort targets separate when Files narrows the composer in %s",
    async (engine) => {
      const options = { viewport: { width: 1100, height: 729 }, serviceWorkers: "block" as const };
      const context =
        engine === "chromium"
          ? await suite.newBrowserContext(options)
          : await webkitBrowser.newContext(options);
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      try {
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
        const composer = page.locator(".agent-chat__input");
        const workspace = page.locator('[data-panel-slot="workspace"]');
        const prepareComposer = async () => {
          await page.setViewportSize({ width: 1100, height: 729 });
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("sessions.messages.subscribe");
          await composer.locator('[data-chat-thinking-select="true"]').waitFor();
          await openChatSidePanelType(page, "Files");
          await workspace.waitFor({ state: "visible" });
          await expect
            .poll(() => composer.evaluate((node) => node.getBoundingClientRect().width))
            .toBeLessThan(360);
        };
        await prepareComposer();

        // Files keeps the first two composers narrow; 600 uses the phone touch targets.
        for (const width of [1100, 1280, 560, 600, 900, 393, 320]) {
          if (width === 560) {
            await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
            await workspace.waitFor({ state: "hidden" });
          }
          await page.setViewportSize({ width, height: 729 });
          await composer.locator("textarea").click();
          await page.mouse.move(0, 0);
          // The permission label is whole beside its icon or absent, never clipped.
          await expect
            .poll(() => composer.locator(".chat-controls__permission-label").isVisible())
            .toBe(width === 600 || width === 900);
          if (width === 600 || width === 900) {
            const chips = await composer.evaluate((node) => {
              const read = (selector: string) => {
                const trigger = node.querySelector(selector)!;
                const label = trigger.querySelector(".chat-controls__inline-select-label")!;
                const chip = getComputedStyle(trigger);
                const text = getComputedStyle(label);
                const box = label.getBoundingClientRect();
                return {
                  style: [
                    chip.paddingLeft,
                    chip.paddingRight,
                    chip.columnGap,
                    text.fontSize,
                    text.fontWeight,
                    text.lineHeight,
                    text.letterSpacing,
                  ],
                  center: box.y + box.height / 2,
                  clipped: label.scrollWidth > label.clientWidth,
                };
              };
              return {
                permission: read("[data-chat-permission-select]"),
                model: read("[data-chat-model-select]"),
              };
            });
            expect(chips.permission.style).toEqual(chips.model.style);
            expect(Math.abs(chips.permission.center - chips.model.center)).toBeLessThanOrEqual(0.5);
            expect(chips.permission.clipped).toBe(false);
          }
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
            const modelBox = node
              .querySelector("[data-chat-model-select]")!
              .getBoundingClientRect();
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
          // Reuse the document through 50 Escape and 50 pointer closes at the
          // mobile breakpoint. Reloading between presses hid WebKit close hangs.
          const delays =
            width === 560
              ? Array.from({ length: 50 }, (_, i) => [100, 0, 16, 32, 64][i % 5]!)
              : [0];
          for (const [cycle, delay] of delays.entries()) {
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
              await layoutBox(trigger);
              await trigger.click({ delay });
              await expect.poll(() => composer.locator(menuSelector).isVisible()).toBe(true);
              expect(await composer.locator(otherMenuSelector).isVisible()).toBe(false);
              if (cycle % 2 === 0) {
                await page.keyboard.press("Escape");
              } else {
                await trigger.click();
              }
              await expect.poll(() => composer.locator(menuSelector).isVisible()).toBe(false);
            }
          }
        }
      } finally {
        await (engine === "chromium" ? suite.closeBrowserContext(context) : context.close());
      }
    },
  );
});
