import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { polledAttribute } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI fenced code blocks",
});
const desktop = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
} satisfies BrowserContextOptions;
const shortFence = `\`\`\`json
{
  "status": "${"ready-for-staging-".repeat(4)}",
  "items": [
    "alpha"
  ]
}
\`\`\``;

const wideFence = `\`\`\`bash
openclaw gateway start ${"--flag value ".repeat(40)}
\`\`\``;

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.style.colorScheme = nextMode;
  }, mode);
}

suite.define(() => {
  it.each([
    { key: "Enter", theme: "dark", width: 1440, overflow: true },
    { key: "Space", theme: "light", width: 390, overflow: false },
  ] as const)(
    "keeps native keyboard reading, focus and copying after $key at $width px",
    async ({ key, theme, width, overflow }) => {
      await suite.withPage(
        {
          ...desktop,
          colorScheme: theme,
          viewport: { width, height: 900 },
          permissions: ["clipboard-read", "clipboard-write"],
        },
        async ({ page }) => {
          const source = Array.from({ length: 12 }, (_, index) =>
            overflow
              ? `const deploymentCheck${index} = "${"staging deployment verification ".repeat(6)}";`
              : `const check${index + 1} = true;`,
          ).join("\n");
          await installMockGateway(page, {
            agentModel: "openai/gpt-4o",
            models: [{ id: "gpt-4o", name: "gpt-4o", provider: "openai" }],
            historyMessages: [
              { role: "assistant", content: "```ts\n" + source + "\n```", timestamp: 2000 },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await setThemeMode(page, theme);
          const block = page.locator(".chat-thread .code-block-wrapper");
          const viewport = block.locator(".code-block-viewport");
          const copy = block.getByRole("button", { name: "Copy code", exact: true });
          await copy.focus();
          let before = 0;
          if (overflow) {
            // The overflowing reading surface is a native tab stop before disclosure.
            await page.keyboard.press("Tab");
            expect(await viewport.evaluate((element) => element === document.activeElement)).toBe(
              true,
            );
            const scrolled = viewport.evaluate(
              (element) =>
                new Promise<void>((resolve) => {
                  element.addEventListener("scrollend", () => resolve(), { once: true });
                }),
            );
            await page.keyboard.press("ArrowRight");
            await scrolled;
            before = await viewport.evaluate((element) => element.scrollLeft);
            expect(before).toBeGreaterThan(0);
            await page.keyboard.press("Tab");
          } else {
            await page.keyboard.press("Tab");
          }
          const expand = block.locator(".code-block-expand");
          expect(await expand.evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await expand.getAttribute("aria-controls")).toBe(
            await viewport.getAttribute("id"),
          );
          expect(await expand.getAttribute("aria-expanded")).toBe("false");
          await page.keyboard.press(key);
          await expand.waitFor({ state: "hidden" });
          expect(await expand.getAttribute("aria-expanded")).toBe("true");
          expect(await viewport.locator("code").textContent()).toBe(`${source}\n`);
          expect(await viewport.evaluate((element) => element.matches(":focus-visible"))).toBe(
            true,
          );
          expect(await viewport.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
            "solid",
          );
          expect(await viewport.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          expect(await viewport.evaluate((element) => element.scrollLeft)).toBe(before);
          if (overflow) {
            await page.keyboard.press("ArrowRight");
            await expect
              .poll(() => viewport.evaluate((element) => element.scrollLeft))
              .toBeGreaterThan(before);
          }
          await page.keyboard.press("Shift+Tab");
          expect(await copy.evaluate((element) => element === document.activeElement)).toBe(true);
          await page.keyboard.press("Enter");
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
        },
      );
    },
  );

  it.each([8])("clips %i block-art lines to seven rendered rows", async (lineCount) => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const art = Array.from({ length: lineCount }, () => "██  ██  ██").join("\n");
      await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: "```\n" + art + "\n```", timestamp: 1000 }],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const code = page.locator(".code-block-wrapper.is-collapsible code.markdown-block-art");
      await code.waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await code.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
          scrollHeight: element.scrollHeight,
        }));
        // Fractional line boxes are rounded by layout; a whole extra row is not.
        expect(geometry.height).toBeCloseTo(7 * geometry.lineHeight, 0);
        expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
      }
      const collapsedHeight = await code.evaluate((element) => element.clientHeight);
      await page.locator(".code-block-expand").click();
      expect(await code.evaluate((element) => element.clientHeight)).toBeGreaterThan(
        collapsedHeight,
      );
      expect(await code.textContent()).toBe(art + "\n");
    });
  });

  it.each(["dark", "light"] as const)(
    "keeps code controls correct through disclosure, resize, and virtual remount in %s mode",
    async (theme) => {
      await suite.withPage({ ...desktop, colorScheme: theme }, async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            ...Array.from({ length: 40 }, (_, index) => ({
              role: index % 2 === 0 ? "user" : "assistant",
              content: [{ type: "text", text: `Earlier diagnostic turn ${index}` }],
              timestamp: Date.now() - 40 + index,
              __openclaw: { id: `earlier-diagnostic-${index}`, seq: index + 1 },
            })),
            ...(
              [
                ["user", "Return the deployment receipt.", "user-fence-short"],
                ["assistant", shortFence, "assistant-fence-short"],
                ["user", "Show the launch command.", "user-fence-wide"],
                ["assistant", wideFence, "assistant-fence-wide"],
              ] as const
            ).map(([role, text, id], index) =>
              chatMessage(role, text, {
                timestamp: Date.now() + index,
                __openclaw: { id, seq: 41 + index },
              }),
            ),
          ],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await setThemeMode(page, theme);
        const shortBubble = page.locator('[data-entry-id="assistant-fence-short"]');
        const wideBubble = page.locator('[data-entry-id="assistant-fence-wide"]');
        await wideBubble.waitFor({ state: "visible" });

        // JSON starts in Tree; Raw retains the shared fence preview and wrap contract.
        await shortBubble.getByRole("button", { name: "Raw", exact: true }).click();

        // A fence at or under the preview budget stays whole and offers no reveal.
        expect(await shortBubble.locator(".code-block-wrapper.is-collapsible").count()).toBe(0);
        expect(await shortBubble.locator(".code-block-expand").count()).toBe(0);
        expect(await shortBubble.locator("pre code").isVisible()).toBe(true);

        // The wrap control only appears once a line measurably overflows, and it
        // reverses; the transcript itself must never grow a horizontal scrollbar.
        const wideWrapper = wideBubble.locator(".code-block-wrapper");
        await polledAttribute(wideWrapper, "class").toContain("has-horizontal-overflow");
        const wrapButton = wideWrapper.locator(".code-block-wrap");
        expect(await wrapButton.isVisible()).toBe(true);
        await wrapButton.click();
        await polledAttribute(wideWrapper, "class").toContain("is-wrapped");
        expect(
          await wideWrapper
            .locator(".code-block-viewport")
            .evaluate((viewport) => viewport.scrollWidth - viewport.clientWidth),
        ).toBeLessThanOrEqual(1);
        await wrapButton.click();
        await polledAttribute(wideWrapper, "class").not.toContain("is-wrapped");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);

        // Resize must update existing code controls without another chat message.
        const shortWrapper = shortBubble.locator(".code-block-wrapper");
        const shortWrap = shortWrapper.locator(".code-block-wrap");
        await shortBubble.scrollIntoViewIfNeeded();
        expect(await shortWrap.isVisible()).toBe(false);
        await page.setViewportSize({ width: 560, height: 900 });
        await shortBubble.scrollIntoViewIfNeeded();
        await expect.poll(() => shortWrap.isVisible()).toBe(true);
        await page.setViewportSize({ width: 1440, height: 900 });
        await shortBubble.scrollIntoViewIfNeeded();
        await expect.poll(() => shortWrap.isVisible()).toBe(false);

        // Virtualization must initialize replacement DOM in an otherwise quiet transcript.
        const thread = page.locator(".chat-thread");
        // Focused rows stay mounted offscreen; move focus out of the wrap control first.
        await page.locator(".agent-chat__composer-combobox textarea").click();
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
        await expect.poll(() => wideBubble.count()).toBe(0);
        await page.mouse.wheel(0, 100_000);
        await wideBubble.waitFor({ state: "visible" });
        await expect.poll(() => wideWrapper.locator(".code-block-wrap").isVisible()).toBe(true);
        expect(await shortWrapper.locator(".code-block-wrap").isVisible()).toBe(false);
      });
    },
  );
});
