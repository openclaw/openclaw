import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

const suite = createChatFlowE2eSuite({
  channel: "chromium",
  args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
});
const sessionKey = "agent:main:main";
const steps = [
  { step: "Read the project instructions", status: "completed" },
  {
    step: "Map the dashboard controls and their behavior across desktop and mobile layouts, including long checklist entries that continue onto a second line",
    status: "completed",
  },
  { step: "Check the task progress card", status: "in_progress" },
  ...Array.from({ length: 12 }, (_, index) => ({
    step: `Verify checklist item ${index + 4}`,
    status: "pending",
  })),
];

async function openProgress(page: Page) {
  const card = { sessionKey, revision: 1, updatedAt: Date.now(), steps };
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
    sessionKey,
    sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: ["polish-run"] },
    inFlightRun: { runId: "polish-run" },
    methodResponses: { "progressCard.get": { card } },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await openChatDetails(page);
  const disclosure = page.locator('[data-progress-card-placement="details"]');
  await disclosure.waitFor();
  if ((await disclosure.getAttribute("open")) === null) {
    await disclosure.locator("summary").click();
  }
  await disclosure.locator(".session-progress-card__body").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { gateway, card };
}

suite.define(() => {
  it.each([
    { width: 1440, touch: false },
    { width: 390, touch: false },
    { width: 390, touch: true },
    { width: 1440, touch: true },
  ])(
    "aligns Details checklists and retains only Home gesture handles at $width px, touch=$touch",
    async ({ width, touch }) => {
      const context = await suite.newBrowserContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        hasTouch: touch,
        isMobile: touch,
      });
      try {
        const page = await context.newPage();
        const { gateway } = await openProgress(page);
        for (const placement of ["details", "composer"] as const) {
          if (placement === "composer") {
            // A Home dock is suppressed while that same conversation owns the page.
            await page.goto(`${suite.server.baseUrl}new`);
            await openProgressHomeDock(page);
            await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
          }
          const disclosure = page.locator(`[data-progress-card-placement="${placement}"]`);
          await disclosure.waitFor();
          if ((await disclosure.getAttribute("open")) === null) {
            await disclosure.locator("summary").click();
          }
          const measurements = await disclosure
            .locator(".session-progress-card__step")
            .evaluateAll((rows) =>
              rows.map((row) => {
                const marker = row.querySelector(".session-progress-card__step-marker > *")!;
                const text = row.querySelector(".session-progress-card__step-text")!;
                const icon = marker.getBoundingClientRect();
                const bounds = text.getBoundingClientRect();
                const line = Number.parseFloat(getComputedStyle(text).lineHeight);
                return {
                  delta: Math.abs(icon.top + icon.height / 2 - (bounds.top + line / 2)),
                  lines: bounds.height / line,
                };
              }),
            );
          expect(measurements.some(({ lines }) => lines > 1.5)).toBe(true);
          for (const { delta } of measurements) {
            expect(delta).toBeLessThanOrEqual(1);
          }
          const summary = disclosure.locator(".session-progress-card__summary");
          const opacity = () => summary.evaluate((el) => getComputedStyle(el, "::before").opacity);
          await page.mouse.move(0, 0);
          expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(!touch);
          if (placement === "details") {
            expect(await summary.evaluate((el) => getComputedStyle(el, "::before").display)).toBe(
              "none",
            );
          } else {
            expect(await opacity()).toBe(touch ? "1" : "0");
          }
          expect(await summary.getAttribute("aria-label")).toBeTruthy();
          expect(await summary.getAttribute("title")).toBeNull();
          if (!touch && placement === "composer") {
            await summary.hover();
            expect(await opacity()).toBe("1");
            await page.waitForTimeout(650); // Beyond the shared title tooltip's reveal delay.
            expect(await page.getByRole("tooltip").count()).toBe(0);
            await disclosure.locator(".session-progress-card__step-text").first().hover();
            expect(await opacity()).toBe("1");
            await page.mouse.move(0, 0);
            await summary.press("Tab");
            await page.keyboard.press("Shift+Tab");
            expect(await summary.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
            expect(await opacity()).toBe("1");
          }
          await summary.press("Enter");
          expect(await disclosure.getAttribute("open")).toBeNull();
          await summary.press("Space");
          expect(await disclosure.getAttribute("open")).not.toBeNull();
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps Details unmasked and preserves the compact Home unread fade in %s",
    async (mode) => {
      const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
      try {
        await context.addInitScript(
          ({ key, theme }) =>
            localStorage.setItem(key, JSON.stringify({ theme, themeMode: theme })),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), theme: mode },
        );
        const page = await context.newPage();
        const { gateway, card } = await openProgress(page);
        const detailsCard = page.locator('[data-progress-card-placement="details"]');
        const detailsBody = detailsCard.locator(".session-progress-card__body");
        expect(await detailsBody.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("none");
        expect(await detailsBody.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
        expect(await detailsBody.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
        const detailsFrame = await detailsCard.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            top: style.borderTopWidth,
            side: style.borderLeftWidth,
            radius: style.borderRadius,
          };
        });
        expect(detailsFrame).toEqual({ top: "1px", side: "0px", radius: "0px" });
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        const readerTop = await thread.evaluate((el) => el.scrollTop);
        await detailsCard.locator(".session-progress-card__step").last().scrollIntoViewIfNeeded();
        expect(await detailsBody.evaluate((el) => el.scrollTop)).toBe(0);
        expect(await thread.evaluate((el) => el.scrollTop)).toBe(readerTop);
        // Keep the Home identity, but release its full-page presentation before docking.
        await page.goto(`${suite.server.baseUrl}new`);
        await openProgressHomeDock(page);
        await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
        const home = page.locator("openclaw-home-session");
        const disclosure = home.locator('[data-progress-card-placement="composer"]');
        await disclosure.waitFor();
        if ((await disclosure.getAttribute("open")) === null) {
          await disclosure.locator("summary").click();
        }
        await disclosure.locator(".session-progress-card__summary").focus();
        const frame = await disclosure.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            width: style.borderTopWidth,
            color: style.borderTopColor,
            shadow: style.boxShadow,
          };
        });
        expect(frame.width).toBe("1px");
        expect(frame.color).not.toBe("rgba(0, 0, 0, 0)");
        expect(frame.shadow).toBe("none");
        if (mode === "light") {
          const composerShadow = await home
            .locator(".agent-chat__input")
            .evaluate((element) => getComputedStyle(element).boxShadow);
          expect(composerShadow.startsWith(`${frame.color} 0px 0px 0px 1px`)).toBe(true);
        }
        const body = disclosure.locator(".session-progress-card__body");
        const mask = () => body.evaluate((el) => getComputedStyle(el).maskImage);
        const height = () => body.evaluate((el) => el.clientHeight);
        const initialHeight = await height();
        expect(await body.evaluate((el) => el.scrollHeight)).toBeGreaterThan(initialHeight);
        await expect.poll(mask).not.toBe("none");
        await body.hover();
        await page.mouse.wheel(0, 1000);
        await expect.poll(mask).toBe("none");
        expect(await height()).toBe(initialHeight);
        await page.mouse.wheel(0, -1000);
        await expect.poll(mask).not.toBe("none");
        expect(await height()).toBe(initialHeight);
        const revise = async (revision: number, nextSteps: typeof steps) => {
          await gateway.setMethodResponse("progressCard.get", {
            card: { ...card, revision, steps: nextSteps },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision });
        };
        await revise(2, steps.slice(0, 1));
        await expect.poll(mask).toBe("none");
        await revise(3, steps);
        await expect.poll(mask).not.toBe("none");
        await disclosure.locator(".session-progress-card__summary").click();
        await disclosure.locator(".session-progress-card__summary").click();
        await expect.poll(mask).not.toBe("none");
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
