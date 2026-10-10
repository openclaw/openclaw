import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails, openDetailsPullRequests } from "./chat-details.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile shell geometry" });
const scenarios = [
  {
    name: "standalone-large-unit-contract",
    width: 402,
    height: 874,
    mobile: true,
    standalone: true,
    top: 62,
    bottom: 34,
    largeUnit: true,
  },
  { name: "desktop-zero", width: 1440, height: 900, mobile: false },
  { name: "phone-zero", width: 390, height: 844, mobile: true },
  { name: "landscape-zero", width: 844, height: 390, mobile: true },
  { name: "compact-landscape", width: 560, height: 390, mobile: true },
  { name: "standalone-zero-contract", width: 390, height: 844, mobile: true, standalone: true },
  {
    name: "standalone-insets-contract",
    width: 390,
    height: 844,
    mobile: true,
    standalone: true,
    top: 48,
    bottom: 30,
  },
  {
    name: "standalone-landscape-contract",
    width: 844,
    height: 390,
    mobile: true,
    standalone: true,
    bottom: 20,
    left: 48,
    right: 48,
  },
];

async function activateStandaloneStyles(page: Page, largeUnitDifference = 0) {
  // Fault injection, not an iPhone measurement: CSS viewport units may exceed
  // the native-scale visible viewport even when layoutHeight == visualHeight.
  // The previous short-layout fixture assumed the extra lvh region was visible;
  // neither viewport API (nor a physical screen size) establishes that premise.
  await page.evaluate(async (difference) => {
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          rule.media.mediaText = rule.conditionText.replaceAll(
            "(display-mode: standalone)",
            "(min-width: 0px)",
          );
        }
        if (difference && rule instanceof CSSStyleRule) {
          const base = rule.style.getPropertyValue("--shell-viewport-base");
          if (base === "100lvh" || base === "100dvh") {
            rule.style.setProperty(
              "--shell-viewport-base",
              "calc(" + base + " + " + difference + "px)",
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
  }, largeUnitDifference);
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
  if (mobile) {
    // Compact Send uses the 36px primary target; Chat's existing Stop variant
    // uses the 32px quiet target. Model/effort retain their independent 44px targets.
    const compact = await page
      .locator(".agent-chat__input")
      .evaluate((element) => element.getBoundingClientRect().width <= 560);
    const targetSize = compact && label === "Send message" ? 36 : 32;
    expect(bounds!.width).toBe(targetSize);
    expect(bounds!.height).toBe(targetSize);
    for (const picker of await page
      .locator(".chat-controls__model-trigger, .chat-controls__effort-trigger")
      .all()) {
      if (compact && (await picker.isVisible())) {
        const box = await picker.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    }
  }
  expect(
    await action.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      );
    }),
  ).toBe(true);
  return { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
}

async function expectEditableDraft(
  page: Page,
  visibleBottom: number,
  artifacts: string,
  mobile: boolean,
) {
  // PRs/progress no longer create a scrollable footer context. Close the
  // independent overlay before exercising the short editor itself; dense
  // queue/context reachability is covered by chat-footer.e2e.test.ts.
  await expect(page.locator(".chat-details:popover-open")).toHaveCount(0);
  await expect(
    page.locator(".chat-footer__context .session-progress-card, .chat-footer__context .chat-prs"),
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
        inputMinHeight: getComputedStyle(editor.closest(".agent-chat__input")!).minHeight,
        clientHeight: editor.clientHeight,
        scrollHeight: editor.scrollHeight,
        scrollTop: editor.scrollTop,
        line,
        paddingTop,
        paddingBottom,
        lineTop,
        lineBottom: lineTop + line,
        reachable:
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === editor,
      };
    });
  const before = await measure();

  expect(before.top).toBeGreaterThanOrEqual(before.conversationTop);
  expect(before.bottom).toBeLessThanOrEqual(visibleBottom);
  expect(before.clientHeight - before.paddingTop - before.paddingBottom).toBeGreaterThanOrEqual(
    before.line,
  );
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
  // Native caret scrolling reveals the glyphs, not necessarily all line leading.
  // Scroll the draft itself to prove the complete last reading line is reachable.
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() => textarea.evaluate((editor) => editor.scrollTop + editor.clientHeight))
    .toBe(await textarea.evaluate((editor) => editor.scrollHeight));
  const last = await measure();
  await page.screenshot({
    path: path.join(artifacts, "short-editor-typing.png"),
    animations: "disabled",
  });

  expect(last.scrollTop).toBeGreaterThan(0);
  expect(last.lineTop).toBeGreaterThanOrEqual(Math.max(last.top, last.conversationTop));
  expect(last.lineBottom).toBeLessThanOrEqual(Math.min(last.bottom, visibleBottom));
  await expectReachableAction(page, "Send message", visibleBottom, mobile);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.type("Edited ");
  await waitForLayoutSettled(page, ".agent-chat__composer-combobox textarea");
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => textarea.evaluate((editor) => editor.scrollTop)).toBe(0);
  const first = await measure();
  expect(first.lineTop).toBeGreaterThanOrEqual(Math.max(first.top, first.conversationTop));
  expect(first.lineBottom).toBeLessThanOrEqual(Math.min(first.bottom, visibleBottom));
  await expect(textarea).toHaveValue("Edited First line\nSecond line\nThird line\nLast line typed");
  await writeFile(
    path.join(artifacts, "short-editor.json"),
    JSON.stringify({ before, last, first }, null, 2),
  );
  await textarea.fill("");
}

async function geometry(page: Page) {
  await waitForLayoutSettled(page, ".shell, .agent-chat__composer-shell");
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) {
        return null;
      }
      const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    return {
      shell: rect(".shell")!,
      body: rect("body")!,
      composer: rect(".agent-chat__composer-shell")!,
      thread: rect(".chat-thread-inner"),
      footer: rect(".chat-footer"),
      context: rect(".chat-footer__context"),
      progress: rect('[data-progress-card-placement="details"]'),
      details: rect(".chat-details:popover-open"),
      conversation: rect(".chat-main__conversation-frame"),
      header: rect(".chat-pane__header"),
      scrollWidth: document.documentElement.scrollWidth,
      layoutHeight: document.documentElement.clientHeight,
      visualHeight: window.visualViewport?.height,
      canvas: getComputedStyle(document.documentElement).getPropertyValue("--shell-canvas-height"),
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
          await activateStandaloneStyles(page);
          await page.evaluate(() => {
            const visit = (rules: CSSRuleList) => {
              for (const rule of rules) {
                if (rule instanceof CSSStyleRule) {
                  const base = rule.style.getPropertyValue("--shell-viewport-base");
                  if (base === "100dvh") {
                    rule.style.setProperty("--shell-viewport-base", "calc(100dvh - 62px)");
                  }
                  if (base === "100lvh") {
                    rule.style.setProperty("--shell-viewport-base", "calc(100lvh + 62px)");
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
          });
          const frame = await geometry(page);
          expect(frame.shell.bottom).toBe(812);
          expect(frame.composer.bottom).toBeLessThanOrEqual(812);
        },
      );
    },
  );

  it.each(scenarios)("keeps $name routes and controls in one usable canvas", async (scenario) => {
    const { name, width, height, mobile } = scenario;
    const top = scenario.top ?? 0;
    const bottom = scenario.bottom ?? 0;
    const left = scenario.left ?? 0;
    const right = scenario.right ?? 0;
    const artifacts = createControlUiE2eArtifactDir(name);
    await suite.withPage(
      { viewport: { width, height }, hasTouch: mobile, isMobile: mobile, colorScheme: "dark" },
      async ({ page, context }) => {
        await page.clock.setFixedTime(new Date("2026-09-20T16:50:10Z"));
        await page.emulateMedia({ reducedMotion: "reduce" });
        if (scenario.standalone) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setSafeAreaInsetsOverride", {
            insets: { top, bottom, left, right },
          });
        }
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "progressCard.get",
            "controlUi.sessionPullRequests.subscribe",
          ],
          methodResponses: { "controlUi.sessionPullRequests.subscribe": { subscribed: true } },
          assistantName: "OpenClaw",
          workspace: "/workspace/example",
          historyMessages: [
            {
              role: "user",
              content: "Please check the mobile layout.",
              timestamp: 1_789_923_000_000,
            },
            {
              role: "assistant",
              content: "The transcript and composer should share a comfortable reading column.",
              timestamp: 1_789_923_001_000,
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "new");
        await expect(page.locator(".new-session-page__message")).toBeVisible();
        if (scenario.standalone) {
          await activateStandaloneStyles(page, scenario.largeUnit ? top : 0);
        }
        const fresh = await geometry(page);
        await page.screenshot({ path: path.join(artifacts, "new.png"), animations: "disabled" });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await expect(textarea).toBeVisible();
        await page
          .getByText("The transcript and composer should share a comfortable reading column.")
          .waitFor();
        if (scenario.standalone) {
          await activateStandaloneStyles(page, scenario.largeUnit ? top : 0);
        }
        await waitForWatchedSessionKey(gateway, "agent:main:main");
        await gateway.emitGatewayEvent("controlUi.sessionPullRequests.changed", {
          sessions: {
            "agent:main:main": {
              pullRequests: [
                {
                  number: 123,
                  owner: "example",
                  repo: "layout",
                  branch: "fix/layout",
                  title: "Synthetic mobile layout repair",
                  url: "https://github.com/example/layout/pull/123",
                  state: "merged",
                },
              ],
              rateLimited: false,
              status: "ok",
            },
          },
        });
        await openDetailsPullRequests(page);
        await expect(page.locator('.chat-pr[data-state="merged"]').first()).toBeVisible();
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey: "agent:main:main",
            revision: 1,
            updatedAt: 1_789_923_001_000,
            markdown: "Mobile layout checks completed.",
            steps: [
              { step: "Inspect the layout", status: "completed" },
              { step: "Verify the controls", status: "completed" },
              { step: "Review the result", status: "completed" },
            ],
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", {
          sessionKey: "agent:main:main",
          revision: 1,
        });
        await expect(page.locator('[data-progress-card-placement="details"]')).toBeVisible();
        const chat = await geometry(page);
        await page.screenshot({ path: path.join(artifacts, "chat.png"), animations: "disabled" });
        await textarea.fill("Please continue the layout check.");
        const sendPoint = await expectReachableAction(
          page,
          "Send message",
          height - bottom,
          mobile,
        );
        // Coordinate input cannot auto-scroll an offscreen control into view.
        if (mobile) {
          await page.touchscreen.tap(sendPoint.x, sendPoint.y);
        } else {
          await page.mouse.click(sendPoint.x, sendPoint.y);
        }
        await gateway.waitForRequest("chat.send");
        const stop = page.getByRole("button", { name: "Stop generating" });
        await expect(stop).toBeVisible();
        const generating = await geometry(page);
        await page.screenshot({
          path: path.join(artifacts, "generating.png"),
          animations: "disabled",
        });
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey: "agent:main:main",
            revision: 2,
            updatedAt: 1_789_923_001_000,
            markdown: "Checking the usable mobile canvas.",
            steps: [
              { step: "Inspect the layout", status: "completed" },
              { step: "Verify the controls", status: "in_progress" },
            ],
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", {
          sessionKey: "agent:main:main",
          revision: 2,
        });
        const progress = page.locator('[data-progress-card-placement="details"]');
        // Sending is an outside click; updates must not reopen Details.
        await expect(progress).toBeHidden();
        await openChatDetails(page);
        await expect(progress).toBeVisible();
        const withProgress = await geometry(page);
        await page.screenshot({
          path: path.join(artifacts, "progress.png"),
          animations: "disabled",
        });
        await page.getByRole("button", { name: "Close details", exact: true }).click();
        const keyboard = [];
        if (mobile) {
          await textarea.focus();
          // Simulate only the browser's VisualViewport contract. No drawn
          // keyboard, clipped screenshot, or claim of native IME reproduction.
          const naturalHeight = height;
          for (const state of [
            { name: "small-browser-bar", height: naturalHeight - 62, offsetTop: 0, scale: 1 },
            { name: "keyboard-open", height: height - 240, offsetTop: 0, scale: 1 },
            { name: "keyboard-pan", height: height - 270, offsetTop: 45, scale: 1 },
            {
              name: "keyboard-dismissed-focus-retained",
              height: naturalHeight,
              offsetTop: 0,
              scale: 1,
            },
            { name: "pinch-zoom", height: height / 2, offsetTop: 35, scale: 2 },
          ]) {
            await visualViewport(page, state.height, state.offsetTop, state.scale);
            keyboard.push({ ...state, geometry: await geometry(page) });
            if (state.name === "keyboard-open" && width > height) {
              await page.screenshot({
                path: path.join(artifacts, "short-editor.png"),
                animations: "disabled",
              });
              await expectEditableDraft(page, state.height + state.offsetTop, artifacts, mobile);
            }
            if (state.scale === 1) {
              await expectReachableAction(
                page,
                "Stop generating",
                state.height + state.offsetTop,
                mobile,
              );
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
          await expectEditableDraft(page, bounds.y + bounds.height, artifacts, mobile);
          await expectReachableAction(page, "Stop generating", bounds.y + bounds.height, mobile);
          await frame.evaluate((element: HTMLElement) => {
            element.style.removeProperty("flex");
          });
        }
        if (mobile && width > height) {
          await visualViewport(page, height - 240);
          const point = await expectReachableAction(page, "Stop generating", height - 240, mobile);
          await page.touchscreen.tap(point.x, point.y);
        } else {
          await stop.click();
        }
        await gateway.waitForRequest("chat.abort");
        if (mobile) {
          await visualViewport(page, height);
        }
        const surfaces: Array<{
          name: string;
          left: number;
          right: number;
          top: number;
          bottom: number;
        }> = [];
        if (mobile) {
          const readSurface = async (selector: string, surfaceName: string) => {
            await waitForLayoutSettled(page, selector);
            const bounds = await page.locator(selector).evaluate((el) => {
              const box = el.getBoundingClientRect();
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
            });
            surfaces.push({ name: surfaceName, ...bounds });
          };
          await page.locator("[data-chat-model-select]").click();
          await expect(page.locator(".chat-controls__model-menu")).toBeVisible();
          await readSurface(".chat-controls__model-menu", "model-menu");
          await page.keyboard.press("Escape");
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
          await expect(page.locator(".shell--nav-drawer-open")).toBeVisible();
          await readSurface(".shell-nav", "drawer");
          await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
          await expect(page.locator(".sidebar-session-filter-panel")).toBeVisible();
          await readSurface(".sidebar-session-filter-panel", "filter-sheet");
          await page.screenshot({
            path: path.join(artifacts, "drawer-filter.png"),
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }
        await writeFile(
          path.join(artifacts, "geometry.json"),
          JSON.stringify(
            { scenario, fresh, chat, generating, withProgress, keyboard, surfaces },
            null,
            2,
          ),
        );
        // Collect captures before the regression assertion so the unfixed entry
        // point is inspectable in exactly the same route, data and viewport.
        expect(chat.layoutHeight).toBe(height);
        expect(chat.visualHeight).toBe(height);
        expect(chat.composer.bottom).toBeLessThanOrEqual(height - bottom);
        expect(chat.shell.top).toBeCloseTo(top, 0);
        expect(chat.shell.bottom).toBeCloseTo(height - bottom, 0);
        expect(generating.scrollWidth).toBeLessThanOrEqual(width);
        if (mobile) {
          expect(fresh.composer.left).toBeCloseTo(generating.composer.left, 0);
          expect(fresh.composer.right).toBeCloseTo(generating.composer.right, 0);
          expect(chat.composer.left).toBeGreaterThanOrEqual(left + 20);
          expect(chat.composer.right).toBeLessThanOrEqual(width - right - 20);
          expect(chat.thread!.left).toBeCloseTo(chat.composer.left, 0);
          expect(chat.thread!.right).toBeCloseTo(chat.composer.right, 0);
          expect(withProgress.details).not.toBeNull();
          expect(withProgress.details!.left).toBeGreaterThanOrEqual(
            withProgress.conversation!.left,
          );
          expect(withProgress.details!.right).toBeLessThanOrEqual(withProgress.conversation!.right);
          expect(withProgress.details!.bottom).toBeLessThanOrEqual(withProgress.footer!.top);
          for (const surface of surfaces) {
            expect(surface.left, surface.name).toBeGreaterThanOrEqual(left);
            expect(surface.right, surface.name).toBeLessThanOrEqual(width - right);
            expect(surface.top, surface.name).toBeGreaterThanOrEqual(top);
            expect(surface.bottom, surface.name).toBeLessThanOrEqual(height);
          }
          for (const state of keyboard) {
            const occluded = state.name === "keyboard-open" || state.name === "keyboard-pan";
            expect(state.geometry.shell.bottom, state.name).toBeCloseTo(
              state.scale !== 1
                ? (scenario.largeUnit ? height + top : height) - bottom
                : state.height + state.offsetTop - (occluded ? 0 : bottom),
              0,
            );
            expect(state.geometry.composer.bottom, state.name).toBeLessThanOrEqual(
              state.geometry.shell.bottom,
            );
          }
        }
      },
    );
  });
});
