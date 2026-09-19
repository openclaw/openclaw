import { expect, it } from "vitest";
import { fillComposer } from "../test-helpers/composer-editor.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("starts an empty cloud workspace before the default folder Git check finishes", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:empty-cloud-workspace";
      const message = "Create a new project in an empty workspace";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        workspace: "/home/test/workspace",
        workspaceGit: true,
        heldMethods: ["worktrees.branches"],
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "environments.list": {
            environments: [],
            profiles: [{ id: "aws", providerId: "crabbox" }],
          },
          "worktrees.branches": { repositoryStatus: "not_git", branches: [] },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
          "sessions.dispatch": { placement: { state: "active", generation: 1 } },
          "sessions.send": { runId: "run-empty-workspace", status: "started" },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("worktrees.branches");
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const cloud = page.locator('.new-session-page__where-popover [data-value="cloud:aws"]');
      await expect.poll(() => cloud.isEnabled()).toBe(true);
      await cloud.click();
      await page.keyboard.press("Escape");

      const source = page.locator("#new-session-project-trigger");
      await pollLocatorText(source).toContain("New workspace");
      expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
      await source.click();
      const empty = page.locator('.new-session-page__project-popover [data-value="new-workspace"]');
      await expect.poll(() => empty.getAttribute("aria-pressed")).toBe("true");
      await pollLocatorText(empty).toContain("Start in an empty folder for this session.");
      await empty.click();

      await fillComposer(page.locator(".new-session-page__message"), message);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "",
        titleSource: message,
        worktree: true,
        worktreeSource: "empty",
      });
      for (const field of [
        "cwd",
        "projectId",
        "projectGitUrl",
        "repository",
        "worktreeBaseRef",
        "worktreeName",
      ]) {
        expect(create.params).not.toHaveProperty(field);
      }
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({ key: sessionKey, agentId: "main", profileId: "aws" });
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      await gateway.resolveDeferred("worktrees.branches");
      await gateway.resolveDeferred("sessions.dispatch");
      const send = await gateway.waitForRequest("sessions.send");
      expect(send.params).toMatchObject({ key: sessionKey, agentId: "main", message });
      expect(
        (await gateway.getRequests())
          .map((request) => request.method)
          .filter((method) =>
            ["sessions.create", "sessions.dispatch", "sessions.send"].includes(method),
          ),
      ).toEqual(["sessions.create", "sessions.dispatch", "sessions.send"]);
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
    });
  });
});
