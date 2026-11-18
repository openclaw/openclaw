import { expect, it } from "vitest";
import { observeLayoutShifts } from "../test-helpers/control-ui-layout-shift.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import {
  createPageOpener,
  deferRecoveryScopeHydration,
} from "./new-session-page.scenario.test-support.ts";
import {
  SESSION_LIST_DEFAULTS,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  WORKSPACE,
  captureUiProof,
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
  it.each([400, 820, 1280])(
    "keeps the composer steady as placement loads at %s px",
    async (width) => {
      const page = await openPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const systemInfo = { machineName: "Atlas", hostname: "atlas.local", platform: "darwin" };
      const agents = LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"];
      const gateway = await installMockGateway(page, {
        featureMethods: startupFeatures("system.info", "worktrees.branches"),
        heldMethods: ["agents.list", "system.info"],
        methodResponses: {
          "agents.list": {
            ...agents,
            agents: [...agents.agents, { id: "review", name: "Review" }],
          },
          "system.info": systemInfo,
          "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("system.info");
      const editor = page.locator(".new-session-page__message");
      const where = page.locator("#new-session-where-trigger .new-session-page__trigger-label");
      const folder = page.locator("#new-session-project-trigger .new-session-page__trigger-label");
      const checkout = page.locator("#new-session-checkout-trigger");
      const placementRows = () =>
        Promise.all(
          ["where", "project", "checkout"].map(async (kind) => {
            const trigger = page.locator(`#new-session-${kind}-trigger`);
            return (await trigger.count()) ? (await trigger.boundingBox())?.y : undefined;
          }),
        );
      await editor.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await captureUiProof(suite, page, `placement-${width}-loading.png`);
      const initial = await editor.boundingBox();
      const pendingLabels = await Promise.all([where.textContent(), folder.textContent()]);
      const pendingRows = width === 400 ? await placementRows() : undefined;
      if (pendingRows) {
        await pollAttribute(checkout, "aria-busy").toBe("true");
        await pollDisabled(checkout).toBe(true);
      }
      const shifts = await observeLayoutShifts(page);

      await gateway.resolveDeferred("agents.list");
      await page.locator(".agent-chat__welcome-name button").waitFor();
      await gateway.resolveDeferred("system.info", systemInfo);
      await pollLocatorText(where).toBe("Atlas");
      await pollLocatorText(folder).toBe("openclaw");
      await pollLocatorText(checkout.locator(".new-session-page__trigger-label")).toBe(
        "Current checkout",
      );
      await captureUiProof(suite, page, `placement-${width}-ready.png`);
      const report = await shifts.evaluate((probe) => probe.read());
      await shifts.evaluate((probe) => probe.stop());
      await shifts.dispose();
      expect(await editor.boundingBox()).toEqual(initial);
      if (pendingRows) {
        expect(await placementRows()).toEqual(pendingRows);
        await pollDisabled(checkout).toBe(false);
      }
      expect(
        report.entries
          .flatMap((entry) => entry.sources)
          .filter(({ node }) => node?.includes("new-session-page__message")),
      ).toEqual([]);
      expect(pendingLabels).toEqual(["", ""]);
    },
  );

  it("removes the loading checkout row for a plain workspace on mobile", async () => {
    const page = await openPage({ viewport: { width: 400, height: 844 } });
    const agents = LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"];
    const gateway = await installMockGateway(page, {
      heldMethods: ["agents.list"],
      methodResponses: {
        "agents.list": {
          ...agents,
          agents: [{ ...agents.agents[0], workspaceGit: false }],
        },
      },
    });
    await page.goto(suite.server.baseUrl + "new");
    await gateway.waitForRequest("agents.list");
    const checkout = page.locator("#new-session-checkout-trigger");
    await pollDisabled(checkout).toBe(true);
    await gateway.resolveDeferred("agents.list");
    await pollLocatorText(
      page.locator("#new-session-project-trigger .new-session-page__trigger-label"),
    ).toBe("openclaw");
    await checkout.waitFor({ state: "detached" });
  });

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
        late === "system info" ? "" : "QA-Gateway",
      );
      const place = page.locator(".oc-popover.new-session-page__where-popover");
      const local = place.locator('[data-value="gateway"]');
      await trigger.click();
      await local.waitFor();
      if (late === "recovery scope") {
        await expect.poll(() => tooltipTitleText(local)).toBe("QA-Gateway Runs on this computer");
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
        await pollAttribute(pathInput, "placeholder").toBe("This computer");
        await gateway.resolveDeferred("system.info", systemInfo);
        await expect.poll(() => tooltipTitleText(local)).toBe("QA-Gateway Runs on this computer");
      }
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("QA-Gateway");
      await pollAttribute(pathInput, "placeholder").toBe("This computer · QA-Gateway");

      await page.keyboard.press("Escape");
      await replaceGatewayClient(page);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("QA-Gateway");
      await trigger.click();
      await expect.poll(() => tooltipTitleText(local)).toBe("QA-Gateway Runs on this computer");
    },
  );

  it("keeps the known Gateway label while refreshing after returning to the tab", async () => {
    const page = await openPage();
    const now = Date.now();
    await page.clock.setFixedTime(now);
    const gateway = await installMockGateway(page, {
      featureMethods: startupFeatures("system.info"),
      methodResponses: { "system.info": { machineName: "Atlas" } },
    });
    await page.goto(suite.server.baseUrl + "new");
    const label = page.locator("#new-session-where-trigger .new-session-page__trigger-label");
    await pollLocatorText(label).toBe("Atlas");
    await gateway.deferNext("system.info");
    const requestCount = (await gateway.getRequests("system.info")).length;
    await page.clock.setFixedTime(now + 11_000);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(async () => (await gateway.getRequests("system.info")).length)
      .toBe(requestCount + 1);
    const pendingLabel = await label.textContent();
    await gateway.resolveDeferred("system.info", { machineName: "Atlas renamed" });
    await pollLocatorText(label).toBe("Atlas renamed");
    expect(pendingLabel).toBe("Atlas");
  });

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

    await expect.poll(() => page.locator("#new-session-checkout-trigger").count()).toBe(0);
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
