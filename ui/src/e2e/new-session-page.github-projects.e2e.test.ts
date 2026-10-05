import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  WORKSPACE,
  ONE_PIXEL_PNG_B64,
  captureProjectUiProof,
  captureUiProofEnabled,
  checkoutBaseRefInput,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const remoteSearchResult = {
  credential: "missing",
  projects: [
    {
      name: "openclaw",
      fullName: "openclaw/openclaw",
      description: "Personal AI assistant",
      cloneUrl: "https://github.com/openclaw/openclaw.git",
      webUrl: "https://github.com/openclaw/openclaw",
      defaultBranch: "main",
      private: false,
    },
  ],
};

suite.define(() => {
  it.each([false, true])(
    "dispatches a repository with an explicit worker checkout choice (%s)",
    async (worktree) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const sessionKey = `agent:main:worker-checkout-${worktree}`;
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          workspace: WORKSPACE,
          deferredMethods: ["sessions.dispatch"],
          featureMethods: [
            "projects.list",
            "projects.searchRemote",
            "sessions.create",
            "sessions.dispatch",
            "environments.list",
          ],
          methodResponses: {
            "projects.list": { projects: [] },
            "projects.searchRemote": remoteSearchResult,
            "environments.list": {
              environments: [],
              profiles: [{ id: "aws", providerId: "crabbox" }],
            },
            "sessions.create": { key: sessionKey },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await page.locator("#new-session-where-trigger").click();
        await page
          .locator("wa-popover.new-session-page__where-popover")
          .getByRole("button", { name: "aws", exact: true })
          .click();
        await page.locator("#new-session-project-trigger").click();
        const projects = page.locator("wa-popover.new-session-page__project-popover");
        await projects
          .getByRole("searchbox", { name: "Search projects or paste a Git URL" })
          .fill("openclaw");
        await projects.getByRole("button", { name: /openclaw\/openclaw/u }).click();
        await page.locator("#new-session-checkout-trigger").click();
        const checkout = page.locator("wa-popover.new-session-page__checkout-popover");
        await checkoutBaseRefInput(checkout).waitFor();
        await captureProjectUiProof(suite, page, `repository-checkout-menu-${worktree}.png`);
        const choice = checkout.locator(`[data-value="${worktree ? "worktree" : "checkout"}"]`);
        expect(await choice.count()).toBe(1);
        expect(await choice.isEnabled()).toBe(true);
        await choice.click();
        await page.locator(`#new-session-checkout-trigger[data-worktree="${worktree}"]`).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill("Inspect this worker checkout");
        await page.getByRole("button", { name: "Start session" }).click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({
          repository: { url: "https://github.com/openclaw/openclaw.git", ref: "main" },
          worktree,
        });
        for (const local of [
          "cwd",
          "projectId",
          "projectGitUrl",
          "worktreeBaseRef",
          "worktreeName",
        ]) {
          expect(created.params).not.toHaveProperty(local);
        }
        const dispatch = await gateway.waitForRequest("sessions.dispatch");
        expect(dispatch.params).toMatchObject({ key: sessionKey, profileId: "aws" });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("projects.add")).toHaveLength(0);
      });
    },
  );

  it.each(["saved", "explicit"] as const)(
    "keeps a %s worker selection after late default repository discovery",
    async (source) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          const appUrl = new URL(suite.server.baseUrl);
          const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
          const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
          if (source === "saved") {
            await page.addInitScript((key) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  agents: { main: { where: { kind: "cloud", id: "selected-worker" } } },
                }),
              );
            }, storageKey);
          }
          const gateway = await installMockGateway(page, {
            workspace: WORKSPACE,
            workspaceGit: false,
            agentModel: "openai/gpt-4.1",
            models: [{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }],
            featureMethods: [
              "projects.list",
              "environments.list",
              "sessions.create",
              "sessions.dispatch",
            ],
            deferredMethods: ["projects.list", "sessions.dispatch"],
            methodResponses: {
              "projects.list": {
                projects: [],
                githubHost: "ghe.example.test",
                defaultRepository: {
                  identity: "acme/private-repo",
                  url: "https://ghe.example.test/acme/private-repo.git",
                  ref: "main",
                  profileId: "default-worker",
                },
              },
              "environments.list": {
                environments: [],
                profiles: [
                  { id: "default-worker", providerId: "crabbox" },
                  { id: "selected-worker", providerId: "crabbox" },
                ],
              },
              "sessions.create": { key: "agent:main:late-repository-default" },
            },
          });
          await page.goto(`${suite.server.baseUrl}new`);
          await gateway.waitForRequest("projects.list");
          const where = page.locator("#new-session-where-trigger");
          if (source === "explicit") {
            await where.click();
            await page
              .locator("wa-popover.new-session-page__where-popover")
              .getByRole("button", { name: "selected-worker", exact: true })
              .click();
            await page.keyboard.press("Escape");
          }
          await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("selected-worker");
          await page
            .locator(".new-session-page__message")
            .fill("Inspect the repository on my selected worker");
          await gateway.resolveDeferred("projects.list");
          await pollLocatorText(page.locator("#new-session-project-trigger")).toContain(
            "acme/private-repo",
          );
          await captureProjectUiProof(suite, page, `late-repository-${source}-destination.png`);
          expect(await where.getAttribute("data-cloud-profile")).toBe("selected-worker");
          await page.getByRole("button", { name: "Start session" }).click();
          const created = await gateway.waitForRequest("sessions.create");
          expect(created.params).toMatchObject({
            repository: { url: "https://ghe.example.test/acme/private-repo.git", ref: "main" },
          });
          const dispatched = await gateway.waitForRequest("sessions.dispatch");
          expect(dispatched.params).toMatchObject({ profileId: "selected-worker" });
        },
      );
    },
  );

  it("keeps a pasted SCP repository through catalog refresh and submission", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const cloneUrl = "git@ghe.example.test:acme/private-repo.git";
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: false,
        featureMethods: ["projects.list", "projects.add", "sessions.create"],
        methodResponses: {
          "projects.list": { projects: [], githubHost: "ghe.example.test" },
          "sessions.create": { key: "agent:main:scp-repository" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const project = page.locator("#new-session-project-trigger");
      await project.click();
      const picker = page.locator("wa-popover.new-session-page__project-popover");
      await picker
        .getByRole("searchbox", { name: "Search projects or paste a Git URL" })
        .fill(cloneUrl);
      await picker.locator('[data-value="project-clone-url"]').click();
      await pollLocatorText(project).toContain(cloneUrl);
      const requests = (await gateway.getRequests("projects.list")).length;
      await gateway.emitGatewayEvent("config.changed", {});
      await gateway.waitForRequest("projects.list", { after: requests });
      await page.locator(".new-session-page__message").fill("Inspect this SCP repository");
      await page.getByRole("button", { name: "Start session" }).click();
      const created = await gateway.waitForRequest("sessions.create");
      expect(created.params).toHaveProperty("projectGitUrl", cloneUrl);
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
    });
  });

  it("retires a selected remote repository after a live GitHub host change", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          workspace: WORKSPACE,
          workspaceGit: false,
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }],
          featureMethods: [
            "projects.list",
            "projects.searchRemote",
            "projects.add",
            "sessions.create",
          ],
          methodResponses: {
            "projects.list": { projects: [], githubHost: "a.ghe.example.test" },
            "projects.searchRemote": {
              credential: "configured",
              projects: [
                {
                  name: "private-repo",
                  fullName: "acme/private-repo",
                  private: true,
                  cloneUrl: "https://a.ghe.example.test/acme/private-repo.git",
                  webUrl: "https://a.ghe.example.test/acme/private-repo",
                  defaultBranch: "main",
                },
              ],
            },
            "sessions.create": { key: "agent:main:host-change-proof" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("projects.list");
        await page.locator("#new-session-project-trigger").click();
        const projects = page.locator("wa-popover.new-session-page__project-popover");
        await projects
          .getByRole("searchbox", { name: "Search projects or paste a Git URL" })
          .fill("acme");
        await projects.getByRole("button", { name: /acme\/private-repo/u }).click();
        const selected = page.locator("#new-session-project-trigger");
        await pollLocatorText(selected).toContain("acme/private-repo");
        await page.locator(".new-session-page__message").fill("keep the draft message");
        await captureProjectUiProof(suite, page, "host-switch-before.png");
        const requests = (await gateway.getRequests("projects.list")).length;
        await gateway.setMethodResponse("projects.list", {
          projects: [],
          githubHost: "b.ghe.example.test",
        });
        await gateway.emitGatewayEvent("config.changed", {});
        await gateway.waitForRequest("projects.list", { after: requests });
        await pollLocatorText(selected).not.toContain("acme/private-repo");
        await captureProjectUiProof(suite, page, "host-switch-after.png");
        expect(await page.locator(".new-session-page__message").inputValue()).toBe(
          "keep the draft message",
        );
        await page.getByRole("button", { name: "Start session" }).click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).not.toHaveProperty("projectGitUrl");
        expect(created.params).not.toHaveProperty("repository");
      },
    );
  });

  it("uses the configured repository ref instead of an unrelated saved Gateway branch", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
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
                    baseRef: "gateway/old-branch",
                  },
                },
              }),
            );
          },
          { key: storageKey, workspace: WORKSPACE },
        );
        const gateway = await installMockGateway(page, {
          workspace: WORKSPACE,
          workspaceGit: false,
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }],
          featureMethods: [
            "projects.list",
            "sessions.create",
            "sessions.dispatch",
            "environments.list",
          ],
          methodResponses: {
            "projects.list": {
              projects: [],
              githubHost: "ghe.example.test",
              defaultRepository: {
                identity: "acme/private-repo",
                url: "https://ghe.example.test/acme/private-repo.git",
                ref: "release/current",
                profileId: "qa-worker",
              },
            },
            "environments.list": {
              environments: [],
              profiles: [{ id: "qa-worker", providerId: "crabbox" }],
            },
            "sessions.create": { key: "agent:main:configured-repository-e2e" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await pollLocatorText(page.locator("#new-session-project-trigger")).toContain(
          "acme/private-repo",
        );
        await expect
          .poll(() => page.locator("#new-session-where-trigger").getAttribute("data-cloud-profile"))
          .toBe("qa-worker");
        await page.locator("#new-session-checkout-trigger").click();
        const branch = checkoutBaseRefInput(page);
        await branch.waitFor();
        await captureProjectUiProof(suite, page, "configured-repository-default-ref.png");
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill("inspect the repository");
        await page.getByRole("button", { name: "Start session" }).click();
        const created = await gateway.waitForRequest("sessions.create");
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(suite.artifactDir, "project-registry", "sessions.create.json"),
            JSON.stringify(created.params, null, 2),
          );
        }
        expect(created.params).toMatchObject({
          repository: {
            url: "https://ghe.example.test/acme/private-repo.git",
            ref: "release/current",
          },
          message: "",
        });
        expect(created.params).not.toHaveProperty("projectGitUrl");
      },
    );
  });

  it("offers a worktree for a GitHub result before its checkout exists", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        ...(captureUiProofEnabled
          ? {
              recordVideo: {
                dir: path.join(suite.artifactDir, "project-registry"),
                size: { height: 900, width: 1280 },
              },
              viewport: { height: 900, width: 1280 },
            }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          workspace: WORKSPACE,
          workspaceGit: false,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "projects.add",
            "projects.list",
            "projects.searchRemote",
            "sessions.create",
          ],
          methodResponses: {
            "projects.list": { projects: [] },
            "projects.searchRemote": remoteSearchResult,
            "sessions.create": { key: "agent:main:github-worktree-e2e" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("projects.list");
        await page.locator("#new-session-project-trigger").click();
        const projects = page.locator("wa-popover.new-session-page__project-popover");
        await projects
          .getByRole("searchbox", { name: "Search projects or paste a Git URL" })
          .fill("openclaw");
        await projects.getByRole("button", { name: /openclaw\/openclaw/u }).click();

        await captureProjectUiProof(suite, page, "github-worktree-direct.png");
        const checkout = page.locator("#new-session-checkout-trigger");
        await expect.poll(() => checkout.isVisible()).toBe(true);
        await pollLocatorText(checkout).toContain("Current checkout");
        await checkout.click();
        const checkoutPopover = page.locator("wa-popover.new-session-page__checkout-popover");
        await checkoutPopover
          .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
          .click();
        await expect.poll(() => checkout.getAttribute("data-worktree")).toBe("true");
        await pollLocatorText(checkout.locator(".new-session-page__trigger-label")).toBe(
          "New worktree from main",
        );
        const baseRef = checkoutBaseRefInput(checkoutPopover);
        expect(await baseRef.getAttribute("placeholder")).toBe("From");
        expect(await baseRef.inputValue()).toBe("main");
        expect(await checkoutPopover.locator("datalist option").count()).toBe(0);
        await captureProjectUiProof(suite, page, "github-worktree-selected.png", {
          surface: checkoutPopover.locator('wa-popup [part="popup"]'),
          content: [baseRef],
        });
        await page.locator(".new-session-page__message").fill("inspect the worktree");
        await page.getByRole("button", { name: "Start session" }).click();

        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          projectGitUrl: "https://github.com/openclaw/openclaw.git",
          worktree: true,
          message: "inspect the worktree",
        });
        expect(create.params).not.toHaveProperty("projectId");
        expect(create.params).toHaveProperty("worktreeBaseRef", "main");
        expect(await gateway.getRequests("projects.add")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      },
    );
  });

  it.each([
    { name: "shows workspace preparation in the admitted session", failure: null, worktree: false },
    {
      name: "keeps a project preparation failure actionable in the admitted session",
      failure: "Repository clone failed; verify repository access and try again.",
      worktree: false,
    },
    { name: "shows worktree preparation in the admitted session", failure: null, worktree: true },
    {
      name: "keeps a worktree setup failure actionable in the admitted session",
      failure: "Worktree setup failed; fix the setup command and try again.",
      worktree: true,
    },
  ])("keeps GitHub selection inert and $name", async ({ failure, worktree }) => {
    // Both capture gates share this attempt's screenshots, custody report, and video.
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? path.join(suite.artifactDir, "project-registry")
      : undefined;
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(captureUiProofEnabled || artifactDir
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "project-registry"),
              size: { height: 900, width: 1280 },
            },
            viewport: { height: 900, width: 1280 },
          }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:cloned-project-e2e";
    const sessionId = "cloned-project-session";
    const runId = "run-cloned-project-e2e";
    const message = "inspect the cloned project";
    let releaseChatModule!: () => void;
    let chatModuleRequested = false;
    const chatModuleBlocked = new Promise<void>((resolve) => {
      releaseChatModule = resolve;
    });
    await page.route(
      controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      async (route) => {
        chatModuleRequested = true;
        await chatModuleBlocked;
        await route.continue();
      },
    );
    let releaseMedia!: () => void;
    const mediaBlocked = new Promise<void>((resolve) => {
      releaseMedia = resolve;
    });
    let metadataRequested = false;
    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const metadata = new URL(route.request().url()).searchParams.has("meta");
      metadataRequested ||= metadata;
      await mediaBlocked;
      await route.fulfill(
        metadata
          ? { json: { available: true } }
          : { contentType: "image/png", body: Buffer.from(ONE_PIXEL_PNG_B64, "base64") },
      );
    });
    const acceptedAt = Date.now();
    const pendingInput = {
      id: "accepted-project-input",
      runId,
      acceptedAt,
      state: "queued",
      message: {
        role: "user",
        content: message,
        timestamp: acceptedAt,
        __openclaw: {
          id: "pending:accepted-project-input",
          senderId: "synthetic-author",
          senderName: "Synthetic Author",
          media: [
            {
              url: "media://inbound/synthetic.png",
              contentType: "image/png",
              fileName: "synthetic.png",
            },
          ],
          mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
        },
      },
    };
    const history = {
      messages: [],
      sessionId,
      sessionInfo: {
        key: sessionKey,
        sessionId,
        kind: "direct",
        hasActiveRun: true,
        activeRunIds: [runId],
        status: "running",
      },
      pendingInputs: { items: [pendingInput], total: 1 },
      inFlightRun: {
        runId,
        startedAt: acceptedAt,
        events: [
          {
            runId,
            sessionKey,
            seq: 1,
            stream: "run_status",
            ts: acceptedAt,
            data: { phase: "preparing_workspace" },
          },
        ],
      },
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup"],
      workspace: WORKSPACE,
      workspaceGit: true,
      historyMessages: [],
      presenceUsers: [{ id: "synthetic-author", name: "Synthetic Author", self: true }],
      inFlightRun: {
        runId,
        startedAt: Date.now(),
        events: [
          {
            runId,
            sessionKey,
            seq: 1,
            stream: "run_status",
            ts: Date.now(),
            data: { phase: "preparing_workspace" },
          },
        ],
      },
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: [runId],
        key: sessionKey,
        sessionId,
        kind: "direct",
        status: "running",
      },
      featureMethods: [
        "chat.abort",
        "chat.metadata",
        "chat.send",
        "chat.startup",
        "projects.add",
        "projects.list",
        "projects.searchRemote",
        "sessions.create",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": { projects: [] },
        "projects.searchRemote": remoteSearchResult,
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey, sessionId, runStarted: true, runId },
        "chat.startup": history,
        "chat.history": history,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      const search = place.getByRole("searchbox", {
        name: "Search projects or paste a Git URL",
      });
      await search.fill("openclaw");

      const searchRequest = await gateway.waitForRequest("projects.searchRemote");
      expect(searchRequest.params).toEqual({ query: "openclaw" });
      await place
        .getByText(
          "No Control UI GitHub credential or shared Gateway environment token is configured; public GitHub results only.",
        )
        .waitFor();
      await place.getByRole("button", { name: /openclaw\/openclaw/u }).click();

      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw/openclaw",
      );
      expect(await trigger.getAttribute("data-project-id")).toBeNull();

      if (worktree) {
        const checkoutTrigger = page.locator("#new-session-checkout-trigger");
        await checkoutTrigger.click();
        await page
          .locator("wa-popover.new-session-page__checkout-popover")
          .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
          .click();
        await expect.poll(() => checkoutTrigger.getAttribute("data-worktree")).toBe("true");
        await page.keyboard.press("Escape");
      }

      const permission = page.locator('[data-chat-permission-select="true"]');
      await permission.click();
      await page.locator('[data-chat-permission-option="read-only"]').click();
      await page.locator(".new-session-page__message").fill(message);
      await page.locator(".agent-chat__photo-input").setInputFiles({
        name: "synthetic.png",
        mimeType: "image/png",
        buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      });
      await page.getByRole("img", { name: "synthetic.png" }).waitFor();
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message,
        attachments: [{ type: "image", mimeType: "image/png", content: ONE_PIXEL_PNG_B64 }],
        permissionMode: "read-only",
        projectGitUrl: "https://github.com/openclaw/openclaw.git",
        ...(worktree ? { worktree: true } : {}),
      });
      expect(create.params).not.toHaveProperty("cwd");
      expect(create.params).not.toHaveProperty("projectId");
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);

      await expect.poll(() => chatModuleRequested).toBe(true);
      // The blocked preview module has not rendered; only confirmed navigation
      // may publish the accepted URL once that preview load settles.
      expect(new URL(page.url()).pathname).toBe("/new");
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 1,
        state: "status",
        phase: "preparing_workspace",
      });
      releaseChatModule();
      await waitForCommittedChatRoute(page);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await gateway.waitForRequest("chat.startup");

      const userImage = page.locator(".chat-group.user img.chat-message-image");
      const readImage = () =>
        userImage.evaluate((image) => {
          const element = image as HTMLImageElement;
          return {
            inline: element.src.startsWith("data:image/png;base64,"),
            usable: element.complete && element.naturalWidth > 0,
          };
        });
      await expect.poll(() => page.locator(".chat-group.user").count()).toBe(1);
      await expect.poll(() => userImage.count()).toBe(1);
      await expect.poll(readImage).toEqual({ inline: true, usable: true });
      const transition = await page.evaluateHandle(() => {
        const frames: { users: number; images: number }[] = [];
        let frame: number;
        const observe = () => {
          frames.push({
            users: document.querySelectorAll(".chat-group.user").length,
            images: document.querySelectorAll(".chat-group.user img.chat-message-image").length,
          });
          frame = requestAnimationFrame(observe);
        };
        observe();
        return {
          stop() {
            cancelAnimationFrame(frame);
            return frames;
          },
        };
      });
      await gateway.resolveDeferred("chat.startup");
      await expect.poll(() => metadataRequested).toBe(true);
      const working = page.locator('.chat-working-indicator[role="status"]');
      await pollLocatorText(working).toContain("Preparing workspace…");
      expect(await page.locator(".chat-notice").count()).toBe(0);
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "preparing.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working, userImage]),
        );
      }
      await expect.poll(() => page.locator(".chat-group.user").count()).toBe(1);
      await expect
        .poll(() => page.locator(".chat-group.user img.chat-message-image").count())
        .toBe(1);
      await expect.poll(readImage).toEqual({ inline: true, usable: true });
      const observed = await transition.evaluate(async (sampler) => {
        await new Promise(requestAnimationFrame);
        return sampler.stop();
      });
      await transition.dispose();
      if (artifactDir) {
        await writeFile(path.join(artifactDir, "custody-frames.json"), JSON.stringify(observed));
      }
      expect(observed.length).toBeGreaterThan(1);
      expect(observed.every(({ users, images }) => users === 1 && images === 1)).toBe(true);
      expect(await working.locator(".chat-reading-indicator").count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await captureProjectUiProof(
        suite,
        page,
        worktree ? "worktree-preparing.png" : "project-cloning.png",
      );

      if (worktree) {
        let seq = 1;
        for (const [phase, label] of [
          ["naming_worktree", "Naming worktree…"],
          ["creating_worktree", "Creating worktree…"],
          ["running_setup", "Running setup…"],
        ] as const) {
          await gateway.emitGatewayEvent("chat", {
            runId,
            sessionKey,
            seq: ++seq,
            state: "status",
            phase,
          });
          await pollLocatorText(working).toContain(label);
          expect(await page.locator(".chat-group.user").count()).toBe(1);
        }
        await captureProjectUiProof(suite, page, "worktree-running-setup.png");
      }

      if (!failure) {
        const promoted = {
          ...pendingInput.message,
          __openclaw: {
            ...pendingInput.message["__openclaw"],
            id: pendingInput.id,
            idempotencyKey: `${runId}:user`,
            seq: 4,
          },
        };
        const promotedHistory = {
          ...history,
          messages: [promoted],
          pendingInputs: { items: [], total: 0 },
        };
        await gateway.setMethodResponse("chat.startup", promotedHistory);
        await gateway.setMethodResponse("chat.history", promotedHistory);
        await gateway.setHistoryMessages([promoted]);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          sessionId: history.sessionId,
          agentId: "main",
          hasActiveRun: true,
          messageId: pendingInput.id,
          messageSeq: 4,
          message: promoted,
        });
        const canonicalBubble = page.locator(
          '.chat-bubble[data-entry-id="accepted-project-input"]',
        );
        await canonicalBubble.waitFor();
        await expect.poll(() => canonicalBubble.count()).toBe(1);
        await expect.poll(() => page.locator(".chat-group.user").count()).toBe(1);
        await expect.poll(() => canonicalBubble.locator("img.chat-message-image").count()).toBe(1);
        await navigateInApp(page, "new-session");
        await page.locator(".new-session-page__message").waitFor();
        await page.goBack();
        await waitForCommittedChatRoute(page);
        await canonicalBubble.waitFor();
        await expect.poll(() => page.locator(".chat-group.user").count()).toBe(1);
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, "promoted.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [canonicalBubble]),
          );
        }
        await gateway.emitChatFinal({ runId, sessionKey, text: "Project workspace is ready." });
        await page
          .getByRole("paragraph")
          .filter({ hasText: "Project workspace is ready." })
          .waitFor();
        await expect.poll(() => working.count()).toBe(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        return;
      }

      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 5,
        state: "error",
        errorMessage: failure,
      });
      const alert = page.locator('.chat-error[role="alert"]');
      await pollLocatorText(alert).toContain(failure);
      expect(await gateway.getSessionRow(sessionKey)).toMatchObject({
        activeRunIds: [],
        hasActiveRun: false,
        status: "failed",
      });
      await expect.poll(() => working.count()).toBe(0);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await captureProjectUiProof(
        suite,
        page,
        worktree ? "worktree-setup-failed.png" : "project-cloning-failed.png",
      );

      await composer.fill(message);
      await page.getByRole("button", { name: "Send message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({ sessionKey, message });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
    } finally {
      releaseChatModule();
      releaseMedia();
      await context.close();
    }
  });
});
