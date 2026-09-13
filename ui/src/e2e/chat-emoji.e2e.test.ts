import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI emoji entry" });

suite.define(() => {
  it.each([
    {
      name: "Chat",
      route: "chat",
      selector: ".agent-chat__composer-combobox > textarea",
      viewport: { width: 1280, height: 800 },
      prefix: "Nice ",
    },
    {
      name: "New Session",
      route: "new?agent=main",
      selector: ".new-session-page__message",
      viewport: { width: 1280, height: 800 },
      prefix: "Nice ",
    },
    {
      name: "narrow multiline Chat",
      route: "chat",
      selector: ".agent-chat__composer-combobox > textarea",
      viewport: { width: 390, height: 760 },
      prefix: "A short first line.\nNice ",
    },
  ])(
    "supports compact, anchored emoji entry in $name",
    async ({ route, selector, viewport, prefix }) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(selector);
        await composer.waitFor({ state: "visible" });
        await composer.fill(prefix);
        await expect
          .poll(() => composer.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeLessThanOrEqual(1);
        const beforeMenu = (await composer.boundingBox())!;
        const openingVisibility = page.evaluate(
          () =>
            new Promise<string>((resolve) => {
              const observer = new MutationObserver(() => {
                const popup = document.querySelector(".emoji-menu-popup");
                const openingMenu = popup?.querySelector<HTMLElement>(".emoji-menu");
                if (openingMenu && popup && !popup.hasAttribute("data-current-placement")) {
                  observer.disconnect();
                  resolve(getComputedStyle(popup).visibility);
                }
              });
              observer.observe(document.body, { childList: true, subtree: true });
            }),
        );
        await composer.pressSequentially(":smi");
        expect(await openingVisibility).toBe("hidden");
        const menu = page.getByRole("listbox", { name: /emoji/i });
        await menu.waitFor({ state: "visible" });
        expect(await menu.getByRole("option").count()).toBeGreaterThan(1);
        const word = await composer.evaluate((element, draftPrefix) => {
          if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error("Expected composer");
          }
          const style = getComputedStyle(element);
          const context = document.createElement("canvas").getContext("2d")!;
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const bounds = element.getBoundingClientRect();
          const line = draftPrefix.slice(draftPrefix.lastIndexOf("\n") + 1);
          return {
            x:
              bounds.left +
              element.clientLeft +
              Number.parseFloat(style.paddingLeft) +
              context.measureText(line).width +
              (Number.parseFloat(style.letterSpacing) || 0) * line.length -
              element.scrollLeft,
            y:
              bounds.top +
              element.clientTop +
              Number.parseFloat(style.paddingTop) +
              (draftPrefix.split("\n").length - 1) * Number.parseFloat(style.lineHeight) -
              element.scrollTop,
          };
        }, prefix);
        expect(Math.abs((await composer.boundingBox())!.y - beforeMenu.y)).toBeLessThan(1);
        await expect
          .poll(async () => Math.abs((await menu.boundingBox())!.x - word.x))
          .toBeLessThan(3);
        await expect
          .poll(async () => {
            const box = (await menu.boundingBox())!;
            return Math.abs(box.y + box.height - (word.y - 6));
          })
          .toBeLessThan(3);
        expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(302);
        const anchor = await page
          .locator("wa-popup.emoji-menu-popup")
          .evaluateHandle((popup: WaPopup) => popup.anchor);
        await composer.press("ArrowDown");
        await composer.press("ArrowUp");
        await composer.press("Tab");
        await expect.poll(() => composer.inputValue()).toBe(`${prefix}😄`);
        await expect
          .poll(() => composer.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await expect.poll(() => menu.count()).toBe(0);
        await expect
          .poll(() =>
            anchor.evaluate((element) => element instanceof Element && element.isConnected),
          )
          .toBe(false);
        await anchor.dispose();

        await composer.fill("Nice ");
        await composer.pressSequentially(":smile:");
        await expect.poll(() => composer.inputValue()).toBe("Nice 😄");

        await composer.fill("Before :smi after");
        await composer.evaluate((element) => {
          if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error("Expected composer");
          }
          element.setSelectionRange(11, 11);
        });
        await composer.press("ArrowLeft");
        await composer.press("ArrowRight");
        await menu.waitFor({ state: "visible" });
        await menu
          .getByRole("option")
          .filter({ has: page.getByText(":smile:", { exact: true }) })
          .click();
        await expect.poll(() => composer.inputValue()).toBe("Before 😄 after");
        await composer.press("ControlOrMeta+z");
        await expect.poll(() => composer.inputValue()).toBe("Before :smi after");

        for (const literalPrefix of [
          "`:smile",
          "```text\n:smile",
          "https://example.com/:smile",
          "\\:smile",
          ":not_a_real_emoji",
        ]) {
          await composer.fill(literalPrefix);
          await composer.pressSequentially(":");
          await expect.poll(() => composer.inputValue()).toBe(`${literalPrefix}:`);
          await expect.poll(() => menu.count()).toBe(0);
        }

        await composer.fill("");
        await composer.pressSequentially(":smi");
        await menu.waitFor({ state: "visible" });
        await composer.press("Escape");
        await expect.poll(() => menu.count()).toBe(0);
        await expect.poll(() => composer.inputValue()).toBe(":smi");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
  it("dismisses the menu when its token is scrolled out of view", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await composer.fill("Context line\n".repeat(50));
      await composer.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await composer.pressSequentially(":smi");
      const menu = page.getByRole("listbox", { name: /emoji/i });
      await menu.waitFor({ state: "visible" });
      await composer.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect.poll(() => menu.count()).toBe(0);
      await composer.dispatchEvent("select");
      expect(await composer.getAttribute("aria-expanded")).not.toBe("true");
      await expect.poll(() => composer.inputValue()).toBe("Context line\n".repeat(50) + ":smi");
    });
  });
});
