import { expect, it } from "vitest";
import { emptyPairingSnapshot } from "../pages/channels/pairing.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { sessionsUsageResponse } from "../test-helpers/sessions-usage-response.ts";
import { agentRoster as createAgentRoster } from "./agent-roster.test-support.ts";
import {
  configSnapshot,
  pageRunner,
  settingsPageOptions,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI settings loading skeletons mocked Gateway E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

async function expectLoadingState(target: import("playwright").Locator): Promise<void> {
  await target.waitFor({ state: "visible" });
  const skeletons = target.locator(".settings-loading-skeleton");
  await expect.poll(() => skeletons.count()).toBeGreaterThan(0);
  expect(
    await target
      .getByText(/Loading/)
      .filter({ visible: true })
      .count(),
  ).toBe(0);
}

const runPage = pageRunner(suite, settingsPageOptions);
const withPage = (run: (page: import("playwright").Page) => Promise<void>) =>
  runPage(({ page }) => run(page));

suite.define(() => {
  it("renders the Models initial load as a skeleton", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "reviewer", name: "Reviewer" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "config.get": configSnapshot({}, "settings-loading-models"),
          "models.list": { models: [] },
          "models.authStatus": { providers: [], ts: Date.now() },
          "sessions.usage": sessionsUsageResponse(),
          "usage.status": { providers: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/model-providers",
        routeId: "model-providers",
      });
      await gateway.waitForRequest("models.authStatus");
      const authStatusRequestCount = (await gateway.getRequests("models.authStatus")).length;
      await gateway.deferNext("models.authStatus");
      await gateway.deferNext("models.authStatus");
      await gateway.deferNext("models.authStatus");
      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("menuitemradio", { name: "Reviewer", exact: true }).click();
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Reviewer");
      await gateway.waitForRequest("models.authStatus", { after: authStatusRequestCount });
      await expectLoadingState(page.locator(".settings-page").first());
    });
  });

  it("renders the MCP server load as a skeleton", async () => {
    await withPage(async (page) => {
      await installMockGateway(page, { heldMethods: ["config.get"] });
      await page.goto(`${suite.server.baseUrl}settings/mcp`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/mcp",
        routeId: "mcp",
      });
      await expectLoadingState(page.locator(".mcp-server-list"));
    });
  });

  it("renders the Plugins catalog load as a skeleton", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "plugins.list"],
        heldMethods: ["plugins.list"],
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins`);
      await gateway.waitForRequest("plugins.list");
      await expectLoadingState(page.locator("#plugin-settings-panel"));
    });
  });

  it("renders the advanced Plugins config load as a skeleton", async () => {
    await withPage(async (page) => {
      await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "plugins.list"],
        heldMethods: ["config.get"],
        methodResponses: {
          "plugins.list": {
            diagnostics: [],
            mutationAllowed: true,
            plugins: [],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins?tab=advanced`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/plugins",
        routeId: "plugin-settings",
        search: "?tab=advanced",
      });
      await expectLoadingState(page.locator("#plugin-settings-advanced .settings-section"));
    });
  });

  it("renders the Profile identity load as a skeleton", async () => {
    await withPage(async (page) => {
      const profileId = "11111111-1111-4111-8111-111111111111";
      const gateway = await installMockGateway(page, {
        heldMethods: ["users.self"],
        presenceUsers: [
          {
            self: true,
            id: profileId,
            name: "Test Person",
            email: "test@example.com",
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      await waitForControlUiRoute(page, { pathname: "/settings/profile", routeId: "profile" });
      await gateway.waitForRequest("users.self");
      await expectLoadingState(page.locator("#settings-profile-identity"));
    });
  });

  it("renders both Agent Tools data loads as skeletons", async () => {
    await withPage(async (page) => {
      const config = {
        agents: { entries: { main: { tools: { profile: "full" } } } },
      };
      const gateway = await installMockGateway(page, {
        heldMethods: ["tools.catalog", "tools.effective"],
        methodResponses: {
          "agents.list": createAgentRoster({ main: "Main agent" }, "main", "agent"),
          "config.get": {
            ...configSnapshot(config, "settings-loading-tools"),
            sourceConfig: config,
            runtimeConfig: config,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
      await gateway.waitForRequest("tools.catalog");
      await gateway.waitForRequest("tools.effective");
      const panel = page.locator("#agent-panel");
      await expectLoadingState(
        panel.locator(".settings-section", { hasText: "Tool preview" }).first(),
      );
      await expectLoadingState(
        panel.locator(".settings-section", { hasText: "Tool catalog" }).first(),
      );
    });
  });

  it("uses a compact spinner when Custodian refreshes existing history", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "openclaw.changes.list"],
        methodResponses: {
          "openclaw.changes.list": {
            entries: [
              {
                at: Date.now() - 5_000,
                id: "system-agent-audit:3",
                kind: "operation",
                source: "system-agent",
                summary: "Set config gateway.port",
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}custodian`);
      await waitForControlUiRoute(page, { pathname: "/custodian", routeId: "custodian" });
      const historyToggle = page.getByRole("button", { name: "History", exact: true });
      await historyToggle.click();
      await gateway.waitForRequest("openclaw.changes.list");
      await page.locator(".custodian__change-card").waitFor();

      const requestCount = (await gateway.getRequests("openclaw.changes.list")).length;
      await gateway.deferNext("openclaw.changes.list");
      await historyToggle.click();
      await historyToggle.click();
      await gateway.waitForRequest("openclaw.changes.list", { after: requestCount });

      const history = page.locator(".custodian__history");
      const spinner = history.locator(".custodian__history-spinner");
      await spinner.waitFor({ state: "visible" });
      expect(await history.locator(".settings-loading-skeleton").count()).toBe(0);
    });
  });

  it("renders the Channels config schema load as a skeleton", async () => {
    await withPage(async (page) => {
      const config = { channels: { whatsapp: { enabled: true } } };
      const gateway = await installMockGateway(page, {
        heldMethods: ["config.schema"],
        methodResponses: {
          "channels.pairing.list": emptyPairingSnapshot(),
          "channels.status": {
            ts: Date.now(),
            channelOrder: ["whatsapp"],
            channelLabels: { whatsapp: "WhatsApp" },
            channels: {
              whatsapp: {
                configured: true,
                linked: true,
                running: true,
                connected: true,
                reconnectAttempts: 0,
              },
            },
            channelAccounts: {},
            channelDefaultAccountId: {},
          },
          "config.get": configSnapshot(config, "settings-loading-channel-schema"),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/channels`);
      await waitForControlUiRoute(page, { pathname: "/settings/channels", routeId: "channels" });
      await gateway.waitForRequest("config.schema");
      await page
        .locator("button.channels-item, button.channels-item__detail", { hasText: "WhatsApp" })
        .first()
        .click();
      await expectLoadingState(page.locator(".channels-detail"));
    });
  });

  it("preserves the schema-driven Config spinner", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        heldMethods: ["config.schema"],
        methodResponses: {
          "config.get": configSnapshot({}, "settings-loading-config-schema"),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/infrastructure`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/infrastructure",
        routeId: "infrastructure",
      });
      await gateway.waitForRequest("config.schema");
      const panel = page.locator("#config-section-panel");
      const spinner = panel.locator(".config-loading__spinner");
      await spinner.waitFor({ state: "visible" });
      expect(await spinner.isVisible()).toBe(true);
      expect(await panel.locator(".settings-loading-skeleton").count()).toBe(0);
    });
  });

  it("wraps row-shaped loading controls at the compact breakpoint", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["secrets.store.list"],
          heldMethods: ["secrets.store.list"],
        });
        await page.goto(`${suite.server.baseUrl}settings/secrets`);
        const row = page.locator(".settings-loading-skeleton__row").first();
        const text = row.locator(".settings-row__text");
        const control = row.locator(".settings-row__control");
        await row.waitFor();
        const [textBox, controlBox] = await Promise.all([
          text.boundingBox(),
          control.boundingBox(),
        ]);
        expect(textBox).not.toBeNull();
        expect(controlBox).not.toBeNull();
        expect(controlBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height);
        await expectLoadingState(page.locator(".settings-page").first());
      },
    );
  });

  it("renders the lazy Settings sidebar as navigation skeletons", async () => {
    await withPage(async (page) => {
      let releaseSidebar: (() => void) | undefined;
      const sidebarRelease = new Promise<void>((resolve) => {
        releaseSidebar = resolve;
      });
      await page.route("**/src/components/settings-sidebar.ts*", async (route) => {
        await sidebarRelease;
        await route.continue();
      });
      await installMockGateway(page);
      try {
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await expectLoadingState(page.locator(".settings-sidebar"));
      } finally {
        releaseSidebar?.();
      }
    });
  });
});
