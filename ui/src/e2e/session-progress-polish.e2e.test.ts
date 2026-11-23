import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatTaskProgress } from "./chat-details.test-support.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

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

async function openProgress(page: Page, active = true) {
  const card = { sessionKey, revision: 1, updatedAt: Date.now(), steps };
  await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
    sessionKey,
    sessionInfo: {
      key: sessionKey,
      hasActiveRun: active,
      activeRunIds: active ? ["polish-run"] : [],
    },
    ...(active ? { inFlightRun: { runId: "polish-run" } } : {}),
    methodResponses: { "progressCard.get": { card } },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const disclosure = await openChatTaskProgress(page);
  if (
    (await disclosure.getAttribute("data-progress-card-placement")) === "details" &&
    (await disclosure.getAttribute("open")) === null
  ) {
    await disclosure.locator("summary").click();
  }
  await disclosure.locator(".task-progress-details__plan").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return disclosure;
}

suite.define(() => {
  it.each([1440, 390])(
    "keeps paused and pending progress markers at their compact size at %i px",
    async (width) => {
      const context = await suite.newBrowserContext({ viewport: { width, height: 1000 } });
      try {
        const page = await context.newPage();
        const details = await openProgress(page, false);
        const size = expect.closeTo(((width === 1440 ? 13 : 12) * 24) / 21.5, 2);
        for (const status of ["paused", "pending"]) {
          const marker = await details
            .locator(`.session-progress-card__step-marker[data-status="${status}"] > svg`)
            .first()
            .evaluate((svg) => {
              const bounds = svg.getBoundingClientRect();
              return [bounds.width, bounds.height, getComputedStyle(svg).strokeWidth];
            });
          expect(marker).toEqual([size, size, "1.5px"]);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
  it.each([
    { width: 1440, touch: false },
    { width: 390, touch: false },
    { width: 390, touch: true },
    { width: 1440, touch: true },
  ])("aligns Details checklists at $width px, touch=$touch", async ({ width, touch }) => {
    const context = await suite.newBrowserContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 2,
      hasTouch: touch,
      isMobile: touch,
    });
    try {
      const page = await context.newPage();
      const details = await openProgress(page);
      const measurements = await details
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
      expect(measurements).toHaveLength(steps.length);
      expect(measurements.some(({ lines }) => lines > 1.5)).toBe(true);
      for (const { delta } of measurements) {
        expect(delta).toBeLessThanOrEqual(1);
      }
      const summary = details.locator(".task-progress-details__summary");
      if ((await details.getAttribute("data-details-page")) === "task-progress") {
        expect(await summary.count()).toBe(0);
        await details.getByRole("button", { name: "Task progress options", exact: true }).waitFor();
      } else {
        expect(await summary.evaluate((el) => getComputedStyle(el, "::before").content)).toBe(
          "none",
        );
        expect(await summary.getAttribute("aria-label")).toBeTruthy();
        expect(await summary.getAttribute("title")).toBeNull();
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["light", "dark"] as const)("keeps Details unmasked in %s", async (mode) => {
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
    try {
      await context.addInitScript(
        ({ key, theme }) => localStorage.setItem(key, JSON.stringify({ theme, themeMode: theme })),
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), theme: mode },
      );
      const page = await context.newPage();
      const detailsCard = await openProgress(page);
      const detailsBody = detailsCard.locator(".task-progress-details__body");
      expect(await detailsBody.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("none");
      expect(await detailsBody.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
      expect(await detailsBody.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      const readerTop = await thread.evaluate((el) => el.scrollTop);
      await detailsCard.locator(".session-progress-card__step").last().scrollIntoViewIfNeeded();
      expect(await detailsBody.evaluate((el) => el.scrollTop)).toBe(0);
      expect(await thread.evaluate((el) => el.scrollTop)).toBe(readerTop);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
