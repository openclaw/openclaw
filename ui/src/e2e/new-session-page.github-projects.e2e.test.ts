import { Buffer } from "node:buffer";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  WORKSPACE,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  ONE_PIXEL_PNG_B64,
  checkoutBaseRefInput,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollEnabled,
  pollLocatorText,
  pollCount,
  pollAttribute,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";
import { environmentProfiles, pollVisible } from "./new-session-shard.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const viewport = { height: 900, width: 1280 };
const projectMethods = ["projects.list", "projects.add", "sessions.create"];
const localRepository = {
  workspace: WORKSPACE,
  workspaceGit: false,
  agentModel: "openai/gpt-4.1",
  models: [{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }],
};

async function selectRemoteProject(page: Page, query: string, name: RegExp) {
  await page.locator("#new-session-project-trigger").click();
  const picker = page.locator(".oc-popover.new-session-page__project-popover");
  await picker.getByRole("searchbox", { name: "Search projects or paste a Git URL" }).fill(query);
  await picker.getByRole("button", { name }).click();
}
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
  it.each(["saved", "explicit", "branch"] as const)(
    "preserves %s choices when discovering a default repository",
    async (source) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const branch = source === "branch";
          const selectedWorker = branch ? "qa-worker" : "selected-worker";
          const defaultWorker = branch ? selectedWorker : "default-worker";
          const ref = branch ? "release/current" : "main";
          const appUrl = new URL(suite.server.baseUrl);
          const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
          const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
          if (source !== "explicit") {
            const preference = branch
              ? {
                  workspace: WORKSPACE,
                  folder: WORKSPACE,
                  where: { kind: "local" },
                  baseRef: "gateway/old-branch",
                }
              : { where: { kind: "cloud", id: selectedWorker } };
            await page.addInitScript(
              ({ key, value }) =>
                localStorage.setItem(key, JSON.stringify({ agents: { main: value } })),
              { key: storageKey, value: preference },
            );
          }
          const gateway = await installMockGateway(page, {
            ...localRepository,
            featureMethods: [
              "projects.list",
              "environments.list",
              "sessions.create",
              "sessions.dispatch",
            ],
            ...(branch ? {} : { deferredMethods: ["projects.list", "sessions.dispatch"] }),
            methodResponses: {
              "projects.list": {
                projects: [],
                githubHost: "ghe.example.test",
                defaultRepository: {
                  identity: "acme/private-repo",
                  url: "https://ghe.example.test/acme/private-repo.git",
                  ref,
                  profileId: defaultWorker,
                },
              },
              "environments.list": branch
                ? environmentProfiles(defaultWorker)
                : environmentProfiles(defaultWorker, selectedWorker),
              "sessions.create": { key: "agent:main:repository-default" },
            },
          });
          await page.goto(`${suite.server.baseUrl}new`);
          await gateway.waitForRequest("projects.list");
          const where = page.locator("#new-session-where-trigger");
          if (source === "explicit") {
            await where.click();
            await page
              .locator(".oc-popover.new-session-page__where-popover")
              .getByRole("button", { name: selectedWorker, exact: true })
              .click();
            await page.keyboard.press("Escape");
          }
          await pollAttribute(where, "data-cloud-profile").toBe(selectedWorker);
          await page.locator(".new-session-page__message").fill("Inspect the repository");
          if (!branch) {
            await gateway.resolveDeferred("projects.list");
          }
          await pollLocatorText(page.locator("#new-session-project-trigger")).toContain(
            "acme/private-repo",
          );
          if (branch) {
            await page.locator("#new-session-checkout-trigger").click();
            await checkoutBaseRefInput(page).waitFor();
            await page.keyboard.press("Escape");
          } else {
            expect(await where.getAttribute("data-cloud-profile")).toBe(selectedWorker);
          }
          await page.getByRole("button", { name: "Start session" }).click();
          const created = await gateway.waitForRequest("sessions.create");
          expect(created.params).toMatchObject({
            repository: { url: "https://ghe.example.test/acme/private-repo.git", ref },
          });
          if (branch) {
            expect(created.params).toMatchObject({ message: "" });
            expect(created.params).not.toHaveProperty("projectGitUrl");
          } else {
            const dispatched = await gateway.waitForRequest("sessions.dispatch");
            expect(dispatched.params).toMatchObject({ profileId: selectedWorker });
          }
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
        featureMethods: projectMethods,
        methodResponses: {
          "projects.list": { projects: [], githubHost: "ghe.example.test" },
          "sessions.create": { key: "agent:main:scp-repository" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const project = page.locator("#new-session-project-trigger");
      await project.click();
      const picker = page.locator(".oc-popover.new-session-page__project-popover");
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
          ...localRepository,
          featureMethods: [...projectMethods, "projects.searchRemote"],
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
        await selectRemoteProject(page, "acme", /acme\/private-repo/u);
        const selected = page.locator("#new-session-project-trigger");
        await pollLocatorText(selected).toContain("acme/private-repo");
        await page.locator(".new-session-page__message").fill("keep the draft message");
        const requests = (await gateway.getRequests("projects.list")).length;
        await gateway.setMethodResponse("projects.list", {
          projects: [],
          githubHost: "b.ghe.example.test",
        });
        await gateway.emitGatewayEvent("config.changed", {});
        await gateway.waitForRequest("projects.list", { after: requests });
        await pollLocatorText(selected).not.toContain("acme/private-repo");
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

  it.each([
    { name: "shows workspace preparation in the admitted session", failure: null, worktree: false },
    {
      name: "keeps a worktree setup failure actionable in the admitted session",
      failure: "Worktree setup failed; fix the setup command and try again.",
      worktree: true,
    },
    { name: "offers a worktree before checkout exists", failure: null, worktree: "missing" },
  ])("keeps GitHub selection inert and $name", async ({ failure, worktree }) => {
    const missingCheckout = worktree === "missing";
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const sessionKey = "agent:main:cloned-project-e2e";
    const sessionId = "cloned-project-session";
    const runId = "run-cloned-project-e2e";
    const message = "inspect the cloned project";
    let chatModuleRequested = false;
    const { promise: chatModuleBlocked, resolve: releaseChatModule } = createDeferred();
    await page.route(
      controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      async (route) => {
        chatModuleRequested = true;
        await chatModuleBlocked;
        await route.continue();
      },
    );
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
      workspaceGit: !missingCheckout,
      historyMessages: [],
      presenceUsers: [{ id: "synthetic-author", name: "Synthetic Author", self: true }],
      inFlightRun: history.inFlightRun,
      sessionInfo: history.sessionInfo,
      featureMethods: [
        ...projectMethods,
        "chat.abort",
        "chat.metadata",
        "chat.send",
        "chat.startup",
        "projects.searchRemote",
        ...(missingCheckout ? [] : ["worktrees.branches"]),
      ],
      methodResponses: {
        "projects.list": { projects: [] },
        "projects.searchRemote": remoteSearchResult,
        ...(missingCheckout
          ? {}
          : {
              "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
            }),
        "sessions.create": { key: sessionKey, sessionId, runStarted: true, runId },
        "chat.startup": history,
        "chat.history": history,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator(".oc-popover.new-session-page__project-popover");
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
        if (missingCheckout) {
          await pollVisible(checkoutTrigger).toBe(true);
          await pollLocatorText(checkoutTrigger).toContain("Current checkout");
        }
        await checkoutTrigger.click();
        await page
          .locator(".oc-popover.new-session-page__checkout-popover")
          .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
          .click();
        await pollAttribute(checkoutTrigger, "data-worktree").toBe("true");
        if (missingCheckout) {
          await pollLocatorText(checkoutTrigger.locator(".new-session-page__trigger-label")).toBe(
            "New worktree from main",
          );
          const popover = page.locator(".oc-popover.new-session-page__checkout-popover");
          const baseRef = checkoutBaseRefInput(popover);
          expect(await baseRef.getAttribute("placeholder")).toBe("From");
          expect(await baseRef.inputValue()).toBe("main");
          expect(await popover.locator("datalist option").count()).toBe(0);
        }
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
      if (missingCheckout) {
        expect(create.params).toHaveProperty("worktreeBaseRef", "main");
      }
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

      await gateway.resolveDeferred("chat.startup");
      const working = page.locator('.chat-working-indicator[role="status"]');
      await pollLocatorText(working).toContain("Preparing workspace…");
      await pollCount(page.locator(".chat-group.user")).toBe(1);
      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);
      expect(await page.locator(".chat-notice").count()).toBe(0);
      expect(await working.locator(".chat-reading-indicator").count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

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
      }

      if (!failure) {
        await gateway.emitChatFinal({ runId, sessionKey, text: "Project workspace is ready." });
        await page
          .getByRole("paragraph")
          .filter({ hasText: "Project workspace is ready." })
          .waitFor();
        await pollCount(working).toBe(0);
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
      await pollCount(working).toBe(0);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await pollEnabled(composer).toBe(true);

      await composer.fill(message);
      await page.getByRole("button", { name: "Send message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({ sessionKey, message });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
    } finally {
      releaseChatModule();
      await context.close();
    }
  });
});
