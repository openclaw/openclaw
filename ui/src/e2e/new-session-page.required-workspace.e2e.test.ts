import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureProjectUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const scopes = ["operator.sessions.read", "operator.sessions.write"];
const creationPolicy = {
  workspaceRequired: true,
  worktreeRequired: true,
  worktreeBaseRef: "main",
  execution: "foreground-only",
};
const approved = {
  projects: [{ id: "approved-project", displayName: "Shared Project", source: "registered" }],
  creationPolicy,
};
const featureMethods = ["chat.metadata", "chat.startup", "projects.list", "sessions.create"];

suite.define(() => {
  it.each(["foreground-only", "workspace-only"] as const)(
    "keeps restored remote placement honest for %s",
    async (execution) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const appUrl = new URL(suite.server.baseUrl);
      const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
      await page.addInitScript(
        ({ key }) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              agents: {
                main: {
                  workspace: "/workspace",
                  folder: "/workspace",
                  projectId: "approved-project",
                  where: { kind: "device", id: "member-runner" },
                },
              },
            }),
          );
        },
        { key: `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}` },
      );
      const policy = {
        workspaceRequired: true,
        worktreeRequired: true,
        worktreeBaseRef: "main",
        ...(execution === "foreground-only" ? { execution } : {}),
      };
      const gateway = await installMockGateway(page, {
        workspace: "/workspace",
        featureMethods: [...featureMethods, "environments.list", "sessions.dispatch"],
        operatorScopes: ["operator.admin"],
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "projects.list": { ...approved, creationPolicy: policy },
          "environments.list": {
            environments: [
              {
                id: "node:member-runner",
                type: "node",
                label: "Member runner",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 1, available: 1 },
              },
            ],
            profiles: [{ id: "cloud", providerId: "crabbox" }],
          },
          "sessions.create": {
            key: "agent:main:placed-thread",
            runStarted: execution === "foreground-only",
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".new-session-page__message").fill("Keep the selected project");
        await pollLocatorText(page.locator("#new-session-project-trigger")).toContain(
          "Shared Project",
        );
        const where = page.locator("#new-session-where-trigger");
        await pollLocatorText(where).toContain("Member runner");
        const start = page.getByRole("button", { name: "Start session" });
        if (execution === "foreground-only") {
          const notice = page.locator("[data-execution-placement-policy]");
          await pollLocatorText(notice).toContain(
            "remote execution cannot confirm foreground cleanup",
          );
          await expect.poll(() => start.isDisabled()).toBe(true);
          await where.click();
          const places = page.locator("wa-popover.new-session-page__where-popover");
          await expect
            .poll(() => places.locator('[data-value="device:member-runner"]').isDisabled())
            .toBe(true);
          await expect
            .poll(() => places.locator('[data-value="cloud:cloud"]').isDisabled())
            .toBe(true);
          await page.keyboard.press("Escape");
          await page.keyboard.press("ControlOrMeta+K");
          const palette = page.locator(".cmd-palette");
          await palette.locator(".cmd-palette__input").fill("Another task");
          await palette.getByRole("button", { name: "New session settings", exact: true }).click();
          const settings = page.locator("wa-popover.palette-session-settings");
          await settings.locator(".palette-session-settings__workspace").click();
          await expect
            .poll(() =>
              settings
                .locator('[data-machine="device:member-runner"][data-project="approved-project"]')
                .isDisabled(),
            )
            .toBe(true);
          await expect
            .poll(() =>
              settings
                .locator('[data-machine="cloud:cloud"][data-project="approved-project"]')
                .isDisabled(),
            )
            .toBe(true);
          await settings.getByRole("button", { name: "Back", exact: true }).click();
          const paletteWorkspace = settings.locator(".palette-session-settings__workspace");
          await paletteWorkspace.press("Escape");
          await paletteWorkspace.waitFor({ state: "hidden" });
          await palette.locator(".cmd-palette__input").press("Escape");
          await palette.locator(".cmd-palette__input").waitFor({ state: "hidden" });
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          await captureProjectUiProof(suite, page, "foreground-restored-remote.png");
          await notice.getByRole("button", { name: "Use this Gateway" }).click();
          await expect.poll(() => start.isEnabled()).toBe(true);
        } else {
          await expect.poll(() => start.isEnabled()).toBe(true);
        }
        await start.click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({
          projectId: "approved-project",
          message: execution === "foreground-only" ? "Keep the selected project" : "",
        });
        for (const field of ["execNode", "cwd", "repository", "worktreeSource"]) {
          expect(created.params).not.toHaveProperty(field);
        }
        if (execution === "foreground-only") {
          expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        } else {
          await expect(gateway.waitForRequest("sessions.dispatch")).resolves.toMatchObject({
            params: { key: "agent:main:placed-thread", deviceId: "member-runner" },
          });
        }
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    { name: "desktop", viewport: { width: 1440, height: 1000 } },
    { name: "mobile", viewport: { width: 390, height: 844 } },
  ])(
    "requires an approved project on $name and sends only its identity",
    async ({ name, viewport }) => {
      const context = await suite.browser.newContext({
        ...createControlUiE2eContextOptions(),
        viewport,
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods,
        operatorScopes: scopes,
        deferredMethods: ["projects.list"],
        methodResponses: {
          "sessions.create": { key: "agent:main:approved-thread", runStarted: true },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".new-session-page__message").fill("Review the project");
        const start = page.getByRole("button", { name: "Start session" });
        await gateway.waitForRequest("projects.list");
        await pollLocatorText(page.locator("[data-workspace-policy]")).toContain(
          "Loading available workspaces",
        );
        await expect.poll(() => start.isDisabled()).toBe(true);
        await gateway.resolveDeferred("projects.list", approved);
        await pollLocatorText(page.locator("[data-workspace-policy]")).toContain(
          "Choose an approved project",
        );
        await page.locator("#new-session-project-trigger").click();
        const picker = page.locator("wa-popover.new-session-page__project-popover");
        await picker.getByRole("button", { name: "Shared Project", exact: true }).waitFor();
        expect(
          await picker
            .locator(
              '[data-value="browse"], [data-value="workspace"], [data-value="new-workspace"], [data-value="project-clone-url"]',
            )
            .count(),
        ).toBe(0);
        await captureProjectUiProof(suite, page, `required-${name}-choose.png`);
        await picker.getByRole("button", { name: "Shared Project", exact: true }).click();
        await pollLocatorText(page.locator("[data-required-worktree]")).toContain(
          "separate worktree and branch from main",
        );
        await pollLocatorText(page.locator("[data-execution-policy]")).toContain(
          "Each turn requires a new message",
        );
        await pollLocatorText(page.locator("[data-execution-policy]")).toContain(
          "Talk and dictation cannot confirm foreground cleanup",
        );
        await expect
          .poll(() => page.getByRole("button", { name: "Dictate", exact: true }).isDisabled())
          .toBe(true);
        expect(await gateway.getRequests("talk.session.create")).toHaveLength(0);
        expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
        await expect.poll(() => start.isEnabled()).toBe(true);
        await captureProjectUiProof(suite, page, `required-${name}-ready.png`);
        await start.click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({
          projectId: "approved-project",
          message: "Review the project",
        });
        for (const field of [
          "cwd",
          "repository",
          "worktree",
          "worktreeBaseRef",
          "worktreeName",
          "projectGitUrl",
          "execNode",
        ]) {
          expect(created.params).not.toHaveProperty(field);
        }
        expect(await gateway.getRequests("worktrees.branches")).toHaveLength(0);
        await expect.poll(() => page.url()).toContain("/chat/");
      } finally {
        await context.close();
      }
    },
  );

  it("keeps required creation blocked through empty choices and a failed retry", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      operatorScopes: scopes,
      methodResponses: { "projects.list": { projects: [], creationPolicy } },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const input = page.locator(".new-session-page__message");
      await input.fill("Keep this draft");
      const status = page.locator("[data-workspace-policy]");
      const start = page.getByRole("button", { name: "Start session" });
      await pollLocatorText(status).toContain("Ask a maintainer to add an approved project");
      await expect.poll(() => start.isDisabled()).toBe(true);
      await captureProjectUiProof(suite, page, "required-empty.png");
      await gateway.deferNext("projects.list");
      await status.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("projects.list", { after: 1 });
      await gateway.rejectDeferred("projects.list", { message: "Workspace catalog unavailable" });
      await pollLocatorText(status).toContain("Retry before starting the session");
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await input.inputValue()).toBe("Keep this draft");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await captureProjectUiProof(suite, page, "required-retry.png");
      await gateway.setMethodResponse("projects.list", approved);
      await status.getByRole("button", { name: "Retry" }).click();
      await pollLocatorText(status).toContain("Choose an approved project");
      await page.locator("#new-session-project-trigger").click();
      await page.getByRole("button", { name: "Shared Project", exact: true }).click();
      await expect.poll(() => start.isEnabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("retains ordinary creation after optional discovery fails and displays server rejection", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      operatorScopes: ["operator.read", "operator.write"],
      deferredMethods: ["projects.list", "sessions.create"],
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      await gateway.rejectDeferred("projects.list", { message: "Project discovery unavailable" });
      await page.locator(".new-session-page__message").fill("Let the server check");
      await pollLocatorText(page.locator("[data-workspace-policy]")).toContain(
        "the server will check its requirements",
      );
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await start.click();
      await gateway.waitForRequest("sessions.create");
      await gateway.rejectDeferred("sessions.create", {
        code: "FORBIDDEN",
        message: "Choose an approved project before creating a session.",
      });
      await pollLocatorText(page.locator(".new-session-page__error")).toContain(
        "Choose an approved project",
      );
      expect(await page.locator(".new-session-page__message").inputValue()).toBe(
        "Let the server check",
      );
    } finally {
      await context.close();
    }
  });

  it("shows effective own-work access and publication handoff guidance in Profile", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const profile = {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Project Member",
      emails: ["member@example.test"],
      role: "contributor",
      avatarMime: null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 1,
      githubIdentity: null,
      hasAvatar: false,
    };
    await installMockGateway(page, {
      featureMethods: ["projects.list", "users.self"],
      operatorScopes: scopes,
      presenceUsers: [
        { self: true, id: profile.id, name: profile.displayName, email: profile.emails[0] },
      ],
      methodResponses: { "projects.list": approved, "users.self": { profile } },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      const access = page.locator("#settings-profile-access");
      await pollLocatorText(access).toContain("contributor");
      await pollLocatorText(access).toContain("Shared Project");
      await pollLocatorText(access).toContain("Foreground turns only");
      for (const action of ["sessionActions", "review"]) {
        await pollLocatorText(
          access.locator(`[data-access-action="${action}"] .settings-row__value`),
        ).toBe("Granted");
      }
      for (const action of ["archive", "publication", "serverSettings"]) {
        await pollLocatorText(
          access.locator(`[data-access-action="${action}"] .settings-row__value`),
        ).toBe("Not granted");
      }
      await pollLocatorText(access).toContain("review and publish from the same thread");
      await captureProjectUiProof(suite, page, "required-profile.png", {
        surface: access,
        content: [access.locator('[data-access-action="publication"]')],
      });
    } finally {
      await context.close();
    }
  });
});
