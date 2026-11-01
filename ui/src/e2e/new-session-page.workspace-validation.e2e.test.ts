import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { holdModuleResponse, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import { cliAgentCatalog } from "./new-session-page.native-terminal.test-support.ts";
import { deferRecoveryScopeHydration } from "./new-session-page.scenario.test-support.ts";
import {
  LOCAL_GIT_WORKSPACE_RESPONSES,
  NEW_SESSION_MODEL_CATALOG,
  SOURCE_REPO,
  TARGET_REPO,
  WORKSPACE,
  captureUiProof,
  checkoutBaseRefInput,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
  replaceGatewayClient,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const BASE_CONTEXT: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block" };
const DESKTOP_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  viewport: { height: 900, width: 1280 },
};
const checkoutPopover = (page: Page) =>
  page.locator(".oc-popover.new-session-page__checkout-popover");
const worktreeOption = (page: Page) =>
  checkoutPopover(page).getByRole("button", {
    name: "New worktree Isolated copy of the repo",
    exact: true,
  });
const messageInput = (page: Page) => page.locator(".new-session-page__message");
const startButton = (page: Page) => page.getByRole("button", { name: "Start session" });
const requestCount = async (gateway: MockGateway, method: string) =>
  (await gateway.getRequests(method)).length;
const expectAttribute = (target: Locator, name: string, value: string | null) =>
  expect.poll(() => target.getAttribute(name)).toBe(value);
const expectInput = (target: Locator, value: string) =>
  expect.poll(() => target.inputValue()).toBe(value);
const expectFocus = (target: Locator) =>
  expect.poll(() => target.evaluate((element) => document.activeElement === element)).toBe(true);
const expectOpen = (target: Locator, open: boolean) =>
  expect.poll(() => target.evaluate((element) => element.matches(":popover-open"))).toBe(open);
const expectRequests = (gateway: MockGateway, method: string, count: number) =>
  expect.poll(() => requestCount(gateway, method)).toBe(count);

async function selectWorktree(page: Page) {
  const trigger = page.locator("#new-session-checkout-trigger");
  await trigger.click();
  await worktreeOption(page).click();
  await page.keyboard.press("Escape");
  await expectAttribute(trigger, "data-worktree", "true");
}

function workspaceResponses(key: string) {
  return {
    "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
    "worktrees.branches": branchList(),
    "sessions.create": { key },
  };
}

const agent = (id: string, name: string, workspace: string) => ({
  id,
  identity: { name },
  name,
  workspace,
  workspaceGit: true,
});
function mainAgentList(name = "Main", workspace = WORKSPACE) {
  return {
    agents: [agent("main", name, workspace)],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  };
}

function branchList(name = "main") {
  return {
    branches: [{ kind: "local", name }],
    defaultBranch: name,
    repositoryStatus: "git",
  };
}

function deviceEnvironment(nodeId: "old-device" | "new-device") {
  return {
    id: `node:${nodeId}`,
    type: "node",
    label: nodeId === "old-device" ? "Old device" : "New device",
    status: "available",
    sessionHost: true,
    workerSlots: { total: 1, available: 1 },
  };
}

type MockGateway = Awaited<ReturnType<typeof installMockGateway>>;
type GatewayOptions = NonNullable<Parameters<typeof installMockGateway>[1]>;
async function openNewPage(
  page: Page,
  methodResponses: Record<string, unknown>,
  options: Omit<GatewayOptions, "methodResponses"> = {},
  query = "",
) {
  const gateway = await installMockGateway(page, { ...options, methodResponses });
  await page.goto(`${suite.server.baseUrl}new${query}`);
  return gateway;
}

async function chooseCustomFolder(page: Page, gateway: MockGateway) {
  const trigger = page.locator("#new-session-project-trigger");
  const place = page.locator(".oc-popover.new-session-page__project-popover");
  await trigger.click();
  await place.getByRole("button", { name: "Browse folders" }).click();
  await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect
    .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
    .toEqual({ repoRoot: TARGET_REPO, includeRepositoryStatus: true });
}

async function disconnectGateway(page: Page, gateway: MockGateway) {
  await pauseVirtualClock(page);
  await gateway.setOnline(false);
  // Show the offline status after its grace window and start the first retry socket.
  await page.clock.fastForward(2_000);
  await waitForControlUiGatewayReconnecting(page);
}

async function reconnectForBranchRediscovery(page: Page, gateway: MockGateway) {
  const branchRequests = await requestCount(gateway, "worktrees.branches");
  await disconnectGateway(page, gateway);
  await resumeGateway(page, gateway);
  await expectRequests(gateway, "worktrees.branches", branchRequests + 1);
}

async function resumeGateway(page: Page, gateway: MockGateway) {
  // Disconnect advanced the retry; taking the mock online opens its waiting socket.
  await gateway.setOnline(true);
  await page.clock.resume();
  await waitForControlUiGatewayReady(page);
}

async function expectPendingNewSession(page: Page, message: string) {
  const startup = page.locator(".new-session-page__starting");
  const submittedPrompt = startup.locator(".chat-group.user");
  await expect.poll(() => submittedPrompt.isVisible()).toBe(true);
  await pollLocatorText(submittedPrompt).toContain(message);
  await pollLocatorText(startup.locator('.chat-working-indicator[role="status"]')).toContain(
    "Starting…",
  );
  expect(await messageInput(page).isVisible()).toBe(false);
}

suite.define(() => {
  it("keeps worktree editing stable and resets the accepted name", async () => {
    await suite.withPage(DESKTOP_CONTEXT, async ({ page }) => {
      const sessionKey = "agent:main:picker-inputs";
      const gateway = await openNewPage(
        page,
        {
          "agents.list": LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"],
          "worktrees.branches": {
            ...LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
            branches: [
              { kind: "local", name: "main" },
              { kind: "local", name: "release/next" },
            ],
          },
          "sessions.create": { key: sessionKey, runStarted: true, runId: "picker-inputs-run" },
        },
        { workspaceGit: true, models: NEW_SESSION_MODEL_CATALOG },
      );
      const checkout = checkoutPopover(page);
      await page.locator("#new-session-checkout-trigger").click();
      await worktreeOption(page).click();

      const baseRef = checkoutBaseRefInput(checkout);
      await baseRef.focus();
      await checkout.locator('[data-worktree-suggestion="release/next"]').click();
      await expectInput(baseRef, "release/next");
      await baseRef.fill("");
      await baseRef.pressSequentially("release/next");
      await expectFocus(baseRef);
      await captureUiProof(suite, page, "worktree-picker-input-focus.png");
      await baseRef.press("Home");
      await baseRef.press("End");
      await baseRef.press("ArrowLeft");
      expect(await baseRef.evaluate((input) => (input as HTMLInputElement).selectionStart)).toBe(
        "release/next".length - 1,
      );
      await baseRef.press("ArrowDown");
      await baseRef.press("ArrowDown");
      await expect
        .poll(() =>
          checkout
            .locator('[data-worktree-suggestion="release/next"]')
            .getAttribute("aria-selected"),
        )
        .toBe("true");
      await baseRef.press("Enter");
      await expectInput(baseRef, "release/next");
      await expectFocus(baseRef);
      const name = checkout.getByLabel("Name", { exact: true });
      await baseRef.press("Tab");
      await expectFocus(name);
      await expectOpen(checkout, true);
      await name.fill("picker-inputs");
      await checkout
        .getByText("Creates branch openclaw/picker-inputs in a separate checkout.", {
          exact: true,
        })
        .waitFor();

      const box = await name.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width - 8, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x - 12, box!.y + box!.height / 2, { steps: 6 });
      await page.mouse.up();
      await expectOpen(checkout, true);

      await name.press("Enter");
      await expectOpen(checkout, false);
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.className))
        .toContain("new-session-page__message");

      await messageInput(page).fill("verify the picker inputs");
      await startButton(page).click();
      await gateway.waitForRequest("sessions.create");
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));

      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-checkout-trigger").click();
      await expect.poll(() => page.getByLabel("Name", { exact: true }).inputValue()).toBe("");
    });
  });

  it.each([false, true])(
    "starts a worktree from an unsuggested ref when branch suggestions are unavailable=%s",
    async (branchesUnavailable) => {
      await suite.withPage(DESKTOP_CONTEXT, async ({ page }) => {
        const branches = branchList();
        const gateway = await openNewPage(
          page,
          {
            "agents.list": mainAgentList(),
            "worktrees.branches": {
              ...branches,
              branches: branchesUnavailable ? [] : branches.branches,
              ...(branchesUnavailable ? { branchesUnavailable: true } : {}),
            },
            "sessions.create": { key: "agent:main:unsuggested-ref", runStarted: true },
          },
          { workspaceGit: true, models: NEW_SESSION_MODEL_CATALOG },
        );
        const checkout = page.locator("#new-session-checkout-trigger");
        await checkout.click();
        await worktreeOption(page).click();
        await expectAttribute(checkout, "data-worktree", "true");
        const baseRef = checkoutBaseRefInput(page);
        await baseRef.fill("origin/release-outside-suggestions");
        expect(
          await page
            .locator('[data-worktree-suggestion="origin/release-outside-suggestions"]')
            .count(),
        ).toBe(0);
        await captureUiProof(
          suite,
          page,
          `worktree-branches-${branchesUnavailable ? "unavailable" : "limited"}.png`,
        );
        await page
          .getByText(
            branchesUnavailable
              ? "Branch suggestions are unavailable. Enter a branch or commit."
              : "Suggestions are limited. Enter any branch or commit.",
            { exact: true },
          )
          .waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await messageInput(page).fill("start from the selected release");
        await startButton(page).click();
        expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
          agentId: "main",
          message: "start from the selected release",
          worktree: true,
          worktreeBaseRef: "origin/release-outside-suggestions",
        });
      });
    },
  );

  it.each([
    ["workspace", "unavailable", "keep this task isolated", "worktree-unavailable"],
    ["custom", "not_git", "continue directly", "custom-now-direct"],
    ["custom", "unavailable", "do not run directly", "custom-worktree-cleared"],
  ] as const)(
    "handles %s worktree rediscovery becoming %s",
    async (folder, repositoryStatus, message, id) => {
      await suite.withPage(BASE_CONTEXT, async ({ page }) => {
        await page.clock.install();
        const key = `agent:main:${id}`;
        const gateway = await installMockGateway(page, {
          workspace: WORKSPACE,
          workspaceGit: true,
          methodResponses:
            folder === "custom"
              ? workspaceResponses(key)
              : {
                  "worktrees.branches": branchList(),
                  "sessions.create": { key },
                },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        if (folder === "custom") {
          await chooseCustomFolder(page, gateway);
        } else {
          await gateway.waitForRequest("worktrees.branches");
        }
        const trigger = page.locator("#new-session-checkout-trigger");
        const start = startButton(page);
        await selectWorktree(page);
        if (folder === "workspace") {
          await gateway.deferNext("worktrees.branches");
        } else {
          await gateway.setMethodResponse("worktrees.branches", { branches: [], repositoryStatus });
        }
        await reconnectForBranchRediscovery(page, gateway);
        if (folder === "workspace") {
          await gateway.rejectDeferred("worktrees.branches", {
            code: "UNAVAILABLE",
            message: "branch lookup unavailable",
          });
        }
        if (repositoryStatus === "not_git") {
          await expect.poll(() => trigger.count()).toBe(0);
          expect(
            await page.evaluate(() => {
              const storageKey = Object.keys(localStorage).find((candidate) =>
                candidate.startsWith("openclaw.new-session.preferences.v1:"),
              );
              const value = storageKey
                ? (JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
                    agents?: Record<string, { worktree?: boolean }>;
                  } | null)
                : null;
              return value?.agents?.main?.worktree;
            }),
          ).toBe(false);
        } else {
          await expectAttribute(trigger, "data-worktree", "true");
          await messageInput(page).fill(message);
          await expect.poll(() => start.isDisabled()).toBe(true);
          await trigger.click();
          const worktree = worktreeOption(page);
          if (folder === "workspace") {
            await expectAttribute(worktree, "aria-pressed", "true");
            expect(await worktree.isDisabled()).toBe(true);
            await page.keyboard.press("Escape");
            expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
            await trigger.click();
          } else {
            expect(await worktree.isDisabled()).toBe(true);
            await expect
              .poll(() => tooltipTitleText(worktree))
              .toBe("Couldn't verify Git for this folder. Choose it again to retry.");
          }
          await checkoutPopover(page).getByRole("button", { name: "Current checkout" }).click();
          await expect.poll(() => trigger.count()).toBe(0);
          if (folder === "custom") {
            await expect.poll(() => start.isEnabled()).toBe(true);
          }
          await page.keyboard.press("Escape");
        }
        if (repositoryStatus === "not_git") {
          await messageInput(page).fill(message);
        }
        await start.click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          message,
          ...(folder === "custom" ? { cwd: TARGET_REPO } : {}),
          ...(repositoryStatus === "unavailable" ? { agentId: "main" } : {}),
        });
        expect(create.params).not.toHaveProperty("worktree");
      });
    },
  );

  it("blocks an unavailable cloud source until New workspace is explicitly selected", async () => {
    await suite.withPage(BASE_CONTEXT, async ({ page }) => {
      await page.clock.install();
      const sessionKey = "agent:main:cleared-unavailable-source";
      const gateway = await openNewPage(
        page,
        {
          "environments.list": {
            environments: [],
            profiles: [{ id: "aws", providerId: "crabbox" }],
          },
          ...workspaceResponses(sessionKey),
          "sessions.list": createdSessionListResult(sessionKey),
          "sessions.dispatch": {
            sessionId: `session:${sessionKey}`,
            placement: { state: "active", generation: 1 },
          },
          "chat.send": { runId: "run-cleared-source", status: "started" },
        },
        { workspace: WORKSPACE, workspaceGit: true },
      );
      await gateway.waitForRequest("environments.list");
      await chooseCustomFolder(page, gateway);
      const whereTrigger = page.locator("#new-session-where-trigger");
      const where = page.locator(".oc-popover.new-session-page__where-popover");
      const checkoutTrigger = page.locator("#new-session-checkout-trigger");
      await whereTrigger.click();
      await where.getByRole("button", { name: "aws", exact: true }).click();
      await expectAttribute(whereTrigger, "data-cloud-profile", "aws");
      await expectAttribute(checkoutTrigger, "data-worktree", "true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "unavailable",
      });
      await reconnectForBranchRediscovery(page, gateway);

      await expectAttribute(whereTrigger, "data-cloud-profile", "aws");
      await expectAttribute(checkoutTrigger, "data-worktree", "true");
      await messageInput(page).fill("do not run directly");
      const start = startButton(page);
      await expect.poll(() => start.isDisabled()).toBe(true);
      await whereTrigger.click();
      const cloud = where.getByRole("button", { name: "aws", exact: true });
      expect(await cloud.isEnabled()).toBe(true);
      await cloud.click();
      await expect.poll(() => start.isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      await checkoutTrigger.click();
      const checkout = checkoutPopover(page);
      expect(await checkout.locator('[data-value="checkout"]').isDisabled()).toBe(true);
      await checkoutBaseRefInput(checkout).waitFor();
      await checkout.getByLabel("Name", { exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.keyboard.press("Escape");

      const projectTrigger = page.locator("#new-session-project-trigger");
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "target-repo",
      );
      await projectTrigger.click();
      await page.locator('.new-session-page__project-popover [data-value="new-workspace"]').click();
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "New workspace",
      );
      expect(await checkoutTrigger.count()).toBe(0);
      await expect.poll(() => start.isEnabled()).toBe(true);
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "",
        titleSource: "do not run directly",
        worktree: true,
        worktreeSource: "empty",
      });
      for (const field of ["cwd", "projectId", "repository", "worktreeBaseRef", "worktreeName"]) {
        expect(create.params).not.toHaveProperty(field);
      }
      expect((await gateway.waitForRequest("sessions.dispatch")).params).toEqual({
        key: sessionKey,
        agentId: "main",
        profileId: "aws",
      });
      expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
        sessionKey,
        sessionId: `session:${sessionKey}`,
        expectedLeafEntryId: null,
        message: "do not run directly",
      });
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
    });
  });

  it("rediscovers Gateway-owned draft state when the app replaces its client", async () => {
    await suite.withPage(DESKTOP_CONTEXT, async ({ page }) => {
      const gateway = await openNewPage(page, {
        "agents.list": mainAgentList("Original agent", SOURCE_REPO),
        "environments.list": {
          environments: [deviceEnvironment("old-device")],
          profiles: [],
        },
        "worktrees.branches": branchList("alpha"),
      });
      await page.getByRole("heading", { name: "Original agent" }).waitFor();
      await gateway.waitForRequest("environments.list");
      await gateway.waitForRequest("worktrees.branches");

      const message = messageInput(page);
      const whereSelect = page.locator(".oc-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const projectSelect = page.locator(".oc-popover.new-session-page__project-popover");
      const projectTrigger = page.locator("#new-session-project-trigger");
      await message.fill("preserve this replacement draft");
      await page.locator("#new-session-checkout-trigger").click();
      await worktreeOption(page).click();
      await page.keyboard.press("Escape");
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Old device" }).click();

      // Keep an old-client browser request in flight. Replacement must close
      // its menu and prevent its eventual completion from reviving old state.
      await gateway.deferNext("fs.listDir");
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");

      await gateway.setMethodResponse(
        "agents.list",
        mainAgentList("Replacement agent", TARGET_REPO),
      );
      await gateway.setMethodResponse("environments.list", {
        environments: [deviceEnvironment("new-device")],
        profiles: [],
      });
      await gateway.setMethodResponse("worktrees.branches", branchList("beta"));
      const socketsBefore = await gateway.getSocketCount();
      const environmentsBefore = await requestCount(gateway, "environments.list");
      const branchesBefore = await requestCount(gateway, "worktrees.branches");

      await replaceGatewayClient(page);

      await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
      await expectRequests(gateway, "environments.list", environmentsBefore + 1);
      await expect
        .poll(async () =>
          (await gateway.getRequests("worktrees.branches"))
            .slice(branchesBefore)
            .map((request) => request.params),
        )
        .toEqual([{ repoRoot: TARGET_REPO, includeRepositoryStatus: true }]);
      await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
      await expectInput(message, "preserve this replacement draft");
      await expectOpen(projectSelect, false);
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "target-repo",
      );

      const branchRequests = await gateway.getRequests("worktrees.branches");
      expect(branchRequests.at(-1)?.params).toEqual({
        repoRoot: TARGET_REPO,
        includeRepositoryStatus: true,
      });
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "New device" }).waitFor();
      expect(await whereSelect.getByRole("button", { name: "Old device" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator("#new-session-checkout-trigger").click();
      const checkout = checkoutPopover(page);
      await expect
        .poll(() => checkoutBaseRefInput(checkout).getAttribute("placeholder"))
        .toBe("beta");
      expect(await checkoutBaseRefInput(checkout).inputValue()).toBe("");
      await page.keyboard.press("Escape");

      await gateway.resolveDeferred("fs.listDir", {
        path: "/stale-device-path",
        home: "/stale-device-path",
        entries: [],
      });
      await expectOpen(projectSelect, false);
      await expectInput(message, "preserve this replacement draft");
    });
  });

  it.each(["before acceptance", "during chat preparation"] as const)(
    "keeps a local start owned when recovery scope hydrates %s",
    async (hydration) => {
      await suite.withPage(DESKTOP_CONTEXT, async ({ page }) => {
        await page.addInitScript(deferRecoveryScopeHydration);
        const chatModule = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
        );
        try {
          const sessionKey = "agent:main:late-recovery-scope";
          const gateway = await openNewPage(
            page,
            {
              "sessions.create": { key: sessionKey, runStarted: true, runId: "late-scope-run" },
            },
            { deferredMethods: ["sessions.create"] },
          );
          const message = messageInput(page);
          const start = page.locator("button.new-session-page__start-submit");
          await message.fill("keep this admitted task");
          await waitForGatewayRecoveryScope(page, false);
          await start.click();
          await gateway.waitForRequest("sessions.create");
          if (hydration === "during chat preparation") {
            await gateway.resolveDeferred("sessions.create");
            // The provisional route cannot adopt selection while its preview module is blocked.
            await expect
              .poll(() =>
                evaluateControlUiContext(page, (context) => context.gateway.snapshot.sessionKey),
              )
              .toBe("agent:main:main");
            await chatModule.request;
          }

          await page.evaluate(() => window.dispatchEvent(new Event("test-release-recovery-scope")));
          await waitForGatewayRecoveryScope(page);
          await page.locator("openclaw-new-session-page").evaluate(async (element) => {
            await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
          });
          expect(await page.locator(".new-session-page__error").allTextContents()).toEqual([]);
          await expectPendingNewSession(page, "keep this admitted task");
          expect(await gateway.getSocketCount()).toBe(1);
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);

          if (hydration === "before acceptance") {
            await gateway.resolveDeferred("sessions.create");
          }
          chatModule.release();
          await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
        } finally {
          chatModule.release();
          await page.unrouteAll({ behavior: "wait" });
        }
      });
    },
  );

  for (const reconnectKind of ["same-client reconnect", "client replacement"] as const) {
    it(`automatically resumes an idempotent session creation after ${reconnectKind}`, async () => {
      await suite.withPage(DESKTOP_CONTEXT, async ({ page }) => {
        if (reconnectKind === "same-client reconnect") {
          await page.clock.install();
        }
        const sessionKey = `agent:main:resumed-${reconnectKind.replaceAll(" ", "-")}`;
        const gateway = await openNewPage(page, {
          "agents.list": mainAgentList("Original agent", SOURCE_REPO),
          "worktrees.branches": branchList(),
          "sessions.create": { key: sessionKey },
        });
        await page.getByRole("heading", { name: "Original agent" }).waitFor();
        const message = messageInput(page);
        const start = page.locator("button.new-session-page__start-submit");
        const submittedMessage = "retry this draft after reconnect";
        await message.fill(submittedMessage);
        await gateway.deferNext("sessions.create");
        await start.click();
        const originalCreate = await gateway.waitForRequest("sessions.create");
        await expectPendingNewSession(page, submittedMessage);
        await gateway.deferNext("sessions.create");
        const agentRequestsBefore = await requestCount(gateway, "agents.list");

        if (reconnectKind === "client replacement") {
          await gateway.setMethodResponse(
            "agents.list",
            mainAgentList("Replacement agent", TARGET_REPO),
          );
          const socketsBefore = await gateway.getSocketCount();
          await replaceGatewayClient(page);
          await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
          await waitForControlUiGatewayReady(page);
        } else {
          await disconnectGateway(page, gateway);
          // Transport loss keeps the submitted display while execution waits for reconnection.
          expect(await page.getByText(submittedMessage, { exact: true }).isVisible()).toBe(true);
          await expect
            .poll(() => page.locator(".chat-working-indicator").textContent())
            .toContain("Reconnecting");
          expect(await page.locator("openclaw-chat-pane").count()).toBe(0);
          await resumeGateway(page, gateway);
        }
        await expectRequests(gateway, "agents.list", agentRequestsBefore + 1);
        await expectRequests(gateway, "sessions.create", 2);
        const resumedCreate = (await gateway.getRequests("sessions.create")).at(-1);
        expect(originalCreate.params).toMatchObject({
          idempotencyKey: expect.any(String),
          message: submittedMessage,
        });
        expect(resumedCreate?.params).toEqual(originalCreate.params);
        await expectPendingNewSession(page, submittedMessage);
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
      });
    });
  }

  it.each(["process restarts", "recovery owner changes", "recovery owner disappears"] as const)(
    "keeps an interrupted creation fail-closed after the Gateway %s",
    async (change) => {
      await suite.withPage(DESKTOP_CONTEXT, async ({ page }) => {
        await page.clock.install();
        const gateway = await openNewPage(page, {
          "agents.list": LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"],
          "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
        });
        await page.getByRole("heading", { name: "Main" }).waitFor();
        await waitForGatewayRecoveryScope(page);
        await messageInput(page).fill("do not duplicate this task");
        await gateway.deferNext("sessions.create");
        await startButton(page).click();
        await gateway.waitForRequest("sessions.create");
        await expectPendingNewSession(page, "do not duplicate this task");

        if (change === "process restarts") {
          await gateway.setGatewayBootId("different-gateway-process");
        } else {
          const hello = await evaluateControlUiContext(
            page,
            (context) => context.gateway.snapshot.hello,
          );
          await gateway.setMethodResponse("connect", {
            ...hello,
            auth: {
              role: hello?.auth?.role,
              scopes: hello?.auth?.scopes,
              ...(change === "recovery owner changes"
                ? { recoveryScope: "different-recovery-owner" }
                : {}),
            },
          });
        }
        await disconnectGateway(page, gateway);
        await resumeGateway(page, gateway);
        await waitForGatewayRecoveryScope(page);

        const warning = page.getByRole("alert").filter({
          hasText:
            "The Gateway changed while this session was starting. Check recent sessions before starting this task again.",
        });
        await messageInput(page).waitFor();
        if (change === "process restarts") {
          await warning.waitFor();
          await expectInput(messageInput(page), "do not duplicate this task");
          expect(await startButton(page).isDisabled()).toBe(true);
        } else {
          // A different principal gets a fresh draft, not the previous owner's
          // private text or frozen startup controller (including its error).
          await expectInput(messageInput(page), "");
          expect(await warning.isVisible()).toBe(false);
          expect(
            await page.getByText("do not duplicate this task", { exact: true }).isVisible(),
          ).toBe(false);
          await messageInput(page).fill("new owner's task");
          await expect.poll(() => startButton(page).isEnabled()).toBe(true);
        }
        expect(await page.locator(".new-session-page__starting").isVisible()).toBe(false);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        expect(new URL(page.url()).pathname).toBe("/new");
      });
    },
  );

  it("resets agent-derived workspace state when retargeted to a catalog", async () => {
    await suite.withPage(DESKTOP_CONTEXT, async ({ page }) => {
      const gateway = await openNewPage(
        page,
        {
          "agents.list": {
            agents: [
              agent("main", "Main", WORKSPACE),
              agent("research", "Research", "/home/peter/research"),
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
          "sessions.catalog.list": {
            catalogs: [cliAgentCatalog(true)],
          },
          "sessions.catalog.startTerminal": {
            sessionId: "claude-retarget",
            agentId: "research",
            shell: "claude",
            cwd: "/home/peter/research",
            confined: false,
          },
        },
        {
          cliAgentsEnabled: true,
          terminalEnabled: true,
          featureMethods: [
            "sessions.catalog.list",
            "sessions.catalog.startTerminal",
            "terminal.open",
          ],
        },
        "?agent=research",
      );
      const folderLabel = page.locator(
        "#new-session-project-trigger .new-session-page__trigger-label",
      );
      await pollLocatorText(folderLabel).toBe("research");

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=main&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
      await pollLocatorText(folderLabel).toBe("openclaw");
      await messageInput(page).fill("retarget this draft");
      await page.getByRole("button", { name: "Start in terminal" }).click();

      const create = await gateway.waitForRequest("sessions.catalog.startTerminal");
      expect(create.params).toMatchObject({
        agentId: "main",
        initialMessage: "retarget this draft",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).toHaveProperty("cwd", WORKSPACE);
    });
  });
});
