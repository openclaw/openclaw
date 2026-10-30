import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createPageOpener,
  bounds,
  button,
  folderListings,
  expectAttribute,
  expectLabel,
  expectValue,
} from "./new-session-page.scenario.test-support.ts";
import {
  PICKED,
  WORKSPACE,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const EXTRA_FOLDERS = [
  { name: "tools", path: `${WORKSPACE}/tools` },
  { name: ".git", path: `${WORKSPACE}/.git`, hidden: true },
];

async function selectProject(page: Page, name: string) {
  await page.locator("#new-session-project-trigger").click();
  await button(page.locator(".new-session-page__project-popover"), name, true).click();
}

suite.define(() => {
  const openPage = createPageOpener(suite);
  it("drafts a session with a browsed folder and creates it on first message", async () => {
    const page = await openPage({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", name: "Main", workspace: WORKSPACE },
            { id: "research", name: "Research", workspace: "/home/peter/research" },
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
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          headBranch: "main",
          repositoryStatus: "git",
        },
        "fs.listDir": folderListings("/home/peter", "/home/peter", EXTRA_FOLDERS),
        "sessions.list": createdSessionListResult("agent:main:existing"),
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });
    const response = await page.goto(`${suite.server.baseUrl}new`);
    expect(response?.status()).toBe(200);
    await page.getByRole("heading", { name: "Main" }).waitFor();
    await page.locator(".new-session-page__message").waitFor();
    const incognitoToggle = page.getByRole("switch", { name: "Incognito" });
    const incognitoBox = await bounds(incognitoToggle);
    const pageBox = await bounds(page.locator(".new-session-page"));
    expect(incognitoBox.x).toBeGreaterThan(pageBox.x + pageBox.width / 2);
    expect(incognitoBox.x + incognitoBox.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
    expect(incognitoBox.y).toBeGreaterThanOrEqual(pageBox.y);
    expect(
      await page
        .locator(".new-session-page__composer")
        .getByRole("switch", { name: "Incognito" })
        .count(),
    ).toBe(0);
    const fastMode = page.locator('.new-session-page__composer [data-chat-speed-option="on"]');
    await page.locator('.new-session-page__composer [data-chat-thinking-select="true"]').click();
    await fastMode.waitFor();
    expect(await fastMode.count()).toBe(1);
    expect(await fastMode.getAttribute("aria-checked")).toBe("false");
    expect(
      await fastMode.evaluate((element) =>
        element.classList.contains("chat-controls__speed-option"),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
    const projectSelect = page.locator(".oc-popover.new-session-page__project-popover");
    const projectTrigger = page.locator("#new-session-project-trigger");
    const checkoutSelect = page.locator(".oc-popover.new-session-page__checkout-popover");
    const checkoutTrigger = page.locator("#new-session-checkout-trigger");
    await expectLabel(projectTrigger, "openclaw");
    await projectTrigger.click();
    await pollLocatorText(projectSelect.locator(".new-session-page__menu-title").first()).toBe(
      "Projects",
    );
    await button(projectSelect, "Browse folders").click();
    await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
    await expectValue(page.locator("input.new-session-page__browser-path"), PICKED);
    await button(page, "Use this folder").click();
    await expect
      .poll(() => projectSelect.evaluate((element) => element.matches(":popover-open")))
      .toBe(false);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("new-session-project-trigger");
    await expectLabel(projectTrigger, "packages");
    await expectAttribute(checkoutTrigger, "data-worktree", "false");
    await expectLabel(checkoutTrigger, "main");
    await checkoutTrigger.click();
    await expectAttribute(checkoutTrigger, "aria-expanded", "true");
    await pollLocatorText(checkoutSelect.locator(".new-session-page__menu-title").first()).toBe(
      "Checkout",
    );
    await button(checkoutSelect, "New worktree Isolated copy of the repo", true).click();
    await checkoutSelect.getByLabel("Name", { exact: true }).fill("release-proof");
    const afterPointerHide = checkoutSelect.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener("overlay-after-hide", () => resolve(), { once: true });
        }),
    );
    // The name now opens the agent picker; use the visible, noninteractive avatar
    // to prove outside-pointer dismissal without opening a sibling menu.
    await page.locator(".agent-chat__welcome-avatar").click();
    await afterPointerHide;
    expect(await agentPicker.locator(".agent-select__trigger").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await expect
      .poll(() => checkoutSelect.evaluate((element) => element.matches(":popover-open")))
      .toBe(false);
    const message = page.locator(".new-session-page__message");
    await message.fill("/");
    const slashMenu = page.locator("#chat-new-session-slash-menu-listbox");
    await pollLocatorText(slashMenu).toContain("/status");
    expect(await slashMenu.textContent()).not.toContain("/clear");
    await message.fill("fix the flaky test");
    expect(new URL(page.url()).pathname).toBe("/new");
    expect(
      await page.locator('.sidebar-recent-session[data-session-key="agent:main:existing"]').count(),
    ).toBe(1);
    expect(await page.locator(".sidebar-recent-session").count()).toBe(1);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    await button(page, "Start session").click();
    const createRequest = await gateway.waitForRequest("sessions.create");
    expect(createRequest.params).toMatchObject({
      agentId: "main",
      message: "fix the flaky test",
      worktree: true,
      worktreeName: "release-proof",
      cwd: PICKED,
    });
    expect(createRequest.params).not.toHaveProperty("worktreeBaseRef");
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(controlUiSessionPath("agent:main:draft-e2e"));
    expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
  });

  it("selects an eligible checkout for a restricted registered project", async () => {
    const page = await openPage({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.sessions.write"],
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "projects.list",
        "projects.checkoutOptions",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": {
          projects: [
            { id: "sample-project", displayName: "Sample Project", source: "registered" },
            { id: "allowed-project", displayName: "Workspace Project", source: "registered" },
          ],
        },
        "projects.checkoutOptions": {
          cases: [
            {
              match: { projectId: "allowed-project" },
              response: { current: true, worktree: true },
            },
            { response: { current: false, worktree: true } },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:main:checkout-choice" },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("projects.list");
    const message = page.locator(".new-session-page__message");
    await message.fill("Inspect the project and explain the next change.");
    await selectProject(page, "Sample Project");
    const trigger = page.locator("#new-session-checkout-trigger");
    await trigger.click();
    const checkout = page.locator(".oc-popover.new-session-page__checkout-popover");
    await expectAttribute(trigger, "data-worktree", "true");
    const current = checkout.locator('[data-value="checkout"]');
    expect(await current.isDisabled()).toBe(true);
    expect(await current.textContent()).toContain(
      "Use an isolated worktree for this project and agent",
    );
    await page.keyboard.press("Escape");
    await selectProject(page, "Workspace Project");
    await trigger.click();
    await expect.poll(() => current.isDisabled()).toBe(false);
    expect(await trigger.getAttribute("data-worktree")).toBe("true");
    await current.click();
    await expectAttribute(trigger, "data-worktree", "false");
    await page.keyboard.press("Escape");
    await selectProject(page, "Sample Project");
    await expectAttribute(trigger, "data-worktree", "true");
    expect(await message.inputValue()).toBe("Inspect the project and explain the next change.");
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "main",
      projectId: "sample-project",
      worktree: true,
      message: "Inspect the project and explain the next change.",
    });
    expect(create.params).not.toHaveProperty("cwd");
  });

  it("selects a registered project and submits its id at write scope", async () => {
    const page = await openPage({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "projects.list",
        "environments.list",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": {
          projects: [
            {
              id: "workspace:main",
              displayName: "openclaw",
              repoRoot: WORKSPACE,
              source: "workspace",
              agentId: "main",
            },
            {
              id: "recorded-openclaw",
              displayName: "Recorded OpenClaw",
              repoRoot: "/recorded/openclaw",
              source: "registered",
            },
          ],
        },
        "environments.list": { environments: [], profiles: [] },
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        "sessions.create": { key: "agent:main:project-e2e" },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("projects.list");
    const trigger = page.locator("#new-session-project-trigger");
    const place = page.locator(".oc-popover.new-session-page__project-popover");
    await trigger.click();
    await button(place, "Recorded OpenClaw", true).click();
    await expectLabel(trigger, "Recorded OpenClaw");
    expect(await trigger.getAttribute("data-project-id")).toBe("recorded-openclaw");
    await expect
      .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
      .toEqual({ repoRoot: "/recorded/openclaw", includeRepositoryStatus: true });
    await page.locator("#new-session-checkout-trigger").click();
    await button(
      page.locator(".oc-popover.new-session-page__checkout-popover"),
      "New worktree Isolated copy of the repo",
      true,
    ).click();
    await page.keyboard.press("Escape");
    await page.locator(".new-session-page__message").fill("inspect the project");
    await button(page, "Start session").click();
    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "main",
      message: "inspect the project",
      projectId: "recorded-openclaw",
      worktree: true,
    });
    expect(create.params).not.toHaveProperty("worktreeBaseRef");
    expect(create.params).not.toHaveProperty("cwd");
    expect(create.params).not.toHaveProperty("execNode");
  });

  it("opens the typed folder exactly and filters folders for keyboard activation", async () => {
    const page = await openPage({ locale: "en-US", serviceWorkers: "block" });
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: { "fs.listDir": folderListings(WORKSPACE, undefined, EXTRA_FOLDERS) },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const place = page.locator(".oc-popover.new-session-page__project-popover");
    await page.locator("#new-session-project-trigger").click();
    await button(place, "Browse folders").click();
    await gateway.waitForRequest("fs.listDir");
    const input = place.locator("input.new-session-page__browser-path");
    await expectValue(input, WORKSPACE);
    await place.locator(".new-session-page__browser-entry", { hasText: "packages" }).waitFor();
    await input.fill(WORKSPACE);
    await input.press("Enter");
    await gateway.waitForRequest("fs.listDir", { after: 1 });
    await place.locator(".new-session-page__browser-loading").waitFor({ state: "hidden" });
    expect(await input.inputValue()).toBe(WORKSPACE);
    expect((await gateway.getRequests("fs.listDir")).at(-1)?.params).toEqual({ path: WORKSPACE });
    const requestsBefore = await gateway.getRequests("fs.listDir");
    await input.fill(`${WORKSPACE}/pa`);
    await expect
      .poll(() => place.locator(".new-session-page__browser-entry").allTextContents())
      .toEqual([expect.stringMatching(/^\s*packages\s*$/)]);
    expect(await gateway.getRequests("fs.listDir")).toHaveLength(requestsBefore.length);
    await input.press("ArrowDown");
    await input.press("Enter");
    await gateway.waitForRequest("fs.listDir", { match: { path: PICKED } });
    await expectValue(input, PICKED);
    await input.fill(`${WORKSPACE}/zzz`);
    await place.getByText("No matching folders", { exact: true }).waitFor();
  });

  it("returns from the browse root to the place menu", async () => {
    const page = await openPage({ locale: "en-US", serviceWorkers: "block" });
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": { path: WORKSPACE, home: WORKSPACE, entries: [] },
        "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const trigger = page.locator("#new-session-project-trigger");
    const place = page.locator(".oc-popover.new-session-page__project-popover");
    await trigger.click();
    await button(place, "Browse folders").click();
    await gateway.waitForRequest("fs.listDir");
    await button(place, "Parent folder").click();
    await button(place, "Browse folders").waitFor();
    expect(await place.evaluate((element) => element.matches(":popover-open"))).toBe(true);
    await button(place, "Browse folders").click();
    await page.locator("input.new-session-page__browser-path").press("Escape");
    await button(place, "Browse folders").waitFor();
    expect(await place.evaluate((element) => element.matches(":popover-open"))).toBe(true);
  });

  it("shows a retry when project discovery fails and restores the list", async () => {
    const page = await openPage({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "projects.list"],
      methodResponses: {
        "projects.list": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "Session projection changed while preparing the listing. Retry the request.",
          },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("projects.list");
    const message = page.locator(".new-session-page__message");
    await message.fill("Keep this draft while projects reload.");
    const trigger = page.locator("#new-session-project-trigger");
    await trigger.click();
    const error = page.locator(".new-session-page__project-error");
    await pollLocatorText(error).toContain(
      "Session projection changed while preparing the listing",
    );
    await page.screenshot({ path: "/tmp/pr-187062-projects-failed.png", fullPage: true });
    await gateway.setMethodResponse("projects.list", {
      projects: [{ id: "registered", displayName: "Registered Project", source: "registered" }],
    });
    await button(error, "Retry").click();
    await pollLocatorText(page.locator(".new-session-page__project-popover")).toContain(
      "Registered Project",
    );
    expect(await error.count()).toBe(0);
    expect(await message.inputValue()).toBe("Keep this draft while projects reload.");
    await page.screenshot({ path: "/tmp/pr-187062-projects-recovered.png", fullPage: true });
  });
});
