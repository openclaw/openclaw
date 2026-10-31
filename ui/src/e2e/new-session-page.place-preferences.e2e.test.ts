import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { NewSessionPreference } from "../pages/new-session/preferences.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  WORKSPACE,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  checkoutBaseRefInput,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  pollAttribute,
  pollValue,
  pollEnabled,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const GIT_BRANCHES = LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"];
const REGISTERED_PROJECT = {
  id: "registered",
  displayName: "Registered",
  repoRoot: "/srv/registered",
  source: "registered",
};

const savedSetup = (setup: NewSessionPreference) => ({
  workspace: WORKSPACE,
  folder: WORKSPACE,
  ...setup,
});
const durablePreferences = (setup: NewSessionPreference) => ({
  status: "ok",
  entries: { "new-session.migration.v1": true, "new-session.v1:main": savedSetup(setup) },
});
async function seedLocalPreferences(page: Page, setup: NewSessionPreference) {
  const url = new URL(suite.server.baseUrl);
  const gateway = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: `openclaw.new-session.preferences.v1:${gatewayOriginScope(gateway)}`,
    value: { agents: { main: savedSetup(setup) } },
  });
}
async function tryBlockedSubmission(page: Page) {
  await page.getByRole("button", { name: "Start session", exact: true }).click({ force: true });
  const message = page.locator(".new-session-page__message");
  await message.press("Enter");
  await message.press("Control+Enter");
}
async function reconnect(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await gateway.setOnline(false);
  await waitForControlUiGatewayReconnecting(page);
  await gateway.setOnline(true);
  await waitForControlUiGatewayReady(page);
}

suite.define(() => {
  it.each([
    { kind: "worktree", result: "rejected" },
    { kind: "worktree", result: "unavailable" },
    { kind: "project", result: "rejected" },
  ] as const)(
    "preserves saved $kind intent after $result discovery until recovery or opt-out",
    async ({ kind, result }) => {
      const page = await openPage();
      const worktree = kind === "worktree";
      const method = worktree ? "worktrees.branches" : "projects.list";
      const messageText = worktree ? "keep this task isolated" : "work in the saved project";
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        ...(worktree ? { workspaceGit: true } : {}),
        presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
        featureMethods: ["users.prefs.get", "users.prefs.set", "sessions.create", method],
        deferredMethods: [method],
        methodResponses: {
          "users.prefs.get": durablePreferences(
            worktree ? { worktree: true } : { projectId: REGISTERED_PROJECT.id },
          ),
          "users.prefs.set": { status: "ok" },
          "worktrees.branches": GIT_BRANCHES,
          ...(!worktree
            ? { "projects.list": { projects: [REGISTERED_PROJECT], recents: [] } }
            : {}),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest(method);
      const message = page.locator(".new-session-page__message");
      const start = page.getByRole("button", { name: "Start session", exact: true });
      const checkout = page.locator("#new-session-checkout-trigger");
      const restoring = page
        .locator(".agent-chat__composer-status-text")
        .filter({ hasText: /^Restoring your last session setup…$/ });
      await message.fill(messageText);
      await (worktree ? tryBlockedSubmission(page) : start.click({ force: true }));
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      if (worktree) {
        await restoring.waitFor();
      }

      if (result === "rejected") {
        await gateway.rejectDeferred(method, {
          code: "UNAVAILABLE",
          message: worktree ? "branch lookup unavailable" : "project lookup unavailable",
        });
      } else {
        await gateway.resolveDeferred(method, { repositoryStatus: "unavailable", branches: [] });
      }
      if (worktree) {
        await restoring.waitFor({ state: "hidden" });
      }
      expect(await start.getAttribute("aria-disabled")).toBe("true");
      if (worktree) {
        expect(await checkout.getAttribute("data-worktree")).toBe("true");
      }
      await tryBlockedSubmission(page);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      if (result === "rejected") {
        await reconnect(page, gateway);
        if (worktree) {
          await pollAttribute(start, "aria-disabled").toBe("false");
        } else {
          await page
            .locator('#new-session-project-trigger[data-project-id="registered"]')
            .waitFor();
        }
      } else {
        await checkout.click();
        await page.getByRole("button", { name: "Current checkout", exact: true }).click();
        await page.keyboard.press("Escape");
        await pollAttribute(start, "aria-disabled").toBe("false");
      }
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        ...(worktree ? { agentId: "main" } : { projectId: "registered" }),
        message: messageText,
      });
      if (worktree && result === "rejected") {
        expect(create.params).toHaveProperty("worktree", true);
      } else if (worktree) {
        expect(create.params).not.toHaveProperty("worktree");
      }
    },
  );

  it("ignores a restored cloud preference without a profile grant", async () => {
    const page = await openPage();
    await seedLocalPreferences(page, { where: { kind: "cloud", id: "aws" } });
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
          dispatchableProfileIds: [],
        },
        "worktrees.branches": GIT_BRANCHES,
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("environments.list");
    const where = page.locator("#new-session-where-trigger");
    await pollAttribute(where, "data-cloud-profile").toBeNull();
    await where.click();
    const picker = page.locator(".oc-popover.new-session-page__where-popover");
    await picker.locator('[data-value="device:writer-runner"]').waitFor();
    expect(await picker.locator('[data-value="cloud:aws"]').count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.locator(".new-session-page__message").fill("start locally");
    await pollEnabled(page.getByRole("button", { name: "Start session" })).toBe(true);
  });

  it.each(["browser", "identity"] as const)(
    "restores Where, What, and Checkout defaults from %s preferences",
    async (storage) => {
      const page = await openPage();
      const identity = storage === "identity";
      const baseRef = identity ? "release/next" : "release/local";
      const worktreeName = identity ? "identity-task" : "browser-task";
      const preference: NewSessionPreference = {
        where: identity ? { kind: "cloud", id: "aws" } : { kind: "local" },
        projectId: "registered",
        worktree: true,
        baseRef,
        worktreeName,
      };
      if (!identity) {
        await seedLocalPreferences(page, preference);
      }
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        ...(identity
          ? { presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }] }
          : {}),
        featureMethods: identity
          ? [
              "chat.metadata",
              "chat.startup",
              "environments.list",
              "projects.list",
              "sessions.create",
              "users.prefs.get",
              "users.prefs.set",
              "worktrees.branches",
            ]
          : ["projects.list", "sessions.create", "worktrees.branches"],
        methodResponses: {
          "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
          "worktrees.branches": GIT_BRANCHES,
          ...(identity
            ? {
                "environments.list": {
                  environments: [{ id: "gateway", type: "local", status: "available" }],
                  profiles: [{ id: "aws", providerId: "crabbox" }],
                },
                "users.prefs.get": durablePreferences(preference),
                "users.prefs.set": { status: "ok" },
              }
            : {}),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const where = page.locator("#new-session-where-trigger");
      const project = page.locator("#new-session-project-trigger");
      const checkout = page.locator("#new-session-checkout-trigger");
      if (identity) {
        await gateway.waitForRequest("users.prefs.get");
        await pollAttribute(where, "data-cloud-profile").toBe("aws");
        await pollLocatorText(where.locator(".new-session-page__trigger-label")).toBe("aws");
      }
      await pollAttribute(project, "data-project-id").toBe("registered");
      await pollLocatorText(project.locator(".new-session-page__trigger-label")).toBe("Registered");
      await pollAttribute(checkout, "data-worktree").toBe("true");
      await checkout.click();
      const fields = identity
        ? page.locator(".oc-popover.new-session-page__checkout-popover")
        : page;
      await pollValue(checkoutBaseRefInput(fields)).toBe(baseRef);
      await pollValue(fields.getByLabel("Name", { exact: true })).toBe(worktreeName);
      if (!identity) {
        expect(await gateway.getRequests("users.prefs.get")).toHaveLength(0);
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
      }
    },
  );
});
