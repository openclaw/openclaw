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
      // Take over the browser clock so elapsed time is set explicitly instead of
      // slept through: a slow runner must not decide whether the timer reset. The
      // system time moves while timers keep running, so the startup path still
      // schedules its own work.
      await page.clock.install({ time: Date.now() });
      await page.getByRole("button", { name: "Start session" }).click();
      await gateway.waitForRequest("sessions.dispatch");
      await waitForCommittedChatRoute(page);

      const working = page.locator('.chat-thread .chat-working-indicator[role="status"]');
      const elapsed = working.locator(".chat-working-indicator__elapsed");
      const elapsedStartMs = async (): Promise<number> =>
        await elapsed.evaluate(
          (element) => (element as HTMLElement & { startMs?: unknown }).startMs as number,
        );

      // First attempt: pin the clock five seconds past its start and read the
      // label. Fixed time (not install's ticking clock) keeps the reading exact
      // however long the harness takes to get here.
      await pollLocatorText(working).toContain("Provisioning environment…");
      const firstStartedAt = await elapsedStartMs();
      await page.clock.setFixedTime(firstStartedAt + 5_000);
      await pollLocatorText(elapsed).toContain("5s");
      const firstElapsed = await elapsed.textContent();
      await captureUiProof(suite, page, "01-retry-timer-before-first-attempt.png");

      // The first attempt fails and surfaces the queued-message Retry action.
      await gateway.rejectDeferred("sessions.dispatch", {
        code: "INVALID_REQUEST",
        message: "cloud profile was removed",
      });
      const failedGroup = page.locator(".chat-group.user", { hasText: message });
      await failedGroup.waitFor({ state: "visible" });
      await expect.poll(() => working.count()).toBe(0);

      // Retry starts a new attempt; hold its dispatch so the working indicator is
      // observable again. The elapsed timer must start over instead of continuing
      // the failed attempt's count.
      await gateway.deferNext("sessions.dispatch");
      await failedGroup.getByRole("button", { name: "Retry queued message" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.dispatch")).length)
        .toBe(2);
      await pollLocatorText(working).toContain("Provisioning environment…");
      const retryStartedAt = await elapsedStartMs();
      await page.clock.setFixedTime(retryStartedAt + 1_000);
      await pollLocatorText(elapsed).toContain("1s");
      const retryElapsed = await elapsed.textContent();
      await captureUiProof(suite, page, "02-retry-timer-after-retry.png");

      const parseSeconds = (value: string | null) => {
        const match = value?.trim().match(/^(\d+)\s*s/i);
        return match ? Number(match[1]) : null;
      };
      const first = parseSeconds(firstElapsed);
      const retried = parseSeconds(retryElapsed);
      // The first attempt's five-second reading is exact, and the retried attempt
      // started its own clock after that advance instead of inheriting the failed
      // attempt's start time.
      expect(first).toBe(5);
      expect(retried).toBe(1);
      expect(retryStartedAt - firstStartedAt).toBeGreaterThanOrEqual(5_000);

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
