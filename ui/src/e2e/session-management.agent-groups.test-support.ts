import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  type createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  submitInputDialog,
} from "./session-management.test-support.ts";

export function defineAgentGroupTests(suite: ReturnType<typeof createSessionManagementE2eSuite>) {
  it("retires a rename dialog after selecting another agent and returning", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const agentsList = {
      agents: [
        { id: "main", name: "Main" },
        { id: "research", name: "Research" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
    };
    const gateway = await installMockGateway(page, {
      sessionGroupsByAgent: { main: ["Shared"], research: ["Shared"] },
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models: [] },
          sessionId: "main-session",
          thinkingLevel: null,
        },
        "sessions.list": sessionsListResponse([]),
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Shared"]');
      await group.waitFor({ state: "visible" });
      await group.hover();
      await group.getByRole("button", { name: "Group options for Shared" }).click();
      await page.getByRole("menuitem", { name: "Rename group", exact: true }).click();
      await page
        .getByRole("dialog", { name: 'Rename group "Shared"' })
        .waitFor({ state: "visible" });
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { agentSelection: { set: (agentId: string) => void } } };
        };
        if (!app.runtime) {
          throw new Error("Application runtime is missing");
        }
        app.runtime.context.agentSelection.set("research");
        app.runtime.context.agentSelection.set("main");
      });
      await submitInputDialog(page, "Wrong owner");
      expect(await gateway.getRequests("sessions.groups.rename")).toHaveLength(0);
      expect(await page.locator('[data-session-section="category:Wrong owner"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it.each([1440, 390])("isolates agent groups and same-name defaults at %ipx", async (width) => {
    const context = await suite.browser.newContext({
      ...createControlUiE2eContextOptions(),
      colorScheme: "dark",
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    const agentsList = {
      agents: [
        { id: "main", name: "Main" },
        { id: "research", name: "Research" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
    };
    const gateway = await installMockGateway(page, {
      assistantName: "Main",
      sessionGroupsByAgent: {
        main: ["Shared", "Only Main"],
        research: ["Shared", "Only Research"],
      },
      sessionGroupDefaultsByAgent: {
        main: { Shared: { cwd: "/workspace/main" } },
        research: { Shared: { cwd: "/workspace/research" } },
      },
      workspace: "/workspace",
      methodResponses: {
        "agents.list": agentsList,
        "agent.identity.get": {
          cases: [
            {
              match: { agentId: "main" },
              response: { agentId: "main", name: "Main", avatar: "", emoji: "🦞" },
            },
            {
              match: { agentId: "research" },
              response: { agentId: "research", name: "Research", avatar: "", emoji: "🔬" },
            },
          ],
        },
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models: [] },
          sessionId: "main-session",
          thinkingLevel: null,
        },
        "sessions.list": {
          cases: [
            {
              match: { agentId: "main" },
              response: sessionsListResponse([
                sessionRow("agent:main:thread", "Main work", 1, { category: "Shared" }),
              ]),
            },
            {
              match: { agentId: "research" },
              response: sessionsListResponse([
                sessionRow("agent:research:thread", "Research work", 1, { category: "Shared" }),
              ]),
            },
          ],
        },
        "worktrees.branches": { branches: [], repositoryStatus: "not_git" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("heading", { name: "Main", exact: true }).waitFor({ state: "visible" });
      const sidebar = page.locator("openclaw-app-sidebar");
      if (width === 390) {
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
      }
      await page
        .locator('[data-session-section="category:Only Main"]')
        .waitFor({ state: "attached" });
      expect(await page.locator('[data-session-section="category:Only Research"]').count()).toBe(0);
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      await captureUiProof(suite, page, `groups-per-agent-main-${width}.png`);
      // The native sidebar switch menu is the real selection control.
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitemradio", { name: "Research", exact: true })
        .click();
      await page
        .locator('[data-session-section="category:Only Research"]')
        .waitFor({ state: "attached" });
      expect(await page.locator('[data-session-section="category:Only Main"]').count()).toBe(0);
      await page
        .getByRole("heading", { name: "Research", exact: true })
        .waitFor({ state: "visible" });
      if (width === 390) {
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
      }
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      await captureUiProof(suite, page, `groups-per-agent-research-${width}.png`);
      expect(
        (await gateway.getRequests("sessions.groups.list")).some(
          (request) => requireRecord(request.params).agentId === "research",
        ),
      ).toBe(true);
      // A fresh URL explicitly requesting the other agent must not reuse Research's folder.
      await page.goto(`${suite.server.baseUrl}new?agent=main&group=Shared`);
      await page.locator(".new-session-page__message").fill("Start scoped work");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const created = await gateway.waitForRequest("sessions.create");
      expect(created.params).toMatchObject({
        agentId: "main",
        category: "Shared",
        cwd: "/workspace/main",
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main&group=Shared`);
      await page.locator(".new-session-page__message").fill("Keep this draft for Research");
      const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await picker.locator(".agent-select__trigger").click();
      await picker.getByRole("menuitemradio", { name: "Research", exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("research");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe("Keep this draft for Research");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await expect.poll(() => gateway.getRequests("sessions.create")).toHaveLength(1);
      expect((await gateway.getRequests("sessions.create")).at(-1)?.params).toMatchObject({
        agentId: "research",
        category: "Shared",
        cwd: "/workspace/research",
      });
    } finally {
      await context.close();
    }
  });
}
