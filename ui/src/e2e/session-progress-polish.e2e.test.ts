import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";
import { expand, parts, styles, updateCard } from "./session-progress.test-support.ts";

const suite = createChatFlowE2eSuite({
  channel: "chromium",
  args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
});
const sessionKey = "agent:main:main";
async function dockHome(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await page.goto(`${suite.server.baseUrl}new`);
  await openProgressHomeDock(page);
  await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
}
const steps = Array.from({ length: 15 }, (_, index) => ({
  step:
    index === 1
      ? "Map the dashboard controls and their behavior across desktop and mobile layouts, including long checklist entries that continue onto a second line"
      : `Verify checklist item ${index + 1}`,
  status: index < 2 ? "completed" : index === 2 ? "in_progress" : "pending",
}));
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
  const details = parts(page, "details");
  await expand(details.card);
  await details.body.waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { gateway, card, details };
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
          const { card, summary, steps: rows, stepText } = parts(page, placement);
          await expand(card);
          const measurements = await rows.evaluateAll((elements) =>
            elements.map((row) => {
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
          expect(Math.max(...measurements.map(({ delta }) => delta))).toBeLessThanOrEqual(1);
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
            await stepText.first().hover();
            expect(await opacity()).toBe("1");
            await page.mouse.move(0, 0);
            await summary.press("Tab");
            await page.keyboard.press("Shift+Tab");
            expect(await summary.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
            expect(await opacity()).toBe("1");
          }
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
        const { gateway, card, details } = await openProgress(page);
        const { card: detailsCard, body: detailsBody } = details;
        const bodyCss = await styles(detailsBody, ["max-height", "overflow-y", "mask-image"]);
        expect(bodyCss).toEqual(["none", "visible", "none"]);
        expect(
          await styles(detailsCard, ["border-top-width", "border-left-width", "border-radius"]),
        ).toEqual(["1px", "0px", "0px"]);
        await dockHome(page, gateway);
        const { card: homeCard, summary, body } = parts(page, "composer");
        await expand(homeCard);
        await summary.focus();
        const [width, color, shadow] = await styles(homeCard, [
          "border-top-width",
          "border-top-color",
          "box-shadow",
        ]);
        expect({ width, shadow }).toEqual({ width: "1px", shadow: "none" });
        expect(color).not.toBe("rgba(0, 0, 0, 0)");
        if (mode === "light") {
          const composerShadow = await page
            .locator("openclaw-home-session .agent-chat__input")
            .evaluate((element) => getComputedStyle(element).boxShadow);
          expect(composerShadow.startsWith(`${color} 0px 0px 0px 1px`)).toBe(true);
        }
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
        await updateCard(gateway, { ...card, revision: 2, steps: steps.slice(0, 1) });
        await expect.poll(mask).toBe("none");
        await updateCard(gateway, { ...card, revision: 3, steps });
        await expect.poll(mask).not.toBe("none");
        await summary.click();
        await summary.click();
        await expect.poll(mask).not.toBe("none");
      });
    },
  );
});
