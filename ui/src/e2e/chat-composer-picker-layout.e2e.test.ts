import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer picker layout" });

suite.define(() => {
  it("keeps model and effort targets separate when Files narrows the composer", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("composer-picker-targets", artifactRoot)
      : undefined;
    await suite.withPage({ viewport: { width: 701, height: 729 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", reasoning: true }],
        sessions: [
          createControlUiSessionRow("agent:main:main", "Main", 1, {
            contextTokens: 200_000,
            thinkingLevel: "medium",
            thinkingLevels: [
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
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

      for (const width of [701, 1280, 560, 393]) {
        if (width === 560) {
          await page.locator(".chat-side-panel-toggle").click();
          await page.locator(".chat-workspace-rail").waitFor({ state: "hidden" });
        }
        await page.setViewportSize({ width, height: 729 });
        await page.mouse.move(0, 0);
        if (artifactDir) {
          await writeFile(
            `${artifactDir}/composer-${width}.png`,
            await takeControlUiElementScreenshot(page, composer, []),
          );
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
                .map((node) => ({ node, rect: node.getBoundingClientRect() }))
                .filter(({ node, rect }) => node.checkVisibility() && rect.width > 0);
              return controls.flatMap(({ node, rect }, index) => {
                const label = node.getAttribute("aria-label") ?? node.className;
                const violations =
                  rect.left < bounds.left - 1 || rect.right > bounds.right + 1
                    ? [`${label} leaves the footer`]
                    : [];
                for (const other of controls.slice(index + 1)) {
                  if (
                    Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) >
                      1 &&
                    Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) >
                      1
                  ) {
                    violations.push(`${label} overlaps ${other.node.getAttribute("aria-label")}`);
                  }
                }
                return violations;
              });
            }),
          )
          .toEqual([]);
        for (const [triggerSelector, menuSelector, otherMenuSelector] of [
          [
            '[data-chat-model-select="true"]',
            ".chat-controls__model-menu",
            ".chat-controls__effort-menu",
          ],
          [
            '[data-chat-thinking-select="true"]',
            ".chat-controls__effort-menu",
            ".chat-controls__model-menu",
          ],
        ] as const) {
          const trigger = composer.locator(triggerSelector);
          await expect
            .poll(() =>
              trigger.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                return node.contains(
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                );
              }),
            )
            .toBe(true);
          const box = await trigger.boundingBox();
          if (!box) {
            throw new Error(`Missing picker target at viewport ${width}`);
          }
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
