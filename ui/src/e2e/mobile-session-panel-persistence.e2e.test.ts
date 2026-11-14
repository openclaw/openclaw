import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session panel persistence across session navigation",
  startServerBeforeBrowser: true,
});
const firstSession = "agent:main:panel-first";
const secondSession = "agent:main:panel-second";
const transcript = "The workspace notes are ready for review.";

// Both sessions saved an open Files panel, as a desktop visit leaves them.
const savedOpenFiles = {
  columns: [
    {
      id: "side",
      side: "right",
      panels: ["conversation", "workspace"].map((slot) => ({ id: slot, slot })),
      activePanelId: "workspace",
      width: 480,
      height: 360,
    },
  ],
  mainPanelId: "conversation",
  open: true,
};

// A closed mobile sheet keeps its panel mounted below the viewport, so the host
// region's open state is the shown fact there; desktop shows the panel itself.
// Parked session panes stay in the DOM, so only the active pane counts.
async function filesShown(page: Page, mobile: boolean): Promise<boolean> {
  const pane = page.locator(".chat-pane-cache__pane--active");
  const shown = mobile
    ? pane.locator(".sidebar-region--mobile-host[data-mobile-open]")
    : pane.locator('[data-panel-slot="workspace"]:visible');
  return (await shown.count()) > 0;
}

/** Waits out sheet motion, then requires the settled state to hold. */
async function expectFilesSettled(page: Page, mobile: boolean, shown: boolean): Promise<void> {
  await expect.poll(() => filesShown(page, mobile), { timeout: 5_000 }).toBe(shown);
  await page.waitForTimeout(750);
  expect(await filesShown(page, mobile)).toBe(shown);
}

suite.define(() => {
  it.each([
    { presentation: "mobile", viewport: { width: 390, height: 844 }, restored: false },
    { presentation: "desktop", viewport: { width: 1280, height: 900 }, restored: true },
  ])(
    "restores saved open panels on $presentation: $restored",
    async ({ presentation, viewport, restored }) => {
      const mobile = presentation === "mobile";
      await suite.withPage(
        mobile
          ? {
              viewport,
              userAgent:
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
              isMobile: true,
              hasTouch: true,
            }
          : { viewport },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, settings }) => localStorage.setItem(key, JSON.stringify(settings)),
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              settings: {
                sidebarSessionLayouts: {
                  [firstSession]: savedOpenFiles,
                  [secondSession]: savedOpenFiles,
                },
              },
            },
          );
          await installMockGateway(page, {
            sessionKey: firstSession,
            sessions: [
              { key: firstSession, label: "First workspace", kind: "direct", updatedAt: 2 },
              { key: secondSession, label: "Second workspace", kind: "direct", updatedAt: 1 },
            ],
            historyMessages: [{ role: "assistant", content: [{ type: "text", text: transcript }] }],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession));
          await page.getByText(transcript).first().waitFor();
          await expectFilesSettled(page, mobile, restored);

          if (mobile) {
            // A sheet opened in one session stays behind when the user moves on.
            await openChatSidePanelType(page, "Files");
            await page.locator('[data-panel-slot="workspace"]:visible').waitFor();
            await expectFilesSettled(page, mobile, true);
          }
          await navigateToControlUiSession(page, secondSession);
          await page.getByText(transcript).first().waitFor();
          await expectFilesSettled(page, mobile, restored);
          // Returning reuses the first session's retained pane.
          await navigateToControlUiSession(page, firstSession);
          await page.getByText(transcript).first().waitFor();
          await expectFilesSettled(page, mobile, restored);
        },
      );
    },
  );
});
