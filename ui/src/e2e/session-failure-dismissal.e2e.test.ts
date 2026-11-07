import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session failure dismissal" });

const rejectionMessage = "Couldn't mark as read. Try again. Session store unavailable";

/** Rejects this session’s acknowledgement the way an unavailable session store does. */
async function rejectNextAcknowledgement(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  control: Locator,
  key: string,
) {
  await gateway.deferNext("sessions.patch", { key });
  await control.click();
  await gateway.waitForRequest("sessions.patch", { match: { key } });
  await gateway.rejectDeferred("sessions.patch", {
    code: "UNAVAILABLE",
    message: "Session store unavailable",
  });
}

suite.define(() => {
  it("keeps retry focus and feedback after a partial bulk acknowledgement", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        const now = Date.now();
        const parent = {
          key: "agent:main:panel-parent",
          agentId: "main",
          sessionId: "parent-session",
          kind: "direct",
          label: "Workspace review",
          updatedAt: now,
        } satisfies GatewaySessionRow;
        const failure = {
          key: "agent:main:subagent:retry",
          agentId: "main",
          sessionId: "retry-session",
          kind: "direct",
          classification: "subagent",
          label: "Audit release notes",
          spawnedBy: parent.key,
          parentSessionKey: parent.key,
          status: "failed",
          lastRunError: "You've hit your session limit",
          hasActiveRun: false,
          activeRunIds: [],
          startedAt: now - 70_000,
          endedAt: now - 60_000,
          updatedAt: now - 60_000,
        } satisfies GatewaySessionRow;
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", name: "Preview model", provider: "openai" }],
          sessionKey: parent.key,
          communityInvite: false,
          sessions: [
            parent,
            failure,
            {
              ...failure,
              key: "agent:main:subagent:read",
              sessionId: "read-session",
              label: "Check documentation",
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await openChatSidePanelType(page, "Subagents");
        const panel = page.locator("openclaw-chat-subagents-panel");
        const mark = panel.getByRole("button", {
          name: `Mark ${failure.label} as read`,
          exact: true,
        });
        await mark.waitFor();
        const bulk = panel.getByRole("button", { name: "Mark all as read", exact: true });
        await bulk.focus();
        await rejectNextAcknowledgement(gateway, bulk, failure.key);
        await expect.poll(() => bulk.count()).toBe(0);
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
          .toBe(`Mark ${failure.label} as read`);
        const error = page.locator(".app-toast--error .app-toast__body");
        await expect.poll(() => error.textContent()).toBe(rejectionMessage);

        await mark.click();
        await expect.poll(() => mark.count()).toBe(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(3);
        await expect
          .poll(() => page.locator(".app-toast .app-toast__message").textContent())
          .toBe("Marked as read");
        expect(await error.count()).toBe(0);
        // The acknowledged run stays listed under Failed.
        expect(
          await panel.locator(`[data-session-key="${failure.key}"]`).getAttribute("data-group"),
        ).toBe("failed");
      },
    );
  });

  it("reports a rejected hovercard Dismiss and retries it", async () => {
    const now = Date.now();
    const homeKey = "agent:main:dismiss-retry-home";
    const failedKey = "agent:main:dismiss-retry-failed";
    await suite.withPage(
      { hasTouch: false, ...createControlUiE2eContextOptions() },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
          methodResponses: { "progressCard.get": { card: null } },
          sessionKey: homeKey,
          sessions: [
            { key: homeKey, kind: "direct", label: "Release planning", updatedAt: now },
            {
              key: failedKey,
              sessionId: "dismiss-retry-session",
              kind: "direct",
              label: "Nightly audit",
              status: "failed",
              lastRunError: "You've hit your session limit",
              endedAt: now - 60_000,
              updatedAt: now - 60_000,
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${failedKey}"]`);
        const alerting = () => row.evaluate((element) => element.className);
        await row.waitFor({ state: "visible" });
        await row.hover();
        const dismiss = page
          .locator(".session-progress-hovercard .session-hovercard__error")
          .getByRole("button", { name: "Dismiss", exact: true });
        await dismiss.waitFor({ state: "visible" });
        await rejectNextAcknowledgement(gateway, dismiss, failedKey);
        const error = page.locator(".app-toast--error .app-toast__body");
        await expect.poll(() => error.textContent()).toBe(rejectionMessage);
        await expect.poll(alerting).toContain("sidebar-recent-session--attention-danger");

        await row.hover();
        await dismiss.click();
        await expect.poll(alerting).not.toContain("sidebar-recent-session--attention-danger");
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
        await expect
          .poll(() => page.locator(".app-toast .app-toast__message").textContent())
          .toBe("Marked as read");
        expect(await error.count()).toBe(0);
      },
    );
  });
});
