import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { readRepositoryBranches } from "../../../src/agents/worktrees/branches.runtime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import {
  expectAttribute,
  expectFocused,
  expectText,
  withSessionPage,
} from "./session-page.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gitRepository = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};
const clientCwd = "/home/peter/client-work";
const dialogSelector = `openclaw-modal-dialog[label='New session defaults for "Client work"']`;
const groupSelector = '[data-session-section="category:Client work"]';
const defaultsSelector = '.sidebar-session-group-menu [data-value="group-defaults"]';
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;

async function expectSavedDefaults(gateway: Gateway, cwd: string | null, worktree: boolean) {
  const request = await gateway.waitForRequest("sessions.groups.update");
  expect(request.params).toMatchObject({ name: "Client work", cwd, worktree });
}

function savedGitGroup(options: NonNullable<Parameters<typeof installMockGateway>[1]> = {}) {
  return {
    methodResponses: { "worktrees.branches": gitRepository },
    sessionGroupDefaults: { "Client work": { cwd: clientCwd, worktree: true } },
    ...options,
  };
}

function defaultsControls(page: Page) {
  const dialog = page.locator(dialogSelector);
  return {
    dialog,
    environment: dialog.locator("[data-session-group-environment]"),
    modeTrigger: dialog.locator("#session-group-defaults-mode-trigger"),
    folderTrigger: dialog.locator("#session-group-defaults-folder-trigger"),
    save: dialog.getByRole("button", { name: "Save" }),
  };
}

function sessionControls(page: Page) {
  return {
    message: page.locator(".new-session-page__message"),
    checkout: page.locator("#new-session-checkout-trigger"),
    project: page.locator("#new-session-project-trigger .new-session-page__trigger-label"),
    start: page.getByRole("button", { name: "Start session" }),
  };
}

async function newGroupSession(group: Locator) {
  await group.locator(".sidebar-recent-sessions__head").hover();
  await group.getByRole("link", { name: "New session in Client work" }).click();
}

async function commitDraft(page: Page, text: string) {
  await page.locator(".new-session-page__message").fill(text);
  await waitForCommittedComposerDraft(page, JSON.stringify(["", "", "Client work"]), text, 0);
}

async function withGroupGateway(
  options: NonNullable<Parameters<typeof installMockGateway>[1]>,
  run: (page: Page, gateway: Gateway) => Promise<void>,
) {
  await withSessionPage(suite, async (page) => {
    const gateway = await installMockGateway(page, {
      sessionGroups: ["Client work"],
      workspace: "/home/peter/openclaw",
      workspaceGit: true,
      ...options,
      methodResponses: { "sessions.list": sessionsListResponse([]), ...options.methodResponses },
    });
    await run(page, gateway);
  });
}

async function openDefaults(page: Page) {
  await chooseSidebarMenuOption(page, "Status", "All");
  await closeSidebarMenu(page);
  const group = page.locator(groupSelector);
  await group.waitFor({ state: "visible", timeout: 10_000 });
  await group.locator(".sidebar-recent-sessions__head").hover();
  await group.getByRole("button", { name: "Group options for Client work" }).click();
  await page.getByRole("menuitem", { name: "New session defaults" }).click();
  const controls = defaultsControls(page);
  await controls.dialog.waitFor({ state: "visible" });
  return { group, ...controls };
}

suite.define(() => {
  it("saves current-checkout group defaults for an agent workspace without a commit", async () => {
    const workspace = tempDirs.make("openclaw-group-unborn-");
    await promisify(execFile)("git", ["init", "-b", "main", "--template=", workspace]);
    const repository = await readRepositoryBranches(workspace, { includeRepositoryStatus: true });
    await withGroupGateway(
      {
        methodResponses: {
          "sessions.create": { key: "agent:main:unborn-group", runStarted: true },
          "worktrees.branches": repository,
        },
        workspace,
      },
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}chat`);
        const { group, dialog, environment, save } = await openDefaults(page);
        await expectAttribute(environment, "data-session-group-environment", "local");
        try {
          await expect.poll(() => save.isEnabled()).toBe(true);
        } finally {
          await captureUiProof(suite, page, "group-defaults-unborn-workspace.png");
        }
        expect(await dialog.locator("#session-group-defaults-mode-trigger").count()).toBe(0);
        await save.click();
        await expectSavedDefaults(gateway, null, false);
        await dialog.waitFor({ state: "detached" });
        await newGroupSession(group);
        await page.locator(".new-session-page__message").fill("Start in the empty repository");
        await page.getByRole("button", { name: "Start session" }).click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({
          agentId: "main",
          category: "Client work",
          message: "Start in the empty repository",
        });
        expect(created.params).not.toHaveProperty("worktree");
      },
    );
  });

  it("starts a session from a group with its saved folder and worktree defaults", async () => {
    const initialGroupCwd = "/home/peter";
    await withGroupGateway(
      {
        methodResponses: {
          "fs.listDir": {
            path: clientCwd,
            parent: "/home/peter",
            home: "/home/peter",
            entries: Array.from({ length: 12 }, (_, index) => ({
              name: `project-${index + 1}`,
              path: `${clientCwd}/project-${index + 1}`,
            })),
          },
          "sessions.create": { key: "agent:main:client-work", runStarted: true },
          "worktrees.branches": {
            cases: [
              {
                match: { repoRoot: initialGroupCwd },
                response: { branches: [], repositoryStatus: "not_git" },
              },
              { match: { repoRoot: clientCwd }, response: gitRepository },
            ],
          },
        },
        sessionGroupDefaults: { "Client work": { cwd: initialGroupCwd, worktree: false } },
      },
      async (page, gateway) => {
        try {
          await page.goto(`${suite.server.baseUrl}chat`);
          const { group, dialog, environment, modeTrigger, folderTrigger, save } =
            await openDefaults(page);
          const { message, checkout, project, start } = sessionControls(page);
          expect((await gateway.waitForRequest("worktrees.branches")).params).toMatchObject({
            repoRoot: initialGroupCwd,
            includeRepositoryStatus: true,
          });
          await expectAttribute(environment, "data-session-group-environment", "local");
          await expect
            .poll(() => dialog.locator(".session-group-defaults__mode-dropdown").count())
            .toBe(0);
          await expect.poll(() => environment.getByRole("button").count()).toBe(0);
          const localEnvironment = environment.locator(".session-group-defaults__resolved-mode");
          await expect
            .poll(async () => (await localEnvironment.boundingBox())?.height)
            .toBeCloseTo(56, 1);
          await expect.poll(() => folderTrigger.getAttribute("aria-label")).toContain("peter");
          await folderTrigger.click();
          const folderPicker = dialog.locator(".oc-popover.session-group-defaults__folder-popover");
          await folderPicker.getByRole("button", { name: "Browse folders" }).click();
          expect((await gateway.waitForRequest("fs.listDir")).params).toEqual({
            path: initialGroupCwd,
          });
          await expect
            .poll(() => folderPicker.locator("input.new-session-page__browser-path").inputValue())
            .toBe(clientCwd);
          for (const viewport of [
            { height: 844, name: "phone", width: 390 },
            { height: 1024, name: "tablet", width: 768 },
            { height: 900, name: "desktop", width: 1440 },
            { height: 500, name: "landscape", width: 932 },
          ]) {
            await page.setViewportSize(viewport);
            await expect
              .poll(async () => {
                const bounds = await folderPicker.boundingBox();
                return {
                  horizontal: Boolean(
                    bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
                  ),
                  vertical: Boolean(
                    bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
                  ),
                };
              })
              .toEqual({ horizontal: true, vertical: true });
            if (viewport.name === "landscape") {
              await folderPicker.locator(".new-session-page__browser-head").hover();
              await page.mouse.wheel(0, 600);
              await expect
                .poll(async () => {
                  const panel = await folderPicker.boundingBox();
                  const action = await folderPicker
                    .getByRole("button", { name: "Use this folder" })
                    .boundingBox();
                  return Boolean(
                    panel &&
                    action &&
                    action.y >= panel.y &&
                    action.y + action.height <= panel.y + panel.height,
                  );
                })
                .toBe(true);
            }
            await captureUiProof(suite, page, `group-defaults-folder-picker-${viewport.name}.png`);
          }
          await folderPicker.getByRole("button", { name: "Use this folder" }).click();
          await page.setViewportSize({ height: 900, width: 1280 });
          await expectText(folderTrigger, "client-work");
          await expect.poll(() => dialog.locator('input[name="cwd"]').count()).toBe(0);
          await expect
            .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
            .toMatchObject({ repoRoot: clientCwd, includeRepositoryStatus: true });
          await expectAttribute(environment, "data-session-group-environment", "git");
          const modeDropdown = environment.locator(".session-group-defaults__mode-dropdown");
          await expectAttribute(modeTrigger, "data-value", "local");
          await expectText(modeTrigger, "Current checkout");
          expect((await modeTrigger.boundingBox())?.height).toBeCloseTo(56, 1);
          await modeTrigger.click();
          const worktreeOption = modeDropdown.getByRole("menuitemradio", {
            name: /New worktree.*isolated Git worktree/i,
          });
          await expect
            .poll(() => worktreeOption.locator(".session-group-defaults__mode-option-icon").count())
            .toBe(1);
          await page.keyboard.press("Escape");
          await expectAttribute(modeTrigger, "aria-expanded", "false");
          await expectFocused(modeTrigger);
          await expect.poll(() => dialog.isVisible()).toBe(true);
          await modeTrigger.click();
          await worktreeOption.click();
          await expectAttribute(modeTrigger, "data-value", "worktree");
          await modeTrigger.focus();
          await page.keyboard.press("Enter");
          await expectFocused(worktreeOption);
          await page.keyboard.press("Escape");
          await expectFocused(modeTrigger);
          await save.click();
          await expectSavedDefaults(gateway, clientCwd, true);

          await newGroupSession(group);
          await message.waitFor();
          await expect
            .poll(() => new URL(page.url()).searchParams.get("group"))
            .toBe("Client work");
          await expectText(project, "client-work");
          expect((await gateway.waitForRequest("worktrees.branches")).params).toMatchObject({
            repoRoot: clientCwd,
          });
          await expectAttribute(checkout, "data-worktree", "true");

          await message.fill("prepare the client release");
          await start.click();
          expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
            agentId: "main",
            category: "Client work",
            cwd: clientCwd,
            message: "prepare the client release",
            worktree: true,
          });
        } catch (error) {
          await captureControlUiE2eFailureDiagnostics(page, {
            error: error instanceof Error ? error : new Error(String(error)),
            label: "session-group-defaults-worktree",
          });
          throw error;
        }
      },
    );
  });

  it.each(["/home/peter/client-work", ""])(
    "blocks saving a worktree default until repository inspection succeeds (%s)",
    async (groupCwd) => {
      await withGroupGateway(
        {
          methodResponses: {
            "worktrees.branches": {
              branches: [],
              repositoryStatus: "unavailable",
            },
          },
          sessionGroupDefaults: { "Client work": { cwd: groupCwd, worktree: true } },
        },
        async (page, gateway) => {
          await page.goto(`${suite.server.baseUrl}chat`);
          const { dialog, environment, modeTrigger, save } = await openDefaults(page);
          await expect
            .poll(() => environment.getAttribute("data-session-group-environment"))
            .not.toBe("checking");
          await captureUiProof(
            suite,
            page,
            `group-defaults-${groupCwd ? "folder" : "workspace"}.png`,
          );
          await expectText(environment, "Couldn't verify Git");
          await expect.poll(() => save.isDisabled()).toBe(true);
          expect(await gateway.getRequests("sessions.groups.update")).toHaveLength(0);

          await gateway.setMethodResponse("worktrees.branches", gitRepository);
          await dialog.getByRole("button", { name: "Retry" }).click();
          await expectAttribute(modeTrigger, "data-value", "worktree");
          await expect.poll(() => save.isEnabled()).toBe(true);
          await save.click();
          await expectSavedDefaults(gateway, groupCwd || null, true);
        },
      );
    },
  );

  it("shows the admin requirement when probing an outside-workspace folder is denied", async () => {
    const outsideCwd = "/home/peter/outside-project";
    await withGroupGateway(
      {
        methodResponses: {
          "worktrees.branches": {
            __mockError: {
              code: "FORBIDDEN",
              message: "missing scope: operator.admin",
              details: {
                code: "MISSING_SCOPE",
                missingScope: "operator.admin",
                requiredScopes: ["operator.admin"],
              },
            },
          },
        },
        sessionGroupDefaults: { "Client work": { cwd: outsideCwd, worktree: false } },
      },
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}chat`);
        const { dialog, environment, save } = await openDefaults(page);
        await expectAttribute(environment, "data-session-group-environment", "restricted");
        await expect.poll(() => save.isDisabled()).toBe(true);
        await expectText(environment, "requires operator.admin");
        await expect.poll(() => environment.textContent()).not.toContain("Couldn't verify Git");
        expect(await gateway.getRequests("sessions.groups.update")).toHaveLength(0);

        await gateway.setMethodResponse("worktrees.branches", gitRepository);
        await dialog.getByRole("button", { name: "Retry" }).click();
        await expectAttribute(environment, "data-session-group-environment", "git");
        await expect.poll(() => save.isEnabled()).toBe(true);
        await save.click();
        await expectSavedDefaults(gateway, outsideCwd, false);
      },
    );
  });

  it("keeps the group category without saved folder defaults", async () => {
    await withGroupGateway(
      {
        methodResponses: {
          "sessions.create": { key: "agent:main:group-without-defaults", runStarted: true },
        },
        workspaceGit: false,
      },
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}new?group=Client+work`);
        await page.locator(".new-session-page__message").fill("start without folder defaults");
        await page.getByRole("button", { name: "Start session" }).click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          agentId: "main",
          message: "start without folder defaults",
          category: "Client work",
        });
      },
    );
  });

  it("reloads changed group defaults and identity without losing its draft", async () => {
    const refreshedCwd = "/home/peter/refreshed-client-work";
    await withGroupGateway(savedGitGroup(), async (page) => {
      await page.goto(`${suite.server.baseUrl}new?group=Client+work`);
      const { project, message, checkout, start } = sessionControls(page);
      await expectText(project, "client-work");
      await commitDraft(page, "keep this draft");

      await evaluateControlUiContext(
        page,
        (application, cwd) =>
          application.sessions.groupsUpdate("Client work", { cwd, worktree: false }),
        refreshedCwd,
      );

      await page.reload();
      await expectText(project, "refreshed-client-work");
      await expectAttribute(checkout, "data-worktree", "false");
      await expect.poll(() => message.inputValue()).toBe("keep this draft");

      await evaluateControlUiContext(page, (application) =>
        application.sessions.groupsRename("Client work", "Customer work"),
      );

      await page.reload();
      const unavailable = page.locator(".new-session-page__catalog-unavailable");
      await expectText(unavailable, "This session target is unavailable.");
      await expect.poll(() => start.isDisabled()).toBe(true);
      await expect.poll(() => message.inputValue()).toBe("keep this draft");
    });
  });

  it("reloads a group draft after a background catalog failure", async () => {
    await withGroupGateway(savedGitGroup(), async (page, gateway) => {
      await page.goto(`${suite.server.baseUrl}new?group=Client+work`);
      const { start, message } = sessionControls(page);
      await commitDraft(page, "wait for fresh defaults");
      await expect.poll(() => start.isEnabled()).toBe(true);
      // Pin past load-time requests so the wait observes the invalidation.
      const groupListsBeforeInvalidation = (await gateway.getRequests("sessions.groups.list"))
        .length;
      await gateway.deferNext("sessions.groups.list");
      await gateway.emitGatewayEvent("sessions.changed", { reason: "groups" });
      await gateway.waitForRequest("sessions.groups.list", {
        after: groupListsBeforeInvalidation,
      });
      await gateway.rejectDeferred("sessions.groups.list", {
        code: "UNAVAILABLE",
        message: "catalog reload failed",
      });

      await page.reload();
      await gateway.waitForRequest("sessions.groups.defaults");
      await expectText(page.locator("#new-session-project-trigger"), "client-work");
      await expect.poll(() => message.inputValue()).toBe("wait for fresh defaults");
      expect(await page.locator(".new-session-page__catalog-unavailable").count()).toBe(0);
      await expect.poll(() => start.isEnabled()).toBe(true);
    });
  });

  it("keeps rejected group defaults editable and allows retry", async () => {
    await withGroupGateway(
      savedGitGroup({ deferredMethods: ["sessions.groups.update"] }),
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}chat`);
        const { group, dialog, modeTrigger, save } = await openDefaults(page);
        const { checkout } = sessionControls(page);
        const modeDropdown = dialog.locator(".session-group-defaults__mode-dropdown");
        await modeTrigger.waitFor({ state: "visible" });
        await modeTrigger.click();
        await modeDropdown
          .getByRole("menuitemradio", { name: /Current checkout.*Works in the selected folder/i })
          .click();
        await save.click();
        await gateway.waitForRequest("sessions.groups.update");
        await gateway.rejectDeferred("sessions.groups.update", {
          code: "INVALID_REQUEST",
          message: "rejected group defaults",
        });

        const alert = dialog.getByRole("alert");
        await alert.waitFor({ state: "visible" });
        await expectText(alert, "rejected group defaults");
        await expectAttribute(modeTrigger, "data-value", "local");

        await save.click();
        await expect
          .poll(async () => (await gateway.getRequests("sessions.groups.update")).length)
          .toBe(2);
        await dialog.waitFor({ state: "detached" });

        await newGroupSession(group);
        await checkout.waitFor();
        await expectAttribute(checkout, "data-worktree", "false");
      },
    );
  });

  it("offers retry when authoritative group defaults are unavailable", async () => {
    await withGroupGateway(
      savedGitGroup({ deferredMethods: ["sessions.groups.defaults"] }),
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}chat`);
        await chooseSidebarMenuOption(page, "Status", "All");
        await closeSidebarMenu(page);
        const group = page.locator(groupSelector);
        await group.waitFor({ state: "visible", timeout: 10_000 });
        await gateway.waitForRequest("sessions.groups.list");
        await gateway.waitForRequest("sessions.groups.defaults");
        await group.locator(".sidebar-recent-sessions__head").hover();
        await group.getByRole("button", { name: "Group options for Client work" }).click();
        const defaultsAction = page.locator(defaultsSelector);
        await defaultsAction.waitFor({ state: "attached" });
        await expect.poll(() => defaultsAction.isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.groups.update")).toHaveLength(0);
        expect(await page.locator(dialogSelector).count()).toBe(0);

        await gateway.rejectDeferred("sessions.groups.defaults", {
          code: "INVALID_REQUEST",
          message: "defaults unavailable",
        });
        await expectText(defaultsAction, "Retry");
        await expect.poll(() => defaultsAction.isEnabled()).toBe(true);

        // Pin past the load-time catalog request so the retry wait cannot return it.
        const groupListsBeforeRetry = (await gateway.getRequests("sessions.groups.list")).length;
        await gateway.deferNext("sessions.groups.list");
        await defaultsAction.click();
        await gateway.waitForRequest("sessions.groups.list", { after: groupListsBeforeRetry });
        await gateway.resolveDeferred("sessions.groups.list", {
          groups: [{ name: "Client work", position: 0 }],
        });
        await expect
          .poll(async () => (await gateway.getRequests("sessions.groups.defaults")).length)
          .toBe(2);

        await group.locator(".sidebar-recent-sessions__head").hover();
        await group.getByRole("button", { name: "Group options for Client work" }).click();
        const readyDefaultsAction = page.locator(defaultsSelector);
        await expect.poll(() => readyDefaultsAction.textContent()).not.toContain("Retry");
        await expect.poll(() => readyDefaultsAction.isEnabled()).toBe(true);
        await readyDefaultsAction.click();

        const { dialog, folderTrigger, modeTrigger } = defaultsControls(page);
        await dialog.waitFor({ state: "visible" });
        await expect.poll(() => folderTrigger.getAttribute("aria-label")).toContain("client-work");
        await expectAttribute(modeTrigger, "data-value", "worktree");
        expect(await gateway.getRequests("sessions.groups.update")).toHaveLength(0);
        await dialog.getByRole("button", { name: "Cancel" }).click();
      },
    );
  });

  it("blocks a missing group until a fresh catalog retry resolves it", async () => {
    await withGroupGateway(
      {
        sessionGroups: [],
      },
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}new?group=Deleted`);
        const unavailable = page.locator(".new-session-page__catalog-unavailable");
        await unavailable.waitFor();
        await expectText(unavailable, "This session target is unavailable.");
        await page.locator(".new-session-page__message").fill("do not create this session");
        const start = page.getByRole("button", { name: "Start session" });
        await expect.poll(() => start.isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        const listRequestsBeforeRetry = (await gateway.getRequests("sessions.groups.list")).length;
        await page.getByRole("button", { name: "Retry" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("sessions.groups.list")).length)
          .toBeGreaterThan(listRequestsBeforeRetry);
        await expect.poll(() => start.isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      },
    );
  });
});
