import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  captureNewSessionComposerUiProof,
  captureProjectUiProof,
  captureUiProofEnabled,
  checkoutBaseRefInput,
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

async function captureFolderBrowser(page: Page, name: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  const browser = page.locator(".new-session-page__browser");
  const frame = await takeControlUiScreenshotFrame(
    page,
    browser,
    [browser.getByRole("combobox"), button(browser, "Use this folder")],
    { animations: "disabled", viewport: { width: 1280, height: 900 } },
  );
  await writeFile(path.join(suite.artifactDir, name), frame.png);
}

function recordingOptions(name: string, desktop = true): BrowserContextOptions {
  const viewport = { height: 900, width: 1280 };
  return {
    locale: "en-US",
    serviceWorkers: "block",
    ...(desktop ? { viewport } : {}),
    ...(captureUiProofEnabled
      ? { viewport, recordVideo: { dir: path.join(suite.artifactDir, name), size: viewport } }
      : {}),
  };
}

async function selectProject(page: Page, name: string) {
  await page.locator("#new-session-project-trigger").click();
  await button(page.locator(".new-session-page__project-popover"), name, true).click();
}

suite.define(() => {
  const openPage = createPageOpener(suite);
  it("keeps the pre-submit draft on the composer and creates exactly one session", async () => {
    const page = await openPage(recordingOptions("new-session-slash-menu"));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"],
        "sessions.list": createdSessionListResult("agent:main:existing"),
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });
    await page.goto(`${suite.server.baseUrl}new?agent=main`);
    await page.getByRole("heading", { name: "Main" }).waitFor();
    const message = page.locator(".new-session-page__message");
    await message.waitFor();
    await message.fill("/");
    const slashMenu = page.locator("#chat-new-session-slash-menu-listbox");
    await pollLocatorText(slashMenu).toContain("/status");
    expect(await slashMenu.textContent()).not.toContain("/clear");
    await captureNewSessionComposerUiProof(suite, page, "slash-menu-open.png", {
      surface: slashMenu,
      content: [slashMenu.getByRole("option").first()],
    });
    if (captureUiProofEnabled) {
      await page.waitForTimeout(750);
    }
    await message.fill("fix the flaky draft test");
    expect(new URL(page.url())).toMatchObject({ pathname: "/new", search: "?agent=main" });
    expect(await message.inputValue()).toBe("fix the flaky draft test");
    expect(
      await page.locator('.sidebar-recent-session[data-session-key="agent:main:existing"]').count(),
    ).toBe(1);
    expect(await page.locator(".sidebar-recent-session").count()).toBe(1);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    await button(page, "Start session").click();
    const createRequest = await gateway.waitForRequest("sessions.create");
    expect(createRequest.params).toMatchObject({
      agentId: "main",
      message: "fix the flaky draft test",
    });
    // Count after navigation settles so a late duplicate cannot escape the assertion.
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(controlUiSessionPath("agent:main:draft-e2e"));
    expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
  });

  it("drafts a session with a browsed folder and creates it on first message", async () => {
    const page = await openPage(recordingOptions("project-registry"));
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
    expect(await incognitoToggle.getAttribute("aria-checked")).toBe("false");
    await incognitoToggle.click();
    await expectAttribute(incognitoToggle, "aria-checked", "true");
    await incognitoToggle.click();
    await expectAttribute(incognitoToggle, "aria-checked", "false");
    const heroBox = await bounds(page.locator(".agent-chat__welcome-identity"));
    const triggersBox = await bounds(page.locator(".new-session-page__triggers"));
    const composerBox = await bounds(page.locator(".new-session-page__composer"));
    await bounds(page.locator('[data-chat-model-select="true"]'));
    const modelWrapperBox = await bounds(
      page.locator(".new-session-page__composer .chat-composer-model-control"),
    );
    const footerBox = await bounds(
      page.locator(".new-session-page__composer .agent-chat__composer-footer"),
    );
    const actionsBox = await bounds(
      page.locator(".new-session-page__composer .agent-chat__composer-actions"),
    );
    const attachmentButton = button(page, "Add attachment");
    const attachmentBox = await bounds(attachmentButton);
    expect(incognitoBox.y + incognitoBox.height).toBeLessThanOrEqual(composerBox.y);
    expect(heroBox.y + heroBox.height).toBeLessThanOrEqual(triggersBox.y + 1);
    expect(triggersBox.y + triggersBox.height).toBeLessThanOrEqual(composerBox.y + 1);
    expect(
      await page.locator(".new-session-page__composer .agent-chat__composer-footer").count(),
    ).toBe(1);
    expect(
      await page
        .locator('[data-chat-model-select="true"]')
        .evaluate((element) => element.closest(".agent-chat__composer-footer") != null),
    ).toBe(true);
    expect(
      await attachmentButton.evaluate(
        (element) => element.closest(".agent-chat__composer-footer") != null,
      ),
    ).toBe(true);
    expect(
      await attachmentButton.evaluate(
        (element) => element.closest(".agent-chat__composer-input-row") == null,
      ),
    ).toBe(true);
    expect(attachmentBox.x).toBeLessThan(modelWrapperBox.x);
    expect(modelWrapperBox.x).toBeGreaterThan(footerBox.x + footerBox.width / 2);
    expect(actionsBox.x - (modelWrapperBox.x + modelWrapperBox.width)).toBeLessThanOrEqual(12);
    expect(modelWrapperBox.x + modelWrapperBox.width).toBeLessThanOrEqual(actionsBox.x);
    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(footerBox.x + footerBox.width + 1);
    expect(triggersBox.x).toBeCloseTo(composerBox.x, 0);
    expect(triggersBox.width).toBeCloseTo(composerBox.width, 0);
    expect(composerBox.width).toBeCloseTo(48 * 16, 0);
    expect(await page.locator(".new-session-page__message").getAttribute("rows")).toBe("1");
    await captureProjectUiProof(suite, page, "new-session-control-layout.png");
    await page.setViewportSize({ width: 393, height: 852 });
    const mobileModelSettings = page.locator(
      '.new-session-page__composer [data-chat-model-select="true"]',
    );
    const mobilePermission = page.locator(
      '.new-session-page__composer [data-chat-permission-select="true"]',
    );
    const mobilePermissionIcon = mobilePermission.locator(".chat-controls__permission-icon svg");
    const permissionIconCenterError = async () => {
      const [triggerBox, iconBox] = await Promise.all([
        mobilePermission.boundingBox(),
        mobilePermissionIcon.boundingBox(),
      ]);
      if (!triggerBox || !iconBox) {
        return Number.POSITIVE_INFINITY;
      }
      const x = iconBox.x + iconBox.width / 2 - (triggerBox.x + triggerBox.width / 2);
      const y = iconBox.y + iconBox.height / 2 - (triggerBox.y + triggerBox.height / 2);
      return Math.max(Math.abs(x), Math.abs(y));
    };
    await expect.poll(() => mobileModelSettings.isVisible()).toBe(true);
    await expect.poll(permissionIconCenterError).toBeLessThanOrEqual(1);
    // Visibility and centered icons also hold before the responsive layout lands.
    await waitForLayoutSettled(
      page,
      '.new-session-page__composer .agent-chat__composer-footer, .new-session-page__composer [data-chat-model-select="true"]',
    );
    const [mobileFooterBox, mobileModelSettingsBox] = await Promise.all([
      page.locator(".new-session-page__composer .agent-chat__composer-footer").boundingBox(),
      mobileModelSettings.boundingBox(),
    ]);
    expect(mobileFooterBox).not.toBeNull();
    expect(mobileModelSettingsBox).not.toBeNull();
    if (!mobileFooterBox || !mobileModelSettingsBox) {
      throw new Error("expected mobile new-session composer controls");
    }
    expect(mobileModelSettingsBox.width).toBeGreaterThanOrEqual(44);
    expect(mobileModelSettingsBox.height).toBeGreaterThanOrEqual(44);
    expect(mobileModelSettingsBox.x).toBeGreaterThanOrEqual(mobileFooterBox.x);
    expect(mobileModelSettingsBox.x + mobileModelSettingsBox.width).toBeLessThanOrEqual(
      mobileFooterBox.x + mobileFooterBox.width,
    );
    await captureProjectUiProof(suite, page, "mobile-new-session-idle.png");
    await mobilePermission.click();
    await page.locator('[data-chat-permission-option="workspace"]').click();
    await expectAttribute(mobilePermission, "data-chat-select-value", "workspace");
    await mobilePermission.click();
    await expect
      .poll(() => page.locator(".chat-controls__permission-option").first().isVisible())
      .toBe(true);
    await captureProjectUiProof(suite, page, "mobile-new-session-permissions-open.png", {
      surface: page.locator(".chat-controls__permission-menu"),
      content: [page.locator(".chat-controls__permission-option").first()],
    });
    await page.keyboard.press("Escape");
    await mobileModelSettings.click();
    await expect.poll(() => page.locator(".chat-controls__model-menu").isVisible()).toBe(true);
    const capturedModelOption = page
      .locator(".chat-controls__model-picker[open] [data-chat-model-option]")
      .first();
    if (captureUiProofEnabled) {
      await capturedModelOption.waitFor({ state: "visible" });
    }
    await captureProjectUiProof(suite, page, "mobile-new-session-model-open.png", {
      surface: page.locator(".chat-controls__model-picker > [data-anchored-overlay]"),
      content: [capturedModelOption],
    });
    expect(
      await page
        .locator(".chat-controls__model-menu")
        .getByText(/Effort|Speed/)
        .count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await page.locator('[data-chat-thinking-select="true"]').click();
    await expect.poll(() => page.locator(".chat-controls__effort-menu").isVisible()).toBe(true);
    await captureProjectUiProof(suite, page, "mobile-new-session-effort-open.png", {
      surface: page.locator(".chat-controls__effort-picker > [data-anchored-overlay]"),
      content: [fastMode],
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 900 });
    const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
    await agentPicker.locator(".agent-select__trigger").click();
    await pollLocatorText(agentPicker.locator(".agent-select__menu-title")).toBe("Agents");
    await captureProjectUiProof(suite, page, "new-session-agent-menu-label.png", {
      surface: agentPicker.locator(".agent-select__menu"),
      content: [agentPicker.locator(".agent-select__menu-title")],
    });
    await page.keyboard.press("Escape");
    const whereSelect = page.locator(".oc-popover.new-session-page__where-popover");
    const whereTrigger = page.locator("#new-session-where-trigger");
    await whereTrigger.click();
    const environmentSearch = whereSelect.getByRole("searchbox", { name: "Search environments" });
    await expectAttribute(environmentSearch, "placeholder", "Search environments");
    await expect
      .poll(() => environmentSearch.evaluate((element) => element === document.activeElement))
      .toBe(true);
    const localEnvironment = whereSelect.locator('[data-value="gateway"]');
    expect(await localEnvironment.getAttribute("aria-pressed")).toBe("true");
    await environmentSearch.fill("no-such-environment");
    await whereSelect
      .getByRole("status")
      .getByText("No matching environments", { exact: true })
      .waitFor();
    expect(await whereTrigger.locator(".new-session-page__trigger-label").textContent()).toBe(
      "Local",
    );
    await environmentSearch.fill("");
    await expect.poll(() => localEnvironment.isVisible()).toBe(true);
    expect(await localEnvironment.getAttribute("aria-pressed")).toBe("true");
    await captureProjectUiProof(suite, page, "new-session-environment-search.png", {
      surface: whereSelect,
      content: [environmentSearch],
    });
    await page.keyboard.press("Escape");
    await expectAttribute(whereTrigger, "aria-expanded", "false");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("new-session-where-trigger");
    const projectSelect = page.locator(".oc-popover.new-session-page__project-popover");
    const projectTrigger = page.locator("#new-session-project-trigger");
    const checkoutSelect = page.locator(".oc-popover.new-session-page__checkout-popover");
    const checkoutTrigger = page.locator("#new-session-checkout-trigger");
    await expectLabel(projectTrigger, "openclaw");
    await projectTrigger.click();
    await pollLocatorText(projectSelect.locator(".new-session-page__menu-title").first()).toBe(
      "Projects",
    );
    await captureProjectUiProof(suite, page, "new-session-project-menu-label.png", {
      surface: projectSelect,
      content: [button(projectSelect, "Browse folders")],
    });
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
    await captureProjectUiProof(suite, page, "new-session-checkout-menu-label.png", {
      surface: checkoutSelect,
      content: [checkoutSelect.locator(".new-session-page__menu-title").first()],
    });
    const currentCheckout = checkoutSelect.locator('[data-value="checkout"]');
    const worktreeItem = button(checkoutSelect, "New worktree Isolated copy of the repo", true);
    await expectAttribute(currentCheckout, "aria-pressed", "true");
    await expectAttribute(worktreeItem, "aria-pressed", "false");
    expect(await worktreeItem.isEnabled()).toBe(true);
    await worktreeItem.click();
    await expectAttribute(checkoutTrigger, "data-worktree", "true");
    await expectAttribute(currentCheckout, "aria-pressed", "false");
    await expectLabel(checkoutTrigger, "New worktree");
    await checkoutBaseRefInput(checkoutSelect).waitFor();
    await checkoutSelect.getByLabel("Name", { exact: true }).waitFor();
    await checkoutSelect
      .getByText("Creates a branch from the session title in a separate checkout.", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await expectAttribute(checkoutTrigger, "aria-expanded", "false");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("new-session-checkout-trigger");
    await checkoutTrigger.click();
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
    await expectLabel(checkoutTrigger, "Worktree · release-proof");
    expect(await checkoutTrigger.getAttribute("aria-label")).toBe(
      "Checkout: Worktree · release-proof",
    );
    expect(await checkoutTrigger.getAttribute("title")).toBe("Checkout: Worktree · release-proof");
    await checkoutTrigger.click();
    expect(await checkoutSelect.getByLabel("Name", { exact: true }).inputValue()).toBe(
      "release-proof",
    );
    await page.keyboard.press("Escape");
    await expect
      .poll(() => checkoutSelect.evaluate((element) => element.matches(":popover-open")))
      .toBe(false);
    const message = page.locator(".new-session-page__message");
    await message.fill("fix the flaky test");
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
  });

  it("selects an eligible checkout for a restricted registered project", async () => {
    const page = await openPage(recordingOptions("checkout-choice"));
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
    await captureProjectUiProof(suite, page, "checkout-choice.png", {
      surface: checkout,
      content: [current],
    });
    if (captureUiProofEnabled) {
      await page.waitForTimeout(750);
    }
    await page.keyboard.press("Escape");
    await selectProject(page, "Workspace Project");
    await trigger.click();
    await expect.poll(() => current.isDisabled()).toBe(false);
    expect(await trigger.getAttribute("data-worktree")).toBe("true");
    await current.click();
    await expectAttribute(trigger, "data-worktree", "false");
    if (captureUiProofEnabled) {
      await page.waitForTimeout(750);
    }
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
    const page = await openPage(recordingOptions("project-registry", false));
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
    const checkout = page.locator(".oc-popover.new-session-page__checkout-popover");
    await captureProjectUiProof(suite, page, "project-selected.png", {
      surface: checkout,
      content: [checkoutBaseRefInput(checkout)],
    });
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
    await captureFolderBrowser(page, "folder-enter.png");
    expect(await input.inputValue()).toBe(WORKSPACE);
    expect((await gateway.getRequests("fs.listDir")).at(-1)?.params).toEqual({ path: WORKSPACE });
    const requestsBefore = await gateway.getRequests("fs.listDir");
    await input.fill(`${WORKSPACE}/pa`);
    await expect
      .poll(() => place.locator(".new-session-page__browser-entry").allTextContents())
      .toEqual([expect.stringMatching(/^\s*packages\s*$/)]);
    await page.screenshot({ path: path.join(suite.artifactDir, "folder-live-prefix.png") });
    expect(await gateway.getRequests("fs.listDir")).toHaveLength(requestsBefore.length);
    await input.press("ArrowDown");
    await input.press("Enter");
    await gateway.waitForRequest("fs.listDir", { match: { path: PICKED } });
    await expectValue(input, PICKED);
    await input.fill(`${WORKSPACE}/zzz`);
    await place.getByText("No matching folders", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(suite.artifactDir, "folder-live-no-matches.png") });
  });

  it("opens HOME for a missing starting workspace and reports a typed missing folder", async () => {
    const page = await openPage({ locale: "en-US", serviceWorkers: "block" });
    const home = "/home/test";
    const gateway = await installMockGateway(page, {
      workspace: "/state/workspace-main",
      methodResponses: {
        "fs.listDir": {
          path: home,
          home,
          parent: "/home",
          entries: [{ name: "projects", path: `${home}/projects` }],
        },
      },
    });
    const missing = { code: "INVALID_REQUEST", message: "ENOENT: no such file or directory" };
    await page.goto(`${suite.server.baseUrl}new?agent=main`);
    await page.locator("#new-session-project-trigger").click();
    await gateway.deferNext("fs.listDir");
    await button(page, "Browse folders").click();
    await gateway.waitForRequest("fs.listDir", { match: { path: "/state/workspace-main" } });
    await gateway.rejectDeferred("fs.listDir", missing);
    const browser = page.locator(".new-session-page__browser");
    await browser.getByRole("option", { name: "projects", exact: true }).waitFor();
    await captureFolderBrowser(page, "folder-start.png");
    expect(await browser.getByRole("combobox").inputValue()).toBe(home);
    expect(await browser.getByRole("alert").count()).toBe(0);
    await gateway.deferNext("fs.listDir");
    await browser.getByRole("combobox").fill("/missing");
    await browser.getByRole("combobox").press("Enter");
    await gateway.waitForRequest("fs.listDir", { match: { path: "/missing" } });
    await gateway.rejectDeferred("fs.listDir", missing);
    await browser.getByRole("alert").waitFor();
    expect(await browser.getByRole("alert").textContent()).toBe("Couldn't list that folder.");
    expect(await browser.getByRole("combobox").inputValue()).toBe("/missing");
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
});
