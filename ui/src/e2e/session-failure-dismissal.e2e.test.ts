import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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

async function capture(page: Page, surface: Locator, name: string) {
  const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
}

/** Rejects the next acknowledgement the way an unavailable session store does. */
async function rejectNextAcknowledgement(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  control: Locator,
) {
  await gateway.deferNext("sessions.patch");
  await control.click();
  await gateway.waitForRequest("sessions.patch");
  await gateway.rejectDeferred("sessions.patch", {
    code: "UNAVAILABLE",
    message: "Session store unavailable",
  });
}

suite.define(() => {
  it("reports a rejected Subagents panel mark as read and retries it from the same control", async () => {
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
          sessions: [parent, failure],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await openChatSidePanelType(page, "Subagents");
        const panel = page.locator("openclaw-chat-subagents-panel");
        const mark = panel.getByRole("button", {
          name: `Mark ${failure.label} as read`,
          exact: true,
        });
        await mark.waitFor();
        await rejectNextAcknowledgement(gateway, mark);
        const error = page.locator(".app-toast--error .app-toast__message");
        await expect.poll(() => error.textContent()).toBe(rejectionMessage);
        expect(await mark.isEnabled()).toBe(true);
        // Park the pointer so a row tooltip does not cover the toast.
        await page.mouse.move(0, 0);
        await capture(page, panel, "panel-mark-read-rejected");

        await mark.click();
        await expect.poll(() => mark.count()).toBe(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
        await expect
          .poll(() => page.locator(".app-toast .app-toast__message").textContent())
          .toBe("Marked as read");
        expect(await error.count()).toBe(0);
        // The acknowledged run stays listed under Failed.
        expect(
          await panel.locator(`[data-session-key="${failure.key}"]`).getAttribute("data-group"),
        ).toBe("failed");
        await page.mouse.move(0, 0);
        await capture(page, panel, "panel-mark-read-retried");
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
        await rejectNextAcknowledgement(gateway, dismiss);
        const error = page.locator(".app-toast--error .app-toast__message");
        await expect.poll(() => error.textContent()).toBe(rejectionMessage);
        await expect.poll(alerting).toContain("sidebar-recent-session--attention-danger");
        await capture(page, page.locator(".shell"), "hovercard-dismiss-rejected");

        await row.hover();
        await dismiss.click();
        await expect.poll(alerting).not.toContain("sidebar-recent-session--attention-danger");
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
        await expect
          .poll(() => page.locator(".app-toast .app-toast__message").textContent())
          .toBe("Marked as read");
        expect(await error.count()).toBe(0);
        await capture(page, page.locator(".shell"), "hovercard-dismiss-retried");
      },
    );
  });
});
