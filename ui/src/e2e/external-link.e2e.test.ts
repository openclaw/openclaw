import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { COMMUNITY_DISCORD_URL } from "../lib/product-links.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Product navigation indicators",
  browserLaunchOptions: {
    channel: "chromium",
    args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
  },
});

async function expectNoIndicator(surface: Locator) {
  await surface.first().waitFor();
  expect(await surface.locator("openclaw-external-link, .external-link-indicator").count()).toBe(0);
}

async function indicatorGeometry(link: Locator) {
  await link.scrollIntoViewIfNeeded();
  const indicator = link.getByRole("img", { name: "opens in a new tab", exact: true });
  await indicator.waitFor();
  expect(await indicator.count()).toBe(1);
  return indicator.evaluate((element) => {
    const arrow = element.querySelector("svg");
    const anchor = element.closest("a");
    if (!arrow || !anchor) {
      throw new Error("Navigation indicator has no arrow or link");
    }
    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    let text: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) {
        text = node;
      }
    }
    if (!text) {
      throw new Error("Navigation link has no label");
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const labelBox = range.getBoundingClientRect();
    const arrowBox = arrow.getBoundingClientRect();
    const labelStyle = getComputedStyle(text.parentElement!);
    const arrowStyle = getComputedStyle(arrow);
    return {
      right: arrowBox.right,
      width: arrowBox.width,
      overlap: Math.min(labelBox.bottom, arrowBox.bottom) - Math.max(labelBox.top, arrowBox.top),
      labelSize: Number.parseFloat(labelStyle.fontSize),
      labelColor: labelStyle.color,
      arrowColor: arrowStyle.color,
    };
  });
}

suite.define(() => {
  it("keeps Learn more in the prose flow and inherits the link color, including hover", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}settings/labs`);
      const link = page.locator(
        '.page-subtitle a[href="https://docs.openclaw.ai/concepts/experimental-features"]',
      );
      await link.waitFor();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const wrapping = await link.evaluate((anchor) => {
        const subtitle = anchor.closest<HTMLElement>(".page-subtitle")!;
        const baseline = subtitle.cloneNode(true) as HTMLElement;
        const baselineLink = baseline.querySelector("a")!;
        baselineLink.replaceChildren(document.createTextNode(anchor.textContent!.trim()));
        const originalStyle = subtitle.getAttribute("style");
        subtitle.after(baseline);
        const wordBox = (element: Element, last = false) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let box: DOMRect | undefined;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const matches = [...(node.textContent ?? "").matchAll(/\S+/gu)];
            const match = last ? matches.at(-1) : matches[0];
            if (!match) {
              continue;
            }
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            box = range.getBoundingClientRect();
            if (!last) {
              return box;
            }
          }
          if (!box) {
            throw new Error("Learn more has no rendered label");
          }
          return box;
        };
        const mismatches: number[] = [];
        let followsProse = 0;
        try {
          // Sweep remaining-line space, rather than relying on one font-specific width.
          for (let width = 180; width <= 500; width += 4) {
            subtitle.style.width = `${width}px`;
            baseline.style.width = `${width}px`;
            for (const last of [false, true]) {
              const decorated = wordBox(anchor, last);
              const plain = wordBox(baselineLink, last);
              const actualY = decorated.top - subtitle.getBoundingClientRect().top;
              const expectedY = plain.top - baseline.getBoundingClientRect().top;
              if (Math.abs(actualY - expectedY) > 1) {
                mismatches.push(width);
              }
            }
            const plain = wordBox(baselineLink);
            const prose = [...baseline.childNodes].find(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            );
            if (prose?.nodeType === Node.TEXT_NODE) {
              const end = prose.textContent!.trimEnd().length;
              const range = document.createRange();
              range.setStart(prose, end - 1);
              range.setEnd(prose, end);
              if (Math.abs(range.getBoundingClientRect().top - plain.top) < 1) {
                followsProse += 1;
              }
            }
          }
          return { mismatches, followsProse };
        } finally {
          baseline.remove();
          if (originalStyle === null) {
            subtitle.removeAttribute("style");
          } else {
            subtitle.setAttribute("style", originalStyle);
          }
        }
      });
      expect(wrapping.followsProse).toBeGreaterThan(0);
      expect(wrapping.mismatches).toEqual([]);
      const normal = await indicatorGeometry(link);
      expect(normal.arrowColor).toBe(normal.labelColor);
      await link.hover();
      await expect
        .poll(async () => {
          const hover = await indicatorGeometry(link);
          return hover.arrowColor === hover.labelColor;
        })
        .toBe(true);
    });
  });
  it.each([1440, 390])("limits arrows to explicit product navigation at %i px", async (width) => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        deviceScaleFactor: 2,
        viewport: { width, height: 900 },
      },
      async ({ page }) => {
        const label =
          "Read the complete documentation for configuring permissions and reviewing external destinations";
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              timestamp: 1_700_000_000_000,
              content: [
                {
                  type: "text",
                  text: `[${label}](https://example.test/guide)\n\nhttps://example.test/printed\n\nhttps://github.com/openclaw/openclaw/issues/150454\n\n[Settings](/settings/about) and [Current session](/chat/main/cafebabe).`,
                },
              ],
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const markdown = page.locator(".chat-group.assistant .chat-text");
        const external = markdown.locator('a[href="https://example.test/guide"]');
        await external.waitFor();
        await expectNoIndicator(markdown);
        expect(await markdown.locator("a.markdown-github-item").textContent()).toBe("#150454");
        expect(await page.getByRole("link", { name: label, exact: true }).count()).toBe(1);
        expect(
          await external.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            const selected = selection?.toString();
            selection?.removeAllRanges();
            return selected;
          }),
        ).toBe(label);

        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.locator("[data-chat-permission-select]").click();
        const permissionLink = page.locator(".chat-controls__permission-learn-more");
        const permission = await indicatorGeometry(permissionLink);
        expect(permission.width).toBeLessThan(permission.labelSize);
        expect(permission.overlap).toBeGreaterThan(0);
        expect(permission.arrowColor).toBe(permission.labelColor);
        await permissionLink.hover();
        await permissionLink.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations({ subtree: true }).map((animation) => animation.finished),
          );
        });
        const permissionHover = await indicatorGeometry(permissionLink);
        expect(permissionHover.arrowColor).toBe(permissionHover.labelColor);
        await page.keyboard.press("Escape");

        if (width > 768) {
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-identity-card").click();
          const help = sidebar.locator(".sidebar-identity-menu__help");
          await help.hover();
          const links = help.locator("a");
          expect(await links.count()).toBe(4);
          const boxes = [];
          for (const link of await links.all()) {
            const box = await indicatorGeometry(link);
            expect(box.width).toBeGreaterThan(0);
            expect(box.width).toBeLessThan(box.labelSize);
            expect(box.overlap).toBeGreaterThan(0);
            expect(box.arrowColor).not.toBe(box.labelColor);
            boxes.push(box);
          }
          expect(
            Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.right)),
          ).toBeLessThanOrEqual(1);
          await page.keyboard.press("Escape");
        }

        await page.goto(`${suite.server.baseUrl}apps`);
        if (width === 1440) {
          const store = page.locator(
            'a.apps-card__cta[href="https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig"]',
          );
          const setup = page
            .locator('a.apps-card__cta[href="https://docs.openclaw.ai/tools/chrome-extension"]')
            .first();
          await store.waitFor();
          await setup.waitFor();
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const storeBox = await store.boundingBox();
          const setupBox = await setup.boundingBox();
          expect(storeBox).not.toBeNull();
          expect(setupBox).not.toBeNull();
          expect(Math.abs(storeBox!.y - setupBox!.y)).toBeLessThanOrEqual(1);
        }

        await expectNoIndicator(
          page.locator('a.apps-card__cta[href="https://github.com/openclaw/openclaw/releases"]'),
        );
        const docs = await indicatorGeometry(
          page.locator('a.apps-card__cta[href="https://docs.openclaw.ai/platforms/macos"]'),
        );
        expect(docs.overlap).toBeGreaterThan(0);
        expect(docs.arrowColor).toBe(docs.labelColor);
        await expectNoIndicator(page.locator(`.apps-pill[href="${COMMUNITY_DISCORD_URL}"]`));
        await page.goto(`${suite.server.baseUrl}settings/about`);
        await expectNoIndicator(page.locator(".about-hero__links"));
      },
    );
  });
});
