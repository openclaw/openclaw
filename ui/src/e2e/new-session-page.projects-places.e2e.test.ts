import { expect, it } from "vitest";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import {
  createPageOpener,
  deferRecoveryScopeHydration,
} from "./new-session-page.scenario.test-support.ts";
import {
  SESSION_LIST_DEFAULTS,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  WORKSPACE,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  replaceGatewayClient,
  waitForGatewayRecoveryScope,
  pollAttribute,
  pollDisabled,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const gatewayEnvironment = {
  id: "gateway",
  type: "local",
  status: "available",
};
const startupFeatures = (...methods: string[]) => [
  "chat.metadata",
  "chat.startup",
  "sessions.create",
  ...methods,
];
suite.define(() => {
  it("registers a Git checkout from Browse and selects the refreshed project", async () => {
    const page = await openPage();
    const repoRoot = "/recorded/openclaw";
    const registeredProject = {
      id: "recorded-openclaw",
      displayName: "openclaw",
      repoRoot,
      source: "registered",
    };
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: startupFeatures(
        "fs.listDir",
        "projects.list",
        "projects.register",
        "worktrees.branches",
      ),
      methodResponses: {
        "projects.list": {
          sequence: [{ projects: [] }, { projects: [registeredProject] }],
        },
        "projects.register": registeredProject,
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: { path: WORKSPACE, home: "/home/peter", entries: [] },
            },
            {
              match: { path: repoRoot },
              response: { path: repoRoot, parent: "/recorded", home: "/home/peter", entries: [] },
            },
          ],
        },
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("projects.list");
    const trigger = page.locator("#new-session-project-trigger");
    const place = page.locator(".oc-popover.new-session-page__project-popover");
    await trigger.click();
    await place.getByRole("button", { name: "Browse folders" }).click();
    const pathInput = page.locator("input.new-session-page__browser-path");
    await pathInput.fill(repoRoot);
    await pathInput.press("Enter");
    const register = place.getByRole("button", { name: "Register as project" });
    await register.waitFor();

    await register.click();

    const request = await gateway.waitForRequest("projects.register");
    expect(request.params).toEqual({ path: repoRoot });
    await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("openclaw");
    await pollAttribute(trigger, "data-project-id").toBe("recorded-openclaw");
  });

  it("handles a legacy projects-only response for write-scoped operators", async () => {
    const page = await openPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: startupFeatures("projects.list"),
      methodResponses: { "projects.list": { projects: [] } },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("projects.list");
    const place = page.locator(".oc-popover.new-session-page__project-popover");
    await page.locator("#new-session-project-trigger").click();
    await place
      .getByText("Admins can register projects from Browse folders", { exact: true })
      .waitFor();
    expect(await place.getByRole("button", { name: "Register as project" }).count()).toBe(0);
  });

  it.each(["recovery scope", "system info"] as const)(
    "updates Gateway place labels after late %s",
    async (late) => {
      const page = await openPage({
        locale: "en-US",
        serviceWorkers: "block",
      });
      if (late === "recovery scope") {
        // Resolve auth recovery after name discovery to exercise their independent lifetimes.
        await page.addInitScript(deferRecoveryScopeHydration);
      }
      const systemInfo = {
        machineName: "QA-Gateway",
        hostname: "qa-gateway.local",
        platform: "darwin",
      };
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        featureMethods: startupFeatures("system.info", "fs.listDir"),
        heldMethods: late === "system info" ? ["system.info"] : [],
        methodResponses: {
          "system.info": systemInfo,
          "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
          "environments.list": {
            environments: [gatewayEnvironment],
            profiles: [],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("system.info");
      const trigger = page.locator("#new-session-where-trigger");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe(
        late === "system info" ? "Local" : "QA-Gateway",
      );
      const place = page.locator(".oc-popover.new-session-page__where-popover");
      const local = place.locator('[data-value="gateway"]');
      await trigger.click();
      await local.waitFor();
      if (late === "recovery scope") {
        await expect.poll(() => tooltipTitleText(local)).toBe("QA-Gateway Runs on your gateway");
        const catalogRequests = (await gateway.getRequests("environments.list")).length;
        await page.evaluate(() => window.dispatchEvent(new Event("test-release-recovery-scope")));
        await waitForGatewayRecoveryScope(page);
        expect(await gateway.getRequests("environments.list")).toHaveLength(catalogRequests);
      }
      await page.keyboard.press("Escape");
      await page.locator("#new-session-project-trigger").click();
      await page
        .locator(".oc-popover.new-session-page__project-popover")
        .getByRole("button", { name: "Browse folders" })
        .click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await pathInput.fill("");
      if (late === "system info") {
        await pollAttribute(pathInput, "placeholder").toBe("Gateway · local");
        await gateway.resolveDeferred("system.info", systemInfo);
        await expect.poll(() => tooltipTitleText(local)).toBe("QA-Gateway Runs on your gateway");
      }
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("QA-Gateway");
      await pollAttribute(pathInput, "placeholder").toBe("Gateway · QA-Gateway");

      await page.keyboard.press("Escape");
      await replaceGatewayClient(page);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("QA-Gateway");
      await trigger.click();
      await expect.poll(() => tooltipTitleText(local)).toBe("QA-Gateway Runs on your gateway");
    },
  );

  it("keeps and disambiguates recent locations with the same basename", async () => {
    const page = await openPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": { environments: [], profiles: [] },
        "sessions.list": {
          count: 2,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            { key: "agent:main:a", kind: "direct", updatedAt: 2, execCwd: "/a/openclaw" },
            { key: "agent:main:b", kind: "direct", updatedAt: 1, execCwd: "/b/openclaw" },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:recent-collision" },
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("environments.list");
    const trigger = page.locator("#new-session-project-trigger");
    await trigger.click();
    const first = page.locator('[data-value="recent:/a/openclaw"]');
    const second = page.locator('[data-value="recent:/b/openclaw"]');
    await first.waitFor();
    await second.waitFor();
    await pollLocatorText(first.locator(".session-menu__sub")).toBe("a");
    await pollLocatorText(second.locator(".session-menu__sub")).toBe("b");
    const recentValues = await page
      .locator('[data-value^="recent:"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-value")));
    expect(recentValues).toEqual(["recent:/a/openclaw", "recent:/b/openclaw"]);
    await second.click();
    await page.locator(".new-session-page__message").fill("continue in work checkout");
    await page.getByRole("button", { name: "Start session" }).click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      cwd: "/b/openclaw",
      message: "continue in work checkout",
    });
  });

  it("runs directly in a custom non-Git Gateway folder", async () => {
    const page = await openPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"],
        "environments.list": {
          environments: [gatewayEnvironment],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
        "worktrees.branches": {
          cases: [
            {
              match: { repoRoot: WORKSPACE },
              response: LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
            },
            {
              match: { repoRoot: "/home" },
              response: { branches: [], repositoryStatus: "not_git" },
            },
          ],
        },
        "sessions.create": { key: "agent:main:plain-folder" },
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("environments.list");
    const trigger = page.locator("#new-session-project-trigger");
    const place = page.locator(".oc-popover.new-session-page__project-popover");
    await trigger.click();
    await place.getByRole("button", { name: "Browse folders" }).click();
    await page.locator("input.new-session-page__browser-path").fill("/home");
    await page.getByRole("button", { name: "Use this folder" }).click();
    await expect
      .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
      .toEqual({ repoRoot: "/home", includeRepositoryStatus: true });
    await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("home");

    expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
    await page.locator("#new-session-where-trigger").click();
    const where = page.locator(".oc-popover.new-session-page__where-popover");
    const cloud = where.getByRole("button", { name: "aws", exact: true });
    await cloud.waitFor();
    expect(await cloud.isEnabled()).toBe(true);
    await cloud.click();
    await pollAttribute(page.locator("#new-session-where-trigger"), "data-cloud-profile").toBe(
      "aws",
    );
    await page.keyboard.press("Escape");
    await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("home");
    await page.locator(".new-session-page__message").fill("clone and inspect this project");
    await pollDisabled(page.getByRole("button", { name: "Start session" })).toBe(true);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    await page.locator("#new-session-where-trigger").click();
    await where.locator('[data-value="gateway"]').click();
    await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("home");
    await page.getByRole("button", { name: "Start session" }).click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "main",
      cwd: "/home",
      message: "clone and inspect this project",
    });
    expect(create.params).not.toHaveProperty("worktree");
    expect(create.params).not.toHaveProperty("worktreeBaseRef");
    expect(create.params).not.toHaveProperty("worktreeSource");
  });
});
