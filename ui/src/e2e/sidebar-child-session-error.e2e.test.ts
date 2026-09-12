import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it.each([
    { width: 1440, touch: false, hiddenMain: true },
    { width: 390, touch: true, hiddenMain: true },
    { width: 1440, touch: false, hiddenMain: false },
    { width: 390, touch: true, hiddenMain: false },
  ])(
    "keeps child-load details out of the session list at $width px (hidden main: $hiddenMain) and retries with accessible controls",
    async ({ width, touch, hiddenMain }) => {
      const artifacts = createControlUiE2eArtifactDir("sidebar-child-error");
      const context = await suite.browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: touch,
        isMobile: touch,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const parent = hiddenMain ? "agent:main:main" : "agent:main:parent";
      const child = "agent:main:subagent:sample";
      const active = "agent:main:sample";
      const rows = [
        sessionRow(parent, "Main", 10, { childSessions: [child] }),
        sessionRow(active, "Retained session", 11),
      ];
      const error = "child session list returned no result";
      try {
        const gateway = await installMockGateway(page, {
          sessionKey: active,
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { spawnedBy: parent },
                  response: { __mockError: { code: "UNAVAILABLE", message: error } },
                },
                { response: sessionsListResponse(rows) },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        if (touch) {
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
        }
        const sidebar = page.locator("openclaw-app-sidebar:visible");
        if (!hiddenMain) {
          await sidebar.locator(`[data-child-session-toggle="${parent}"]`).click();
        }
        const indicator = sidebar.locator("[data-child-session-error]");
        await indicator.waitFor({ state: "attached" });
        await sidebar.getByText("Retained session", { exact: true }).waitFor();
        await page.screenshot({ path: path.join(artifacts, "error-state.png") });
        expect(await sidebar.locator(".callout.danger").count()).toBe(0);
        const trigger = indicator.getByRole("button", {
          name: "Some sessions could not load. Show details",
        });
        const toolbar = sidebar.locator(".sidebar-session-toolbar");
        expect(await toolbar.locator("[data-child-session-error]").count()).toBe(
          hiddenMain ? 1 : 0,
        );
        const list = sidebar.locator(".sidebar-recent-sessions");
        const initialBounds = await list.boundingBox();
        const retry = indicator.getByRole("button", { name: "Retry", exact: true });
        expect(await retry.isVisible()).toBe(false);
        if (touch) {
          await trigger.tap();
        } else {
          await trigger.hover();
          await indicator.locator("openclaw-tooltip[open]").waitFor({ state: "attached" });
          await page.keyboard.press("Escape");
          await trigger.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await indicator.locator("openclaw-tooltip[open]").waitFor({ state: "attached" });
          await page.keyboard.press("Escape");
          await trigger.click();
          await retry.waitFor({ state: "visible" });
          await expect.poll(() => retry.evaluate((el) => el.matches(":focus"))).toBe(true);
          await page.keyboard.press("Escape");
          await retry.waitFor({ state: "hidden" });
          await trigger.press("Enter");
        }
        await retry.waitFor({ state: "visible" });
        if (touch) {
          await toolbar.getByText("Sessions", { exact: true }).tap();
          await retry.waitFor({ state: "hidden" });
          await trigger.tap();
        } else {
          await expect.poll(() => retry.evaluate((el) => el.matches(":focus"))).toBe(true);
          await page.keyboard.press("Escape");
          await retry.waitFor({ state: "hidden" });
          expect(await trigger.evaluate((el) => el.matches(":focus"))).toBe(true);
          await trigger.press("Space");
        }
        await retry.waitFor({ state: "visible" });
        expect(await list.boundingBox()).toEqual(initialBounds);
        await page.screenshot({ path: path.join(artifacts, "details.png") });
        await gateway.setMethodResponse("sessions.list", {
          cases: [
            {
              match: { spawnedBy: parent },
              response: sessionsListResponse([
                sessionRow(child, "Recovered child", 12, { spawnedBy: parent }),
              ]),
            },
            { response: sessionsListResponse(rows) },
          ],
        });
        const before = (await gateway.getRequests("sessions.list")).filter(
          (r) => requireRecord(r.params).spawnedBy === parent,
        ).length;
        if (touch) {
          await retry.tap();
        } else {
          await expect.poll(() => retry.evaluate((el) => el.matches(":focus"))).toBe(true);
          await page.keyboard.press("Enter");
        }
        await indicator.waitFor({ state: "detached" });
        await sidebar.getByText("Recovered child", { exact: true }).waitFor();
        expect(
          (await gateway.getRequests("sessions.list")).filter(
            (r) => requireRecord(r.params).spawnedBy === parent,
          ).length,
        ).toBe(before + 1);
        await page.screenshot({ path: path.join(artifacts, "recovered.png") });
      } finally {
        await context.close();
      }
    },
  );
});
