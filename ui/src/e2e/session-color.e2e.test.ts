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
  sessionMenuSubmenu,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const headerPanel = (page: Page) =>
  page.locator("openclaw-chat-header-session-menu .chat-header-session-menu__panel");
const expectAttribute = (locator: Locator, name: string, value: string) =>
  expect.poll(() => locator.getAttribute(name)).toBe(value);
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
          for (const name of ["Advanced", "Icon & color"]) {
            await focusSessionMenuItem(page, name);
            await page.keyboard.press("Enter");
          }
        } else {
          await openAppearance(page);
        }
        const picker = page.locator(".session-menu__appearance:visible");
        await expect
          .poll(() =>
            picker.evaluate((element) =>
              [
                element.querySelector(".session-menu__icon-picker"),
                element.querySelectorAll(".session-menu__icon-section-label")[2],
              ].map((child) => (child ? getComputedStyle(child).marginTop : null)),
            ),
          )
          .toEqual(["4px", "4px"]);
        const focused = () =>
          picker.evaluate(
            (element) => element.querySelector(":focus")?.getAttribute("aria-label") ?? null,
          );
        await expect.poll(focused).toBe("No color");
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
        await expectFocused(reset);
        await page.keyboard.press("Shift+Tab");
        const iconCount = await picker.locator(".session-menu__icon-choice").count();
        for (let index = 0; index < iconCount && (await focused()) !== "Custom icon…"; index += 1) {
          await page.keyboard.press("ArrowRight");
        }
        await page.keyboard.press("Enter");
        const custom = picker.getByRole("textbox", { name: "Custom icon", exact: true });
        await expect
          .poll(() => custom.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.insertText("✨");
        await press(page, "Tab", "Enter");
        await patched({ icon: "✨" });
        await press(page, "Shift+Tab", "Escape");
        await expect.poll(focused).toBe("Custom icon…");
        await page.keyboard.press("Tab");
        await expectFocused(reset);
        await page.keyboard.press("Enter");
        await patched({ color: null, icon: null });
        await page.keyboard.press("Tab");
        await expect.poll(() => picker.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("sets and clears session colors through desktop and compact menus", async () => {
    const key = "agent:main:color-proof";
    const now = Date.now();
    const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    const proofDir = capture
      ? createControlUiE2eArtifactDir("session-color-web-proof", "/tmp/session-color-web-proof")
      : "";
    const context = await suite.browser.newContext({
      locale: "en-US",
      colorScheme: "dark",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
      recordVideo: capture ? { dir: proofDir, size: { width: 1440, height: 900 } } : undefined,
    });
    const page = await context.newPage();
    const designReview = sessionRow(key, "Design review", now);
    const sessions = [
      designReview,
      { ...sessionRow("agent:main:research", "Research notes", now - 60_000), color: "green" },
      { ...sessionRow("agent:main:release", "Release checklist", now - 120_000), color: "orange" },
    ];
    const text =
      "The design review is ready. Use session colors to keep related conversations easy to find.";
    const gateway = await installMockGateway(page, {
      sessionKey: key,
      historyMessages: [{ role: "assistant", content: [{ type: "text", text }] }],
      methodResponses: {
        "sessions.list": sessionsListResponse(sessions),
        "sessions.patch": {},
      },
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
    });
    const patched = sessionPatches(gateway, key);
    const shot = async (
      name: string,
      surface = page.locator(".shell"),
      content = [page.locator(".chat-pane__session-title")],
    ) => {
      if (capture) {
        await writeFile(
          path.join(proofDir, name),
          await takeControlUiViewportScreenshot(page, surface, content),
        );
      }
    };
    const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
    const dot = page.locator(".chat-pane__session-title .session-color-dot");
    const stripe = () =>
      row.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await row.waitFor({ state: "visible" });
      expect(await row.getAttribute("class")).not.toContain("sidebar-recent-session--colored");
      expect(await dot.count()).toBe(0);
      await shot("before-no-color.png");
      await row.click({ button: "right" });
      await openAppearance(page);
      await button(page, "Purple").click();
      await patched({ color: "purple" });
      await expect
        .poll(() => row.getAttribute("class"))
        .toContain("sidebar-recent-session--colored");
      await dot.waitFor({ state: "visible" });
      expect(await dot.getAttribute("aria-label")).toBe("Session color: Purple");
      expect(await row.getAttribute("style")).toContain("--session-color-purple");
      expect(await row.evaluate((element) => getComputedStyle(element, "::before").width)).toBe(
        "3px",
      );
      const darkStripe = await stripe();
      expect(darkStripe).not.toBe("rgba(0, 0, 0, 0)");
      const picker = page.locator("openclaw-session-menu .session-menu__appearance");
      await button(picker, "book").click();
      await patched({ icon: "book" });
      await expectAttribute(button(picker, "book"), "aria-pressed", "true");
      await expectAttribute(button(picker, "Purple"), "aria-pressed", "true");
      const appearanceSubmenu = sessionMenuSubmenu(menuItem(page, "Icon & color"));
      const appearanceChoices = [button(picker, "Purple"), button(picker, "book")];
      await shot("after-dark-menu.png", appearanceSubmenu, appearanceChoices);
      await page.emulateMedia({ colorScheme: "light" });
      await expectAttribute(page.locator("html"), "data-theme-mode", "light");
      await expect.poll(stripe).not.toBe(darkStripe);
      await shot("after-light-menu.png", appearanceSubmenu, appearanceChoices);
      for (const name of ["Icon & color", "Advanced"]) {
        await page.keyboard.press("Escape");
        await expectAttribute(menuItem(page, name), "aria-expanded", "false");
      }
      await page.keyboard.press("Escape");
      await page.locator("openclaw-session-menu").waitFor({ state: "detached" });

      const committed = await gateway.getSessionRow(key);
      Object.assign(designReview, {
        ...committed,
        // This replaces stored facts; let the next wire read sample its own clock.
        snapshotAt: undefined,
        label: "Design review refreshed",
        color: null,
        icon: "book",
        updatedAt: committed.updatedAt! + 1,
      });
      await gateway.setSessionsListResponse(sessionsListResponse(sessions));
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey: key, color: null });
      // Await the roster-only label so an event-only clear cannot mask a stale refresh color.
      await row.getByText("Design review refreshed", { exact: true }).waitFor();
      expect(
        await row.evaluate((element) => element.style.getPropertyValue("--session-color")),
      ).toBe("");
      await expect.poll(() => dot.count()).toBe(0);
      await expect
        .poll(() => row.getAttribute("class"))
        .not.toContain("sidebar-recent-session--colored");

      await page.setViewportSize({ width: 560, height: 900 });
      await page.locator(".chat-header-session-menu__trigger").click();
      await menuItem(page, "Advanced").click();
      await menuItem(page, "Icon & color").click();
      await button(page, "Blue").click();
      await patched({ color: "blue" });
      await expectAttribute(dot, "aria-label", "Session color: Blue");
      await shot("after-compact-menu.png", headerPanel(page), [button(page, "Blue")]);
      await button(page, "Reset to default").click();
      await patched({ color: null, icon: null });
      await expect.poll(() => dot.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
