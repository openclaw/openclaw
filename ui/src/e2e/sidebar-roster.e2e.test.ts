import type { LitElement } from "lit";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
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
          await workspaceMenu.locator(".sidebar-agent-menu__agent-grid wa-dropdown-item").count(),
        ).toBe(5);
        expect(await workspaceMenu.locator('[value="command:help"]').count()).toBe(0);
        expect(await workspaceMenu.locator("wa-dropdown-item[aria-checked]").count()).toBe(0);
        expect(await allAgentsTile.getAttribute("aria-current")).toBe("true");
        const agentTiles = workspaceMenu.locator(
          ".sidebar-agent-menu__agent-grid wa-dropdown-item",
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
        await expect.poll(() => sessionRows.count()).toBe(8);
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
        expect(await sidebar.getByRole("link", { name: "Home", exact: true }).count()).toBe(1);
        expect(await chip.isVisible()).toBe(true);
        expect(await workspace.count()).toBe(0);
        await chip.click();
        await expect.poll(() => allAgentsTile.isVisible()).toBe(true);
        expect(await allAgentsTile.getAttribute("aria-current")).toBeNull();
        expect(
          await sidebar.locator(".sidebar-agent-menu__agent-grid wa-dropdown-item").count(),
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
    "keeps dense main-chat headers on one line with accessible overflow (touch=%s)",
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
          await installMockGateway(page, {
            sessions: [
              { key: "agent:main:main", kind: "direct", agentId: "main", isMain: true },
              {
                key: mainKey,
                kind: "direct",
                agentId: "forge",
                isMain: true,
                hasActiveRun: true,
                status: "running",
                unread: true,
                incognito: true,
                owner: { actor: { type: "human", id: "profile-riley", label: "Riley" } },
              },
            ],
            methodResponses: { "agents.list": agentsList },
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
          const selectors = [".session-glyph--running", ".session-unread-dot"];
          const expectSignals = async () => {
            for (const selector of selectors) {
              await expect.poll(() => headerLocator.locator(selector).isVisible()).toBe(true);
            }
          };
          await page.mouse.move(389, 899);
          await expectSignals();
          const action = headerLocator.locator('button[slot="trigger"]');
          await action.focus();
          await expectSignals();
          const renderDenseFixture = () =>
            sidebar.evaluate(async (sidebarElement, key) => {
              const host = sidebarElement as AppSidebarSessionNavigationElement;
              await host.updateComplete;
              const main = host.rosterMainSessions.get(key);
              if (!main) {
                throw new Error("Missing projected Forge main session");
              }
              // Shell renders rebuild this projection from draft/outbox owners.
              // Restore the same renderer inputs after each layout transition.
              host.sessionOwnershipVisible = true;
              host.rosterMainSessions = new Map(host.rosterMainSessions).set(key, {
                ...main,
                hasComposerDraft: true,
                unreadChildCount: 3,
                outboxAttentionCount: 2,
                pullRequest: { numbers: [103], state: "open" },
              });
              const roster = host.querySelector<LitElement>("openclaw-sidebar-agent-roster")!;
              roster.requestUpdate();
              await roster.updateComplete;
            }, mainKey);
          await renderDenseFixture();
          const measure = () =>
            headerLocator.evaluate((header) => {
              const box = (element: Element) => {
                const rect = element.getBoundingClientRect();
                return {
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  height: rect.height,
                };
              };
              const name = header.querySelector<HTMLElement>(".sidebar-agent-roster__copy > span")!;
              const badge = header.querySelector(".sidebar-session-team-state__status");
              const visibleBadges = [
                ...header.querySelectorAll(".session-row-badge, .session-owner-chip"),
              ].filter((element) =>
                element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
              );
              const empty = header
                .closest("openclaw-sidebar-agent-roster")!
                .querySelector('[data-agent-group="main"] .sidebar-agent-roster__header')!;
              return {
                header: box(header),
                empty: box(empty),
                avatar: box(header.querySelector(".sidebar-agent-roster__avatar")!),
                badge: badge ? box(badge) : null,
                actions: box(header.querySelector(".sidebar-agent-roster__actions")!),
                nameFits: name.clientWidth > 0 && name.scrollWidth <= name.clientWidth,
                name: box(name),
                visibleBadges: visibleBadges.map((element) => ({
                  label: element.getAttribute("aria-label"),
                  box: box(element),
                })),
              };
            });
          const expectCompactHeader = async (nameMustFit = true) => {
            // This fails on the stacked base: metadata makes Forge taller than
            // the signal-free Harbor header even when every icon fits.
            await expect
              .poll(async () => {
                const boxes = await measure();
                return Math.abs(boxes.header.height - boxes.empty.height);
              })
              .toBeLessThanOrEqual(1);
            const boxes = await measure();
            if (nameMustFit) {
              expect(boxes.nameFits).toBe(true);
            } else {
              expect(boxes.name.right - boxes.name.left).toBeGreaterThan(0);
              expect(
                await headerLocator
                  .locator(".sidebar-agent-roster__indicator:not([hidden])")
                  .count(),
              ).toBe(1);
            }
            expect(boxes.badge).not.toBeNull();
            expect(boxes.badge!.left).toBeLessThan(boxes.avatar.right);
            expect(boxes.badge!.right).toBeGreaterThan(boxes.avatar.right);
            expect(boxes.badge!.top).toBeLessThan(boxes.avatar.bottom);
            expect(boxes.badge!.bottom).toBeGreaterThan(boxes.avatar.bottom);
            expect(boxes.visibleBadges.map((badge) => badge.label)).toContain(
              "2 messages need attention",
            );
            for (const box of [
              boxes.name,
              boxes.actions,
              ...boxes.visibleBadges.map((badge) => badge.box),
            ]) {
              expect(box.left).toBeGreaterThanOrEqual(boxes.header.left);
              expect(box.right).toBeLessThanOrEqual(boxes.header.right);
              expect(box.top).toBeGreaterThanOrEqual(boxes.header.top);
              expect(box.bottom).toBeLessThanOrEqual(boxes.header.bottom);
            }
            for (const badge of boxes.visibleBadges) {
              expect(badge.box.left).toBeGreaterThanOrEqual(boxes.name.right);
              expect(badge.box.right).toBeLessThanOrEqual(boxes.actions.left);
            }
          };
          await expectCompactHeader();
          const overflow = headerLocator.locator(".sidebar-agent-roster__overflow");
          if (touch) {
            await expect.poll(() => overflow.isVisible()).toBe(true);
            expect(await overflow.textContent()).toMatch(/^\+\d+$/);
          }
          const link = headerLocator.locator(".sidebar-agent-roster__row");
          await link.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
          const tooltip = headerLocator.locator("openclaw-tooltip.sidebar-agent-roster__tooltip");
          await expect.poll(() => tooltip.getAttribute("open")).not.toBeNull();
          const summary = await tooltip.locator(".tooltip-content").textContent();
          for (const label of [
            "Forge",
            "Created by Riley",
            "Incognito session",
            "#103",
            "2 messages need attention",
            "Unsent draft",
            "Unread: 4",
          ]) {
            expect(summary).toContain(label);
          }
          expect(await link.getAttribute("aria-label")).toBe(summary);
          await page.keyboard.press("Escape");
          await expect.poll(() => tooltip.getAttribute("open")).toBeNull();
          expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);

          if (!touch) {
            await page.setViewportSize({ width: 1440, height: 900 });
            const resizer = page.getByRole("separator", { name: "Resize sidebar" });
            await resizer.waitFor({ state: "visible" });
            await renderDenseFixture();
            await expectCompactHeader();
            await resizer.focus();
            await page.keyboard.press("End");
            await renderDenseFixture();
            await expect.poll(() => overflow.isVisible()).toBe(false);
            await expectCompactHeader();
            expect(await headerLocator.locator(".session-row-badge--draft").isVisible()).toBe(true);
            expect(await headerLocator.locator(".session-row-badge--incognito").isVisible()).toBe(
              true,
            );
            await resizer.focus();
            await page.keyboard.press("Home");
            await renderDenseFixture();
            await expect.poll(() => overflow.isVisible()).toBe(true);
            expect(await overflow.textContent()).toMatch(/^\+\d+$/);
            await expectCompactHeader(false);
            await page.setViewportSize({ width: 390, height: 900 });
            if ((await drawer.getAttribute("aria-expanded")) === "false") {
              await drawer.click();
            }
            await renderDenseFixture();
            await expectCompactHeader();
          }
        },
      );
    },
  );
});
