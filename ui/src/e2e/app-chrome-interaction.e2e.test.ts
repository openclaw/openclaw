import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { polledFocus, polledVisible } from "./chat-presentation.test-support.ts";
import { createConfigSuite, pageRunner } from "./config-composer-fixtures.test-support.ts";
import { expectStyles } from "./style-contract.test-support.ts";

const suite = createConfigSuite("Control UI app chrome interaction mocked Gateway E2E");

const withPage = pageRunner(suite, {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
});

const scrollModels = Array.from({ length: 24 }, (_, index) => ({
  id: `scroll-model-${index + 1}`,
  name: `Scroll Model ${index + 1}`,
  provider: "openai",
}));
const messages = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];

async function dragAcross(page: Page, locator: Locator): Promise<string> {
  await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected a visible text-selection target");
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(3, box.width - 2), y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
}

async function readFocusOutline(locator: Locator) {
  return locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: styles.outlineStyle,
      active: element === document.activeElement,
    };
  });
}

suite.define(() => {
  it("keeps canonical scrollbars without horizontal model-picker overflow and preserves selection", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: messages(
          "Selectable transcript content\n\nRead [example.ts](/tmp/example.ts) for details.",
        ),
        models: [
          {
            contextWindow: 1_000_000,
            id: "gpt-5.6-sol-openclaw",
            name: "openai/gpt-5.6-sol-openclaw",
            provider: "openai",
          },
          ...scrollModels,
        ],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const transcript = page.getByText("Selectable transcript content", { exact: true });
      await transcript.waitFor();
      await page.locator('[data-chat-model-select="true"]').click();
      const modelOptions = page.locator(".chat-controls__model-options");
      await expect.poll(() => modelOptions.isVisible()).toBe(true);
      await expectStyles(modelOptions, { width: "12px" }, "::-webkit-scrollbar");
      expect(
        await modelOptions.evaluate((element) => ({
          overflowX: getComputedStyle(element).overflowX,
          overflow: element.scrollWidth - element.clientWidth,
        })),
      ).toEqual({ overflowX: "hidden", overflow: 0 });
      await page.keyboard.press("Escape");
      expect(await dragAcross(page, transcript)).toContain("Selectable transcript");
      const fileLink = page.getByRole("button", { name: "example.ts", exact: true });
      await expectStyles(fileLink, { "user-select": "text" });
      const thread = page.locator(".chat-thread");
      expect(await readFocusOutline(thread)).toMatchObject({
        focusVisible: false,
        outlineStyle: "none",
      });

      await thread.focus();
      await page.keyboard.press("Tab");
      await polledFocus(thread).toBe(false);
      await page.keyboard.press("Shift+Tab");
      await expect
        .poll(() => readFocusOutline(thread))
        .toEqual({
          active: true,
          focusVisible: true,
          outlineStyle: "none",
        });

      await page.setViewportSize({ height: 650, width: 1440 });
      // Appearance overflows at 650px even with the tiny mock config.
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const { search: settingsSearch, sidebar: settingsSidebar } =
        await waitForControlUiSettingsTakeover(page);
      const settingsTitle = settingsSidebar.locator(".settings-sidebar__title");
      const content = page.locator(".content");
      await expect
        .poll(() => content.evaluate((element) => element.scrollHeight))
        .toBeGreaterThan(await content.evaluate((element) => element.clientHeight));

      expect(await dragAcross(page, settingsTitle)).toBe("");
      const sectionTitle = page.locator(".settings-section__heading").first();
      expect(await dragAcross(page, sectionTitle)).not.toBe("");
      const toggleRow = page.locator(".settings-row--toggle").first();
      expect(await dragAcross(page, toggleRow.locator(".settings-row__title"))).toBe("");
      await settingsSearch.selectText();
      expect(
        await settingsSearch.evaluate(
          (element) =>
            element instanceof HTMLInputElement &&
            element.selectionStart === 0 &&
            element.selectionEnd === element.value.length,
        ),
      ).toBe(true);
      await content.evaluate((element) => {
        element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
      });

      const usageError = "Unknown system error -122, write";
      await gateway.setMethodResponse("sessions.usage", {
        __mockError: { code: "UNAVAILABLE", message: usageError },
      });
      await gateway.setMethodResponse("usage.cost", {
        updatedAt: Date.now(),
        days: 1,
        daily: [],
        totals: {},
      });
      await gateway.setMethodResponse("usage.status", {
        updatedAt: Date.now(),
        providers: [],
      });
      await page.goto(`${suite.server.baseUrl}usage`);
      const usageErrorCallout = page.locator(".usage-callout.callout.danger");
      await usageErrorCallout.waitFor();
      expect(await usageErrorCallout.textContent()).toContain(usageError);
      await expectStyles(usageErrorCallout, { "user-select": "text" });
      expect(await dragAcross(page, usageErrorCallout)).toContain(usageError);
    });
  });

  it("resolves the scrollbar thumb from theme tokens in dark and light modes", async () => {
    const thumbColorByScheme: Record<"dark" | "light", string> = { dark: "", light: "" };
    for (const colorScheme of ["dark", "light"] as const) {
      await withPage(
        async ({ page }) => {
          await installMockGateway(page, {
            historyMessages: messages("Selectable transcript content"),
            models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }, ...scrollModels],
          });

          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Selectable transcript content", { exact: true }).waitFor();
          thumbColorByScheme[colorScheme] = await page.evaluate(
            () => getComputedStyle(document.body, "::-webkit-scrollbar-thumb").backgroundColor,
          );
          await page.locator('[data-chat-model-select="true"]').click();
          await polledVisible(page.locator(".chat-controls__model-options")).toBe(true);
          await page.keyboard.press("Escape");

          const composer = page.locator(".agent-chat__input");
          await composer.getByRole("button", { name: "Add attachment" }).click();
          const capabilityMenu = composer.locator(".agent-chat__capability-menu");
          await expect
            .poll(() => capabilityMenu.evaluate((node) => node.hasAttribute("open")))
            .toBe(true);
          const menu = capabilityMenu.locator(".oc-menu").first();
          await expectStyles(menu, { width: "12px" }, "::-webkit-scrollbar");
          await expectStyles(
            menu,
            {
              "background-color": expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/),
            },
            "::-webkit-scrollbar-thumb",
          );

          const menuScrollbarWidths = await page.evaluate(() => {
            return Array.from(
              document.querySelectorAll("[popover]"),
              (surface) => getComputedStyle(surface, "::-webkit-scrollbar").width,
            );
          });
          expect(menuScrollbarWidths.length).toBeGreaterThan(1);
          expect([...new Set(menuScrollbarWidths)]).toEqual(["12px"]);
        },
        { colorScheme },
      );
    }
    expect(thumbColorByScheme.dark).not.toBe(thumbColorByScheme.light);
    expect(thumbColorByScheme.dark).not.toBe("");
    expect(thumbColorByScheme.light).not.toBe("");
  });
});
