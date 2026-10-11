import type { LitElement } from "lit";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type {
  AgentsListResult,
  CronJob,
  GatewaySessionRow,
  SessionsListResult,
} from "../api/types.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";
import {
  chooseSidebarOwner,
  closeSidebarMenu,
  openSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

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
        const jobs = ["main", "forge"].map((agentId): CronJob => ({
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
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: Date.now() }),
          );
        });
        await page.addInitScript(
          ({ key, entries }) => {
            const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
            if (!Array.isArray(stored.sidebarEntries)) {
              localStorage.setItem(key, JSON.stringify({ ...stored, sidebarEntries: entries }));
            }
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            entries: agentsList.agents.map((agent) => `session:agent:${agent.id}:project`),
          },
        );
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
            "cron.list": cronListResponseFixture([
              ...["main", "forge"].map((agentId) => ({
                match: { agentId },
                response: jobList(agentId),
              })),
              { match: {}, response: jobList() },
            ]),
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
        expect(await sidebar.locator(".sidebar-footer-bar__home").count()).toBe(1);
        expect(await sidebar.locator('[data-session-key="agent:forge:notes"]').count()).toBe(0);
        await captureSidebarUiProof(suite, page, "sidebar-roster-before.png");
        await chip.click();
        const allAgentsTile = sidebar.locator('.sidebar-agent-menu [value="scope:all"]');
        await expect.poll(() => allAgentsTile.isVisible()).toBe(true);
        expect(await allAgentsTile.getAttribute("aria-current")).toBeNull();
        const activeAgentTile = sidebar.locator(".sidebar-agent-menu__agent-switch--active");
        const expectFocused = (locator: Locator) =>
          expect.poll(() => locator.evaluate((el) => el === document.activeElement)).toBe(true);
        await expectFocused(activeAgentTile);
        await page.keyboard.press("Home");
        await expectFocused(allAgentsTile);
        await page.keyboard.press("Enter");

        const headers = sidebar.locator(".sidebar-agent-roster__row");
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() =>
            headers.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent-id"))),
          )
          .toEqual(["main", "forge", "scout", "bloom"]);
        await expect.poll(() => sessionRows.count()).toBe(8);
        expect(await sidebar.locator(".sidebar-footer-bar__home").count()).toBe(1);
        await expectWorkspace();
        expect(await sidebar.locator(".sidebar-session-toolbar").count()).toBe(0);
        expect(await sidebar.locator(".sidebar-brand__actions .sidebar-session-sort").count()).toBe(
          1,
        );
        for (const agent of agentsList.agents) {
          const group = sidebar.locator(`[data-agent-group="${agent.id}"]`);
          const pin = sidebar.locator(
            `.sidebar-rail [data-sidebar-entry="session:agent:${agent.id}:project"]`,
          );
          expect(await pin.count()).toBe(1);
          const pinLink = pin.getByRole("link", { name: `${agent.name} project`, exact: true });
          expect(await pinLink.getAttribute("href")).toBe(`/chat/${agent.id}/project`);
          expect(await pin.locator(".sidebar-recent-session").count()).toBe(0);
          expect(await group.locator(".sidebar-recent-session").allTextContents()).toEqual([
            expect.stringContaining(`${agent.name} project`),
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
        expect(await headers.first().getAttribute("aria-current")).toBe("page");
        // Agent-scope changes update both the rail shortcuts and ordinary rows;
        // measure their settled layout.
        await sidebar.evaluate(finishElementAnimations);
        for (const row of await sessionRows.all()) {
          const lead = await row.locator(".sidebar-session-indicator .session-glyph").boundingBox();
          const title = await row.locator(".sidebar-recent-session__name").boundingBox();
          expect(lead).not.toBeNull();
          expect(title).not.toBeNull();
          expect(title!.x - (lead!.x + lead!.width)).toBeGreaterThanOrEqual(8);
        }
        await page.mouse.move(600, 60);
        await captureSidebarUiProof(suite, page, "sidebar-roster-after.png");

        const activityQuery = {
          archived: "all",
          includeDerivedTitles: true,
          includeLastMessage: true,
          limit: 100,
        };
        const activityReads = () => gateway.getRequests("sessions.list", activityQuery);
        const initialReads = (await activityReads()).length;
        await gateway.deferNext("sessions.list", activityQuery);
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          key: "agent:main:main",
        });
        await expect.poll(async () => (await activityReads()).length).toBe(initialReads + 1);
        for (let index = 0; index < 3; index += 1) {
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            key: "agent:main:main",
          });
          // Exercise separate debounce windows while the original server read stays held.
          await page.waitForTimeout(250);
          expect(await activityReads()).toHaveLength(initialReads + 1);
        }
        await gateway.resolveDeferred("sessions.list");
        await expect.poll(async () => (await activityReads()).length).toBe(initialReads + 2);
        await expect.poll(() => sessionRows.count()).toBe(8);

        const workspaceMenu = sidebar.locator(".sidebar-agent-menu");
        await page.mouse.move(1100, 700);
        await expect.poll(() => workspaceMenu.count()).toBe(0);
        await workspace.focus();
        await Promise.all([
          sidebar.evaluate(
            (element) =>
              new Promise<void>((resolve) => {
                element.addEventListener("wa-after-show", () => resolve(), { once: true });
              }),
          ),
          workspace.hover(),
        ]);
        expect(await workspace.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
        await page.keyboard.press("Enter");
        const workspaceMenuItems = workspaceMenu.locator(":scope > wa-dropdown-item");
        await expect.poll(() => workspaceMenuItems.count()).toBe(4);
        expect(
          await workspaceMenuItems.evaluateAll((items) =>
            items.map((item) => item.getAttribute("value")),
          ),
        ).toEqual([
          "command:new-agent",
          "command:agents-directory",
          "command:capabilities",
          "command:agent-settings",
        ]);
        expect(
          await workspaceMenu.locator(".sidebar-agent-menu__agent-list wa-dropdown-item").count(),
        ).toBe(5);
        expect(await workspaceMenu.locator('[value="command:help"]').count()).toBe(0);
        expect(await workspaceMenu.locator("wa-dropdown-item[aria-checked]").count()).toBe(0);
        expect(await allAgentsTile.getAttribute("aria-current")).toBe("true");
        const agentTiles = workspaceMenu.locator(
          ".sidebar-agent-menu__agent-list wa-dropdown-item",
        );
        await expectFocused(agentTiles.first());
        await page.keyboard.press("ArrowDown");
        await expectFocused(agentTiles.nth(1));
        await page.keyboard.press("End");
        await expectFocused(workspaceMenuItems.last());
        await captureSidebarUiProof(suite, page, "sidebar-team-workspace-menu.png");
        await page.keyboard.press("Escape");
        await expect.poll(() => workspaceMenu.count()).toBe(0);
        await expectFocused(workspace);

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
        await expect
          .poll(() => sidebar.locator('[data-agent-id="forge"]').getAttribute("aria-current"))
          .toBe("page");
        expect(await sidebar.locator('[data-session-key="agent:forge:main"]').count()).toBe(0);
        await sidebar.locator('[data-navigation-view="pages"]').click();
        await sidebar
          .locator(".sidebar-pages")
          .getByRole("link", { name: "Automations", exact: true })
          .click();
        await waitForControlUiRoute(page, { routeId: "cron" });
        await expect.poll(() => page.locator(".cron-table__row").count()).toBe(2);
        expect(
          await page.locator(".cron-table__row openclaw-agent-row-chip").allTextContents(),
        ).toEqual([expect.stringContaining("Harbor"), expect.stringContaining("Forge")]);
        expect((await gateway.getRequests("cron.list")).at(-1)?.params).not.toHaveProperty(
          "agentId",
        );
        await captureSidebarUiProof(suite, page, "sidebar-team-automations.png");

        await sidebar.locator('[data-navigation-view="sessions"]').click();
        await sidebar
          .locator('[data-session-key="agent:forge:notes"] .sidebar-recent-session__link')
          .click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge/notes" });
        await expectWorkspace();
        await expect.poll(() => sessionRows.count()).toBe(8);
        await sidebar.locator(".sidebar-session-sort").click();
        await openSidebarMenu(page);
        expect(
          await sidebar
            .locator(".sidebar-session-sort-menu")
            .locator("#sidebar-sessions-group")
            .count(),
        ).toBe(0);
        expect(
          await sidebar
            .locator(".sidebar-session-sort-menu")
            .getByRole("radiogroup", { name: "Hide empty groups", exact: true })
            .count(),
        ).toBe(0);
        await openSidebarMenu(page);
        await chooseSidebarOwner(page, "owner:profile-riley");
        await closeSidebarMenu(page);
        await expect.poll(() => sessionRows.count()).toBe(4);
        expect(await sessionRows.allTextContents()).toEqual([
          expect.stringContaining("Harbor project"),
          expect.stringContaining("Forge project"),
          expect.stringContaining("Scout project"),
          expect.stringContaining("Bloom project"),
        ]);
        await sidebar.locator(".sidebar-session-sort").click();
        await openSidebarMenu(page);
        await chooseSidebarOwner(page, "all");
        await closeSidebarMenu(page);
        await expect.poll(() => sessionRows.count()).toBe(8);

        await sidebar.locator('[data-agent-collapse="bloom"]').click();
        await expect.poll(() => sessionRows.count()).toBe(6);
        expect(new URL(page.url()).pathname).toBe("/chat/forge/notes");
        await page.reload();
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() =>
            sidebar.locator('[data-agent-collapse="bloom"]').getAttribute("aria-expanded"),
          )
          .toBe("false");
        await expect.poll(() => sessionRows.count()).toBe(6);
        await expectWorkspace();
        const forgeGroup = sidebar.locator('[data-agent-group="forge"]');
        const actions = forgeGroup.locator(".sidebar-agent-roster__actions");
        await forgeGroup.locator(".sidebar-agent-roster__row").focus();
        await page.keyboard.press("Tab");
        await expectFocused(actions.locator("a"));
        await page.keyboard.press("Tab");
        const options = actions.getByRole("button", { name: "Options for Forge" });
        await expectFocused(options);
        await page.keyboard.press("Space");
        await actions.getByRole("menuitem", { name: "All sessions", exact: true }).waitFor();
        expect(await actions.locator("wa-dropdown-item").allTextContents()).toEqual([
          expect.stringContaining("Open main chat"),
          expect.stringContaining("All sessions"),
          expect.stringContaining("Collapse others"),
        ]);
        const overflowItems = actions.locator("wa-dropdown-item");
        expect(await overflowItems.locator('[slot="icon"] svg').count()).toBe(3);
        await expectFocused(overflowItems.first());
        await page.keyboard.press("ArrowDown");
        await expectFocused(overflowItems.nth(1));
        await page.keyboard.press("Escape");
        await expectFocused(options);
        await options.press("Enter");
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
        await workspaceMenu.locator('[value="agent:forge"]').press("Enter");
        await expect.poll(() => headers.count()).toBe(0);
        expect(await sidebar.locator(".sidebar-footer-bar__home").count()).toBe(1);
        expect(await chip.isVisible()).toBe(true);
        expect(await workspace.count()).toBe(0);
        await chip.click();
        await expect.poll(() => allAgentsTile.isVisible()).toBe(true);
        expect(await allAgentsTile.getAttribute("aria-current")).toBeNull();
        expect(
          await sidebar.locator(".sidebar-agent-menu__agent-list wa-dropdown-item").count(),
        ).toBe(5);
        await expectFocused(activeAgentTile);
        await page.keyboard.press("Escape");
        await expect.poll(() => workspaceMenu.count()).toBe(0);
        await page.setViewportSize({ width: 390, height: 844 });
        const drawerToggle = page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first();
        await drawerToggle.click();
        for (const trigger of [chip, workspace]) {
          if (trigger === workspace) {
            await chip.press("Enter");
            await expect.poll(() => allAgentsTile.isVisible()).toBe(true);
            await allAgentsTile.press("Enter");
          }
          await trigger.press("Enter");
          await expect.poll(() => allAgentsTile.isVisible()).toBe(true);
          await expectFocused(activeAgentTile);
          await page.keyboard.press("Escape");
          await expect.poll(() => workspaceMenu.count()).toBe(0);
          expect(await sidebar.isVisible()).toBe(true);
          await expectFocused(trigger);
        }
      },
    );
  });

  it.each([false, true])(
    "keeps main-chat identity, activity, metadata and actions visible (touch=%s)",
    async (touch) => {
      await suite.withPage(
        { viewport: { width: 390, height: 900 }, hasTouch: touch, isMobile: touch },
        async ({ page }) => {
          const mainKey = "agent:forge:main";
          const agentsList: AgentsListResult = {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "main", name: "Harbor" },
              { id: "forge", name: "Forge" },
            ],
          };
          const rows = [
            { key: "agent:main:main", kind: "direct", agentId: "main", isMain: true, icon: "home" },
            {
              key: mainKey,
              kind: "direct",
              agentId: "forge",
              isMain: true,
              hasActiveRun: true,
              status: "running",
              unread: true,
              incognito: touch ? true : undefined,
              owner: { actor: { type: "human", id: "profile-riley", label: "Riley" } },
            },
          ] satisfies GatewaySessionRow[];
          await installMockGateway(page, {
            sessions: rows,
            methodResponses: {
              "agents.list": agentsList,
              "sessions.list": {
                ts: Date.now(),
                path: "",
                count: rows.length,
                defaults: { model: null, modelProvider: null, contextTokens: null },
                owners: [
                  { type: "human", id: "profile-riley", label: "Riley" },
                  { type: "human", id: "profile-devon", label: "Devon" },
                ],
                sessions: rows,
              } satisfies SessionsListResult,
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiRoute(page, { routeId: "chat" });
          const drawer = page
            .locator(".topbar-nav-toggle:visible,.chat-pane__nav-toggle:visible")
            .first();
          if ((await drawer.getAttribute("aria-expanded")) === "false") {
            await drawer.click();
          }
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-agent-card__main").click();
          await sidebar.locator('.sidebar-agent-menu [value="scope:all"]').click();
          const headerLocator = sidebar.locator(
            '[data-agent-group="forge"] .sidebar-agent-roster__header',
          );
          await headerLocator.waitFor({ state: "visible" });
          const quietHeader = sidebar.locator(
            '[data-agent-group="main"] .sidebar-agent-roster__header',
          );
          expect(await quietHeader.locator(".sidebar-session-indicator").count()).toBe(0);
          expect(await quietHeader.locator(".sidebar-agent-roster__signals").isVisible()).toBe(
            false,
          );
          const selectors = [".session-glyph--running", ".session-unread-dot"];
          const expectSignals = async () => {
            for (const selector of selectors) {
              await expect.poll(() => headerLocator.locator(selector).isVisible()).toBe(true);
              expect(await headerLocator.locator(selector).count()).toBe(1);
            }
          };
          await page.mouse.move(389, 899);
          await expectSignals();
          const action = headerLocator.locator('button[slot="trigger"]');
          await action.focus();
          await expectSignals();
          const boxes = await sidebar.evaluate(async (sidebarElement, key) => {
            const host = sidebarElement as AppSidebarSessionNavigationElement;
            // Feed the shell-owned outbox summary, not a replacement row projection.
            host.storedOutboxes = {
              total: 2,
              attentionCountForSession: (sessionKey) => (sessionKey === key ? 2 : 0),
              hasSessionDraft: (sessionKey) => sessionKey === key,
            };
            host.sessionDataContext!.sessions.setPullRequestSummary(key, {
              numbers: [103],
              state: "open",
            });
            await host.updateComplete;
            const roster = host.querySelector<LitElement>("openclaw-sidebar-agent-roster")!;
            await roster.updateComplete;
            const header = roster.querySelector(
              '[data-agent-group="forge"] .sidebar-agent-roster__header',
            )!;
            const box = (element: Element) => {
              const rect = element.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
              };
            };
            const name = header.querySelector<HTMLElement>(".sidebar-agent-roster__copy > span")!;
            return {
              header: box(header),
              signals: box(header.querySelector(".sidebar-agent-roster__signals")!),
              actions: box(header.querySelector(".sidebar-agent-roster__actions")!),
              nameFits: name.clientWidth > 0 && name.scrollWidth <= name.clientWidth,
              badges: [...header.querySelectorAll(".session-row-badge, .session-owner-chip")].map(
                (badge) => ({
                  label: badge.getAttribute("aria-label"),
                  visible: badge.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
                  box: box(badge),
                }),
              ),
            };
          }, mainKey);
          expect(boxes.nameFits).toBe(true);
          expect(
            boxes.signals.right <= boxes.actions.left ||
              boxes.actions.right <= boxes.signals.left ||
              boxes.signals.bottom <= boxes.actions.top ||
              boxes.actions.bottom <= boxes.signals.top,
          ).toBe(true);
          // The agent avatar is the header identity; Home's creator never renders beside it.
          expect(boxes.badges.map((badge) => badge.label)).not.toContain("Created by Riley");
          expect(boxes.badges.map((badge) => badge.label)).toEqual(
            expect.arrayContaining([
              "#103 · Open",
              "2 messages need attention",
              touch ? "Incognito session" : "Unsent draft",
            ]),
          );
          for (const badge of boxes.badges) {
            expect(badge.visible).toBe(true);
          }
          for (const box of [
            boxes.actions,
            boxes.signals,
            ...boxes.badges.map((badge) => badge.box),
          ]) {
            expect(box.left).toBeGreaterThanOrEqual(boxes.header.left);
            expect(box.right).toBeLessThanOrEqual(boxes.header.right);
            expect(box.top).toBeGreaterThanOrEqual(boxes.header.top);
            expect(box.bottom).toBeLessThanOrEqual(boxes.header.bottom);
          }
        },
      );
    },
  );
});
