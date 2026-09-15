import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import type { SessionsListResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";

const mainKey = "agent:main:main";
const existingEntries = ["route:usage", "route:cron"];
const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function openPinEditor(page: Page) {
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.locator(".sidebar-nav__head-action").click();
  await sidebar.getByRole("menuitem", { name: "Edit pinned items" }).click();
  return sidebar.locator(".sidebar-pin-editor-menu");
}

for (const existing of [false, true]) {
  const stateName = existing ? "existing" : "fresh";
  let instance: OpenClawTestInstance | undefined;
  const suite = createControlUiE2eSuite({
    name: `Home pin real Gateway ${stateName} settings`,
    startServerBeforeBrowser: true,
    async startServer() {
      const owner = await createOpenClawTestInstance({
        name: `home-pin-${stateName}`,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: undefined,
          // Do not inherit a host workspace or config-directory override.
          OPENCLAW_WORKSPACE_DIR: undefined,
          OPENCLAW_CONFIG_DIR: undefined,
        },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          agents: { defaults: { model: "fixture/sidebar" } },
          models: {
            providers: {
              fixture: {
                api: "openai-completions",
                apiKey: "synthetic-sidebar-key",
                baseUrl: "http://127.0.0.1:9/v1",
                models: [{ id: "sidebar", name: "Sidebar fixture" }],
              },
            },
          },
          ...(existing
            ? { ui: { prefs: { sidebarEntries: existingEntries, themeMode: "dark" } } }
            : {}),
        },
      });
      instance = owner;
      try {
        await owner.startGateway();
        return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
      } catch (error) {
        await owner.cleanup();
        throw error;
      }
    },
  });

  suite.define(() => {
    it("persists Home across reload and a clean browser without losing pins or session grouping", async () => {
      if (!instance) {
        throw new Error("Gateway fixture was not started");
      }
      const owner = instance;
      const observations: Record<string, unknown> = {};
      const cli = async (args: string[]) => {
        const result = await owner.cli(args);
        expect(result.code, args.join(" ")).toBe(0);
        return result.stdout;
      };
      const call = (method: string, params: Record<string, unknown>) =>
        cli(["gateway", "call", method, "--json", "--params", JSON.stringify(params)]);
      const prefs = async () => JSON.parse(await cli(["config", "get", "ui.prefs", "--json"]));
      const mainRow = async () => {
        const result: SessionsListResult = JSON.parse(
          await call("sessions.list", { agentId: "main" }),
        );
        return result.sessions.find((row) => row.key === mainKey);
      };
      await call("sessions.create", { key: mainKey, agentId: "main", label: "Main conversation" });
      await call("sessions.groups.put", { names: ["Projects"] });
      const original = await mainRow();
      expect(original).toMatchObject({ key: mainKey, label: "Main conversation" });
      // Read only the public preference subtree, never retain fixture auth/config.
      const initialConfig = JSON.parse(await fs.readFile(owner.configPath, "utf8"));
      expect(initialConfig.ui?.prefs?.sidebarHomePinned).toBeUndefined();
      observations.initialPrefs = initialConfig.ui?.prefs ?? {};
      const open = async (page: Page) => {
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        const { browserUrl }: { browserUrl: string } = JSON.parse(
          await cli(["dashboard", "--json"]),
        );
        const url = new URL("chat/main", browserUrl);
        url.hash = new URL(browserUrl).hash;
        await page.goto(url.toString());
        await waitForControlUiGatewayReady(page);
      };
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await open(page);
        const sidebar = page.locator("openclaw-app-sidebar");
        const home = sidebar.locator(".nav-item--home");
        const main = sidebar.locator(`.sidebar-recent-session[data-session-key="${mainKey}"]`);
        await expect.poll(() => home.isVisible()).toBe(true);
        expect(await main.count()).toBe(0);
        if (captureEnabled) {
          await page.screenshot({ path: path.join(suite.artifactDir, "01-home-pinned.png") });
        }
        const editor = await openPinEditor(page);
        await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(async () => (await prefs()).sidebarHomePinned).toBe(false);
        observations.unpinnedPrefs = await prefs();
        if (existing) {
          expect(await prefs()).toMatchObject({
            sidebarEntries: existingEntries,
            themeMode: "dark",
          });
        }
        await expect.poll(() => main.isVisible()).toBe(true);
        await main.hover();
        await main.getByRole("button", { name: "Open session menu" }).click();
        await openSessionMenuSubmenu(page, "Move to group");
        await page.getByRole("menuitemradio", { name: /^Projects/ }).click();
        await expect.poll(async () => (await mainRow())?.category).toBe("Projects");
        await page.reload();
        await waitForControlUiGatewayReady(page);
        const grouped = sidebar.locator(
          `[data-session-section="category:Projects"] .sidebar-recent-session[data-session-key="${mainKey}"]`,
        );
        await expect.poll(() => grouped.isVisible()).toBe(true);
        expect(await home.count()).toBe(0);
        if (captureEnabled) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "02-home-unpinned-grouped.png"),
          });
        }
      });
      // A new context has no mirrored local preferences or auth from the first browser.
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await open(page);
        const sidebar = page.locator("openclaw-app-sidebar");
        const grouped = sidebar.locator(
          `[data-session-section="category:Projects"] .sidebar-recent-session[data-session-key="${mainKey}"]`,
        );
        await expect.poll(() => grouped.isVisible()).toBe(true);
        expect(await sidebar.locator(".nav-item--home").count()).toBe(0);
        observations.cleanBrowserPrefs = await prefs();
        let editor = await openPinEditor(page);
        await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(async () => (await prefs()).sidebarHomePinned).toBe(true);
        await expect.poll(() => sidebar.locator(".nav-item--home").isVisible()).toBe(true);
        expect(await grouped.count()).toBe(0);
        if (existing) {
          expect(await prefs()).toMatchObject({
            sidebarEntries: existingEntries,
            themeMode: "dark",
          });
        }
        editor = await openPinEditor(page);
        await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(async () => (await prefs()).sidebarHomePinned).toBe(false);
        await expect.poll(() => grouped.isVisible()).toBe(true);
        editor = await openPinEditor(page);
        await editor.getByRole("menuitem", { name: "Reset pinned items", exact: true }).click();
        await expect.poll(async () => (await prefs()).sidebarHomePinned).toBe(true);
        await expect.poll(() => sidebar.locator(".nav-item--home").isVisible()).toBe(true);
        observations.resetPrefs = await prefs();
      });
      const final = await mainRow();
      expect(final).toMatchObject({
        key: mainKey,
        sessionId: original?.sessionId,
        label: "Main conversation",
        category: "Projects",
      });
      observations.session = {
        key: final?.key,
        label: final?.label,
        category: final?.category,
        sameSession: final?.sessionId === original?.sessionId,
      };
      if (captureEnabled) {
        await fs.writeFile(
          path.join(suite.artifactDir, "persistence.json"),
          JSON.stringify(observations, null, 2),
        );
      }
    }, 120_000);
  });
}
