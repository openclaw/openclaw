import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI sidebar agent roster" });

suite.define(() => {
  it("groups all agents' sessions, switches context, filters groups, and restores collapsed groups", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1280 } },
      async ({ page }) => {
        const agentsList: AgentsListResult = {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
            { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
            { id: "scout", name: "Scout", identity: { emoji: "🔭" } },
            { id: "bloom", name: "Bloom", identity: { emoji: "🌱" } },
          ],
        };
        const now = Date.now();
        const owners = [
          { type: "human", id: "profile-riley", label: "Riley" },
          { type: "human", id: "profile-devon", label: "Devon" },
        ] as const;
        const sessions = {
          ts: now,
          path: "",
          count: agentsList.agents.length * 3,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          owners: [...owners],
          sessions: agentsList.agents.flatMap(
            (agent, index): Array<GatewaySessionRow & { updatedAt: number }> => [
              {
                key: `agent:${agent.id}:main`,
                kind: "direct",
                label: agent.name ?? agent.id,
                updatedAt: now - 600_000,
                agentId: agent.id,
                isMain: true,
                lastMessagePreview:
                  agent.id === "forge"
                    ? "Preparing the sample dashboard."
                    : "Ready for the next task.",
              },
              ...["project", "notes"].map(
                (suffix, sessionIndex): GatewaySessionRow & { updatedAt: number } => ({
                  key: `agent:${agent.id}:${suffix}`,
                  kind: "direct",
                  label: `${agent.name} ${suffix}`,
                  updatedAt: now - (index + 1) * 60_000 - sessionIndex * 1_000,
                  agentId: agent.id,
                  pinned: sessionIndex === 0,
                  owner: { actor: sessionIndex === 0 ? owners[0] : owners[1] },
                  hasActiveRun: agent.id === "forge" && sessionIndex === 0,
                  status: agent.id === "forge" && sessionIndex === 0 ? "running" : "done",
                  unread: agent.id === "scout" && sessionIndex === 1,
                  lastMessagePreview:
                    agent.id === "forge"
                      ? "Preparing the sample dashboard."
                      : "Ready for the next task.",
                }),
              ),
            ],
          ),
        } satisfies SessionsListResult;
        const jobs = ["main", "forge"].map((agentId) => ({
          id: `${agentId}-daily`,
          agentId,
          configRevision: `${agentId}-revision`,
          name: `${agentId === "main" ? "Harbor" : "Forge"} daily review`,
          enabled: true,
          createdAtMs: now,
          updatedAtMs: now,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Review the sample project." },
          state: { nextRunAtMs: now + 86_400_000 },
        }));
        const jobList = (agentId?: string) => ({
          jobs: jobs.filter((job) => !agentId || job.agentId === agentId),
          snapshotRevision: "team-jobs",
          total: agentId ? 1 : 2,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        });
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            JSON.stringify({ dismissedAtMs: Date.now() }),
          );
        });
        const gateway = await installMockGateway(page, {
          sessions: sessions.sessions,
          methodResponses: {
            "agents.list": agentsList,
            "agent.identity.get": {
              cases: agentsList.agents.map((agent) => ({
                match: { agentId: agent.id },
                response: {
                  agentId: agent.id,
                  name: agent.name,
                  emoji: agent.identity?.emoji,
                  avatar: "",
                },
              })),
            },
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
              thinkingLevel: null,
            },
            "sessions.list": sessions,
            "cron.list": {
              cases: [
                ...["main", "forge"].map((agentId) => ({
                  match: { agentId },
                  response: jobList(agentId),
                })),
                { match: {}, response: jobList() },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const chip = sidebar.locator(".sidebar-agent-card__main");
        const workspace = sidebar.locator(".sidebar-workspace-header__main");
        const expectWorkspace = async () => {
          await expect.poll(() => workspace.textContent()).toMatch(/^\s*OpenClaw\s*$/);
          expect(await sidebar.locator("openclaw-sidebar-agent-card").count()).toBe(0);
          expect(await sidebar.locator(".sidebar-agent-card__avatar").count()).toBe(0);
        };
        const sessionRows = sidebar.locator(".sidebar-recent-session");
        await expect.poll(() => chip.isVisible()).toBe(true);
        await expect.poll(() => sessionRows.count()).toBe(2);
        expect(await sidebar.getByRole("link", { name: "Home", exact: true }).count()).toBe(1);
        expect(await sidebar.locator('[data-session-key="agent:forge:notes"]').count()).toBe(0);
        await captureSidebarUiProof(suite, page, "sidebar-roster-before.png");
        await chip.click();
        const modeToggle = sidebar.locator('wa-dropdown-item[value="command:sidebar-agents"]');
        await expect.poll(() => modeToggle.textContent()).toContain("Show all agents");
        await modeToggle.click();

        const headers = sidebar.locator(".sidebar-agent-roster__row");
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() =>
            headers.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent-id"))),
          )
          .toEqual(["main", "forge", "scout", "bloom"]);
        await expect.poll(() => sessionRows.count()).toBe(12);
        expect(await sidebar.getByRole("link", { name: "Home", exact: true }).count()).toBe(0);
        await expectWorkspace();
        expect(await sidebar.locator(".sidebar-session-toolbar").count()).toBe(0);
        expect(await sidebar.locator(".sidebar-brand__actions .sidebar-session-sort").count()).toBe(
          1,
        );
        for (const agent of agentsList.agents) {
          const group = sidebar.locator(`[data-agent-group="${agent.id}"]`);
          expect(await group.locator(".sidebar-recent-session").allTextContents()).toEqual([
            expect.stringContaining(`${agent.name} project`),
            expect.stringContaining(agent.name!),
            expect.stringContaining(`${agent.name} notes`),
          ]);
          expect(
            await group
              .getByRole("link", { name: `New conversation: ${agent.name}`, exact: true })
              .getAttribute("href"),
          ).toBe(`/new?agent=${agent.id}`);
          expect(await group.locator(".sidebar-agent-roster__row").getAttribute("href")).toBe(
            `/chat/${agent.id}`,
          );
        }
        expect(
          await sidebar
            .locator('[data-session-key="agent:scout:notes"] .session-unread-dot')
            .count(),
        ).toBe(1);
        expect(
          (await headers.first().locator(".sidebar-agent-roster__copy").textContent())?.trim(),
        ).toBe("Harbor");
        await captureSidebarUiProof(suite, page, "sidebar-roster-after.png");

        await workspace.focus();
        await page.keyboard.press("Enter");
        const workspaceMenu = sidebar.locator(".sidebar-agent-menu");
        const workspaceMenuItems = workspaceMenu.locator(":scope > wa-dropdown-item");
        await expect.poll(() => workspaceMenuItems.count()).toBe(3);
        expect(
          await workspaceMenuItems.evaluateAll((items) =>
            items.map((item) => item.getAttribute("value")),
          ),
        ).toEqual(["command:sidebar-agents", "command:agent-settings", "command:help"]);
        expect(
          await workspaceMenu
            .getByRole("menuitem", { name: "Show one agent", exact: true })
            .count(),
        ).toBe(1);
        expect(await workspaceMenuItems.nth(1).textContent()).toContain("Agent settings");
        expect(
          await workspaceMenu.locator('wa-dropdown-item[slot="submenu"]').allTextContents(),
        ).toEqual([
          expect.stringContaining("Docs"),
          expect.stringContaining("Get help"),
          expect.stringContaining("Discord community"),
          expect.stringContaining("View changelog"),
        ]);
        await expect
          .poll(() => modeToggle.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.press("ArrowDown");
        await expect
          .poll(() =>
            workspaceMenuItems.nth(1).evaluate((element) => element === document.activeElement),
          )
          .toBe(true);
        await captureSidebarUiProof(suite, page, "sidebar-team-workspace-menu.png");
        await page.keyboard.press("Escape");
        await expect.poll(() => workspaceMenu.count()).toBe(0);
        await expect
          .poll(() => workspace.evaluate((element) => element === document.activeElement))
          .toBe(true);

        await sidebar.locator(".sidebar-brand__new-thread").click();
        const newMenu = sidebar.locator(".sidebar-brand .sidebar-new-session-menu");
        await expect.poll(() => newMenu.locator("wa-dropdown-item").first().isVisible()).toBe(true);
        expect(
          await newMenu
            .locator("wa-dropdown-item a")
            .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
        ).toEqual(["main", "forge", "scout", "bloom"].map((id) => `/new?agent=${id}`));
        await newMenu.locator('wa-dropdown-item[value="scout"]').click();
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        expect(new URL(page.url()).searchParams.get("agent")).toBe("scout");
        await sidebar.locator('[data-agent-id="forge"]').click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge" });
        await sidebar.getByRole("link", { name: "Automations", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "cron" });
        await expect.poll(() => page.locator(".cron-table__row").count()).toBe(2);
        expect(
          await page.locator(".cron-table__row openclaw-agent-row-chip").allTextContents(),
        ).toEqual([expect.stringContaining("Harbor"), expect.stringContaining("Forge")]);
        expect((await gateway.getRequests("cron.list")).at(-1)?.params).not.toHaveProperty(
          "agentId",
        );
        await captureSidebarUiProof(suite, page, "sidebar-team-automations.png");

        await sidebar
          .locator('[data-session-key="agent:forge:notes"] .sidebar-recent-session__link')
          .click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge/notes" });
        await expectWorkspace();
        await expect.poll(() => sessionRows.count()).toBe(12);
        await sidebar.locator(".sidebar-session-sort").click();
        expect(
          await sidebar.locator('.sidebar-session-sort-menu [value^="grouping:"]').count(),
        ).toBe(0);
        expect(
          await sidebar.locator('.sidebar-session-sort-menu [value="hide-empty-groups"]').count(),
        ).toBe(0);
        await sidebar.locator(".sidebar-session-sort-menu .sidebar-session-owner-submenu").hover();
        await sidebar.locator('.sidebar-session-sort-menu [value="owner:profile-riley"]').click();
        await expect.poll(() => sessionRows.count()).toBe(4);
        expect(await sessionRows.allTextContents()).toEqual([
          expect.stringContaining("Harbor project"),
          expect.stringContaining("Forge project"),
          expect.stringContaining("Scout project"),
          expect.stringContaining("Bloom project"),
        ]);
        await sidebar.locator(".sidebar-session-sort").click();
        await sidebar.locator('.sidebar-session-sort-menu [value="owner:"]').click();
        await expect.poll(() => sessionRows.count()).toBe(12);

        await sidebar.locator('[data-agent-collapse="bloom"]').click();
        await expect.poll(() => sessionRows.count()).toBe(9);
        expect(new URL(page.url()).pathname).toBe("/chat/forge/notes");
        await page.reload();
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() =>
            sidebar.locator('[data-agent-collapse="bloom"]').getAttribute("aria-expanded"),
          )
          .toBe("false");
        await expect.poll(() => sessionRows.count()).toBe(9);
        await expectWorkspace();
        const forgeGroup = sidebar.locator('[data-agent-group="forge"]');
        const actions = forgeGroup.locator(".sidebar-agent-roster__actions");
        await forgeGroup.locator(".sidebar-agent-roster__row").focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => actions.locator("a").evaluate((el) => el === document.activeElement))
          .toBe(true);
        await page.keyboard.press("Tab");
        const options = actions.getByRole("button", { name: "Options for Forge" });
        await expect.poll(() => options.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press("Space");
        await actions.getByRole("menuitem", { name: "All sessions", exact: true }).waitFor();
        expect(await actions.locator("wa-dropdown-item").allTextContents()).toEqual([
          expect.stringContaining("Open main chat"),
          expect.stringContaining("All sessions"),
          expect.stringContaining("Collapse others"),
        ]);
        await actions.getByRole("menuitem", { name: "All sessions", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "sessions", pathname: "/sessions" });
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).map((request) => request.params),
          )
          .toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "forge" })]));
        await expect
          .poll(() =>
            page
              .locator(".agent-scope-control openclaw-agent-select")
              .evaluate((el: HTMLElement & { value?: string }) => el.value),
          )
          .toBe("forge");
        await options.press("Enter");
        await actions.getByRole("menuitem", { name: "Collapse others", exact: true }).click();
        await expect
          .poll(() => sidebar.locator('[data-agent-collapse][aria-expanded="false"]').count())
          .toBe(3);
        expect(
          await forgeGroup.locator("[data-agent-collapse]").getAttribute("aria-expanded"),
        ).toBe("true");
        await page.reload();
        await expect
          .poll(() => sidebar.locator('[data-agent-collapse][aria-expanded="false"]').count())
          .toBe(3);
        await options.press("Enter");
        await actions.getByRole("menuitem", { name: "Open main chat", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge" });
        await actions.locator("a").press("Space");
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        expect(new URL(page.url()).searchParams.get("agent")).toBe("forge");
        await workspace.click();
        await modeToggle.press("Enter");
        await expect.poll(() => headers.count()).toBe(0);
        expect(await sidebar.getByRole("link", { name: "Home", exact: true }).count()).toBe(1);
        expect(await chip.isVisible()).toBe(true);
        expect(await workspace.count()).toBe(0);
        await expect
          .poll(() => chip.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await chip.click();
        await expect.poll(() => modeToggle.textContent()).toContain("Show all agents");
        expect(
          await sidebar.locator(".sidebar-agent-menu__agent-grid wa-dropdown-item").count(),
        ).toBe(4);
        await page.keyboard.press("Escape");
      },
    );
  });
});
