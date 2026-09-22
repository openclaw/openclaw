import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  WORKSPACE,
  captureUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const GIT_BRANCHES = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};
const REGISTERED_PROJECT = {
  id: "registered",
  displayName: "Registered",
  repoRoot: "/srv/registered",
  source: "registered",
};

suite.define(() => {
  it.each(["rejected", "unavailable"] as const)(
    "preserves saved worktree intent after %s discovery until retry or explicit opt-out",
    async (result) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          workspace: WORKSPACE,
          workspaceGit: true,
          presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
          featureMethods: [
            "users.prefs.get",
            "users.prefs.set",
            "sessions.create",
            "worktrees.branches",
          ],
          deferredMethods: ["worktrees.branches"],
          methodResponses: {
            "users.prefs.get": {
              status: "ok",
              entries: {
                "new-session.migration.v1": true,
                "new-session.v1:main": { workspace: WORKSPACE, folder: WORKSPACE, worktree: true },
              },
            },
            "users.prefs.set": { status: "ok" },
            "worktrees.branches": GIT_BRANCHES,
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("worktrees.branches");
        const message = page.locator(".new-session-page__message");
        const start = page.getByRole("button", { name: "Start session", exact: true });
        await message.fill("keep this task isolated");
        // Reasoned blocks intentionally accept clicks to explain why Start is gated.
        await start.click({ force: true });
        await message.press("Enter");
        await message.press("Control+Enter");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        const restoring = page
          .locator(".agent-chat__composer-status-text")
          .filter({ hasText: /^Restoring your last session setup…$/ });
        await restoring.waitFor();

        if (result === "rejected") {
          await gateway.rejectDeferred("worktrees.branches", {
            code: "UNAVAILABLE",
            message: "branch lookup unavailable",
          });
        } else {
          await gateway.resolveDeferred("worktrees.branches", {
            repositoryStatus: "unavailable",
            branches: [],
          });
        }
        await restoring.waitFor({ state: "hidden" });
        await captureUiProof(suite, page, `saved-worktree-${result}.png`);
        expect(await start.getAttribute("aria-disabled")).toBe("true");
        const checkout = page.locator("#new-session-checkout-trigger");
        expect(await checkout.getAttribute("data-worktree")).toBe("true");
        await start.click({ force: true });
        await message.press("Enter");
        await message.press("Control+Enter");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        if (result === "rejected") {
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => start.getAttribute("aria-disabled")).toBe("false");
        } else {
          await checkout.click();
          await page.getByRole("button", { name: "Current checkout", exact: true }).click();
          await page.keyboard.press("Escape");
          await expect.poll(() => start.getAttribute("aria-disabled")).toBe("false");
        }
        await start.click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          agentId: "main",
          message: "keep this task isolated",
        });
        if (result === "rejected") {
          expect(create.params).toHaveProperty("worktree", true);
        } else {
          expect(create.params).not.toHaveProperty("worktree");
        }
      });
    },
  );

  it("ignores a restored cloud preference for a write-scoped caller", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const appUrl = new URL(suite.server.baseUrl);
    const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
    const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
    await page.addInitScript(
      ({ key, workspace }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            agents: {
              main: { workspace, folder: workspace, where: { kind: "cloud", id: "aws" } },
            },
          }),
        );
      },
      { key: storageKey, workspace: WORKSPACE },
    );
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      operatorScopes: ["operator.read", "operator.write"],
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "node:writer-runner",
              type: "node",
              label: "Writer runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": GIT_BRANCHES,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const where = page.locator("#new-session-where-trigger");
      await expect.poll(() => where.getAttribute("data-cloud-profile")).toBeNull();
      await where.click();
      const picker = page.locator("wa-popover.new-session-page__where-popover");
      await picker.locator('[data-value="device:writer-runner"]').waitFor();
      expect(await picker.locator('[data-value="cloud:aws"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("start locally");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isEnabled())
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("restores three-chip defaults from local storage without a durable identity", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const appUrl = new URL(suite.server.baseUrl);
    const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
    const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
    await page.addInitScript(
      ({ key, workspace }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            agents: {
              main: {
                workspace,
                folder: workspace,
                where: { kind: "local" },
                projectId: "registered",
                worktree: true,
                baseRef: "release/local",
                worktreeName: "browser-task",
              },
            },
          }),
        );
      },
      { key: storageKey, workspace: WORKSPACE },
    );
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: ["projects.list", "sessions.create", "worktrees.branches"],
      methodResponses: {
        "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
        "worktrees.branches": GIT_BRANCHES,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const project = page.locator("#new-session-project-trigger");
      const checkout = page.locator("#new-session-checkout-trigger");
      await expect.poll(() => project.getAttribute("data-project-id")).toBe("registered");
      await pollLocatorText(project.locator(".new-session-page__trigger-label")).toBe("Registered");
      await expect.poll(() => checkout.getAttribute("data-worktree")).toBe("true");
      await checkout.click();
      await expect
        .poll(() => page.getByLabel("From", { exact: true }).inputValue())
        .toBe("release/local");
      await expect
        .poll(() => page.getByLabel("Name", { exact: true }).inputValue())
        .toBe("browser-task");
      expect(await gateway.getRequests("users.prefs.get")).toHaveLength(0);
      expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("restores identity-scoped Where, What, and Checkout defaults after discovery", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "environments.list",
        "projects.list",
        "sessions.create",
        "users.prefs.get",
        "users.prefs.set",
        "worktrees.branches",
      ],
      methodResponses: {
        "environments.list": {
          environments: [{ id: "gateway", type: "local", status: "available" }],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
        "users.prefs.get": {
          status: "ok",
          entries: {
            "new-session.migration.v1": true,
            "new-session.v1:main": {
              workspace: WORKSPACE,
              folder: WORKSPACE,
              where: { kind: "cloud", id: "aws" },
              projectId: "registered",
              worktree: true,
              baseRef: "release/next",
              worktreeName: "identity-task",
            },
          },
        },
        "users.prefs.set": { status: "ok" },
        "worktrees.branches": GIT_BRANCHES,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("users.prefs.get");
      const where = page.locator("#new-session-where-trigger");
      const project = page.locator("#new-session-project-trigger");
      const checkout = page.locator("#new-session-checkout-trigger");
      await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("aws");
      await pollLocatorText(where.locator(".new-session-page__trigger-label")).toBe("aws");
      await expect.poll(() => project.getAttribute("data-project-id")).toBe("registered");
      await pollLocatorText(project.locator(".new-session-page__trigger-label")).toBe("Registered");
      await expect.poll(() => checkout.getAttribute("data-worktree")).toBe("true");
      await checkout.click();
      const checkoutPopover = page.locator("wa-popover.new-session-page__checkout-popover");
      await expect
        .poll(() => checkoutPopover.getByLabel("From", { exact: true }).inputValue())
        .toBe("release/next");
      await expect
        .poll(() => checkoutPopover.getByLabel("Name", { exact: true }).inputValue())
        .toBe("identity-task");
    } finally {
      await context.close();
    }
  });
});
