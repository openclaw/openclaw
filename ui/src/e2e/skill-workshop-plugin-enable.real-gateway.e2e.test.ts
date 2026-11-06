import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const PLUGIN_ID = "skill-workshop";

/**
 * One built Gateway whose config keeps Skill Workshop off. The browser turns it on from the
 * Workshop page; the Gateway's own readback proves the result.
 */
function defineSkillWorkshopEnableSuite(params: {
  name: string;
  plugins: Record<string, unknown>;
  /** Allowlist after the page turns Workshop on; undefined when the config has none. */
  expectedAllow?: string[];
}) {
  let instance: OpenClawTestInstance;
  let admin: GatewayClient;
  const suite = createControlUiE2eSuite({
    name: params.name,
    startServerBeforeBrowser: true,
    async startServer() {
      const owner = await createOpenClawTestInstance({
        name: "skill-workshop-off",
        // Plugin lifecycle (enable, publish, method catalog refresh) needs the full Gateway.
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
        config: {
          gateway: { controlUi: { enabled: true } },
          agents: {
            defaults: { model: { primary: "fixture/catalog-only" } },
            entries: { main: {} },
          },
          models: { catalogRefresh: { enabled: false } },
          plugins: params.plugins,
          meta: { migrations: { skillWorkshopPlugin: true } },
        },
      });
      instance = owner;
      const close = () =>
        runQaGatewayFixture(
          () => admin?.stopAndWait(),
          () => owner.cleanup(),
        );
      try {
        await owner.startGateway();
        admin = await acquireGatewayTestClient(
          {
            url: owner.url,
            token: owner.gatewayToken,
            env: owner.env,
            clientName: "cli",
            mode: "cli",
            scopes: ["operator.admin", "operator.read"],
            deviceIdentity: null,
            deviceAuthScope: owner.url,
            requestTimeoutMs: 20_000,
          },
          {
            timeoutMs: 10_000,
            timeoutMessage: "Skill Workshop admin client did not connect",
            closeMessage: "Skill Workshop admin client closed during connect",
          },
        );
        return { baseUrl: `http://127.0.0.1:${owner.port}/`, close };
      } catch (error) {
        return await runQaGatewayFixture(async (): Promise<never> => {
          throw error;
        }, close);
      }
    },
  });

  async function pluginEnabled(): Promise<boolean | undefined> {
    const { plugins } = await admin.request<{ plugins: Array<{ id: string; enabled: boolean }> }>(
      "plugins.list",
      {},
    );
    return plugins.find((plugin) => plugin.id === PLUGIN_ID)?.enabled;
  }

  async function openWorkshop(page: Page) {
    await evaluateControlUiContext(page, (context) => context.navigate("skill-workshop"));
    await page.locator("openclaw-skill-workshop-page").waitFor();
  }

  suite.define(() => {
    it("turns the plugin on from the Workshop page and loads it without a reload", async () => {
      const dashboard = await instance.cli(["dashboard", "--json"]);
      expect(dashboard.code, dashboard.stderr).toBe(0);
      const fragment = new URL(JSON.parse(dashboard.stdout).browserUrl).hash;
      expect(await pluginEnabled()).toBe(false);

      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
          locale: "en-US",
          serviceWorkers: "block",
          permissions: ["local-network-access"],
        },
        async ({ page }) => {
          const sent: Array<{ id: string; method?: string }> = [];
          const responses = new Set<string>();
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => sent.push(JSON.parse(payload.toString())));
            socket.on("framereceived", ({ payload }) => {
              const frame = JSON.parse(payload.toString()) as {
                type: string;
                id: string;
                ok?: boolean;
              };
              if (frame.type === "res" && frame.ok) {
                responses.add(frame.id);
              }
            });
          });
          const workshopRequests = () =>
            sent.filter((frame) => frame.method?.startsWith("skills.workshop."));
          const url = new URL(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main", "chat"));
          url.hash = fragment;
          await page.goto(url.toString());
          await enterControlUiSession(page);
          await waitForControlUiGatewayReady(page);
          await openWorkshop(page);

          // Off: the page explains it, offers the switch, and never calls missing methods.
          const enable = page.getByRole("button", { name: "Turn on Skill Workshop" });
          await enable.waitFor();
          await expect.poll(() => page.getByText("Skill Workshop is off").count()).toBe(1);
          expect(workshopRequests()).toEqual([]);
          // The Plugins hub still lists the Workshop tab, which leads here.
          expect(await page.getByRole("tab", { name: "Skill workshop" }).count()).toBe(1);

          await enable.click();
          // The Gateway publishes the plugin and the open page loads it in place.
          await page.getByText("No learned skills yet").waitFor({ timeout: 60_000 });
          // Focus moves from the departed button to the panel, not the page body.
          await expect
            .poll(() => page.evaluate(() => document.activeElement?.id))
            .toBe("plugins-hub-panel");
          expect(sent.filter((frame) => frame.method === "plugins.setEnabled")).toHaveLength(1);
          expect(workshopRequests().map((frame) => frame.method)).toContain("skills.workshop.list");
          expect(await pluginEnabled()).toBe(true);
          // The Gateway persisted the switch (and any allowlist entry) to the authored config.
          const config = JSON.parse(await readFile(instance.state.configPath, "utf8"));
          expect(config.plugins?.allow).toEqual(params.expectedAllow);
          await expect(
            admin.request("skills.workshop.list", { agentId: "main" }),
          ).resolves.toMatchObject({ agentId: "main", skills: [] });

          // Publication precedes lifecycle cleanup; join the mutation before the next write.
          await expect
            .poll(
              () =>
                sent
                  .filter((frame) => frame.method === "plugins.setEnabled")
                  .every((frame) => responses.has(frame.id)),
              { timeout: 60_000 },
            )
            .toBe(true);

          // The choice is durable: a fresh load serves the Workshop directly.
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await openWorkshop(page);
          await page.getByText("No learned skills yet").waitFor({ timeout: 30_000 });
          expect(await page.getByRole("button", { name: "Turn on Skill Workshop" }).count()).toBe(
            0,
          );

          // Turned off elsewhere, the open page switches back to the off state.
          await admin.request("plugins.setEnabled", { pluginId: PLUGIN_ID, enabled: false });
          await page
            .getByRole("button", { name: "Turn on Skill Workshop" })
            .waitFor({ timeout: 60_000 });
          expect(await pluginEnabled()).toBe(false);
        },
      );
    });
  });
}

defineSkillWorkshopEnableSuite({
  name: "Skill Workshop turned on from its page with a built Gateway and UI",
  // A user turned the bundled plugin off after it moved into a plugin.
  plugins: { entries: { [PLUGIN_ID]: { enabled: false } } },
});

defineSkillWorkshopEnableSuite({
  name: "Skill Workshop turned on from its page past a plugin allowlist",
  // A hardened install that, after the migration, admits only named plugins.
  plugins: { allow: ["memory-core"] },
  expectedAllow: ["memory-core", PLUGIN_ID],
});
