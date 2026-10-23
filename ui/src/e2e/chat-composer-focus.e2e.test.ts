import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI chat composer focus" });
const expectFocus = (locator: Locator, focused = true) =>
  expect
    .poll(() => locator.evaluate((element) => document.activeElement === element))
    .toBe(focused);

async function openAgentPicker(page: Page) {
  await installMockGateway(page, {
    defaultAgentId: "main",
    methodResponses: {
      "agents.list": {
        agents: ["main", "research"].map((id) => ({ id, workspace: `/tmp/${id}` })),
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}new?agent=main`);
  const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
  return {
    picker,
    trigger: picker.locator(".agent-select__trigger"),
    menu: picker.locator(".agent-select__menu"),
    option: picker.getByRole("menuitemradio", { name: "research", exact: true }),
    composer: page.locator(".new-session-page__message"),
  };
}

suite.define(() => {
  it.each(["chat", "new"])(
    "centers %s composer keyboard focus on its action glyphs",
    async (route) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          await installMockGateway(page);
          await page.goto(suite.server.baseUrl + route);
          const composer = page.locator(".agent-chat__input");
          await composer.locator("textarea").waitFor();
          await page.keyboard.press("Tab");
          for (const label of ["Add attachment", "Microphone input"]) {
            const control = composer.getByRole("button", { name: label, exact: true });
            await control.focus();
            await expect
              .poll(() => control.evaluate((element) => element.matches(":focus-visible")))
              .toBe(true);
            await expect
              .poll(
                async () => {
                  const button = await control.boundingBox();
                  const icon = await control.locator("svg").boundingBox();
                  if (!button || !icon) {
                    return Number.POSITIVE_INFINITY;
                  }
                  return Math.max(
                    Math.abs(button.x + button.width / 2 - icon.x - icon.width / 2),
                    Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2),
                  );
                },
                { message: label + " glyph must share the focused hit area's center" },
              )
              .toBeLessThanOrEqual(0.5);
          }
        },
      );
    },
  );

  it("routes agent-menu letters and selection keys to their owners", async () => {
    await suite.withPage({}, async ({ page }) => {
      const { picker, trigger, option, composer } = await openAgentPicker(page);
      await trigger.waitFor({ state: "visible" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      // Opening initializes the selected row after its animation completes.
      const selected = picker.getByRole("menuitemradio", { name: "main", exact: true });
      await expectFocus(selected);
      await page.keyboard.press("ArrowDown");
      await expectFocus(option);

      await page.keyboard.press("Space");

      await expect
        .poll(() => picker.locator(".agent-select__label").textContent())
        .toBe("research");
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
      await option.waitFor({ state: "hidden" });

      await trigger.focus();
      await page.keyboard.press("Enter");
      await expectFocus(option);

      await page.keyboard.type("r");

      await expect.poll(() => composer.inputValue()).toBe("r");
    });
  });

  it("keeps agent-menu activation keys out of the composer while its trigger retains focus", async () => {
    await suite.withPage({}, async ({ page }) => {
      const { trigger, menu, option, composer } = await openAgentPicker(page);
      await composer.waitFor({ state: "visible" });

      await trigger.click();
      await menu.waitFor({ state: "visible" });
      await trigger.focus();
      await expectFocus(trigger);
      await page.keyboard.press("Space");

      await expect
        .poll(() => menu.evaluate((element) => element.matches(":popover-open")))
        .toBe(true);
      await expectFocus(option);
      await expect.poll(() => composer.inputValue()).toBe("");
    });
  });

  it("routes printable input from the real Chat context menu to the composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      const messageText = "Context menu typing route";
      await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: messageText }], timestamp: 1_000 },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-bubble").filter({ hasText: messageText });
      await bubble.waitFor();
      await bubble.click({ button: "right" });
      const menuItem = page
        .locator(".chat-reply-context-menu")
        .getByRole("menuitem", { name: "Reply to message", exact: true });
      await menuItem.focus();

      await page.keyboard.type("x");

      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await expect.poll(() => composer.inputValue()).toBe("x");
      await expectFocus(composer);
    });
  });

  it("keeps remote-control typing out of the chat composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["browser.request", "chat.startup", "desktop.observe", "environments.list"],
        methodResponses: {
          "browser.request": {
            cases: [
              {
                match: { method: "GET", path: "/tabs" },
                response: { running: true, tabs: [] },
              },
            ],
          },
          "environments.list": { environments: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await composer.waitFor({ state: "visible" });

      for (const [label, selector] of [
        ["Browser", "openclaw-browser-panel"],
        ["Desktop", "openclaw-desktop-panel"],
      ] as const) {
        await openChatSidePanelType(page, label);
        const panel = page.locator(selector);
        await panel.waitFor({ state: "visible" });
        await composer.blur();
        await panel.evaluate((element) => {
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "a",
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          );
        });
        await expectFocus(composer, false);
      }
    });
  });

  it.each(["chat", "new"])(
    "keeps %s composer keyboard focus visible in forced colors",
    async (route) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, forcedColors: "active", reducedMotion: "reduce" },
        async ({ page }) => {
          await installMockGateway(page);
          await page.goto(suite.server.baseUrl + route);
          const composer = page.locator(".agent-chat__input");
          const textarea = composer.locator("textarea");
          await textarea.waitFor();
          const indicator = () =>
            composer.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                border: style.borderColor,
                shadow: style.boxShadow,
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
                outlineColor: style.outlineColor,
              };
            });
          await textarea.blur();
          const resting = await indicator();
          await textarea.focus();
          expect(await textarea.evaluate((element) => element.matches(":focus-visible"))).toBe(
            true,
          );
          const focused = await indicator();
          expect(focused.outlineStyle).toBe("solid");
          expect(Number.parseFloat(focused.outlineWidth)).toBeGreaterThanOrEqual(2);
          await page.keyboard.press("Tab");
          expect(await indicator()).toEqual(resting);
        },
      );
    },
  );

  it("changes neutral focus styling in dark and light themes", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const textarea = composer.locator("textarea");
      await composer.waitFor({ state: "visible" });

      for (const theme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
          .toBe(theme);
        await textarea.evaluate((element) => element.blur());
        const unfocused = await composer.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
          const style = getComputedStyle(element);
          const { width, height } = element.getBoundingClientRect();
          return { borderColor: style.borderColor, boxShadow: style.boxShadow, width, height };
        });

        await textarea.focus();
        const focused = await composer.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
          const style = getComputedStyle(element);
          const { width, height } = element.getBoundingClientRect();
          const parseRgb = (color: string): [number, number, number] => {
            const values = color
              .match(/[\d.]+/g)
              ?.slice(0, 3)
              .map(Number);
            if (!values || values.length !== 3) {
              throw new Error(`expected an RGB color, received ${color}`);
            }
            return (
              color.startsWith("color(srgb") ? values.map((value) => value * 255) : values
            ) as [number, number, number];
          };
          const borderChannels = parseRgb(style.borderColor);

          return {
            borderColor: style.borderColor,
            boxShadow: style.boxShadow,
            width,
            height,
            neutralChannelSpread: Math.max(...borderChannels) - Math.min(...borderChannels),
          };
        });

        expect([focused.borderColor, focused.boxShadow]).not.toEqual([
          unfocused.borderColor,
          unfocused.boxShadow,
        ]);
        expect(focused.neutralChannelSpread).toBeLessThanOrEqual(24);
        expect([focused.width, focused.height]).toEqual([unfocused.width, unfocused.height]);
      }
    });
  });
});
