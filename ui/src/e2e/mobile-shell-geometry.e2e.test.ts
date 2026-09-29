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
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile shell geometry" });
const scenarios = [
  {
    name: "standalone-short-layout-contract",
    width: 390,
    height: 844,
    mobile: true,
    standalone: true,
    top: 48,
    bottom: 30,
    shortLayout: true,
  },
  { name: "desktop-zero", width: 1440, height: 900, mobile: false },
  { name: "phone-zero", width: 390, height: 844, mobile: true },
  { name: "landscape-zero", width: 844, height: 390, mobile: true },
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

async function activateStandaloneStyles(page: Page, insetDifference = 0) {
  // Contract stress only: Chromium is not an installed iOS PWA. Keep normal
  // browser screenshots separate and do not present these as device repros.
  await page.evaluate(async (shortLayoutInset) => {
    const focused = document.activeElement;
    if (shortLayoutInset && focused instanceof HTMLElement) {
      focused.blur();
    }
    if (shortLayoutInset) {
      const naturalHeight = window.innerHeight - shortLayoutInset;
      Object.defineProperty(document.documentElement, "clientHeight", {
        configurable: true,
        value: naturalHeight,
      });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: naturalHeight });
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        value: naturalHeight,
      });
    }
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          rule.media.mediaText = rule.conditionText.replaceAll(
            "(display-mode: standalone)",
            "(min-width: 0px)",
          );
        }
        if (shortLayoutInset && rule instanceof CSSStyleRule) {
          // OS-unit contract simulation only: dvh shorter than lvh.
          if (
            rule.style.height === "100dvh" ||
            (rule.style.height === "100%" &&
              rule.selectorText
                .split(",")
                .every((selector) => ["html", "body"].includes(selector.trim())))
          ) {
            rule.style.height = "calc(100dvh - " + shortLayoutInset + "px)";
          }
          if (rule.style.getPropertyValue("--shell-viewport-base") === "100dvh") {
            rule.style.setProperty(
              "--shell-viewport-base",
              "calc(100dvh - " + shortLayoutInset + "px)",
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
    if (shortLayoutInset) {
      window.dispatchEvent(new Event("resize"));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      if (focused instanceof HTMLElement) {
        focused.focus({ preventScroll: true });
      }
    }
  }, insetDifference);
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
      progress: rect(".session-progress-card--composer"),
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
          featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
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
          await activateStandaloneStyles(page, scenario.shortLayout ? top : 0);
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
          await activateStandaloneStyles(page, scenario.shortLayout ? top : 0);
        }
        const chat = await geometry(page);
        await page.screenshot({ path: path.join(artifacts, "chat.png"), animations: "disabled" });
        await textarea.fill("Please continue the layout check.");
        await page.getByRole("button", { name: "Send message" }).click();
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
            revision: 1,
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
          revision: 1,
        });
        const progress = page.locator(".session-progress-card").first();
        await expect(progress).toBeVisible();
        const withProgress = await geometry(page);
        await page.screenshot({
          path: path.join(artifacts, "progress.png"),
          animations: "disabled",
        });
        const keyboard = [];
        if (mobile) {
          await textarea.focus();
          // Simulate only the browser's VisualViewport contract. No drawn
          // keyboard, clipped screenshot, or claim of native IME reproduction.
          const naturalHeight = scenario.shortLayout ? height - top : height;
          for (const state of [
            { name: "small-browser-bar", height: naturalHeight - 40, offsetTop: 0, scale: 1 },
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
          }
          await visualViewport(page, height);
          await expect(textarea).toBeFocused();
        }
        await stop.click();
        await gateway.waitForRequest("chat.abort");
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
        if (scenario.shortLayout) {
          expect(chat.layoutHeight).toBe(height - top);
          expect(chat.body.height).toBe(height);
        }
        expect(chat.shell.top).toBeCloseTo(top, 0);
        expect(chat.shell.bottom).toBeCloseTo(height - bottom, 0);
        expect(generating.scrollWidth).toBeLessThanOrEqual(width);
        if (mobile) {
          expect(fresh.composer.left).toBeCloseTo(generating.composer.left, 0);
          expect(fresh.composer.right).toBeCloseTo(generating.composer.right, 0);
          expect(chat.composer.left).toBeGreaterThanOrEqual(left + 16);
          expect(chat.composer.right).toBeLessThanOrEqual(width - right - 16);
          expect(chat.thread!.left).toBeCloseTo(chat.composer.left, 0);
          expect(chat.thread!.right).toBeCloseTo(chat.composer.right, 0);
          if (withProgress.progress) {
            expect(withProgress.progress.left).toBeCloseTo(chat.composer.left, 0);
            expect(withProgress.progress.right).toBeCloseTo(chat.composer.right, 0);
          }
          for (const surface of surfaces) {
            expect(surface.left, surface.name).toBeGreaterThanOrEqual(left);
            expect(surface.right, surface.name).toBeLessThanOrEqual(width - right);
            expect(surface.top, surface.name).toBeGreaterThanOrEqual(top);
            expect(surface.bottom, surface.name).toBeLessThanOrEqual(height);
          }
          for (const state of keyboard) {
            const occluded = state.name === "keyboard-open" || state.name === "keyboard-pan";
            expect(state.geometry.shell.bottom, state.name).toBeCloseTo(
              occluded ? state.height + state.offsetTop : height - bottom,
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
