import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  TERMINAL_START_FEATURE_METHODS,
  cliAgentCatalog,
} from "./new-session-page.native-terminal.test-support.ts";
import {
  createPageOpener,
  button,
  expectAttribute,
  waitForRequestCount,
  expectValue,
} from "./new-session-page.scenario.test-support.ts";
import {
  REFRESHED_RESEARCH_WORKSPACE,
  WORKSPACE,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  checkoutBaseRefInput,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
} from "./new-session-page.test-support.ts";
import { sessionList } from "./new-session-shard.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const captureCliAgentsProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

function mainAndResearchAgents(mainWorkspace: string, researchWorkspace: string) {
  return {
    agents: [
      { id: "main", name: "Main", workspace: mainWorkspace },
      { id: "research", name: "Research", workspace: researchWorkspace },
    ].map(({ id, name, workspace }) => ({
      id,
      name,
      workspace,
      identity: { name },
      workspaceGit: true,
    })),
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  };
}

function recordingOptions(name: string): BrowserContextOptions {
  const viewport = { height: 900, width: 1280 };
  return {
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureCliAgentsProof
      ? { recordVideo: { dir: path.join(suite.artifactDir, name), size: viewport } }
      : {}),
  };
}

async function captureCatalogProof(page: Page, name: string, surface: Locator, content: Locator[]) {
  if (captureCliAgentsProof) {
    await writeFile(
      path.join(suite.artifactDir, "cli-agents-picker", name),
      await takeControlUiViewportScreenshot(page, surface, content),
    );
  }
}

suite.define(() => {
  const openPage = createPageOpener(suite);
  it("waits for the current roster before loading the CLI catalog", async () => {
    const page = await openPage({ locale: "en-US", serviceWorkers: "block" });
    const gateway = await installMockGateway(page, {
      assistantAgentId: "roboclaw",
      assistantName: "Roboclaw",
      cliAgentsEnabled: true,
      defaultAgentId: "roboclaw",
      deferredRequests: [{ method: "agents.list" }],
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "sessions.catalog.list": {
          cases: [
            {
              match: { metadataOnly: true },
              response: { catalogs: [{ ...cliAgentCatalog(true), hosts: [] }] },
            },
            { match: {}, response: { catalogs: [cliAgentCatalog(true)] } },
          ],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("agents.list");
    await page.locator(".new-session-page__message").waitFor({ state: "visible" });
    expect(await gateway.getRequests("sessions.catalog.list", { metadataOnly: true })).toEqual([]);
    await gateway.resolveDeferred("agents.list");
    await page.getByRole("heading", { name: "Roboclaw" }).waitFor();
    await expect
      .poll(async () => await gateway.getRequests("sessions.catalog.list", { metadataOnly: true }))
      .toHaveLength(1);
    const catalogRequest = (
      await gateway.getRequests("sessions.catalog.list", { metadataOnly: true })
    ).at(0);
    expect(catalogRequest?.params).toEqual({ agentId: "roboclaw", metadataOnly: true });
    await page.locator('[data-chat-model-select="true"]').click();
    const cliGroup = page.locator('[data-chat-model-target-group="cliAgents"]');
    await expect.poll(() => cliGroup.isVisible()).toBe(true);
    await pollLocatorText(cliGroup).toContain("Claude Code");
  });

  it("routes a Labs-enabled CLI agent picker row through catalog-target mode", async () => {
    if (captureCliAgentsProof) {
      await mkdir(path.join(suite.artifactDir, "cli-agents-picker"), { recursive: true });
    }
    const page = await openPage(recordingOptions("cli-agents-picker"));
    const terminalCatalog = cliAgentCatalog(true);
    const historyCatalog = {
      id: "history-only",
      label: "History only",
      capabilities: { continueSession: true, archive: false },
      hosts: [],
    };
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "sessions.catalog.list",
      ],
      methodResponses: {
        "sessions.catalog.list": {
          cases: [
            {
              match: { metadataOnly: true },
              response: { catalogs: [{ ...terminalCatalog, hosts: [] }, historyCatalog] },
            },
            { match: {}, response: { catalogs: [terminalCatalog, historyCatalog] } },
          ],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.catalog.list", { metadataOnly: true })).at(0),
      )
      .toMatchObject({ params: { agentId: "main", metadataOnly: true } });
    await page.locator('[data-chat-model-select="true"]').click();
    const cliGroup = page.locator('[data-chat-model-target-group="cliAgents"]');
    await expect.poll(() => cliGroup.isVisible()).toBe(true);
    await pollLocatorText(cliGroup).toContain("CLI agents");
    await pollLocatorText(cliGroup).toContain("Claude Code");
    expect(await cliGroup.textContent()).not.toContain("History only");
    await captureCatalogProof(
      page,
      "picker-group.png",
      page.locator(".chat-controls__model-picker > [data-anchored-overlay]"),
      [cliGroup],
    );
    await cliGroup.getByRole("option", { name: "Claude Code" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("catalog")).toBe("claude");
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.catalog.list", { catalogId: "claude" })).at(0),
      )
      .toMatchObject({ params: { agentId: "main", catalogId: "claude", limitPerHost: 1 } });
    const targetRequest = (
      await gateway.getRequests("sessions.catalog.list", { catalogId: "claude" })
    ).at(0);
    expect(targetRequest?.params).not.toHaveProperty("metadataOnly");
    await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
    expect(await page.locator('[data-chat-model-select="true"]').count()).toBe(0);
    await captureCatalogProof(page, "catalog-target.png", page.locator(".shell"), [
      page.locator(".new-session-page__runtime"),
    ]);
  });

  it.each<[string, boolean, boolean, boolean]>([
    ["CLI agents gate is off", false, true, true],
    ["terminal gate is off", true, false, true],
    ["catalog capability is absent", true, true, false],
  ])(
    "blocks native submission visibly when %s",
    async (_label, cliAgentsEnabled, terminalEnabled, startTerminal) => {
      const page = await openPage(createControlUiE2eContextOptions());
      const gateway = await installMockGateway(page, {
        cliAgentsEnabled,
        terminalEnabled,
        workspace: WORKSPACE,
        workspaceGit: true,
        featureMethods: [...TERMINAL_START_FEATURE_METHODS],
        methodResponses: {
          "sessions.catalog.list": { catalogs: [cliAgentCatalog(startTerminal)] },
          "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        },
      });
      await page.goto(`${suite.server.baseUrl}new?catalog=claude`);
      await page.locator(".new-session-page__runtime").waitFor();
      expect(await page.locator(".new-session-page__start-split").count()).toBe(0);
      await page.locator(".new-session-page__message").fill("keep the normal path");
      const start = button(page, "Start in terminal");
      await expectAttribute(start, "aria-disabled", "true");
      await page.locator(".new-session-page__message").press("Enter");
      await page.locator(".new-session-page__blocked-submit").waitFor();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.catalog.startTerminal")).toHaveLength(0);
      expect(await page.locator(".new-session-page__start-submit").count()).toBe(1);
    },
  );

  it("creates a worktree, starts the catalog session, and opens its terminal", async () => {
    if (captureCliAgentsProof) {
      await mkdir(path.join(suite.artifactDir, "cli-agents-picker"), { recursive: true });
    }
    const page = await openPage(recordingOptions("cli-agents-picker"));
    const worktreePath = "/home/peter/.openclaw/worktrees/terminal-e2e";
    const config = { tools: { web: { search: { provider: "brave" } } } };
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      terminalEnabled: true,
      operatorScopes: ["operator.read", "operator.write", "operator.admin"],
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "config.get": {
          raw: JSON.stringify(config),
          hash: "terminal-capability-overrides",
          sourceConfig: config,
          runtimeConfig: config,
          config,
        },
        "agents.list": mainAndResearchAgents(WORKSPACE, WORKSPACE),
        "sessions.catalog.list": { catalogs: [cliAgentCatalog(true)] },
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        "worktrees.create": {
          id: "terminal-e2e",
          name: "terminal-task",
          repoFingerprint: "0123456789abcdef",
          repoRoot: WORKSPACE,
          path: worktreePath,
          branch: "openclaw/terminal-task",
          baseRef: "origin/main",
          ownerKind: "manual",
          createdAt: 1,
          lastActiveAt: 1,
        },
        "sessions.catalog.startTerminal": {
          sessionId: "terminal-cli-1",
          agentId: "research",
          shell: "/bin/zsh",
          cwd: worktreePath,
          confined: false,
          title: "Claude Code",
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}new?agent=research&catalog=claude`);
    await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
    expect(await page.locator(".new-session-page__start-split").count()).toBe(0);
    await page.locator("#new-session-checkout-trigger").click();
    const placePopover = page.locator(".oc-popover.new-session-page__checkout-popover");
    const worktreeButton = button(placePopover, "New worktree Isolated copy of the repo", true);
    await worktreeButton.waitFor({ state: "visible" });
    const initialBranchRequestCount = (await gateway.getRequests("worktrees.branches")).length;
    await worktreeButton.click();
    await expectAttribute(checkoutBaseRefInput(placePopover), "placeholder", "main");
    expect(await checkoutBaseRefInput(placePopover).inputValue()).toBe("");
    await placePopover.getByLabel("Name", { exact: true }).fill("terminal-task");
    await page.locator("#new-session-checkout-trigger").click();
    await page.locator(".new-session-page__message").fill("  inspect the checkout  ");
    expect(await button(page, "Add attachment").count()).toBe(0);
    expect(await page.locator('[data-chat-model-select="true"]').count()).toBe(0);
    await captureCatalogProof(page, "terminal-primary.png", page.locator(".shell"), [
      page.locator(".new-session-page__message"),
    ]);
    await button(page, "Start in terminal").click();
    const worktreeRequest = await gateway.waitForRequest("worktrees.create");
    expect(worktreeRequest.params).toEqual({ repoRoot: WORKSPACE, name: "terminal-task" });
    const terminalRequest = await gateway.waitForRequest("sessions.catalog.startTerminal");
    expect(terminalRequest.params).toEqual({
      catalogId: "claude",
      agentId: "research",
      hostId: "gateway:local",
      cwd: worktreePath,
      initialMessage: "inspect the checkout",
    });
    expect(await gateway.getRequests("worktrees.branches")).toHaveLength(initialBranchRequestCount);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    const requests = await gateway.getRequests();
    const methods = requests.map((request) => request.method);
    expect(methods.indexOf("worktrees.create")).toBeLessThan(
      methods.indexOf("sessions.catalog.startTerminal"),
    );
    await page.waitForURL(`${suite.server.baseUrl}terminal/terminal-cli-1`);
    const panel = page.locator("openclaw-terminal-page openclaw-terminal-panel");
    await panel.locator(".tabstrip-tab.is-live").waitFor();
    await panel.locator(".tp-host canvas").waitFor({ state: "visible" });
    expect(await page.locator(".new-session-page__message").count()).toBe(0);
    await expect
      .poll(() => panel.locator(".tabstrip-tab.is-live").getAttribute("title"))
      .toContain(worktreePath);
    expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
    await navigateInApp(page, "new-session", "?agent=research&catalog=claude");
    await expect.poll(() => button(page, "Start in terminal").isEnabled()).toBe(true);
    await button(page, "Start in terminal").click();
    await expect
      .poll(async () => {
        const currentRequests = await gateway.getRequests();
        return currentRequests.filter(
          (request) => request.method === "sessions.catalog.startTerminal",
        ).length;
      })
      .toBe(2);
    const repeatedRequests = await gateway.getRequests();
    const emptyMessageRequest = repeatedRequests.findLast(
      (request) => request.method === "sessions.catalog.startTerminal",
    );
    expect(emptyMessageRequest?.params).toEqual({
      catalogId: "claude",
      agentId: "research",
      hostId: "gateway:local",
      cwd: WORKSPACE,
    });
  });

  it("shows the terminal-start server error without rewriting it", async () => {
    const page = await openPage(createControlUiE2eContextOptions());
    const serverMessage = "cwd is no longer available; choose another folder and retry";
    await installMockGateway(page, {
      cliAgentsEnabled: true,
      terminalEnabled: true,
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "sessions.catalog.list": { catalogs: [cliAgentCatalog(true)] },
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        "sessions.catalog.startTerminal": {
          __mockError: { code: "INVALID_REQUEST", message: serverMessage },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}new?catalog=claude`);
    await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
    await page.locator(".new-session-page__message").fill("keep this draft");
    await button(page, "Start in terminal").click();
    await expect
      .poll(() => page.locator(".new-session-page__alert-message").textContent())
      .toBe(serverMessage);
    expect(await page.locator(".new-session-page__message").inputValue()).toBe("keep this draft");
    expect(await page.locator(".new-session-page__scroll").getAttribute("aria-busy")).toBe("false");
  });

  it.each([
    { catalogId: "codex", action: "Enter" },
    { catalogId: "claude", action: "button" },
  ])(
    "$catalogId + primary $action opens a native terminal without Chat or title inference",
    async ({ catalogId, action }) => {
      const page = await openPage({ locale: "en-US", serviceWorkers: "block" });
      const gateway = await installMockGateway(page, {
        cliAgentsEnabled: true,
        terminalEnabled: true,
        workspace: WORKSPACE,
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        deferredMethods: ["sessions.catalog.startTerminal"],
        featureMethods: [...TERMINAL_START_FEATURE_METHODS],
        methodResponses: {
          "sessions.title.prepare": { title: "Ordinary Chat title" },
          "sessions.catalog.list": {
            catalogs: [{ ...cliAgentCatalog(true), id: catalogId, label: catalogId }],
          },
          "sessions.catalog.startTerminal": {
            sessionId: "native-cli",
            agentId: "main",
            shell: catalogId,
            cwd: WORKSPACE,
            confined: false,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.fill("ordinary Chat naming control");
      await gateway.waitForRequest("sessions.title.prepare");
      expect(await gateway.getRequests("sessions.title.prepare")).toHaveLength(1);
      await navigateInApp(page, "new-session", `?catalog=${catalogId}`);
      await page.clock.install();
      await message.fill("native prompt");
      const start = button(page, "Start in terminal");
      await expectAttribute(start, "aria-disabled", "false");
      await page.clock.runFor(2_000);
      expect(await gateway.getRequests("sessions.title.prepare")).toHaveLength(1);
      if (action === "Enter") {
        await message.press("Enter");
      } else {
        await start.click();
      }
      expect((await gateway.waitForRequest("sessions.catalog.startTerminal")).params).toEqual({
        catalogId,
        agentId: "main",
        hostId: "gateway:local",
        cwd: WORKSPACE,
        initialMessage: "native prompt",
      });
      await expectAttribute(page.locator(".new-session-page__scroll"), "aria-busy", "true");
      const pending = page.locator(".new-session-page__starting");
      await pollLocatorText(pending.locator(".chat-group.user")).toContain("native prompt");
      await pollLocatorText(pending.locator(".chat-working-indicator")).toContain("Starting");
      expect(await pending.isVisible()).toBe(true);
      expect(await message.count()).toBe(0);
      expect(await page.locator(".new-session-page__scroll").getAttribute("inert")).toBeNull();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.catalog.startTerminal");
      await page.waitForURL(`${suite.server.baseUrl}terminal/native-cli`);
      await expect.poll(() => message.count()).toBe(0);
      await page.locator("openclaw-terminal-page .tabstrip-tab.is-live").waitFor();
      expect(await gateway.getRequests("sessions.title.prepare")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    },
  );

  it("navigates to a created session while canonical session refresh is pending", async () => {
    const page = await openPage(createControlUiE2eContextOptions());
    const sessionKey = "agent:main:refresh-overlap-e2e";
    const listResponse = sessionList();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"],
        "sessions.create": { key: sessionKey },
        "sessions.list": listResponse,
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const message = page.locator(".new-session-page__message");
    await message.waitFor({ state: "visible", timeout: 10_000 });
    const listCalls = (await gateway.getRequests("sessions.list")).length;
    await gateway.deferNext("sessions.list");
    await gateway.emitGatewayEvent("sessions.changed", {
      key: "agent:main:other-client",
      kind: "direct",
      reason: "update",
      sessionKey: "agent:main:other-client",
      updatedAt: Date.now(),
    });
    await waitForRequestCount(gateway, listCalls + 1, "sessions.list");
    await message.fill("create during refresh");
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({ agentId: "main", message: "create during refresh" });
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
    await gateway.resolveDeferred("sessions.list", listResponse);
  });

  it("resolves a pending catalog target after reconnect without clearing the draft", async () => {
    const page = await openPage(createControlUiE2eContextOptions());
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      terminalEnabled: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "agents.list": mainAndResearchAgents(WORKSPACE, "/home/peter/research"),
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        "sessions.catalog.list": { catalogs: [cliAgentCatalog(true)] },
        "sessions.catalog.startTerminal": {
          sessionId: "claude-reconnect",
          agentId: "research",
          shell: "claude",
          cwd: "/home/peter/research",
          confined: false,
        },
      },
    });
    const targetedRequests = async () =>
      await gateway.getRequests("sessions.catalog.list", { catalogId: "claude" });
    const target = { catalogId: "claude", agentId: "research", limitPerHost: 1 };
    await page.goto(`${suite.server.baseUrl}new?agent=research`);
    await page.getByRole("heading", { name: "Research" }).waitFor();
    await gateway.setOnline(false);
    await waitForControlUiGatewayReconnecting(page);
    await page.evaluate(() => {
      history.pushState(null, "", "new?agent=research&catalog=claude");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    const message = page.locator(".new-session-page__message");
    await message.fill("keep this reconnect draft");
    await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("claude");
    await expectValue(message, "keep this reconnect draft");
    await expectAttribute(button(page, "Start in terminal"), "aria-disabled", "true");
    expect(await targetedRequests()).toHaveLength(0);
    await gateway.deferNext("sessions.catalog.list", target);
    await gateway.setOnline(true);
    await waitForControlUiGatewayReady(page);
    await expect.poll(async () => (await targetedRequests()).length).toBe(1);
    await gateway.deferNext("sessions.catalog.list", target);
    await gateway.rejectDeferred("sessions.catalog.list", {
      code: "UNAVAILABLE",
      message: "catalog warming up",
      retryable: true,
    });
    await expect.poll(async () => (await targetedRequests()).length).toBe(2);
    await gateway.resolveDeferred("sessions.catalog.list", { catalogs: [] });
    await expect.poll(async () => (await targetedRequests()).length, { timeout: 10_000 }).toBe(3);
    await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
    await expectValue(message, "keep this reconnect draft");
    await pollLocatorText(page.locator(".new-session-page").getByRole("heading")).toContain(
      "Research",
    );
    await button(page, "Start in terminal").click();
    const create = await gateway.waitForRequest("sessions.catalog.startTerminal");
    expect(create.params).toMatchObject({
      agentId: "research",
      initialMessage: "keep this reconnect draft",
      catalogId: "claude",
    });
    expect(create.params).not.toHaveProperty("model");
    expect(create.params).toHaveProperty("cwd", "/home/peter/research");
  });

  it("clears a navigated draft and preserves a manually selected agent across reconnect", async () => {
    const page = await openPage(createControlUiE2eContextOptions());
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": mainAndResearchAgents(WORKSPACE, "/home/peter/research"),
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        "sessions.create": { key: "agent:research:manual-reconnect" },
      },
    });
    await page.goto(`${suite.server.baseUrl}new?agent=research`);
    await page.getByRole("heading", { name: "Research" }).waitFor();
    const message = page.locator(".new-session-page__message");
    await message.fill("discard on real navigation");
    await navigateInApp(page, "new-session", "?agent=main");
    await page.getByRole("heading", { name: "Main" }).waitFor();
    await expectValue(message, "");
    await gateway.waitForRequest("worktrees.branches");
    const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
    await agentPicker.locator(".agent-select__trigger").click();
    await agentPicker
      .locator(".agent-select__option[data-agent-option]")
      .filter({ hasText: "Research" })
      .click();
    await page.getByRole("heading", { name: "Research" }).waitFor();
    await message.fill("keep my selected agent");
    const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;
    const branchRequestsBefore = (await gateway.getRequests("worktrees.branches")).length;
    await gateway.setOnline(false);
    await waitForControlUiGatewayReconnecting(page);
    await gateway.setMethodResponse(
      "agents.list",
      mainAndResearchAgents(WORKSPACE, REFRESHED_RESEARCH_WORKSPACE),
    );
    await gateway.setOnline(true);
    await waitForControlUiGatewayReady(page);
    await waitForRequestCount(gateway, agentRequestsBefore + 1, "agents.list");
    await expectValue(message, "keep my selected agent");
    await pollLocatorText(page.locator(".new-session-page").getByRole("heading")).toContain(
      "Research",
    );
    await pollLocatorText(
      page.locator("#new-session-project-trigger .new-session-page__trigger-label"),
    ).toBe("research-next");
    await waitForRequestCount(gateway, branchRequestsBefore + 1, "worktrees.branches");
    expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
      repoRoot: REFRESHED_RESEARCH_WORKSPACE,
      includeRepositoryStatus: true,
    });
    const placeSelect = page.locator(".oc-popover.new-session-page__checkout-popover");
    const placeTrigger = page.locator("#new-session-checkout-trigger");
    await placeTrigger.click();
    const worktreeItem = button(placeSelect, "New worktree Isolated copy of the repo", true);
    await worktreeItem.click();
    const baseInput = checkoutBaseRefInput(placeSelect);
    await expectAttribute(baseInput, "placeholder", "main");
    expect(await baseInput.inputValue()).toBe("");
    await page.keyboard.press("Escape");
    await gateway.deferNext("worktrees.branches");
    const branchesBeforeSameWorkspaceReconnect = (await gateway.getRequests("worktrees.branches"))
      .length;
    await gateway.setOnline(false);
    await waitForControlUiGatewayReconnecting(page);
    await gateway.setOnline(true);
    await waitForControlUiGatewayReady(page);
    await waitForRequestCount(
      gateway,
      branchesBeforeSameWorkspaceReconnect + 1,
      "worktrees.branches",
    );
    expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
      repoRoot: REFRESHED_RESEARCH_WORKSPACE,
      includeRepositoryStatus: true,
    });
    await placeTrigger.click();
    expect(await baseInput.inputValue()).toBe("");
    expect(await baseInput.getAttribute("placeholder")).toBe("Loading…");
    await baseInput.fill("feature-choice");
    await gateway.resolveDeferred("worktrees.branches", {
      branches: [{ kind: "local", name: "beta" }],
      defaultBranch: "beta",
      repositoryStatus: "git",
    });
    await expectValue(baseInput, "feature-choice");
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "research",
      message: "keep my selected agent",
      worktree: true,
      worktreeBaseRef: "feature-choice",
    });
    expect(create.params).not.toHaveProperty("cwd");
  });
});
