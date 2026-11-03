import { loadPluginManifest } from "../../../src/plugins/manifest.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { GITHUB_REPOSITORY_PLUGIN } from "../test-helpers/repository-plugin.ts";
const repositoryManifestResult = loadPluginManifest(GITHUB_REPOSITORY_PLUGIN.rootDir);
if (!repositoryManifestResult.ok) throw new Error(repositoryManifestResult.error);
const repositoryManifest = repositoryManifestResult.manifest;
const nativeRepositoryPlugins = [GITHUB_REPOSITORY_PLUGIN];
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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
  captureProjectUiProof,
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
const projectMethods = [
  "projects.list",
  "projects.add",
  "sessions.create",
  "projects.searchRemote",
];
const localRepository = {
  nativePlugins: nativeRepositoryPlugins,
  workspace: WORKSPACE,
  workspaceGit: false,
  agentModel: "openai/gpt-4.1",
  models: [{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }],
};

async function selectRemoteProject(page: Page, query: string, name: RegExp) {
  await page.locator("#new-session-project-trigger").click();
  const picker = page.locator(".oc-popover.new-session-page__project-popover");
  await picker.locator(".header-search__toggle").click();
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
  it("adds independent repository sources without replacing GitHub search or legacy plugin activation", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const legacyPlugin = {
          pluginId: "legacy-fixture",
          name: "Legacy plugin fixture",
          revision: "legacy",
          entryUrl: "/__openclaw__/plugins/control-ui/legacy-fixture/legacy/index.js",
          styles: [],
        };
        const initialCatalog = { revision: "native", plugins: [legacyPlugin], diagnostics: [] };
        const source = {
          pluginId: "example-scm",
          id: "repositories",
          label: "Example Forge",
          searchMethod: "example.repositories.search",
        };
        const pluginProject = {
          name: "plugin-project",
          fullName: "example/plugin-project",
          cloneUrl: "https://code.example.test/example/plugin-project.git",
          webUrl: "https://code.example.test/example/plugin-project",
          private: false,
        };
        await page.route(`**${legacyPlugin.entryUrl}`, (route) =>
          route.fulfill({
            contentType: "text/javascript",
            body: `export default { id: "legacy-fixture", async activate(host) {
            await host.request("fixture.legacyReady", { apiVersion: host.apiVersion });
          } };`,
          }),
        );
        const gateway = await installMockGateway(page, {
          ...localRepository,
          featureMethods: [
            ...projectMethods,
            "projects.searchRemote",
            "plugins.controlUi.list",
            "plugins.controlUi.report",
            source.searchMethod,
          ],
          methodResponses: {
            "projects.list": { projects: [] },
            "projects.searchRemote": remoteSearchResult,
            "plugins.controlUi.list": initialCatalog,
            "plugins.controlUi.report": { ok: true },
            "fixture.legacyReady": { ok: true },
            [source.searchMethod]: { credential: "configured", projects: [pluginProject] },
            "sessions.create": { key: "agent:main:plugin-source" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        const legacy = await gateway.waitForRequest("fixture.legacyReady");
        expect(legacy.params).toEqual({ apiVersion: 1 });
        const trigger = page.locator("#new-session-project-trigger");
        const picker = page.locator(".oc-popover.new-session-page__project-popover");
        await trigger.click();
        await picker.locator(".header-search__toggle").click();
        await picker
          .getByRole("searchbox", { name: "Search projects or paste a Git URL" })
          .fill("plugin");
        const nativeResult = picker.getByRole("button", { name: /openclaw\/openclaw/u });
        await nativeResult.waitFor();
        expect(await gateway.getRequests(source.searchMethod)).toHaveLength(0);
        await captureProjectUiProof(suite, page, "plugin-sources-before.png");
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await picker.waitFor({ state: "hidden" });

        await gateway.setMethodResponse("plugins.controlUi.list", {
          ...initialCatalog,
          revision: "plugin-source",
          repositorySources: [
            ...(repositoryManifest.repositorySources ?? []).map((entry) =>
              Object.assign({ pluginId: "github-repositories" }, entry),
            ),
            source,
          ],
        });
        const catalogs = (await gateway.getRequests("plugins.controlUi.list")).length;
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "plugin-source" });
        await gateway.waitForRequest("plugins.controlUi.list", { after: catalogs });
        await trigger.click();
        await picker.locator(".header-search__toggle").click();
        await picker
          .getByRole("searchbox", { name: "Search projects or paste a Git URL" })
          .fill("plugin");
        const searched = await gateway.waitForRequest(source.searchMethod, {
          match: { query: "plugin" },
        });
        expect(searched.params).toEqual({ query: "plugin" });
        const contributedResult = picker.getByRole("button", { name: /example\/plugin-project/u });
        await contributedResult.waitFor();
        await nativeResult.waitFor();
        await captureProjectUiProof(suite, page, "plugin-sources-after.png");
        await contributedResult.click();
        await page.locator(".new-session-page__message").fill("Inspect this repository");
        await page.getByRole("button", { name: "Start session" }).click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({
          repositorySource: "example-scm/repositories",
          projectGitUrl: pluginProject.cloneUrl,
        });
        expect(await gateway.getRequests("projects.add")).toHaveLength(0);
        expect(await gateway.getRequests("fixture.legacyReady")).toHaveLength(1);
      },
    );
  });

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
              "projects.searchRemote",
              "projects.list",
              "environments.list",
              "sessions.create",
              "sessions.dispatch",
            ],
            ...(branch ? {} : { deferredMethods: ["projects.list", "sessions.dispatch"] }),
            methodResponses: {
              "projects.list": {
                projects: [],
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
        nativePlugins: nativeRepositoryPlugins,
        workspace: WORKSPACE,
        workspaceGit: false,
        featureMethods: projectMethods,
        methodResponses: {
          "projects.list": { projects: [] },
          "projects.searchRemote": {
            credential: "configured",
            projects: [
              {
                name: "private-repo",
                fullName: "acme/private-repo",
                cloneUrl,
                webUrl: "https://ghe.example.test/acme/private-repo",
                private: true,
              },
            ],
          },
          "sessions.create": { key: "agent:main:scp-repository" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const project = page.locator("#new-session-project-trigger");
      await project.click();
      const picker = page.locator(".oc-popover.new-session-page__project-popover");
      await picker.locator(".header-search__toggle").click();
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
      expect(created.params).not.toHaveProperty("repositorySource");
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
    });
  });

  it("uses a headless repository source and retains its selection when disabled", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? { recordVideo: { dir: suite.artifactDir, size: viewport } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          ...localRepository,
          nativePlugins: [],
          featureMethods: [...projectMethods, "plugins.controlUi.list"],
          methodResponses: {
            "plugins.controlUi.list": {
              revision: "headless",
              plugins: [],
              repositorySources: (repositoryManifest.repositorySources ?? []).map((source) =>
                Object.assign({ pluginId: repositoryManifest.id }, source),
              ),
              diagnostics: [],
            },
            "projects.list": { projects: [] },
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
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, selected, [selected], {
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, "repository-source-enabled.png"), frame.png);
          await selected.click();
          const sourcePicker = page.locator(".oc-popover.new-session-page__project-popover");
          await sourcePicker.getByRole("searchbox").fill("acme");
          await sourcePicker.getByRole("button", { name: /acme\/private-repo/u }).waitFor();
          const pickerFrame = await takeControlUiScreenshotFrame(
            page,
            sourcePicker,
            [sourcePicker],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(suite.artifactDir, "source-only-repository-picker.png"),
            pickerFrame.png,
          );
          await page.keyboard.press("Escape");
        }
        const searchesBeforeDisable = (await gateway.getRequests("projects.searchRemote")).length;
        await gateway.setMethodResponse("plugins.controlUi.list", {
          revision: "disabled",
          plugins: [],
          repositorySources: [],
          diagnostics: [],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "disabled" });
        await page.locator("#new-session-checkout-trigger").click();
        await page
          .getByText(
            "This repository source is unavailable. Re-enable its plugin or choose another repository or local folder. Your selection has been kept.",
            { exact: true },
          )
          .filter({ visible: true })
          .waitFor();
        await pollLocatorText(selected).toContain("acme/private-repo");
        expect(await page.locator(".new-session-page__message").inputValue()).toBe(
          "keep the draft message",
        );
        expect(await page.getByRole("button", { name: "Start session" }).isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("projects.searchRemote")).toHaveLength(
          searchesBeforeDisable,
        );
        expect(
          await page.evaluate(() =>
            performance
              .getEntriesByType("resource")
              .filter((entry) => entry.name.includes("/plugins/control-ui/github-repositories/"))
              .map((entry) => entry.name),
          ),
        ).toEqual([]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const picker = page.locator(".oc-popover.new-session-page__checkout-popover");
          const frame = await takeControlUiScreenshotFrame(page, picker, [picker], {
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, "repository-source-disabled-selection-retained.png"),
            frame.png,
          );
        }
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
      nativePlugins: nativeRepositoryPlugins,
      subscriptionInitialHistory: false,
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
      await place.locator(".header-search__toggle").click();
      const search = place.getByRole("searchbox", {
        name: "Search projects or paste a Git URL",
      });
      await search.fill("openclaw");

      const searchRequest = await gateway.waitForRequest("projects.searchRemote");
      expect(searchRequest.params).toEqual({ query: "openclaw" });
      await place
        .getByText(
          "Searching public GitHub repositories. Connect an account for private repository access.",
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
        repositorySource: "github-repositories/repositories",
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
