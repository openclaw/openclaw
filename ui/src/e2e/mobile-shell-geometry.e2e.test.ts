import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import {
  waitForControlUiFrameLayout,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile shell geometry" });
const sessionKey = "agent:main:main";

async function waitForMessageGeometry(surface: Locator, content: readonly Locator[]) {
  const targets = [surface, ...content];
  await Promise.all(targets.map((target) => waitForControlUiProofSurface(target, [target])));
  await waitForControlUiFrameLayout(targets);
  await Promise.all(targets.map((target) => expect(target).toBeInViewport()));
}

function viewportScenario(
  name: string,
  width: number,
  height: number,
  insets?: [top: number, bottom: number, left: number, right: number],
  largeUnit = false,
  mobile = true,
) {
  return { name, width, height, mobile, largeUnit, insets };
}
const scenarios = [
  viewportScenario("standalone-large-unit-contract", 402, 874, [62, 34, 0, 0], true),
  viewportScenario("desktop-zero", 1440, 900, undefined, false, false),
  viewportScenario("phone-zero", 390, 844),
  viewportScenario("landscape-zero", 844, 390),
  viewportScenario("compact-landscape", 560, 390),
  viewportScenario("standalone-zero-contract", 390, 844, [0, 0, 0, 0]),
  viewportScenario("standalone-insets-contract", 390, 844, [48, 30, 0, 0]),
  viewportScenario("standalone-landscape-contract", 844, 390, [0, 20, 48, 48]),
];

async function activateStandaloneStyles(page: Page, largeUnitDifference = 0, shortCanvas = false) {
  // Fault injection, not an iPhone measurement: viewport units may exceed the visible viewport.
  await page.evaluate(
    async ({ difference, shortCanvas: short }) => {
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSMediaRule) {
            rule.media.mediaText = rule.conditionText.replaceAll(
              "(display-mode: standalone)",
              "(min-width: 0px)",
            );
          }
          if ((difference || short) && rule instanceof CSSStyleRule) {
            const base = rule.style.getPropertyValue("--shell-viewport-base");
            if (base === "100lvh" || base === "100dvh") {
              rule.style.setProperty(
                "--shell-viewport-base",
                `calc(${base} ${short && base === "100dvh" ? "-" : "+"} ${short ? 62 : difference}px)`,
              );
            }
          }
          if (rule instanceof CSSGroupingRule) {
            visit(rule.cssRules);
          }
        }
      };
      for (const sheet of document.styleSheets) {
        visit(sheet.cssRules);
      }
      window.dispatchEvent(new Event("resize"));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    },
    { difference: largeUnitDifference, shortCanvas },
  );
}

async function expectReachableAction(
  page: Page,
  label: string,
  visibleBottom: number,
  mobile: boolean,
) {
  const action = page.getByRole("button", { name: label, exact: true });
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(visibleBottom);
  const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
  if (mobile) {
    const compact = await page
      .locator(".agent-chat__composer-shell")
      .evaluate((element) => element.getBoundingClientRect().width <= 560);
    expect(Math.min(bounds!.width, bounds!.height)).toBeGreaterThanOrEqual(32);
    for (const picker of await page
      .locator(".chat-controls__model-trigger, .chat-controls__effort-trigger")
      .all()) {
      if (compact && (await picker.isVisible())) {
        const box = await picker.boundingBox();
        expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
      }
    }
  }
  expect(
    await action.evaluate(
      (element, center) => element.contains(document.elementFromPoint(center.x, center.y)),
      point,
    ),
  ).toBe(true);
  return { ...point, width: bounds!.width, height: bounds!.height };
}

async function expectEditableDraft(page: Page, visibleBottom: number, mobile: boolean) {
  // Dense queue/context reachability belongs to chat-footer.e2e.test.ts; this tests the editor.
  await expect(
    page.locator(
      ".chat-details:popover-open, .sidebar-region--mobile-host > .chat-mobile-host:not([hidden]), .chat-footer__context .session-progress-card, .chat-footer__context .chat-prs",
    ),
  ).toHaveCount(0);
  const textarea = page.locator(".agent-chat__composer-combobox textarea");
  const measure = () =>
    textarea.evaluate((editor: HTMLTextAreaElement) => {
      const box = editor.getBoundingClientRect();
      const conversation = editor.closest(".chat-main__conversation")!.getBoundingClientRect();
      const style = getComputedStyle(editor);
      const line = Number.parseFloat(style.lineHeight);
      const paddingTop = Number.parseFloat(style.paddingTop);
      const paddingBottom = Number.parseFloat(style.paddingBottom);
      // Explicit newlines keep the caret's line position independent of wrapping.
      const selectedLine = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
      const lineTop = box.top + paddingTop + selectedLine * line - editor.scrollTop;
      return {
        top: box.top,
        bottom: box.bottom,
        conversationTop: conversation.top,
        availableHeight: editor.clientHeight - paddingTop - paddingBottom,
        scrollTop: editor.scrollTop,
        line,
        lineTop,
        lineBottom: lineTop + line,
        reachable:
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === editor,
      };
    });
  const before = await measure();

  expect(before.top).toBeGreaterThanOrEqual(before.conversationTop);
  expect(before.bottom).toBeLessThanOrEqual(visibleBottom);
  expect(before.availableHeight).toBeGreaterThanOrEqual(before.line);
  expect(before.reachable).toBe(true);
  const box = (await textarea.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(textarea).toBeFocused();
  await textarea.fill("First line\nSecond line\nThird line\nLast line");
  // macOS Chromium binds no editing command to Cmd+Home/End; the caret would stay put.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type(" typed");
  await expect(textarea).toHaveValue("First line\nSecond line\nThird line\nLast line typed");
  await waitForLayoutSettled(page, ".agent-chat__composer-combobox textarea");
  // Scroll the complete line into view; native caret scrolling may show only its glyphs.
  await textarea.hover();
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() => textarea.evaluate((editor) => editor.scrollTop + editor.clientHeight))
    .toBe(await textarea.evaluate((editor) => editor.scrollHeight));
  const last = await measure();
  expect(last.scrollTop).toBeGreaterThan(0);
  await expectReachableAction(page, "Send message", visibleBottom, mobile);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.type("Edited ");
  await waitForLayoutSettled(page, ".agent-chat__composer-combobox textarea");
  await textarea.hover();
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => textarea.evaluate((editor) => editor.scrollTop)).toBe(0);
  const first = await measure();
  for (const reading of [last, first]) {
    expect(reading.lineTop).toBeGreaterThanOrEqual(Math.max(reading.top, reading.conversationTop));
    expect(reading.lineBottom).toBeLessThanOrEqual(Math.min(reading.bottom, visibleBottom));
  }
  await expect(textarea).toHaveValue("Edited First line\nSecond line\nThird line\nLast line typed");
  await textarea.fill("");
}

async function geometry(page: Page) {
  await waitForLayoutSettled(
    page,
    ".shell, .agent-chat__composer-shell, .sidebar-region--mobile-host > .chat-mobile-host:not([hidden])",
  );
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) {
        return null;
      }
      const { left, right, top, bottom } = el.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    return {
      shell: rect(".shell")!,
      composer: rect(".agent-chat__composer-shell")!,
      thread: rect(".chat-thread-inner"),
      scrollWidth: document.documentElement.scrollWidth,
      layoutHeight: document.documentElement.clientHeight,
      visualHeight: window.visualViewport?.height,
    };
  });
}

async function visualViewport(
  page: Page,
  viewportHeight: number,
  viewportOffset = 0,
  viewportScale = 1,
) {
  await page.evaluate(
    ({ height, offsetTop, scale }) => {
      const viewport = window.visualViewport!;
      for (const [key, value] of Object.entries({ height, offsetTop, scale })) {
        Object.defineProperty(viewport, key, { configurable: true, value });
      }
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    },
    { height: viewportHeight, offsetTop: viewportOffset, scale: viewportScale },
  );
}

suite.define(() => {
  it.each([false, true])(
    "keeps a shorter CSS canvas without promoting lvh (VisualViewport missing: %s)",
    async (missing) => {
      await suite.withPage(
        { viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true },
        async ({ page }) => {
          if (missing) {
            await page.addInitScript(() =>
              Object.defineProperty(window, "visualViewport", {
                value: undefined,
                configurable: true,
              }),
            );
          }
          await installMockGateway(page);
          await page.goto(suite.server.baseUrl + "new");
          await expect(page.locator(".new-session-page__message")).toBeVisible();
          await activateStandaloneStyles(page, 0, true);
          const frame = await geometry(page);
          expect(frame.shell.bottom).toBe(812);
          expect(frame.composer.bottom).toBeLessThanOrEqual(812);
        },
      );
    },
  );

  it.each(scenarios)("keeps $name routes and controls in one usable canvas", async (scenario) => {
    const { name, width, height, mobile, largeUnit, insets } = scenario;
    const [top = 0, bottom = 0, left = 0, right = 0] = insets ?? [];
    const standalone = insets !== undefined;
    await suite.withPage(
      { viewport: { width, height }, hasTouch: mobile, isMobile: mobile, colorScheme: "dark" },
      async ({ page, context }) => {
        const reach = (label: string, visibleBottom: number) =>
          expectReachableAction(page, label, visibleBottom, mobile);
        await page.clock.setFixedTime(new Date("2026-09-20T16:50:10Z"));
        await page.emulateMedia({ reducedMotion: "reduce" });
        if (standalone) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setSafeAreaInsetsOverride", {
            insets: { top, bottom, left, right },
          });
        }
        const assistantText =
          "The transcript and composer should share a comfortable reading column.";
        const gateway = await installMockGateway(page, {
          workspace: "/workspace/example",
          historyMessages: ["Please check the mobile layout.", assistantText].map(
            (content, index) => ({
              role: index ? "assistant" : "user",
              content,
              timestamp: 1_789_923_000_000 + index * 1_000,
            }),
          ),
        });
        await page.goto(suite.server.baseUrl + "new");
        await expect(page.locator(".new-session-page__message")).toBeVisible();
        if (standalone) {
          await activateStandaloneStyles(page, largeUnit ? top : 0);
        }
        const fresh = await geometry(page);
        // Keep cold route coverage for the large-unit fault; other viewports reuse the app.
        if (largeUnit) {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        } else {
          await navigateToControlUiSession(page, sessionKey);
        }
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await expect(textarea).toBeVisible();
        await page.getByText(assistantText).waitFor();
        if (standalone) {
          await activateStandaloneStyles(page, largeUnit ? top : 0);
        }
        const firstMessage = page.locator(".chat-group.user").first();
        const bubble = firstMessage.locator(".chat-bubble").first();
        const details = page
          .locator(".mobile-header__title")
          .or(
            page
              .getByRole("button", { name: "Details", exact: true })
              .and(page.locator(".chat-details-toggle")),
          )
          .filter({ visible: true })
          .first();
        await waitForMessageGeometry(bubble, [details, textarea]);
        await (mobile ? bubble.tap() : bubble.hover());
        const actions = firstMessage.locator(".chat-group-footer-actions");
        await expect(actions.locator(".chat-copy-btn")).toBeVisible();
        await waitForMessageGeometry(bubble, [details, actions]);
        const detailsBox = (await details.boundingBox())!;
        const transcriptBoxes = await Promise.all([bubble.boundingBox(), actions.boundingBox()]);
        for (const box of transcriptBoxes) {
          expect(
            box &&
              (detailsBox.x + detailsBox.width <= box.x ||
                box.x + box.width <= detailsBox.x ||
                detailsBox.y + detailsBox.height <= box.y ||
                box.y + box.height <= detailsBox.y),
            `${name}: Header controls must clear the first message and its actions`,
          ).toBe(true);
        }
        const chat = await geometry(page);
        await textarea.fill("Please continue the layout check.");
        const sendPoint = await reach("Send message", height - bottom);
        // Coordinate input cannot auto-scroll an offscreen control into view.
        await (mobile
          ? page.touchscreen.tap(sendPoint.x, sendPoint.y)
          : page.mouse.click(sendPoint.x, sendPoint.y));
        await gateway.waitForRequest("chat.send");
        const stop = page.getByRole("button", { name: "Stop generating" });
        await expect(stop).toBeVisible();
        const stopBounds = await stop.boundingBox();
        expect(stopBounds && { width: stopBounds.width, height: stopBounds.height }).toEqual({
          width: sendPoint.width,
          height: sendPoint.height,
        });
        const generating = await geometry(page);
        if (mobile) {
          await textarea.focus();
          // Simulate the VisualViewport contract, not a native IME.
          for (const [kind, visibleHeight, offsetTop, scale] of [
            ["small-browser-bar", height - 62, 0, 1],
            ["keyboard-open", height - 240, 0, 1],
            ["keyboard-pan", height - 270, 45, 1],
            ["keyboard-dismissed-focus-retained", height, 0, 1],
            ["pinch-zoom", height / 2, 35, 2],
          ] as const) {
            await visualViewport(page, visibleHeight, offsetTop, scale);
            const frame = await geometry(page);
            const occluded = kind === "keyboard-open" || kind === "keyboard-pan";
            expect(frame.shell.bottom, kind).toBeCloseTo(
              scale !== 1
                ? (largeUnit ? height + top : height) - bottom
                : visibleHeight + offsetTop - (occluded ? 0 : bottom),
              0,
            );
            expect(frame.composer.bottom, kind).toBeLessThanOrEqual(frame.shell.bottom);
            if (kind === "keyboard-open" && width > height) {
              await expectEditableDraft(page, visibleHeight + offsetTop, mobile);
            }
            if (scale === 1) {
              await reach("Stop generating", visibleHeight + offsetTop);
            }
          }
          await visualViewport(page, height);
          await expect(textarea).toBeFocused();
        }
        if (!mobile) {
          // The real mounted renderer in a short pane, independent of viewport or keyboard.
          const frame = page.locator(".chat-main__conversation-frame");
          await frame.evaluate((element: HTMLElement) => {
            element.style.flex = "0 0 94px";
          });
          await waitForLayoutSettled(page, ".chat-main__conversation-frame");
          const bounds = (await frame.boundingBox())!;
          await expectEditableDraft(page, bounds.y + bounds.height, mobile);
          await reach("Stop generating", bounds.y + bounds.height);
          await frame.evaluate((element: HTMLElement) => {
            element.style.removeProperty("flex");
          });
        }
        if (mobile && width > height) {
          await visualViewport(page, height - 240);
          const point = await reach("Stop generating", height - 240);
          await page.touchscreen.tap(point.x, point.y);
        } else {
          await stop.click();
        }
        await gateway.waitForRequest("chat.abort");
        if (mobile) {
          await visualViewport(page, height);
          const readSurface = async (selector: string, surfaceName: string) => {
            await waitForLayoutSettled(page, selector);
            const bounds = await page.locator(selector).evaluate((el) => {
              const box = el.getBoundingClientRect();
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
            });
            expect(bounds.left, surfaceName).toBeGreaterThanOrEqual(left);
            expect(bounds.right, surfaceName).toBeLessThanOrEqual(width - right);
            expect(bounds.top, surfaceName).toBeGreaterThanOrEqual(top);
            expect(bounds.bottom, surfaceName).toBeLessThanOrEqual(height);
          };
          await textarea.tap();
          await page.locator("[data-chat-model-select]").click();
          await expect(page.locator(".chat-controls__model-menu")).toBeVisible();
          await readSurface(".chat-controls__model-menu", "model-menu");
          await page.keyboard.press("Escape");
          await navigationDrawerToggle(page).click();
          await expect(page.locator(".shell--nav-drawer-open")).toBeVisible();
          await readSurface(".shell-nav", "drawer");
          await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
          await expect(page.locator(".sidebar-session-filter-panel")).toBeVisible();
          await readSurface(".sidebar-session-filter-panel", "filter-sheet");
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }
        expect([chat.layoutHeight, chat.visualHeight]).toEqual([height, height]);
        expect(chat.composer.bottom).toBeLessThanOrEqual(height - bottom);
        expect(chat.shell.top).toBeCloseTo(top, 0);
        expect(chat.shell.bottom).toBeCloseTo(height - bottom, 0);
        expect(generating.scrollWidth).toBeLessThanOrEqual(width);
        if (mobile) {
          const usableWidth = width - left - right;
          for (const [frame, inset] of [
            [fresh, 20],
            [generating, 16],
          ] as const) {
            const margin = Math.max(inset, (usableWidth - 768) / 2);
            expect(frame.composer.left).toBeCloseTo(left + margin, 0);
            expect(frame.composer.right).toBeCloseTo(width - right - margin, 0);
          }
          expect(generating.composer.left).toBeCloseTo(chat.composer.left, 0);
          expect(generating.composer.right).toBeCloseTo(chat.composer.right, 0);
          expect(chat.thread!.left).toBeCloseTo(chat.composer.left, 0);
          expect(chat.thread!.right).toBeCloseTo(chat.composer.right, 0);
        }
      },
    );
  });
});
