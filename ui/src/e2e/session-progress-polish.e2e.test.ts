import type { Locator, Page } from "playwright";
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
const summarySelector = ".session-progress-card__summary";
const bodySelector = ".session-progress-card__body";
const stepSelector = ".session-progress-card__step";
const disclosure = (page: Page, placement: string) =>
  page.locator(`[data-progress-card-placement="${placement}"]`);
const styles = (element: Locator, properties: string[], pseudo: string | null = null) =>
  element.evaluate(
    (el, options) => {
      const style = getComputedStyle(el, options.pseudo);
      return options.properties.map((property) => style.getPropertyValue(property));
    },
    { properties, pseudo },
  );
async function expand(card: Locator) {
  await card.waitFor();
  if ((await card.getAttribute("open")) === null) {
    await card.locator("summary").click();
  }
}
async function dockHome(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  // A Home dock is suppressed while that same conversation owns the page.
  await page.goto(`${suite.server.baseUrl}new`);
  await openProgressHomeDock(page);
  await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
}
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
  const cardElement = disclosure(page, "details");
  await expand(cardElement);
  await cardElement.locator(bodySelector).waitFor();
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
      const options = {
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        hasTouch: touch,
        isMobile: touch,
      };
      await suite.withPage(options, async ({ page }) => {
        const { gateway } = await openProgress(page);
        for (const placement of ["details", "composer"] as const) {
          if (placement === "composer") {
            await dockHome(page, gateway);
          }
          const card = disclosure(page, placement);
          await expand(card);
          const measurements = await card.locator(stepSelector).evaluateAll((rows) =>
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
          const summary = card.locator(summarySelector);
          const opacity = async () => (await styles(summary, ["opacity"], "::before"))[0];
          await page.mouse.move(0, 0);
          expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(!touch);
          if (placement === "details") {
            expect(await styles(summary, ["display"], "::before")).toEqual(["none"]);
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
            await card.locator(".session-progress-card__step-text").first().hover();
            expect(await opacity()).toBe("1");
            await page.mouse.move(0, 0);
            await summary.press("Tab");
            await page.keyboard.press("Shift+Tab");
            expect(await summary.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
            expect(await opacity()).toBe("1");
          }
          await summary.press("Enter");
          expect(await card.getAttribute("open")).toBeNull();
          await summary.press("Space");
          expect(await card.getAttribute("open")).not.toBeNull();
        }
      });
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps Details unmasked and preserves the compact Home unread fade in %s",
    async (mode) => {
      const options = { viewport: { width: 1440, height: 900 } };
      await suite.withPage(options, async ({ page, context }) => {
        await context.addInitScript(
          ({ key, theme }) =>
            localStorage.setItem(key, JSON.stringify({ theme, themeMode: theme })),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), theme: mode },
        );
        const { gateway, card } = await openProgress(page);
        const detailsCard = disclosure(page, "details");
        const detailsBody = detailsCard.locator(bodySelector);
        expect(await styles(detailsBody, ["max-height", "overflow-y", "mask-image"])).toEqual([
          "none",
          "visible",
          "none",
        ]);
        expect(
          await styles(detailsCard, ["border-top-width", "border-left-width", "border-radius"]),
        ).toEqual(["1px", "0px", "0px"]);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        const readerTop = await thread.evaluate((el) => el.scrollTop);
        await detailsCard.locator(stepSelector).last().scrollIntoViewIfNeeded();
        expect(await detailsBody.evaluate((el) => el.scrollTop)).toBe(0);
        expect(await thread.evaluate((el) => el.scrollTop)).toBe(readerTop);
        await dockHome(page, gateway);
        const home = page.locator("openclaw-home-session");
        const homeCard = disclosure(page, "composer");
        await expand(homeCard);
        await homeCard.locator(summarySelector).focus();
        const [width, color, shadow] = await styles(homeCard, [
          "border-top-width",
          "border-top-color",
          "box-shadow",
        ]);
        expect(width).toBe("1px");
        expect(color).not.toBe("rgba(0, 0, 0, 0)");
        expect(shadow).toBe("none");
        if (mode === "light") {
          const composerShadow = await home
            .locator(".agent-chat__input")
            .evaluate((element) => getComputedStyle(element).boxShadow);
          expect(composerShadow.startsWith(`${color} 0px 0px 0px 1px`)).toBe(true);
        }
        const body = homeCard.locator(bodySelector);
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
        await homeCard.locator(summarySelector).click();
        await homeCard.locator(summarySelector).click();
        await expect.poll(mask).not.toBe("none");
      });
    },
  );
});
