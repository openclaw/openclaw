import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import type {
  ControlUiMockGatewayScenario,
  MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  pollEnabled,
  pollAttribute,
  pollDisabled,
  pollValue,
  SESSION_LIST_DEFAULTS,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

type Draft = { page: Page; gateway: MockGatewayControls };
const writeScopes = ["operator.read", "operator.write"];
const adminScopes = ["operator.admin", ...writeScopes];
const chatMethods = ["chat.metadata", "chat.startup"];
const workspace = "/home/peter/openclaw";
const directory = (
  path: string,
  entries: { name: string; path: string }[] = [],
  home = "/home/peter",
  parent?: string,
) => ({ path, home, entries, ...(parent ? { parent } : {}) });
const expectCreated = async (gateway: MockGatewayControls, params: Record<string, unknown>) =>
  expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({ params });

async function selectFullAccess(page: Page) {
  const permission = page.locator('[data-chat-permission-select="true"]');
  await permission.click();
  await page.locator('[data-chat-permission-option="full"]').click();
  await pollAttribute(permission, "data-chat-select-value").toBe("full");
  return permission;
}

async function withDraft(
  operatorScopes: string[],
  run: (draft: Draft) => Promise<void>,
  featureMethods = [...chatMethods, "projects.list", "sessions.create", "sessions.dispatch"],
  dispatchableProfileIds?: string[],
) {
  return suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
    const gateway = await installMockGateway(page, {
      featureMethods,
      operatorScopes,
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "node:writer-runner",
              type: "node",
              label: "Writer runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
          profiles: [
            { id: "aws", providerId: "crabbox" },
            { id: "restricted", providerId: "crabbox" },
          ],
          dispatchableProfileIds:
            dispatchableProfileIds ??
            (operatorScopes.includes("operator.admin") ? ["aws", "restricted"] : []),
        },
        "projects.list": { projects: [] },
        "worktrees.branches": { branches: [], repositoryStatus: "git" },
        "sessions.create": {
          key: "agent:main:operator-scope-proof",
          ...(dispatchableProfileIds === undefined ? { runStarted: true } : {}),
        },
        "sessions.dispatch": { ok: true },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await page.locator(".new-session-page__message").fill("scope proof");
    await run({ gateway, page });
  });
}

async function withFolder(
  scenario: ControlUiMockGatewayScenario,
  run: (draft: Draft) => Promise<void>,
) {
  return suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
    const gateway = await installMockGateway(page, {
      workspace,
      workspaceGit: true,
      operatorScopes: writeScopes,
      featureMethods: [...chatMethods, "fs.listDir", "sessions.create", "worktrees.branches"],
      ...scenario,
      methodResponses: {
        "worktrees.branches": { branches: [], repositoryStatus: "not_git" },
        "fs.listDir": directory(scenario.workspace ?? workspace),
        "sessions.create": { key: "agent:main:folder-proof" },
        ...scenario.methodResponses,
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await page.locator("#new-session-project-trigger").click();
    const browse = page.getByRole("button", { name: "Browse folders" });
    await pollEnabled(browse).toBe(true);
    await browse.click();
    await run({ page, gateway });
  });
}

async function useFolderAndSubmit(page: Page, message: string) {
  const useFolder = page.getByRole("button", { name: "Use this folder" });
  await pollEnabled(useFolder).toBe(true);
  await useFolder.click();
  await page.locator(".new-session-page__message").fill(message);
  const submit = page.getByRole("button", { name: "Start session" });
  await pollEnabled(submit).toBe(true);
  await submit.click();
}

suite.define(() => {
  it("keeps session-only browsing free of forbidden optional discovery", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const key = "agent:main:scoped-reader";
      const forbidden = [
        "commands.list",
        "sessions.catalog.list",
        "plugins.list",
        "sessions.usage",
        "worktrees.branches",
        "users.background.get",
        "cron.list",
      ];
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.sessions.read"],
        workspace: "/workspace/scoped-project",
        workspaceGit: true,
        presenceUsers: [{ id: "scoped-reader", name: "Scoped reader", self: true }],
        featureMethods: [...chatMethods, ...forbidden, "sessions.create", "tools.effective"],
        sessionKey: key,
        sessions: [
          {
            key,
            sessionId: "scoped-reader",
            kind: "direct",
            label: "Scoped reader",
            model: "demo",
            modelProvider: "example",
            contextTokens: 100000,
            totalTokens: 50000,
            totalTokensFresh: true,
            spawnedCwd: "/workspace/scoped-project",
          },
        ],
        agentModel: "example/demo",
        models: [{ id: "demo", provider: "example", name: "Demo model", contextWindow: 100000 }],
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "lookup", name: "example_lookup", arguments: {} }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "lookup",
            toolName: "example_lookup",
            content: [{ type: "text", text: "Synthetic result" }],
            timestamp: 2,
          },
          { role: "assistant", content: "The scoped conversation remains readable.", timestamp: 3 },
        ],
        methodResponses: Object.fromEntries(
          forbidden.map((method) => [
            method,
            {
              __mockError: { code: "FORBIDDEN", message: "missing scope: operator.read" },
            },
          ]),
        ),
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const submit = page.getByRole("button", { name: "Start session" });
      await pollDisabled(submit).toBe(true);
      expect(await tooltipTitleText(submit)).toContain("operator.sessions.write");
      const picker = page.locator(".chat-controls__model-picker > summary");
      await picker.click();
      await page.locator(".chat-controls__model-search").waitFor();
      expect(await page.locator('[data-chat-model-target-group="cliAgents"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
      await captureUiProof(suite, page, "scoped-reader-new-session.png");
      if (captureUiProofEnabled) {
        console.info(
          "Scoped new-session forbidden calls",
          (await gateway.getRequests("worktrees.branches")).length,
        );
      }
      for (const method of [...forbidden, "sessions.create"]) {
        expect.soft(await gateway.getRequests(method), method).toHaveLength(0);
      }
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page.getByText("The scoped conversation remains readable.", { exact: true }).waitFor();
      await page.locator(".chat-header-session-menu__trigger").filter({ visible: true }).click();
      expect(await page.locator('[data-value="copy-branch"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator(".context-ring").filter({ visible: true }).click();
      const summary = page.locator(".context-usage__popover").filter({ visible: true });
      await summary.getByRole("meter").waitFor();
      expect(await summary.getByRole("meter").getAttribute("aria-valuenow")).toBe("50000");
      await summary.getByRole("button", { name: "View context", exact: true }).click();
      const panel = page.locator("openclaw-chat-context-panel");
      await panel.getByText(/Ask the person who manages OpenClaw for access/).waitFor();
      expect(await panel.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
      for (const method of [...forbidden, "sessions.create"]) {
        expect.soft(await gateway.getRequests(method), method).toHaveLength(0);
      }
      expect(await page.getByText("missing scope: operator.read", { exact: false }).count()).toBe(
        0,
      );
      await captureUiProof(suite, page, "scoped-reader-context.png");
      await page.goto(`${suite.server.baseUrl}usage`);
      await page.getByText(/Ask the person who manages OpenClaw for access/).waitFor();
      for (const method of ["sessions.usage", "usage.status"]) {
        expect.soft(await gateway.getRequests(method), method).toHaveLength(0);
      }
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("#settings-appearance-background").scrollIntoViewIfNeeded();
      expect(await page.locator("[data-background-upload]").isDisabled()).toBe(true);
      await page
        .getByText("Image uploads require permission to edit your profile.", { exact: true })
        .waitFor();
      await captureUiProof(suite, page, "scoped-reader-background.png");
      if (captureUiProofEnabled) {
        console.info(
          "Scoped background forbidden calls",
          (await gateway.getRequests("users.background.get")).length,
        );
      }
      expect.soft(await gateway.getRequests("users.background.get")).toHaveLength(0);
      await page.goto(`${suite.server.baseUrl}automations`);
      await page.getByText(/Ask the person who manages OpenClaw for access/).waitFor();
      for (const method of forbidden) {
        expect.soft(await gateway.getRequests(method), method).toHaveLength(0);
      }
    });
  });

  it.each(["read-only", "missing-method", "disconnected"] as const)(
    "blocks new-session entry and submission when %s",
    async (reason) => {
      await withDraft(
        reason === "read-only" ? ["operator.read"] : adminScopes,
        async ({ gateway, page }) => {
          try {
            if (reason === "disconnected") {
              await gateway.setOnline(false);
              await gateway.closeLatest(1001, "new-session scope proof");
              await expect
                .poll(() => evaluateControlUiContext(page, (app) => app.gateway.snapshot.phase))
                .toBe("reconnecting");
            } else {
              await pollDisabled(page.locator(".sidebar-rail .sidebar-new-session")).toBe(true);
            }
            const submit = page.getByRole("button", { name: "Start session" });
            await pollDisabled(submit).toBe(true);
            if (reason === "read-only") {
              const incognito = page.getByRole("switch", { name: "Incognito" });
              await pollDisabled(incognito).toBe(true);
              expect(await incognito.getAttribute("title")).toBe(
                "This action requires operator.admin access.",
              );
            }
            await submit.click({ force: true });
            if (reason === "read-only") {
              expect(
                (await gateway.getRequests("projects.list")).map(({ params }) => params),
              ).toEqual([{}]);
            }
            expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          } finally {
            if (reason === "disconnected") {
              await gateway.setOnline(true);
            }
          }
        },
        reason === "missing-method" ? chatMethods : undefined,
      );
    },
  );

  it("allows write-scoped Fast Mode creation while keeping incognito admin-only", async () => {
    await withDraft(writeScopes, async ({ gateway, page }) => {
      await expect(gateway.waitForRequest("projects.list")).resolves.toMatchObject({ params: {} });
      const submit = page.getByRole("button", { name: "Start session" });
      const incognito = page.getByRole("switch", { name: "Incognito" });
      const effort = page.locator('[data-chat-thinking-select="true"]');
      await pollEnabled(page.locator(".sidebar-rail .sidebar-new-session")).toBe(true);
      await pollEnabled(submit).toBe(true);
      await pollDisabled(incognito).toBe(true);
      await page.locator("#new-session-where-trigger").click();
      const where = page.locator(".oc-popover.new-session-page__where-popover");
      await where.getByRole("button", { name: /Writer runner/u }).waitFor();
      expect(await where.locator('[data-value="cloud:aws"]').count()).toBe(0);
      expect(await where.locator('[data-action="connect-machine"]').count()).toBe(0);
      expect(await where.locator('[data-action="manage-cloud-workers"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await effort.click();
      const fastMode = page.locator('[data-chat-speed-option="on"]');
      await pollEnabled(fastMode).toBe(true);
      await pollAttribute(fastMode, "role").toBe("radio");
      await pollAttribute(fastMode, "aria-checked").toBe("false");
      await fastMode.click();
      await pollAttribute(page.locator('[data-chat-speed-option="off"]'), "aria-checked").toBe(
        "false",
      );
      await pollAttribute(fastMode, "aria-checked").toBe("true");
      await submit.click();
      await expectCreated(gateway, { agentId: "main", fastMode: true, message: "scope proof" });
    });
  });

  it("lets a write-scoped creator select a granted cloud profile without setup authority", async () => {
    await withDraft(
      writeScopes,
      async ({ gateway, page }) => {
        await gateway.waitForRequest("environments.list");
        await page.locator("#new-session-where-trigger").click();
        const where = page.locator(".oc-popover.new-session-page__where-popover");
        await where.getByRole("button", { name: /Writer runner/u }).waitFor();
        await captureUiProof(suite, page, "granted-cloud-picker.png");
        expect(await where.locator('[data-value="cloud:aws"]').count()).toBe(1);
        expect(await where.locator('[data-value="cloud:restricted"]').count()).toBe(0);
        expect(await where.locator('[data-action="manage-cloud-workers"]').count()).toBe(0);
        expect(await where.locator('[data-action="connect-machine"]').count()).toBe(0);
        await where.locator('[data-value="cloud:aws"]').click();
        await pollAttribute(page.locator("#new-session-where-trigger"), "data-cloud-profile").toBe(
          "aws",
        );
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Start session" }).click();
        await expect(gateway.waitForRequest("sessions.dispatch")).resolves.toMatchObject({
          params: { key: "agent:main:operator-scope-proof", agentId: "main", profileId: "aws" },
        });
      },
      undefined,
      ["aws"],
    );
  });

  it.each(["full", "incognito"] as const)("allows admin-scoped %s creation", async (mode) => {
    await withDraft(adminScopes, async ({ gateway, page }) => {
      if (mode === "full") {
        await selectFullAccess(page);
      } else {
        const incognito = page.getByRole("switch", { name: "Incognito" });
        await pollEnabled(incognito).toBe(true);
        await incognito.click();
      }
      await page.getByRole("button", { name: "Start session" }).click();
      await expectCreated(gateway, {
        message: "scope proof",
        ...(mode === "full" ? { agentId: "main", permissionMode: "full" } : { incognito: true }),
      });
      if (mode === "full") {
        await expect.poll(() => page.url()).toContain("/chat/");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      }
    });
  });

  it("rejects a retained Full-access selection after reconnecting without admin scope", async () => {
    await withDraft(adminScopes, async ({ gateway, page }) => {
      const permission = await selectFullAccess(page);
      await gateway.setOperatorScopes(writeScopes);
      await gateway.closeLatest(1001, "permission scope downgraded");
      await expect.poll(async () => (await gateway.getRequests("connect")).length).toBe(2);
      const submit = page.getByRole("button", { name: "Start session" });
      await pollDisabled(submit).toBe(true);
      expect(await permission.getAttribute("data-chat-select-value")).toBe("full");
      await permission.click();
      const fullAccess = page.locator('[data-chat-permission-option="full"]');
      await pollAttribute(fullAccess, "disabled").not.toBeNull();
      await expect
        .poll(() => tooltipTitleText(fullAccess))
        .toBe("Full access requires operator.admin access.");
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").press("Enter");
      await pollLocatorText(
        page.locator('.new-session-page__blocked-submit[role="status"]'),
      ).toContain("This action requires operator.admin access.");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("lets read-scoped operators search projects without exposing clone actions", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["projects.add", "projects.list", "projects.searchRemote"],
        operatorScopes: ["operator.read"],
        methodResponses: {
          "projects.list": { projects: [] },
          "projects.searchRemote": {
            credential: "missing",
            projects: [
              {
                name: "openclaw",
                fullName: "openclaw/openclaw",
                cloneUrl: "https://github.com/openclaw/openclaw.git",
                webUrl: "https://github.com/openclaw/openclaw",
                private: false,
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      await page.locator("#new-session-project-trigger").click();
      const place = page.locator(".oc-popover.new-session-page__project-popover");
      await place.locator(".header-search__toggle").click();
      await place.getByRole("searchbox").fill("openclaw");
      await gateway.waitForRequest("projects.searchRemote");
      const remote = place.getByRole("button", { name: /openclaw\/openclaw/u });
      await pollDisabled(remote).toBe(true);
      await remote.click({ force: true });
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
    });
  });

  it("lets write-scoped operators browse and restore only workspace-contained folders", async () => {
    const contained = `${workspace}/packages/app`;
    await withFolder(
      {
        methodResponses: {
          "fs.listDir": directory(workspace, [{ name: "packages", path: `${workspace}/packages` }]),
          "sessions.list": {
            count: 2,
            defaults: SESSION_LIST_DEFAULTS,
            path: "",
            sessions: [
              { key: "agent:main:inside", kind: "direct", updatedAt: 2, execCwd: contained },
              { key: "agent:main:outside", kind: "direct", updatedAt: 1, execCwd: "/private/repo" },
            ],
            ts: Date.now(),
          },
        },
      },
      async ({ page, gateway }) => {
        await expect(gateway.waitForRequest("fs.listDir")).resolves.toMatchObject({
          params: { path: workspace },
        });
        await page.getByRole("button", { name: "Parent folder" }).click();
        await page.getByRole("button", { name: "app", exact: true }).click();
        expect(await page.locator('[data-value="recent:/private/repo"]').count()).toBe(0);
        await page.locator(".new-session-page__message").fill("work in the package");
        await page.getByRole("button", { name: "Start session" }).click();
        await expectCreated(gateway, { cwd: contained, message: "work in the package" });
      },
    );
  });

  it("explains when browsing outside the workspace requires admin scope", async () => {
    await withFolder(
      { featureMethods: [...chatMethods, "fs.listDir", "worktrees.branches"] },
      async ({ page, gateway }) => {
        await expect(gateway.waitForRequest("fs.listDir")).resolves.toMatchObject({
          params: { path: workspace },
        });
        const pathInput = page.locator("input.new-session-page__browser-path");
        await pollValue(pathInput).toBe(workspace);
        await page
          .locator(".new-session-page__browser")
          .getByText("No subfolders", { exact: true })
          .waitFor();
        await gateway.deferNext("fs.listDir", { path: "/tmp" });
        await pathInput.fill("/tmp");
        await pathInput.press("Enter");
        await expect.poll(async () => (await gateway.getRequests("fs.listDir")).length).toBe(2);
        expect((await gateway.getRequests("fs.listDir"))[1]?.params).toEqual({ path: "/tmp" });
        await gateway.rejectDeferred("fs.listDir", {
          code: "FORBIDDEN",
          message: "Folder access was denied.",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        });
        await pollLocatorText(
          page.locator(".new-session-page__browser .new-session-page__error"),
        ).toContain(
          "To browse outside agent workspaces, open Inbox, select Limited access, request admin, then approve in Devices.",
        );
        expect(await pathInput.inputValue()).toBe("/tmp");
        expect(await gateway.getRequests("fs.listDir")).toHaveLength(2);
      },
    );
  });

  it("keeps a canonical browser selection submittable for a symlinked workspace alias", async () => {
    const workspaceAlias = "/var/folders/openclaw/workspace-alias";
    const canonicalWorkspace = "/private/var/folders/openclaw/workspace";
    const canonicalFolder = `${canonicalWorkspace}/packages`;
    await withFolder(
      {
        workspace: workspaceAlias,
        methodResponses: {
          "fs.listDir": {
            cases: [
              {
                match: { path: workspaceAlias },
                response: directory(
                  canonicalWorkspace,
                  [{ name: "packages", path: canonicalFolder }],
                  "/Users/peter",
                ),
              },
              {
                match: { path: canonicalFolder },
                response: directory(canonicalFolder, [], "/Users/peter", canonicalWorkspace),
              },
            ],
          },
        },
      },
      async ({ page, gateway }) => {
        await page.getByRole("option", { name: "packages" }).click();
        await useFolderAndSubmit(page, "inspect the canonical checkout");
        await expectCreated(gateway, {
          cwd: canonicalFolder,
          message: "inspect the canonical checkout",
        });
      },
    );
  });

  it("submits an unvalidated typed folder so the Gateway error stays actionable", async () => {
    const typedFolder = "/private/repo";
    await withFolder({ deferredMethods: ["sessions.create"] }, async ({ page, gateway }) => {
      const pathInput = page.locator("input.new-session-page__browser-path");
      await pollValue(pathInput).toBe(workspace);
      await pathInput.fill(typedFolder);
      await useFolderAndSubmit(page, "let the Gateway decide");
      await expectCreated(gateway, { cwd: typedFolder, message: "let the Gateway decide" });
      await gateway.rejectDeferred("sessions.create", {
        code: "FORBIDDEN",
        message: "missing scope: operator.admin",
      });
      await pollLocatorText(page.locator(".new-session-page__error")).toContain(
        "missing scope: operator.admin",
      );
    });
  });
});
