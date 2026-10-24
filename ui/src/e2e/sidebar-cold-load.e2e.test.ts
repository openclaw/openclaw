import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import {
  CHAT_SNAPSHOT_DB_NAME,
  SIDEBAR_SNAPSHOT_STORE_NAME,
} from "../pages/chat/session-snapshot-database.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiBundledGatewayUrl,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const selectedKey = "agent:main:dashboard:00000000-0000-4000-8000-000000000006";
const railPins = ["route:sessions", `session:${selectedKey}`, "plugin:reports/overview"];
// Sidebar pins are not rail shortcuts.
const railEntries = railPins.filter((entry) => !entry.startsWith("session:"));
const pluginPath = "/__openclaw__/plugins/control-ui/reports/one/index.js";
const avatarUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAIElEQVR4nGN4nhWCFTEQkPj64w8ag5AEPqPgiDgdmAgA9YRzYZfFh50AAAAASUVORK5CYII=";

async function observeShape(sidebar: Locator) {
  return sidebar.evaluateHandle((element, key) => {
    const all = (selector: string) => [...element.querySelectorAll(selector)];
    const attributes = (selector: string, name: string) =>
      all(selector).map((row) => row.getAttribute(name));
    const texts = (selector: string) => all(selector).map((row) => row.textContent?.trim() ?? "");
    const read = () => {
      const selected = element.querySelector(
        `[data-session-section="pinned"] .sidebar-recent-session[data-session-key="${key}"]`,
      );
      const bounds = selected?.getBoundingClientRect();
      return {
        navigation: attributes("[data-sidebar-entry]", "data-sidebar-entry"),
        sessions: attributes(".sidebar-session-content [data-session-key]", "data-session-key"),
        rail: attributes(".sidebar-rail [data-sidebar-entry]", "data-sidebar-entry"),
        view:
          element
            .querySelector('[data-navigation-view][aria-pressed="true"]')
            ?.getAttribute("data-navigation-view") ?? null,
        agents: attributes("[data-agent-group]", "data-agent-group"),
        agentNames: texts("[data-agent-group] .sidebar-agent-roster__copy"),
        avatarText: all(
          "[data-agent-group] .sidebar-agent-roster__header .sidebar-agent-roster__avatar",
        ).map((row) => row.querySelector("[data-avatar]")?.getAttribute("data-avatar") ?? ""),
        brand: element.querySelector(".sidebar-workspace-header__main")?.textContent?.trim() ?? "",
        footer: element.querySelector(".sidebar-identity-card__name")?.textContent?.trim() ?? "",
        online: texts(".sidebar-online__person-name"),
        selectedBounds: bounds
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          : null,
      };
    };
    const samples: Array<ReturnType<typeof read>> = [];
    const sample = () => {
      const next = read();
      if (JSON.stringify(samples.at(-1)) !== JSON.stringify(next)) {
        samples.push(next);
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(element, { attributes: true, childList: true, subtree: true });
    let frame = 0;
    const tick = () => {
      sample();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return {
      current() {
        sample();
        return samples.at(-1)!;
      },
      stop() {
        observer.disconnect();
        cancelAnimationFrame(frame);
        sample();
        return samples;
      },
    };
  }, selectedKey);
}

async function capture(page: Page, sidebar: Locator, filename: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, sidebar, [sidebar], {
    animations: "disabled",
    elements: [sidebar],
  });
  await writeFile(path.join(suite.artifactDir, filename), frame.png);
}

async function waitForSavedSidebar(page: Page, view: "sessions" | "pages") {
  await page
    .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
    .waitFor();
  // A previously saved view can remain painted while the new catalog loads.
  await expect
    .poll(() =>
      page.evaluate(
        ({ databaseName, storeName, view: expectedView }) =>
          new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open(databaseName);
            open.addEventListener("error", () =>
              reject(open.error ?? new Error("Sidebar snapshot open failed")),
            );
            open.addEventListener("success", () => {
              const database = open.result;
              const transaction = database.transaction(storeName, "readonly");
              const request = transaction.objectStore(storeName).getAll();
              transaction.addEventListener("complete", () => {
                database.close();
                resolve(
                  request.result.some((record) => record.model.navigationView === expectedView),
                );
              });
              transaction.addEventListener("abort", () => {
                database.close();
                reject(transaction.error ?? new Error("Sidebar snapshot read failed"));
              });
            });
          }),
        { databaseName: CHAT_SNAPSHOT_DB_NAME, storeName: SIDEBAR_SNAPSHOT_STORE_NAME, view },
      ),
    )
    .toBe(true);
}

const settleFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

suite.define(() => {
  it.each(["sessions", "pages"] as const)(
    "restores the %s view and pinned rail before hello through late counts and plugins",
    async (view) => {
      const agents: AgentsListResult = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
          { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
          { id: "scout", name: "Scout", identity: { emoji: "🔭" } },
        ],
      };
      const now = Date.now();
      const sessions = Array.from({ length: 11 }, (_, index) =>
        createControlUiSessionRow(
          `agent:main:dashboard:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          `Project dashboard ${index + 1}`,
          now - index,
          {
            pinned: true,
            boardFace: "chat",
            owner: { actor: { type: "human", id: "riley", label: "Riley" } },
          },
        ),
      );
      const rosterSessions = [
        ...sessions,
        ...Array.from({ length: 229 }, (_, index) =>
          createControlUiSessionRow(
            `agent:main:planning-${index}`,
            `Planning ${index}`,
            now - 100 - index,
            {
              owner: { actor: { type: "human", id: "riley", label: "Riley" } },
            },
          ),
        ),
      ];
      const ownerSessionCounts = [
        { profileId: "riley", open: rosterSessions.length, running: 0 },
        { profileId: "ada", open: 2, running: 0 },
        { profileId: "zoe", open: 3, running: 2 },
      ];
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1100 } },
        async ({ page }) => {
          await page.addInitScript(
            ({ settingsKey, ownerKey, pins }) => {
              if (!localStorage.getItem(settingsKey)) {
                localStorage.setItem(
                  settingsKey,
                  JSON.stringify({
                    sidebarAgentsMode: "roster",
                    railShortcuts: pins,
                    navigationByProfile: {
                      riley: { railShortcuts: pins },
                    },
                  }),
                );
                localStorage.setItem(ownerKey, "involving-me");
              }
            },
            {
              settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              pins: railPins,
              ownerKey: `openclaw.control.sidebarSessionOwnerFilter.v1:${controlUiBundledGatewayUrl(suite.server.baseUrl)}:riley`,
            },
          );
          await page.route(`**${pluginPath}`, (route) =>
            route.fulfill({
              contentType: "text/javascript",
              body: `export default { id: "reports", activate(host) {
            host.ui.registerPage({ id: "overview", label: "Reports", mount() {} });
            host.ui.registerNavigation({ id: "overview", label: "Reports", page: { id: "overview" }, icon: "chart" });
          } };`,
            }),
          );
          const gateway = await installMockGateway(page, {
            awaitInitialRoster: false,
            authMethod: "trusted-proxy",
            heldMethods: ["connect"],
            pluginAssetsRequireAuth: false,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "plugins.controlUi.list",
              "plugins.controlUi.report",
              "users.prefs.get",
              "users.prefs.set",
            ],
            sessionKey: selectedKey,
            sessions: rosterSessions,
            presenceUsers: ["Riley", "Ada", "Zoe"].map((name) =>
              Object.assign(
                {
                  id: name.toLowerCase(),
                  identity: { type: "profile" as const, id: name.toLowerCase() },
                  name,
                  email: `${name.toLowerCase()}@example.test`,
                  avatarUrl,
                  lastInputSeconds: 0,
                },
                name === "Riley" ? { self: true } : {},
              ),
            ),
            methodResponses: {
              "users.prefs.get": { status: "ok", entries: { "ui.railShortcuts": railPins } },
              "agents.list": agents,
              "agent.identity.get": {
                cases: agents.agents.map((agent) => ({
                  match: { agentId: agent.id },
                  response: {
                    agentId: agent.id,
                    name: agent.name,
                    emoji: agent.identity?.emoji,
                    avatar: "",
                  },
                })),
              },
              "sessions.list": {
                cases: [
                  {
                    match: { hasBoard: true },
                    response: { ...sessionsListResponse(sessions), ownerSessionCounts },
                  },
                  {
                    match: {},
                    response: { ...sessionsListResponse(rosterSessions), ownerSessionCounts },
                  },
                ],
              },
              "plugins.controlUi.list": {
                revision: "one",
                diagnostics: [],
                plugins: [
                  {
                    pluginId: "reports",
                    name: "Reports",
                    revision: "one",
                    entryUrl: pluginPath,
                    styles: [],
                    uiCapabilities: ["page", "navigation"],
                  },
                ],
              },
              "plugins.controlUi.report": { ok: true },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedKey));
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          const sidebar = page.locator("aside.sidebar");
          const reloadCached = async () => {
            await page.reload();
            await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
            await gateway.waitForRequest("connect");
          };
          const waitForLive = () =>
            page.locator('aside.sidebar[data-snapshot-state="live"]').waitFor();
          const waitForNewSession = () =>
            sidebar
              .locator('.sidebar-rail a.sidebar-new-session[href]:not([aria-disabled="true"])')
              .waitFor();
          await sidebar.waitFor({ state: "visible" });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await sidebar.locator('[data-sidebar-entry="plugin:reports/overview"]').waitFor();
          await sidebar.locator('[data-agent-group="scout"]').waitFor();
          if (view === "pages") {
            await sidebar.locator('[data-navigation-view="pages"]').click();
            await sidebar
              .locator(`.sidebar-pages [data-session-key="${sessions[9]!.key}"]`)
              .waitFor();
          } else {
            await expect
              .poll(() =>
                sidebar
                  .locator("[data-agent-group]")
                  .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent-group"))),
              )
              .toEqual(["main", "forge", "scout"]);
          }
          await waitForSavedSidebar(page, view);
          expect(
            await sidebar.locator(`[data-navigation-view="${view}"]`).getAttribute("aria-pressed"),
          ).toBe("true");
          await expect
            .poll(() =>
              sidebar
                .locator(".sidebar-rail [data-sidebar-entry]")
                .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry"))),
            )
            .toEqual(railEntries);
          await waitForSavedSidebar(page, view);
          await settleFrames(page);
          const reference = await observeShape(sidebar);
          const settled = await reference.evaluate((observer) => observer.current());
          await reference.evaluate((observer) => observer.stop());
          await reference.dispose();
          expect(settled.navigation.filter((key) => key?.startsWith("session:"))).toHaveLength(
            view === "pages" ? 11 : 0,
          );
          expect(settled).toMatchObject({
            sessions: view === "pages" ? [] : [selectedKey],
            rail: railEntries,
            view,
            agents: view === "pages" ? [] : ["main", "forge", "scout"],
            agentNames: view === "pages" ? [] : ["Harbor", "Forge", "Scout"],
            avatarText: view === "pages" ? [] : ["⚓", "🔧", "🔭"],
            brand: "OpenClaw",
            footer: "Riley",
            online: [],
          });
          expect(settled.selectedBounds !== null).toBe(view === "sessions");

          await reloadCached();
          const restored = await observeShape(sidebar);
          expect(await restored.evaluate((observer) => observer.current())).toEqual(settled);
          expect(await gateway.getRequests()).toHaveLength(1);
          expect(await sidebar.locator('[draggable="true"]').count()).toBe(0);
          expect(await sidebar.getByRole("button", { name: /^Reorder /u }).count()).toBe(0);
          expect(
            await sidebar
              .locator("[data-sidebar-session-pin]:enabled, [data-sidebar-session-archive]:enabled")
              .count(),
          ).toBe(0);
          expect(await sidebar.locator(".sidebar-identity-card__name").textContent()).toContain(
            "Riley",
          );
          await capture(page, sidebar, "sidebar-after-before-hello.png");

          await gateway.deferNext("sessions.list", { includeOwnerSessionCounts: true });
          await gateway.deferNext("plugins.controlUi.list");
          await gateway.resolveDeferred("connect");
          await gateway.waitForRequest("sessions.list", {
            match: { includeOwnerSessionCounts: true },
          });
          await gateway.waitForRequest("plugins.controlUi.list");
          expect(await restored.evaluate((observer) => observer.current())).toEqual(settled);
          await gateway.resolveDeferred("sessions.list");
          await gateway.resolveDeferred("plugins.controlUi.list");
          await waitForSavedSidebar(page, view);
          expect(await restored.evaluate((observer) => observer.current())).toEqual(settled);
          const restoredSamples = await restored.evaluate((observer) => observer.stop());
          await restored.dispose();
          expect(restoredSamples).toEqual([settled]);
          await capture(page, sidebar, "sidebar-after-settled.png");
          await writeFile(
            path.join(suite.artifactDir, "sidebar-cold-load.json"),
            JSON.stringify(
              {
                scenario: "Candidate signed-in reload after a real authenticated prior visit",
                previousVisit: settled,
                restoredSamples,
                restoredLayoutChanges: restoredSamples.length - 1,
              },
              null,
              2,
            ),
          );

          if (view === "pages") {
            await reloadCached();
            // A queued refresh must not recover before the failed-catalog snapshot check.
            await gateway.setMethodResponse("sessions.list", {
              cases: [
                {
                  match: { hasBoard: true },
                  response: {
                    __mockError: {
                      code: "UNAVAILABLE",
                      message: "Synthetic dashboard catalog unavailable",
                    },
                  },
                },
                {
                  match: {},
                  response: { ...sessionsListResponse(rosterSessions), ownerSessionCounts },
                },
              ],
            });
            await gateway.resolveDeferred("connect");
            await gateway.waitForRequest("sessions.list", { match: { hasBoard: true } });
            await waitForLive();
            await sidebar
              .getByRole("alert")
              .filter({ hasText: "Synthetic dashboard catalog unavailable" })
              .waitFor();
            await expect.poll(() => sidebar.getAttribute("data-snapshot-saved")).toBe("false");
            return;
          }
          await reloadCached();
          await gateway.deferNext("plugins.controlUi.list");
          await gateway.resolveDeferred("connect");
          await gateway.waitForRequest("plugins.controlUi.list");
          await gateway.rejectDeferred("plugins.controlUi.list", {
            code: "UNAVAILABLE",
            message: "Synthetic plugin catalog temporarily unavailable",
          });
          await waitForLive();
          await waitForNewSession();
          const pluginPin = sidebar.locator(
            '.sidebar-rail [data-sidebar-entry="plugin:reports/overview"]',
          );
          expect(await pluginPin.count()).toBe(1);

          await gateway.setMethodResponse("plugins.controlUi.list", {
            revision: "empty",
            diagnostics: [],
            plugins: [],
          });
          await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "empty" });
          await expect.poll(() => pluginPin.count()).toBe(0);
          const savedPins = await page.evaluate((settingsKey) => {
            const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
            return settings.navigationByProfile?.riley?.railShortcuts;
          }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
          expect(savedPins).toContain("plugin:reports/overview");
          await waitForSavedSidebar(page, view);

          await reloadCached();
          await gateway.setMethodResponse("sessions.list", {
            __mockError: {
              code: "UNAVAILABLE",
              message: "Synthetic session catalog temporarily unavailable",
            },
          });
          await gateway.resolveDeferred("connect");
          await waitForLive();
          await waitForNewSession();
          expect(await sidebar.getAttribute("data-snapshot-saved")).toBe("false");
        },
      );
    },
  );
});
