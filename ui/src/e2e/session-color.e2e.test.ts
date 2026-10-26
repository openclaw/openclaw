import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  focusSessionMenuItem,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const headerPanel = (page: Page) =>
  page.locator("openclaw-chat-header-session-menu .chat-header-session-menu__panel");
const expectFocused = (locator: Locator) =>
  expect
    .poll(() =>
      locator.evaluateAll((elements) =>
        elements.some((element) => element === document.activeElement),
      ),
    )
    .toBe(true);
async function press(page: Page, ...keys: string[]) {
  for (const key of keys) {
    await page.keyboard.press(key);
  }
}
async function openAppearance(page: Page) {
  await openSessionMenuSubmenu(page, "Advanced");
  await openSessionMenuSubmenu(page, "Icon & color");
}
function sessionPatches(gateway: Parameters<typeof waitForPatch>[0], key: string) {
  return (expected: Record<string, unknown>) =>
    waitForPatch(gateway, (params) =>
      Object.entries({ key, ...expected }).every(([field, value]) => params[field] === value),
    );
}

suite.define(() => {
  it.each(["sidebar", "header", "compact"] as const)(
    "keeps appearance controls keyboard-accessible in the %s menu",
    async (surface) => {
      const key = "agent:main:appearance-keyboard";
      const context = await suite.browser.newContext({
        viewport: { width: surface === "compact" ? 560 : 1440, height: 900 },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(key, "Keyboard appearance", Date.now(), { icon: "🦞" }),
          ]),
          "sessions.patch": {},
        },
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
      });
      const patched = sessionPatches(gateway, key);
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const trigger =
          surface === "sidebar"
            ? page.locator(`[data-session-key="${key}"] .sidebar-recent-session__link`)
            : page.locator(".chat-header-session-menu__trigger");
        await trigger.focus();
        await page.keyboard.press(surface === "sidebar" ? "Shift+F10" : "Enter");
        if (surface === "compact") {
          await expect
            .poll(() => headerPanel(page).locator('[role^="menuitem"]:focus').count())
            .toBe(1);
          await focusSessionMenuItem(page, "Advanced");
          await page.keyboard.press("Enter");
          const appearance = page.locator(".session-actions-page").getByRole("button", {
            name: "Icon & color",
            exact: true,
          });
          await appearance.focus();
          await page.keyboard.press("Enter");
        } else {
          await openAppearance(page);
        }
        const picker = page.locator(".session-menu__appearance:visible");
        const focused = () =>
          picker.evaluate(
            (element) => element.querySelector(":focus")?.getAttribute("aria-label") ?? null,
          );
        await expect.poll(focused).toBe("No color");
        if (surface === "compact" && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const directory = createControlUiE2eArtifactDir("native-appearance-focus");
          await writeFile(
            path.join(directory, "focused.png"),
            await takeControlUiViewportScreenshot(page, picker, [button(picker, "No color")]),
          );
          console.info("[native-appearance-focus] capture", directory);
        }
        await page.keyboard.press("Tab");
        await expect.poll(focused).toBe("Red");
        await page.keyboard.press("Enter");
        await patched({ color: "red" });
        await page.keyboard.press("Tab");
        await expect.poll(focused).toBe("Blue");
        await page.keyboard.press("Shift+Tab");
        await expect.poll(focused).toBe("Red");
        await press(page, ...Array.from({ length: 8 }, () => "Tab"));
        await expect.poll(() => picker.locator(".session-menu__icon-choice:focus").count()).toBe(1);
        await press(page, "ArrowRight", "Enter");
        await patched({ icon: "🚀" });
        await page.keyboard.press("Tab");
        const reset = button(picker, "Reset to default");
        const custom = picker.getByRole("textbox", { name: "Custom icon", exact: true });
        if (surface !== "compact") {
          await expectFocused(reset);
          await page.keyboard.press("Shift+Tab");
          const iconCount = await picker.locator(".session-menu__icon-choice").count();
          for (
            let index = 0;
            index < iconCount && (await focused()) !== "Custom icon…";
            index += 1
          ) {
            await page.keyboard.press("ArrowRight");
          }
          await page.keyboard.press("Enter");
        }
        await expect
          .poll(() => custom.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.insertText("✨");
        await press(page, "Tab", "Enter");
        await patched({ icon: "✨" });
        if (surface !== "compact") {
          await press(page, "Shift+Tab", "Escape");
          await expect.poll(focused).toBe("Custom icon…");
        }
        await page.keyboard.press("Tab");
        await expectFocused(reset);
        await page.keyboard.press("Enter");
        await patched({ color: null, icon: null });
        await page.keyboard.press(surface === "compact" ? "Escape" : "Tab");
        await expect.poll(() => picker.count()).toBe(0);
        if (surface === "compact") {
          await expectFocused(trigger);
        }
      } finally {
        await context.close();
      }
    },
  );

  it("clears an optimistic color when the authoritative roster removes it", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ page }) => {
        const key = "agent:main:color-proof";
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          methodResponses: {
            "sessions.list": sessionsListResponse([sessionRow(key, "Design review", Date.now())]),
            "sessions.patch": {},
          },
          featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        const dot = page.locator(".chat-pane__session-title .session-color-dot");
        await row.click({ button: "right" });
        await openAppearance(page);
        await button(page, "Purple").click();
        await sessionPatches(gateway, key)({ color: "purple" });
        await expect
          .poll(() => row.getAttribute("class"))
          .toContain("sidebar-recent-session--colored");
        await dot.waitFor({ state: "visible" });
        expect(await dot.getAttribute("aria-label")).toBe("Session color: Purple");
        const committed = await gateway.getSessionRow(key);
        await gateway.setSessionsListResponse(
          sessionsListResponse([
            {
              ...committed,
              snapshotAt: undefined,
              label: "Design review refreshed",
              color: null,
              updatedAt: committed.updatedAt! + 1,
            },
          ]),
        );
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey: key, color: null });
        // The roster-only label excludes an event-only clear masking stale refresh data.
        await row.getByText("Design review refreshed", { exact: true }).waitFor();
        expect(
          await row.evaluate((element) => element.style.getPropertyValue("--session-color")),
        ).toBe("");
        await expect.poll(() => dot.count()).toBe(0);
        await expect
          .poll(() => row.getAttribute("class"))
          .not.toContain("sidebar-recent-session--colored");
      },
    );
  });
});
