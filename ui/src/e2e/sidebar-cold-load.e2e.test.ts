import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
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
const baselineMode = process.env.OPENCLAW_SIDEBAR_BASELINE === "1";
const selectedKey = "agent:main:dashboard:00000000-0000-4000-8000-000000000006";
const pluginPath = "/__openclaw__/plugins/control-ui/reports/one/index.js";
const avatarUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAIElEQVR4nGN4nhWCFTEQkPj64w8ag5AEPqPgiDgdmAgA9YRzYZfFh50AAAAASUVORK5CYII=";

async function observeShape(sidebar: Locator) {
  return sidebar.evaluateHandle((element, key) => {
    const samples: Array<{
      navigation: Array<string | null>;
      agents: Array<string | null>;
      agentNames: string[];
      avatarText: string[];
      brand: string;
      footer: string;
      online: string[];
      selectedBounds: { x: number; y: number; width: number; height: number } | null;
    }> = [];
    const sample = () => {
      const selected = element.querySelector(`[data-sidebar-entry="session:${key}"]`);
      const bounds = selected?.getBoundingClientRect();
      const next = {
        navigation: [...element.querySelectorAll("[data-sidebar-entry]")].map((row) =>
          row.getAttribute("data-sidebar-entry"),
        ),
        agents: [...element.querySelectorAll("[data-agent-group]")].map((row) =>
          row.getAttribute("data-agent-group"),
        ),
        agentNames: [
          ...element.querySelectorAll("[data-agent-group] .sidebar-agent-roster__copy"),
        ].map((row) => row.textContent?.trim() ?? ""),
        avatarText: [
          ...element.querySelectorAll(
            "[data-agent-group] .sidebar-agent-roster__row .sidebar-agent-roster__avatar",
          ),
        ].map((row) => row.querySelector("[data-avatar]")?.getAttribute("data-avatar") ?? ""),
        brand: element.querySelector(".sidebar-workspace-header__main")?.textContent?.trim() ?? "",
        footer: element.querySelector(".sidebar-identity-card__name")?.textContent?.trim() ?? "",
        online: [...element.querySelectorAll(".sidebar-online__person-name")].map(
          (row) => row.textContent?.trim() ?? "",
        ),
        selectedBounds: bounds
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          : null,
      };
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

async function waitForExpandedSnapshot(sidebar: Locator) {
  await sidebar.evaluate(
    (element) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          const opened = indexedDB.open("openclaw-chat-snapshots");
          opened.onerror = () => reject(opened.error);
          opened.onsuccess = () => {
            const database = opened.result;
            const transaction = database.transaction("sidebarSnapshots", "readonly");
            const rows = transaction.objectStore("sidebarSnapshots").getAll();
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => {
              database.close();
              const records = rows.result as Array<{
                model: { onlineExpanded: boolean; footer: { id: string } | null };
              }>;
              if (
                records.some(({ model }) => model.footer?.id === "riley" && model.onlineExpanded)
              ) {
                observer.disconnect();
                resolve();
              }
            };
          };
        };
        const observer = new MutationObserver(check);
        observer.observe(element, { attributes: true, attributeFilter: ["data-snapshot-saved"] });
        check();
      }),
  );
}

async function waitForSavedSidebar(page: Page) {
  try {
    await page
      .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
      .waitFor();
  } catch (error) {
    const diagnosis = await page.evaluate(() => {
      const host = document.querySelector<
        AppSidebarSessionNavigationElement & {
          captureSidebarSnapshot(): unknown;
          sidebarSnapshotSettled(): boolean;
        }
      >("openclaw-app-sidebar");
      return {
        settled: host?.sidebarSnapshotSettled(),
        model: host?.captureSidebarSnapshot(),
        state: document.querySelector<HTMLElement>("aside.sidebar")?.dataset.snapshotState,
      };
    });
    await writeFile(
      path.join(suite.artifactDir, "sidebar-persistence-failure.json"),
      JSON.stringify(diagnosis, null, 2),
    );
    throw error;
  }
}

suite.define(() => {
  it("restores the settled sidebar before hello and preserves its shape through late counts and plugins", async () => {
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
    const ownerSessionCounts = [
      { profileId: "riley", open: 11, running: 0 },
      { profileId: "ada", open: 2, running: 0 },
      { profileId: "zoe", open: 3, running: 2 },
    ];
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1100 } },
      async ({ page }) => {
        await page.addInitScript(
          ({ settingsKey, ownerKey }) => {
            if (!localStorage.getItem(settingsKey)) {
              localStorage.setItem(settingsKey, JSON.stringify({ sidebarAgentsMode: "roster" }));
              localStorage.setItem(ownerKey, "involving-me");
            }
          },
          {
            settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
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
          ],
          sessionKey: selectedKey,
          sessions,
          presenceUsers: [
            {
              self: true,
              id: "riley",
              identity: { type: "profile", id: "riley" },
              name: "Riley",
              email: "riley@example.test",
              avatarUrl,
              lastInputSeconds: 0,
            },
            {
              id: "ada",
              identity: { type: "profile", id: "ada" },
              name: "Ada",
              email: "ada@example.test",
              avatarUrl,
              lastInputSeconds: 0,
            },
            {
              id: "zoe",
              identity: { type: "profile", id: "zoe" },
              name: "Zoe",
              email: "zoe@example.test",
              avatarUrl,
              lastInputSeconds: 0,
            },
          ],
          methodResponses: {
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
            "sessions.list": { ...sessionsListResponse(sessions), ownerSessionCounts },
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
        await sidebar.waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await sidebar.locator('[data-sidebar-entry="plugin:reports/overview"]').waitFor();
        await sidebar.locator(`[data-sidebar-entry="session:${sessions.at(-1)!.key}"]`).waitFor();
        await sidebar.locator('[data-agent-group="scout"]').waitFor();
        if (!baselineMode) {
          await waitForSavedSidebar(page);
        }
        const onlineToggle = sidebar.locator(".sidebar-online .sidebar-session-group-toggle");
        await onlineToggle.waitFor();
        if ((await onlineToggle.getAttribute("aria-expanded")) === "false") {
          await onlineToggle.click();
        }
        await sidebar.locator(".sidebar-online__person-name").first().waitFor();
        await expect
          .poll(() => sidebar.locator(".sidebar-online__person-name").allTextContents())
          .toEqual(["Zoe", "Ada", "Riley"]);
        if (!baselineMode) {
          await waitForSavedSidebar(page);
          await waitForExpandedSnapshot(sidebar);
        }
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const reference = await observeShape(sidebar);
        const settled = await reference.evaluate((observer) => observer.current());
        await reference.evaluate((observer) => observer.stop());
        await reference.dispose();
        expect(settled.navigation.filter((key) => key?.startsWith("session:"))).toHaveLength(11);
        expect(settled.agents).toEqual(["main", "forge", "scout"]);
        expect(settled.agentNames).toEqual(["Harbor", "Forge", "Scout"]);
        expect(settled.avatarText).toEqual(["⚓", "🔧", "🔭"]);
        expect(settled.brand).toBe("OpenClaw");
        expect(settled.footer).toBe("Riley");
        expect(settled.online).toEqual(["Zoe", "Ada", "Riley"]);
        expect(settled.selectedBounds).not.toBeNull();

        if (baselineMode) {
          await page.reload();
          await gateway.waitForRequest("connect");
          await sidebar.waitFor({ state: "visible" });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const baseline = await observeShape(sidebar);
          await capture(page, sidebar, "sidebar-old-before-hello.png");
          await gateway.resolveDeferred("connect");
          await sidebar.locator('[data-sidebar-entry="plugin:reports/overview"]').waitFor();
          await sidebar.locator(`[data-sidebar-entry="session:${sessions.at(-1)!.key}"]`).waitFor();
          await expect
            .poll(() =>
              sidebar.locator("[data-agent-group] .sidebar-agent-roster__copy").allTextContents(),
            )
            .toEqual(["Harbor", "Forge", "Scout"]);
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          const reloaded = await baseline.evaluate((observer) => observer.current());
          const baselineSamples = await baseline.evaluate((observer) => observer.stop());
          await baseline.dispose();
          expect(reloaded.navigation.filter((key) => key?.startsWith("session:"))).toHaveLength(11);
          expect(reloaded.avatarText).toEqual(["⚓", "🔧", "🔭"]);
          await capture(page, sidebar, "sidebar-old-settled.png");
          await writeFile(
            path.join(suite.artifactDir, "sidebar-cold-load.json"),
            JSON.stringify(
              {
                baseline: "Baseline source signed-in reload after a real authenticated prior visit",
                previousVisit: settled,
                baselineSamples,
                reloaded,
                baselineLayoutChanges: baselineSamples.length - 1,
              },
              null,
              2,
            ),
          );
          return;
        }

        await page.reload();
        await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
        await gateway.waitForRequest("connect");
        const restored = await observeShape(sidebar);
        expect(await restored.evaluate((observer) => observer.current())).toEqual(settled);
        expect(await gateway.getRequests()).toHaveLength(1);
        expect(await sidebar.locator('[draggable="true"]').count()).toBe(0);
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
        await waitForSavedSidebar(page);
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

        await page.reload();
        await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
        await gateway.waitForRequest("connect");
        await gateway.deferNext("plugins.controlUi.list");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("plugins.controlUi.list");
        await gateway.rejectDeferred("plugins.controlUi.list", {
          code: "UNAVAILABLE",
          message: "Synthetic plugin catalog temporarily unavailable",
        });
        await page.locator('aside.sidebar[data-snapshot-state="live"]').waitFor();
        await sidebar.locator(".sidebar-brand__new-thread:enabled").waitFor();
        expect(
          await sidebar.locator("[data-sidebar-session-archive]:enabled").count(),
        ).toBeGreaterThan(0);
        const navigationKeys = () =>
          sidebar
            .locator("[data-sidebar-entry]")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry")));
        expect(await navigationKeys()).toEqual(settled.navigation);

        await gateway.setMethodResponse("plugins.controlUi.list", {
          revision: "empty",
          diagnostics: [],
          plugins: [],
        });
        await page.evaluate(async () => {
          const context =
            document.querySelector<AppSidebarSessionNavigationElement>(
              "openclaw-app-sidebar",
            )?.sessionDataContext;
          if (!context) {
            throw new Error("Expected sidebar application context");
          }
          await context.plugins.refresh();
        });
        await sidebar
          .locator('[data-sidebar-entry="plugin:reports/overview"]')
          .waitFor({ state: "detached" });
        expect(await navigationKeys()).toEqual(
          settled.navigation.filter((key) => key !== "plugin:reports/overview"),
        );

        await waitForSavedSidebar(page);
        await page.reload();
        await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
        await gateway.waitForRequest("connect");
        await gateway.deferNext("sessions.list");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("sessions.list", { match: { excludeDock: true } });
        await gateway.waitForRequest("sessions.list", {
          match: { includeOwnerSessionCounts: true },
        });
        await gateway.rejectDeferred("sessions.list", {
          code: "UNAVAILABLE",
          message: "Synthetic session catalog temporarily unavailable",
        });
        await sidebar.locator(".sidebar-online__retry").waitFor();
        await page.locator('aside.sidebar[data-snapshot-state="live"]').waitFor();
        await sidebar.locator(".sidebar-brand__new-thread:enabled").waitFor();
        expect(await sidebar.locator(".sidebar-online__counts").count()).toBe(0);
        expect(await sidebar.getAttribute("data-snapshot-saved")).toBe("false");
      },
    );
  });
});
