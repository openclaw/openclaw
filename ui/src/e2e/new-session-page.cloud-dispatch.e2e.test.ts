import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureUiProof,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("dispatches an optionless cloud profile without a machine override", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:optionless-cloud";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        workspaceGit: true,
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", workspace: WORKSPACE, workspaceGit: true }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "environments.list": {
            environments: [],
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                machines: [
                  { id: "standard", label: "Standard", default: true },
                  { id: "fast", label: "Fast" },
                ],
              },
              { id: "machine0", providerId: "crabbox" },
            ],
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await trigger.click();
      await place.getByRole("button", { name: "aws", exact: true }).click();
      await place.getByRole("button", { name: "Fast", exact: true }).click();
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBe("fast");
      await place.getByRole("button", { name: "machine0", exact: true }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("machine0");
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBeNull();
      await expect
        .poll(() => place.getByRole("button", { name: "machine0", exact: true }).isDisabled())
        .toBe(false);
      await expect.poll(() => place.getByText("Machine", { exact: true }).isVisible()).toBe(false);
      await expect.poll(() => place.locator('[data-value^="machine:"]:visible').count()).toBe(0);
      await captureUiProof(suite, page, "optionless-cloud-profile.png");
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("Use the configured machine size");
      await page.getByRole("button", { name: "Start session" }).click();
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({ key: sessionKey, agentId: "main", profileId: "machine0" });
      await pollLocatorText(page.locator(".chat-thread")).toContain(
        "Use the configured machine size",
      );
      await pollLocatorText(
        page.locator('.chat-thread .chat-working-indicator[role="status"]'),
      ).toContain("Provisioning environment…");
      expect(await page.locator(".agent-chat__composer-status-band").count()).toBe(0);
      await captureUiProof(suite, page, "cloud-provisioning.png");
    });
  });
});
