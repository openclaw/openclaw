import { expect, it } from "vitest";
import {
  captureUiProof,
  controlUiSessionPath,
  createCloudAgentsListResponse,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("resets the provisioning elapsed timer on Retry", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:retry-timer-e2e";
    const message = "start the retried attempt";
    const gateway = await installMockGateway(page, {
      defaultAgentId: "cloud",
      deferredMethods: ["sessions.dispatch"],
      featureMethods: ["sessions.create", "sessions.dispatch", "chat.startup"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": createCloudAgentsListResponse(),
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey },
        "sessions.list": createdSessionListResult(sessionKey),
        "sessions.describe": { session: {} },
        "chat.history": {
          messages: [],
          sessionInfo: { hasActiveRun: false, status: "done" },
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator("wa-popover.new-session-page__where-popover")
        .getByRole("button", { name: "aws", exact: true })
        .click();
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      await gateway.waitForRequest("sessions.dispatch");
      await waitForCommittedChatRoute(page);

      // First attempt stays in provisioning long enough for the elapsed timer
      // to show a non-zero value from the original start time.
      const working = page.locator('.chat-thread .chat-working-indicator[role="status"]');
      await pollLocatorText(working).toContain("Provisioning environment…");
      await page.waitForTimeout(5_200);
      const firstElapsed = await working.locator(".chat-working-indicator__elapsed").textContent();
      await captureUiProof(suite, page, "01-retry-timer-before-first-attempt.png");

      // The first attempt fails and surfaces the queued-message Retry action.
      await gateway.rejectDeferred("sessions.dispatch", {
        code: "INVALID_REQUEST",
        message: "cloud profile was removed",
      });
      const failedGroup = page.locator(".chat-group.user", { hasText: message });
      await failedGroup.waitFor({ state: "visible" });
      await expect.poll(() => working.count()).toBe(0);

      // Retry starts a new attempt; hold its dispatch so the working
      // indicator is observable again. With the fix the elapsed timer starts
      // over (~0s) instead of continuing the failed attempt's count.
      await gateway.deferNext("sessions.dispatch");
      await failedGroup.getByRole("button", { name: "Retry queued message" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.dispatch")).length)
        .toBe(2);
      await pollLocatorText(working).toContain("Provisioning environment…");
      await page.waitForTimeout(1_100);
      const retryElapsed = await working.locator(".chat-working-indicator__elapsed").textContent();
      await captureUiProof(suite, page, "02-retry-timer-after-retry.png");

      // The retried attempt's elapsed timer must start near zero, not from the
      // first attempt's start time.
      const parseSeconds = (value: string | null) => {
        const match = value?.trim().match(/^(\d+)\s*s/i);
        return match ? Number(match[1]) : null;
      };
      const first = parseSeconds(firstElapsed);
      const retried = parseSeconds(retryElapsed);
      expect(first).not.toBeNull();
      expect(retried).not.toBeNull();
      expect(retried!).toBeLessThan(3);

      expect(page.url()).toContain(controlUiSessionPath(sessionKey));
      await gateway.resolveDeferred("sessions.dispatch", {
        placement: { state: "active", environmentId: "worker-retry" },
      });
      await expect.poll(() => working.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
