import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatModel } from "../test-helpers/select-picker-e2e.ts";
import {
  createPageOpener,
  bounds,
  button,
  folderListings,
  expectAttribute,
  expectValue,
  expectLabel,
  waitForRequestCount,
} from "./new-session-page.scenario.test-support.ts";
import {
  MOVED_WORKSPACE,
  NEW_SESSION_MODEL_CATALOG,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  PICKED,
  SESSION_LIST_DEFAULTS,
  TARGET_REPO,
  WORKSPACE,
  captureProjectUiProof,
  captureUiProof,
  captureUiProofEnabled,
  checkoutBaseRefInput,
  choosePackagesFolder,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
  waitForCommittedChatRoute,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const BASE_CONTEXT: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block" };
const DESKTOP_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  viewport: { height: 900, width: 1280 },
};
const MOBILE_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  hasTouch: true,
  viewport: { height: 740, width: 364 },
};
const GIT_BRANCHES = LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"];
const FOLDER_LISTINGS = folderListings("/home/peter", "/home/peter");
const REMEMBERED_PROJECT = {
  folder: PICKED,
  workspace: WORKSPACE,
  worktree: true,
  model: "anthropic/claude-sonnet-4-6",
};
const PREF_METHODS = [
  "chat.metadata",
  "chat.startup",
  "sessions.create",
  "users.prefs.get",
  "users.prefs.set",
];

async function seedPreferences(
  page: Page,
  agentPreferences: Record<string, Record<string, unknown>>,
) {
  const url = new URL(suite.server.baseUrl);
  const gatewayUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  await page.addInitScript(
    ({ key, agents }) => {
      localStorage.setItem(key, JSON.stringify({ agents }));
    },
    {
      key: `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`,
      agents: agentPreferences,
    },
  );
}

async function returnToDraft(page: Page) {
  await navigateInApp(page, "chat");
  await waitForCommittedChatRoute(page);
  await navigateInApp(page, "new-session");
}

const MAIN_AGENT = LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"].agents[0];
function mainAgentList(workspace = WORKSPACE, workspaceGit = true) {
  return {
    ...LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"],
    agents: [{ ...MAIN_AGENT, workspace, workspaceGit }],
  };
}

async function mainPreference(
  page: Page,
  updates?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return page.evaluate((patch) => {
    const key = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).find((candidate) => candidate?.startsWith("openclaw.new-session.preferences.v1:"));
    const value = key
      ? (JSON.parse(localStorage.getItem(key) ?? "null") as {
          agents?: Record<string, Record<string, unknown>>;
        } | null)
      : null;
    const main = value?.agents?.main;
    if (patch) {
      if (!key || !main) {
        throw new Error("missing main-agent preference");
      }
      Object.assign(main, patch);
      localStorage.setItem(key, JSON.stringify(value));
    }
    return main ?? null;
  }, updates);
}

function projectProofRecording(): BrowserContextOptions {
  return captureUiProofEnabled
    ? {
        recordVideo: {
          dir: path.join(suite.artifactDir, "project-registry"),
          size: { height: 900, width: 1280 },
        },
        viewport: { height: 900, width: 1280 },
      }
    : {};
}

suite.define(() => {
  const openPage = createPageOpener(suite);
  async function pendingFolderDraft(
    key: string,
    options: NonNullable<Parameters<typeof installMockGateway>[1]> = {},
  ) {
    const page = await openPage(BASE_CONTEXT);
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      ...options,
      methodResponses: {
        "agents.list": mainAgentList(),
        "worktrees.branches": GIT_BRANCHES,
        "fs.listDir": FOLDER_LISTINGS,
        "sessions.create": { key, runStarted: true },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await choosePackagesFolder(page);
    await navigateInApp(page, "chat");
    await waitForCommittedChatRoute(page);
    const requests = (await gateway.getRequests("fs.listDir")).length;
    await gateway.deferNext("fs.listDir");
    await navigateInApp(page, "new-session");
    await expect
      .poll(async () => (await gateway.getRequests("fs.listDir")).length)
      .toBeGreaterThan(requests);
    return { page, gateway };
  }

  it("keeps rail privacy visible and shows the mobile footer mode without hover", async () => {
    const page = await openPage(MOBILE_CONTEXT);
    await installMockGateway(page, {
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT 5.6 Luna",
          provider: "openai",
          contextWindow: 400_000,
        },
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          provider: "anthropic",
          contextWindow: 200_000,
        },
      ],
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const footer = page.locator(".new-session-page__composer .agent-chat__composer-footer");
    const attach = button(page, "Add attachment");
    const takePhoto = page.getByRole("menuitem", { name: "Take photo" });
    const draft = page.locator('.new-session-page__draft-toggle[aria-label^="Draft:"]');
    const incognito = page.getByRole("switch", { name: "Incognito" });
    const model = page.locator(".new-session-page__composer .chat-composer-model-control");
    await Promise.all([
      footer.waitFor(),
      attach.waitFor(),
      draft.waitFor({ state: "attached" }),
      incognito.waitFor(),
      model.waitFor(),
    ]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect
      .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    await expect
      .poll(() => draft.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    expect(
      await incognito.evaluate(
        (element) => element.closest(".new-session-page__incognito-rail") != null,
      ),
    ).toBe(true);
    const [footerBox, attachBox, modelBox] = await Promise.all([
      bounds(footer),
      bounds(attach),
      bounds(model),
    ]);
    await bounds(draft);
    const previousCenter = attachBox.y + attachBox.height / 2;
    const nextCenter = modelBox.y + modelBox.height / 2;
    const sameLine = Math.abs(nextCenter - previousCenter) <= attachBox.height / 2;
    expect(sameLine ? modelBox.x > attachBox.x : nextCenter > previousCenter).toBe(true);
    for (const control of [attachBox, modelBox]) {
      expect(control.x).toBeGreaterThanOrEqual(footerBox.x);
      expect(control.x + control.width).toBeLessThanOrEqual(footerBox.x + footerBox.width);
    }
    const controlsOverflow = await footer.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(controlsOverflow).toBe(0);
    await attach.click();
    await expect.poll(() => takePhoto.isVisible()).toBe(true);
    const attachGlyphSine = () =>
      attach.evaluate((element) => {
        const { transform } = getComputedStyle(element.querySelector("svg") as SVGElement);
        return transform === "none"
          ? 0
          : Number(transform.slice(transform.indexOf("(") + 1).split(",")[1]);
      });
    await expect.poll(attachGlyphSine).toBeCloseTo(-Math.SQRT1_2, 3);
    await page.keyboard.press("Escape");
    await expect.poll(attachGlyphSine).toBe(0);
    await incognito.click();
    await expectAttribute(incognito, "aria-checked", "true");
  });

  it("keeps the effort label, slider stop, and create payload aligned after a model switch", async () => {
    const page = await openPage(DESKTOP_CONTEXT);
    const levels = (ids: string[]) => ids.map((id) => ({ id, label: id }));
    const kimiLevels = levels(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    const gateway = await installMockGateway(page, {
      agentModel: "kimi/k3",
      models: [
        {
          id: "k3",
          name: "Kimi K3",
          provider: "kimi",
          reasoning: true,
          thinkingLevels: kimiLevels,
          thinkingDefault: "high",
        },
        {
          id: "gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          provider: "openai",
          reasoning: true,
          thinkingLevels: levels(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
          thinkingDefault: "medium",
        },
      ],
      methodResponses: {
        "agents.list": {
          ...mainAgentList(),
          agents: [
            {
              id: "main",
              name: "Main",
              identity: { name: "Main" },
              model: { primary: "kimi/k3" },
              thinkingLevels: kimiLevels,
              thinkingDefault: "high",
            },
          ],
        },
        "sessions.create": { key: "agent:main:thinking-model-switch", runStarted: true },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const effortSelect = page.locator('[data-chat-thinking-select="true"]');
    await effortSelect.click();
    const thinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
    await thinkingSlider.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "5";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expectAttribute(effortSelect, "data-chat-thinking-value", "xhigh");
    await selectChatModel(page, "openai/gpt-5.6-sol");
    await effortSelect.click();
    await expectAttribute(
      thinkingSlider,
      "data-chat-thinking-values",
      "off,minimal,low,medium,high,xhigh,max",
    );
    await expectValue(thinkingSlider, "5");
    expect(
      await thinkingSlider.evaluate((element) => ({
        max: element.getAttribute("max"),
        label: element.getAttribute("aria-valuetext"),
        fill: Number.parseFloat(element.style.getPropertyValue("--reasoning-fill")),
      })),
    ).toMatchObject({ max: "6", label: "Extra high", fill: expect.closeTo(83.33, 1) });
    await effortSelect.click();
    await page.locator(".new-session-page__message").fill("keep the selected effort");
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      message: "keep the selected effort",
      model: "openai/gpt-5.6-sol",
      thinkingLevel: "xhigh",
    });
  });

  it("restores valid preferences and repairs a worktree rejected by workspace metadata", async () => {
    const page = await openPage(DESKTOP_CONTEXT);
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      models: NEW_SESSION_MODEL_CATALOG,
      methodResponses: {
        "agents.list": mainAgentList(),
        "worktrees.branches": GIT_BRANCHES,
        "fs.listDir": FOLDER_LISTINGS,
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const placeTrigger = page.locator("#new-session-checkout-trigger");
    const projectTrigger = page.locator("#new-session-project-trigger");
    await choosePackagesFolder(page);
    await placeTrigger.click();
    await button(page, "New worktree Isolated copy of the repo", true).click();
    await checkoutBaseRefInput(page).fill("release/next");
    await page.getByLabel("Name", { exact: true }).fill("remembered-task");
    await page.keyboard.press("Escape");
    const modelSelect = page.locator('[data-chat-model-select="true"]');
    await selectChatModel(page, "anthropic/claude-sonnet-4-6");
    const effortSelect = page.locator('[data-chat-thinking-select="true"]');
    await effortSelect.click();
    const thinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
    await expect.poll(() => thinkingSlider.isVisible()).toBe(true);
    await thinkingSlider.press("End");
    await expectAttribute(effortSelect, "data-chat-thinking-value", "high");
    await page.goto(`${suite.server.baseUrl}new`);
    await expectLabel(projectTrigger, "packages");
    await pollLocatorText(
      page.locator("#new-session-where-trigger .new-session-page__trigger-label"),
    ).toBe("Local");
    await expectAttribute(placeTrigger, "data-worktree", "true");
    await placeTrigger.click();
    await expectValue(checkoutBaseRefInput(page), "release/next");
    await expectValue(page.getByLabel("Name", { exact: true }), "remembered-task");
    await page.keyboard.press("Escape");
    await expectAttribute(modelSelect, "data-chat-select-value", "anthropic/claude-sonnet-4-6");
    await expectAttribute(effortSelect, "data-chat-thinking-value", "high");
    await captureUiProof(suite, page, "new-session-preferences-restored.png");
    const branchRequests = await gateway.getRequests("worktrees.branches");
    expect(branchRequests.at(-1)?.params).toMatchObject({ repoRoot: PICKED });
    await mainPreference(page, { folder: WORKSPACE, workspace: WORKSPACE });
    await gateway.setMethodResponse("agents.list", mainAgentList(WORKSPACE, false));
    await page.reload();
    await expect.poll(async () => (await mainPreference(page))?.worktree).toBe(false);
    await expect.poll(() => placeTrigger.count()).toBe(0);
  });

  it("uses identity-scoped server recents without duplicating registered projects", async () => {
    const page = await openPage({ ...BASE_CONTEXT, ...projectProofRecording() });
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
      featureMethods: [...PREF_METHODS, "projects.list"],
      methodResponses: {
        "projects.list": {
          projects: [{ id: "registered", displayName: "Registered", source: "registered" }],
          recents: [
            { kind: "project", projectId: "registered", displayName: "Registered" },
            {
              kind: "folder",
              folder: `${WORKSPACE}/scratch`,
              displayName: "scratch",
            },
          ],
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            { key: "agent:main:shared", kind: "direct", updatedAt: 99, execCwd: "/shared" },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:identity-project" },
        "users.prefs.get": { status: "ok", entries: {} },
        "users.prefs.set": { status: "ok" },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const trigger = page.locator("#new-session-project-trigger");
    await trigger.click();
    expect(await page.locator('[data-value="recent:/shared"]').count()).toBe(0);
    expect(await page.locator('[data-value="recent-project:registered"]').count()).toBe(0);
    const project = page.locator('[data-value="project:registered"]');
    const recentFolder = page.locator(`[data-value="recent:${WORKSPACE}/scratch"]`);
    await project.waitFor();
    await recentFolder.waitFor();
    await captureProjectUiProof(suite, page, "identity-project-recents-after.png", {
      surface: page.locator(".oc-popover.new-session-page__project-popover"),
      content: [project, recentFolder],
    });
    await project.click();
    await page.locator(".new-session-page__message").fill("continue registered work");
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      projectId: "registered",
      message: "continue registered work",
    });
  });

  it("migrates identity preferences once and mirrors gateway-first writes", async () => {
    const page = await openPage({ ...DESKTOP_CONTEXT, ...projectProofRecording() });
    await seedPreferences(page, { main: REMEMBERED_PROJECT });
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      models: NEW_SESSION_MODEL_CATALOG,
      presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
      featureMethods: [...PREF_METHODS, "fs.listDir", "projects.list", "worktrees.branches"],
      methodResponses: {
        "agents.list": mainAgentList(),
        "fs.listDir": FOLDER_LISTINGS,
        "projects.list": { projects: [], recents: [] },
        "users.prefs.get": {
          sequence: [
            { status: "ok", entries: {} },
            {
              status: "ok",
              entries: {
                "new-session.migration.v1": true,
                "new-session.v1:main": REMEMBERED_PROJECT,
              },
            },
          ],
        },
        "users.prefs.set": { status: "ok" },
        "worktrees.branches": GIT_BRANCHES,
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const migrated = await gateway.waitForRequest("users.prefs.set");
    expect(migrated.params).toMatchObject({
      entries: { "new-session.v1:main": REMEMBERED_PROJECT },
    });
    const trigger = page.locator("#new-session-project-trigger");
    const checkoutTrigger = page.locator("#new-session-checkout-trigger");
    await expectLabel(trigger, "packages");
    await expectAttribute(checkoutTrigger, "data-worktree", "true");
    await captureProjectUiProof(suite, page, "identity-preferences-migrated.png");
    await returnToDraft(page);
    await waitForRequestCount(gateway, 2, "users.prefs.get");
    await waitForRequestCount(gateway, 1, "users.prefs.set");
    await gateway.deferNext("users.prefs.set");
    const newSession = page.locator("openclaw-new-session-page");
    await selectChatModel(newSession, "openai/gpt-5.5");
    await waitForRequestCount(gateway, 2, "users.prefs.set");
    expect((await gateway.getRequests("users.prefs.set")).at(-1)?.params).toMatchObject({
      entries: { "new-session.v1:main": { model: "" } },
    });
    expect((await mainPreference(page))?.model).toBe("anthropic/claude-sonnet-4-6");
    await gateway.resolveDeferred("users.prefs.set", { status: "ok" });
    await expect.poll(async () => (await mainPreference(page))?.model).toBeUndefined();
  });

  it("resumes a partial multi-batch identity preference migration", async () => {
    const page = await openPage(BASE_CONTEXT);
    const agentIds = ["main", ...Array.from({ length: 32 }, (_, index) => `agent${index + 1}`)];
    const browserAgents = Object.fromEntries(
      agentIds.map((agentId) => [agentId, { workspace: WORKSPACE, folder: WORKSPACE }]),
    );
    const remoteEntries = Object.fromEntries(
      agentIds.slice(0, 32).map((agentId) => [`new-session.v1:${agentId}`, browserAgents[agentId]]),
    );
    await seedPreferences(page, browserAgents);
    const gateway = await installMockGateway(page, {
      presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
      featureMethods: PREF_METHODS,
      methodResponses: {
        "agents.list": mainAgentList(),
        "users.prefs.get": { status: "ok", entries: remoteEntries },
        "users.prefs.set": { status: "ok" },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const resumed = await gateway.waitForRequest("users.prefs.set");
    expect(resumed.params).toEqual({
      entries: {
        "new-session.v1:agent32": { workspace: WORKSPACE, folder: WORKSPACE },
        "new-session.migration.v1": true,
      },
      expectedEntries: { "new-session.v1:agent32": null, "new-session.migration.v1": null },
    });
    await waitForRequestCount(gateway, 1, "users.prefs.set");
  });

  it("reuses ready model metadata while a remembered worktree choice validates", async () => {
    const page = await openPage(BASE_CONTEXT);
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      models: NEW_SESSION_MODEL_CATALOG,
      methodResponses: {
        "agents.list": mainAgentList(),
        "worktrees.branches": GIT_BRANCHES,
        "fs.listDir": FOLDER_LISTINGS,
        "sessions.create": { key: "agent:main:restored-fast-submit", runStarted: true },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await choosePackagesFolder(page);
    const placeTrigger = page.locator("#new-session-checkout-trigger");
    await placeTrigger.click();
    await button(page, "New worktree Isolated copy of the repo", true).click();
    await page.keyboard.press("Escape");
    const newSession = page.locator("openclaw-new-session-page");
    const modelSelect = newSession.locator('[data-chat-model-select="true"]');
    await selectChatModel(newSession, "anthropic/claude-sonnet-4-6");
    await navigateInApp(page, "chat");
    await waitForCommittedChatRoute(page);
    const metadataRequests = (await gateway.getRequests("chat.metadata")).length;
    const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
    await gateway.deferNext("worktrees.branches");
    await navigateInApp(page, "new-session");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    await waitForRequestCount(gateway, metadataRequests, "chat.metadata");
    await waitForRequestCount(gateway, branchRequests + 1, "worktrees.branches");
    await expectAttribute(modelSelect, "data-chat-select-value", "anthropic/claude-sonnet-4-6");
    await page.locator(".new-session-page__message").fill("keep both remembered choices");
    const start = button(page, "Start session");
    await expect.poll(() => start.isDisabled()).toBe(true);
    // Discovery failure must preserve isolation intent while keeping submission gated.
    await gateway.rejectDeferred("worktrees.branches", {
      code: "UNAVAILABLE",
      message: "branch lookup unavailable",
    });
    await expectAttribute(placeTrigger, "data-worktree", "true");
    await expect.poll(() => start.isDisabled()).toBe(true);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    expect(await gateway.getRequests("chat.metadata")).toHaveLength(metadataRequests);
    await waitForCommittedNewSessionDraft(page, "keep both remembered choices", 0);
    await page.reload();
    // Refilling would race persisted-draft restoration; wait for its actual value.
    await expectValue(page.locator(".new-session-page__message"), "keep both remembered choices");
    await expectAttribute(modelSelect, "data-chat-select-value", "anthropic/claude-sonnet-4-6");
    await expectAttribute(placeTrigger, "data-worktree", "true");
    await expect.poll(() => start.isDisabled()).toBe(false);
    await start.click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      cwd: PICKED,
      message: "keep both remembered choices",
      model: "anthropic/claude-sonnet-4-6",
      worktree: true,
    });
  });

  it("repairs a remembered default folder when the agent workspace moves", async () => {
    const page = await openPage(BASE_CONTEXT);
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      models: NEW_SESSION_MODEL_CATALOG,
      methodResponses: {
        "agents.list": mainAgentList(),
        "worktrees.branches": GIT_BRANCHES,
        "fs.listDir": { path: WORKSPACE, parent: "/home/peter", home: "/home/peter", entries: [] },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const placeTrigger = page.locator("#new-session-project-trigger");
    await placeTrigger.click();
    await button(page, "Browse folders").click();
    await button(page, "Use this folder").click();
    await navigateInApp(page, "chat");
    await page.waitForURL((url) => url.pathname.endsWith("/chat"));
    await gateway.setMethodResponse("agents.list", mainAgentList(MOVED_WORKSPACE));
    await page.reload();
    await navigateInApp(page, "new-session");
    await expectLabel(placeTrigger, "openclaw-next");
    const newSession = page.locator("openclaw-new-session-page");
    await selectChatModel(newSession, "anthropic/claude-sonnet-4-6");
    expect(await mainPreference(page)).toMatchObject({
      workspace: MOVED_WORKSPACE,
      folder: MOVED_WORKSPACE,
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("falls back to the current workspace when the remembered folder is gone", async () => {
    const { page, gateway } = await pendingFolderDraft("agent:main:stale-folder-fallback", {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "fs.listDir",
        "sessions.create",
        "worktrees.branches",
      ],
    });
    const message = page.locator(".new-session-page__message");
    await message.fill("use a safe folder");
    await expect.poll(() => button(page, "Start session").isDisabled()).toBe(true);
    await gateway.rejectDeferred("fs.listDir", {
      code: "INVALID_REQUEST",
      message: `Error: ENOENT: no such file or directory, scandir '${PICKED}'`,
    });
    const placeTrigger = page.locator("#new-session-project-trigger");
    await expectLabel(placeTrigger, "openclaw");
    const pickedListRequests = (await gateway.getRequests("fs.listDir", { path: PICKED })).length;
    await returnToDraft(page);
    await expectLabel(placeTrigger, "openclaw");
    await expectAttribute(page.locator("#new-session-checkout-trigger"), "data-worktree", "false");
    await waitForRequestCount(gateway, pickedListRequests, "fs.listDir", { path: PICKED });
    await message.fill("use the repaired preference");
    await expect.poll(() => button(page, "Start session").isDisabled()).toBe(false);
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).not.toHaveProperty("cwd");
  });

  it("keeps a newer folder choice when remembered-folder validation finishes late", async () => {
    const { page, gateway } = await pendingFolderDraft("agent:main:newer-folder-wins");
    const placeTrigger = page.locator("#new-session-project-trigger");
    await placeTrigger.click();
    await page
      .locator('.oc-popover.new-session-page__project-popover [data-value="workspace"]')
      .click();
    await gateway.resolveDeferred("fs.listDir", {
      path: PICKED,
      parent: WORKSPACE,
      home: "/home/peter",
      entries: [],
    });
    await expectLabel(placeTrigger, "openclaw");
    await page.locator(".new-session-page__message").fill("keep the newer choice");
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).not.toHaveProperty("cwd");
  });

  it("keeps a folder chosen before the agent roster finishes loading submit-ready", async () => {
    const page = await openPage(BASE_CONTEXT);
    const gateway = await installMockGateway(page, {
      deferredMethods: ["agents.list"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": mainAgentList(),
        "fs.listDir": { path: TARGET_REPO, home: "/home/peter", entries: [] },
        "worktrees.branches": GIT_BRANCHES,
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const trigger = page.locator("#new-session-project-trigger");
    await trigger.click();
    await button(page, "Browse folders").click();
    const browserPath = page.locator("input.new-session-page__browser-path");
    await expectValue(browserPath, TARGET_REPO);
    await browserPath.fill(TARGET_REPO);
    await button(page, "Use this folder").click();
    await gateway.resolveDeferred("agents.list", mainAgentList());
    await page.locator(".new-session-page__message").fill("keep my early folder choice");
    await expect.poll(() => button(page, "Start session").isDisabled()).toBe(false);
    await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toContain(
      "target-repo",
    );
    expect(await mainPreference(page)).toMatchObject({ folder: TARGET_REPO });
  });
});
