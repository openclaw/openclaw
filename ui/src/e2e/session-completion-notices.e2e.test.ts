import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Unattended session completion notices",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
const preference = "ui.notifications.otherSessionsFinished";
const sessionKey = "agent:main:independent-work";

// Event dispatch and Lit rendering finish before asserting a deliberately absent notice.
async function flushRendering(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

suite.define(() => {
  it("opts in through Settings, announces independent and later turns, deduplicates, and opens the exact session", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ id: "synthetic-operator", self: true }],
        sessions: [
          createControlUiSessionRow("agent:main:main", "Planning", 200),
          createControlUiSessionRow(sessionKey, "Independent development task", 100),
        ],
        historyMessages: [{ role: "assistant", content: "Synthetic development proof." }],
        methodResponses: {
          "users.prefs.get": { status: "ok", entries: {} },
          "users.prefs.set": { status: "ok" },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/notifications`);
      const row = page
        .locator(".settings-row--toggle")
        .filter({ hasText: "Notify when other sessions finish" });
      const toggle = row.locator("wa-switch");
      await row.waitFor();
      await expect
        .poll(() =>
          toggle.evaluate((element) => (element as HTMLElement & { disabled: boolean }).disabled),
        )
        .toBe(false);
      const completed = { sessionKey, agentId: "main", runId: "independent-run-1", status: "ok" };
      await gateway.emitGatewayEvent("session.run.completed", completed);
      await flushRendering(page);
      expect(await page.locator(".app-toast").count()).toBe(0);
      await page.screenshot({ path: path.join(suite.artifactDir, "01-before-opt-in.png") });

      await row.locator(".settings-row__title").click();
      const saved = await gateway.waitForRequest("users.prefs.set");
      expect(saved.params).toMatchObject({ entries: { [preference]: true } });
      // Subsequent account refreshes must read the preference that the save committed.
      await gateway.setMethodResponse("users.prefs.get", {
        status: "ok",
        entries: { [preference]: true },
      });
      await expect
        .poll(() =>
          toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(true);
      await gateway.emitGatewayEvent("session.run.completed", completed);
      const toast = page.locator(".app-toast");
      await toast.filter({ hasText: "Independent development task" }).waitFor();
      await page.screenshot({
        path: path.join(suite.artifactDir, "02-after-completion-toast.png"),
      });
      // Both duplicate delivery and shared presentation must produce just one actionable notice.
      await gateway.emitGatewayEvent("session.run.completed", completed);
      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await toast.getByRole("button", { name: "Open session" }).click();
      const opened = await gateway.waitForRequest("chat.startup", { after: startupCount });
      expect(opened.params).toMatchObject({ sessionKey });
      await toast.waitFor({ state: "detached" });
      await flushRendering(page);
      expect(await toast.count()).toBe(0);
      await page.locator(".agent-chat__composer-combobox textarea").first().waitFor();
      await gateway.emitGatewayEvent("session.run.completed", {
        ...completed,
        runId: "visible-run",
      });
      await flushRendering(page);
      expect(await toast.count()).toBe(0);

      // Navigate through the UI so this remains the same connected application owner.
      await page.keyboard.press("Control+Shift+,");
      await page.locator('.settings-sidebar__item[href="/settings/notifications"]').click();
      await row.waitFor();
      // Settings can mount before the retained chat pane finishes its visibility update.
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.querySelectorAll("openclaw-chat-pane")].some(
              (pane) => pane.conversationPresented,
            ),
          ),
        )
        .toBe(false);
      await gateway.emitGatewayEvent("session.run.completed", {
        ...completed,
        runId: "later-run",
        status: "error",
      });
      await toast.filter({ hasText: "Independent development task" }).waitFor();
      expect(await toast.textContent()).toContain("Failed");
      await toast.getByRole("button", { name: "Dismiss" }).click();
      await toast.waitFor({ state: "detached" });
      const saves = (await gateway.getRequests("users.prefs.set")).length;
      await row.locator(".settings-row__title").click();
      expect(
        (await gateway.waitForRequest("users.prefs.set", { after: saves })).params,
      ).toMatchObject({ entries: { [preference]: false } });
      await expect
        .poll(() =>
          toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(false);
      await gateway.emitGatewayEvent("session.run.completed", {
        ...completed,
        runId: "disabled-run",
      });
      await flushRendering(page);
      expect(await toast.count()).toBe(0);
      expect(errors).toEqual([]);
    });
  });
  it("suppresses completions in an unfocused visible split pane", async () => {
    await suite.withPage({ viewport: { width: 1920, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:planning",
        presenceUsers: [{ id: "synthetic-operator", self: true }],
        sessions: [
          createControlUiSessionRow("agent:main:planning", "Planning", 200),
          createControlUiSessionRow(sessionKey, "Independent development task", 100),
          createControlUiSessionRow("agent:main:unattended", "Unattended task", 50),
        ],
        historyMessages: [{ role: "assistant", content: "Synthetic split-pane proof." }],
        methodResponses: { "users.prefs.get": { status: "ok", entries: { [preference]: true } } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:planning"));
      await page.getByRole("button", { name: "Open split view", exact: true }).click();
      await page
        .locator(".chat-split-view__cell")
        .last()
        .getByRole("textbox", { name: "Chat composer" })
        .click();
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      await page
        .locator(".chat-split-view__cell")
        .first()
        .getByRole("textbox", { name: "Chat composer" })
        .click();
      await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(2);
      expect(await page.locator(".chat-split-view__cell").last().textContent()).toContain(
        "Independent development task",
      );
      await gateway.waitForRequest("users.prefs.get", { match: { keys: [preference] } });
      await flushRendering(page);
      await gateway.emitGatewayEvent("session.run.completed", {
        sessionKey,
        agentId: "main",
        runId: "split-visible-run",
        status: "ok",
      });
      await flushRendering(page);
      expect(await page.locator(".app-toast").count()).toBe(0);
      // Positive control: the same app still announces a session absent from both panes.
      await gateway.emitGatewayEvent("session.run.completed", {
        sessionKey: "agent:main:unattended",
        agentId: "main",
        runId: "unattended-run",
        status: "ok",
      });
      await page.locator(".app-toast").filter({ hasText: "Unattended task" }).waitFor();
    });
  });
  it("skips a queued completion after its session becomes visible and advances to the next valid notice", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:planning",
        presenceUsers: [{ id: "synthetic-operator", self: true }],
        sessions: [
          createControlUiSessionRow("agent:main:planning", "Planning", 200),
          createControlUiSessionRow("agent:main:first-completion", "First completed task", 150),
          createControlUiSessionRow(sessionKey, "Independent development task", 100),
          createControlUiSessionRow("agent:main:still-unattended", "Still unattended task", 50),
        ],
        historyMessages: [{ role: "assistant", content: "Synthetic queued-completion proof." }],
        methodResponses: { "users.prefs.get": { status: "ok", entries: { [preference]: true } } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:planning"));
      await page.getByRole("textbox", { name: "Chat composer" }).waitFor();
      await gateway.waitForRequest("users.prefs.get", { match: { keys: [preference] } });
      const completion = { agentId: "main", status: "ok" };
      await gateway.emitGatewayEvent("session.run.completed", {
        ...completion,
        sessionKey: "agent:main:first-completion",
        runId: "first-run",
      });
      const toast = page.locator(".app-toast");
      await toast.filter({ hasText: "First completed task" }).waitFor();
      await toast.hover();
      await gateway.emitGatewayEvent("session.run.completed", {
        ...completion,
        sessionKey,
        runId: "queued-now-visible",
      });
      await gateway.emitGatewayEvent("session.run.completed", {
        ...completion,
        sessionKey: "agent:main:still-unattended",
        runId: "queued-still-valid",
      });
      // Open the middle queued destination through the roster before the first notice clears.
      const startups = (await gateway.getRequests("chat.startup")).length;
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      expect(
        (await gateway.waitForRequest("chat.startup", { after: startups })).params,
      ).toMatchObject({ sessionKey });
      await page.getByRole("textbox", { name: "Chat composer" }).waitFor();
      expect(await toast.textContent()).toContain("First completed task");
      await toast.getByRole("button", { name: "Dismiss" }).click();
      // The stale middle entry must not block FIFO progress until its six-second timeout.
      await expect
        .poll(() => toast.textContent(), { timeout: 2000 })
        .toContain("Still unattended task");
      expect(await toast.textContent()).not.toContain("Independent development task");
      await toast.getByRole("button", { name: "Dismiss" }).click();
      await toast.waitFor({ state: "detached" });
      await flushRendering(page);
      expect(await toast.count()).toBe(0);
    });
  });
});
