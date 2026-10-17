import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  closeChatDetails,
  openChatDetails,
  openDetailsPullRequests,
} from "./chat-details.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile shell geometry" });
function viewportScenario(
  name: string,
  width: number,
  height: number,
  insets?: [top: number, bottom: number, left: number, right: number],
  largeUnit = false,
  mobile = true,
) {
  const [top = 0, bottom = 0, left = 0, right = 0] = insets ?? [];
  return {
    name,
    width,
    height,
    mobile,
    standalone: insets !== undefined,
    largeUnit,
    top,
    bottom,
    left,
    right,
  };
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

const saveJson = (artifacts: string, name: string, value: unknown) =>
  writeFile(path.join(artifacts, name + ".json"), JSON.stringify(value, null, 2));
const screenshot = (page: Page, artifacts: string, name: string) =>
  page.screenshot({ path: path.join(artifacts, name + ".png"), animations: "disabled" });

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
  if (mobile) {
    // Compact Send uses the 36px primary target; Chat's existing Stop variant
    // uses the 32px quiet target. Model/effort retain their independent 44px targets.
    const compact = await page
      .locator(".agent-chat__input")
      .evaluate((element) => element.getBoundingClientRect().width <= 560);
    const targetSize = compact && label === "Send message" ? 36 : 32;
    expect([bounds!.width, bounds!.height]).toEqual([targetSize, targetSize]);
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
  // Dense queue/context reachability belongs to chat-footer.e2e.test.ts; this tests the editor.
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
  await screenshot(page, artifacts, "short-editor-typing");

  expect(last.scrollTop).toBeGreaterThan(0);
  await expectReachableAction(page, "Send message", visibleBottom, mobile);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.type("Edited ");
  await waitForLayoutSettled(page, ".agent-chat__composer-combobox textarea");
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => textarea.evaluate((editor) => editor.scrollTop)).toBe(0);
  const first = await measure();
  for (const reading of [last, first]) {
    expect(reading.lineTop).toBeGreaterThanOrEqual(Math.max(reading.top, reading.conversationTop));
    expect(reading.lineBottom).toBeLessThanOrEqual(Math.min(reading.bottom, visibleBottom));
  }
  await expect(textarea).toHaveValue("Edited First line\nSecond line\nThird line\nLast line typed");
  await saveJson(artifacts, "short-editor", { before, last, first });
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
      composer: rect(".agent-chat__composer-shell")!,
      thread: rect(".chat-thread-inner"),
      footer: rect(".chat-footer"),
      details: rect(".chat-details:popover-open"),
      conversation: rect(".chat-main__conversation-frame"),
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
    const { name, width, height, mobile, top, bottom, left, right } = scenario;
    const artifacts = createControlUiE2eArtifactDir(name);
    await suite.withPage(
      { viewport: { width, height }, hasTouch: mobile, isMobile: mobile, colorScheme: "dark" },
      async ({ page, context }) => {
        const reach = (label: string, visibleBottom: number) =>
          expectReachableAction(page, label, visibleBottom, mobile);
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
        await screenshot(page, artifacts, "new");
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await expect(textarea).toBeVisible();
        await page
          .getByText("The transcript and composer should share a comfortable reading column.")
          .waitFor();
        if (scenario.standalone) {
          await activateStandaloneStyles(page, scenario.largeUnit ? top : 0);
        }
        const firstMessage = page.locator(".chat-group.user").first();
        const bubble = firstMessage.locator(".chat-bubble").first();
        const details = page.locator(".chat-pane__layout-trigger");
        const initialFrame = await takeControlUiScreenshotFrame(page, bubble, [details, textarea], {
          animations: "disabled",
        });
        await writeFile(path.join(artifacts, "details-transcript.png"), initialFrame.png);
        await (mobile ? bubble.tap() : bubble.hover());
        const actions = firstMessage.locator(".chat-group-footer-actions");
        await expect(actions.locator(".chat-copy-btn")).toBeVisible();
        const hoverFrame = await takeControlUiScreenshotFrame(page, bubble, [details, actions], {
          animations: "disabled",
        });
        await writeFile(path.join(artifacts, "details-message-actions.png"), hoverFrame.png);
        const detailsBox = (await details.boundingBox())!;
        const transcriptBoxes = await Promise.all([bubble.boundingBox(), actions.boundingBox()]);
        await saveJson(artifacts, "details-geometry", {
          details: detailsBox,
          bubble: transcriptBoxes[0],
          actions: transcriptBoxes[1],
        });
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
        const setProgress = async (
          revision: number,
          markdown: string,
          steps: Array<{ step: string; status: string }>,
        ) => {
          await gateway.setMethodResponse("progressCard.get", {
            card: {
              sessionKey: "agent:main:main",
              revision,
              updatedAt: 1_789_923_001_000,
              markdown,
              steps,
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: "agent:main:main",
            revision,
          });
        };
        await setProgress(1, "Mobile layout checks completed.", [
          { step: "Inspect the layout", status: "completed" },
          { step: "Verify the controls", status: "completed" },
          { step: "Review the result", status: "completed" },
        ]);
        await expect(page.locator('[data-progress-card-placement="details"]')).toBeVisible();
        const chat = await geometry(page);
        await screenshot(page, artifacts, "chat");
        await textarea.fill("Please continue the layout check.");
        const sendPoint = await reach("Send message", height - bottom);
        // Coordinate input cannot auto-scroll an offscreen control into view.
        await (mobile
          ? page.touchscreen.tap(sendPoint.x, sendPoint.y)
          : page.mouse.click(sendPoint.x, sendPoint.y));
        await gateway.waitForRequest("chat.send");
        const stop = page.getByRole("button", { name: "Stop generating" });
        await expect(stop).toBeVisible();
        const generating = await geometry(page);
        await screenshot(page, artifacts, "generating");
        await setProgress(2, "Checking the usable mobile canvas.", [
          { step: "Inspect the layout", status: "completed" },
          { step: "Verify the controls", status: "in_progress" },
        ]);
        const progress = page.locator('[data-progress-card-placement="details"]');
        // Sending is an outside click; updates must not reopen Details.
        await expect(progress).toBeHidden();
        await openChatDetails(page);
        await expect(progress).toBeVisible();
        const withProgress = await geometry(page);
        await screenshot(page, artifacts, "progress");
        await closeChatDetails(page);
        const keyboard = [];
        if (mobile) {
          await textarea.focus();
          // Simulate only the browser's VisualViewport contract. No drawn
          // keyboard, clipped screenshot, or claim of native IME reproduction.
          for (const state of [
            { name: "small-browser-bar", height: height - 62, offsetTop: 0, scale: 1 },
            { name: "keyboard-open", height: height - 240, offsetTop: 0, scale: 1 },
            { name: "keyboard-pan", height: height - 270, offsetTop: 45, scale: 1 },
            {
              name: "keyboard-dismissed-focus-retained",
              height,
              offsetTop: 0,
              scale: 1,
            },
            { name: "pinch-zoom", height: height / 2, offsetTop: 35, scale: 2 },
          ]) {
            await visualViewport(page, state.height, state.offsetTop, state.scale);
            keyboard.push({ ...state, geometry: await geometry(page) });
            if (state.name === "keyboard-open" && width > height) {
              await screenshot(page, artifacts, "short-editor");
              await expectEditableDraft(page, state.height + state.offsetTop, artifacts, mobile);
            }
            if (state.scale === 1) {
              await reach("Stop generating", state.height + state.offsetTop);
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
          await screenshot(page, artifacts, "drawer-filter");
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }
        await saveJson(artifacts, "geometry", {
          scenario,
          fresh,
          chat,
          generating,
          withProgress,
          keyboard,
          surfaces,
        });
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
