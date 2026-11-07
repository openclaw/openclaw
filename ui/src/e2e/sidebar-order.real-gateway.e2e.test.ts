import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { setUserProfileRole } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { revealSidebarTarget } from "../test-helpers/control-ui-sidebar-window.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { readUiBundle } from "./device-gateway.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Personal sidebar order real Gateway",
  startServerBeforeBrowser: true,
});
const preference = "ui.sidebarAgentOrder";
const agents = [
  "main",
  "alpha",
  "beta",
  ...Array.from({ length: 47 }, (_, i) => `team-${String(i + 1).padStart(2, "0")}`),
];
const people = ["sidebar-owner@example.test", "sidebar-other@example.test"];

function rpc<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return evaluateControlUiContext(
    page,
    async (app, request) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Sidebar proof Gateway client unavailable");
      }
      return client.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

function visibleOrder(page: Page) {
  return page
    .locator("openclaw-app-sidebar [data-agent-group]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent-group")));
}

suite.define(() => {
  it("persists and broadcasts personal order across independent browsers without changing another profile", async (test) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: GatewayServer | undefined;
    const proxies: ViteDevServer[] = [];
    await suite.runScenario(test, {
      async run() {
        const artifactDir = suite.artifactDir;
        const startedAt = Date.now();
        const port = await getFreePort();
        state = await createOpenClawTestState({
          label: "sidebar-order-real-gateway",
          layout: "home",
          env: {
            ...deviceGatewayEnv,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
          },
        });
        const profiles = people.map((email) => {
          const profile = ensureProfileForEmail(email);
          setUserProfileRole(profile.id, "administrator");
          return profile.id;
        });
        const entries: Record<string, { name: string; workspace: string }> = {};
        for (const id of agents) {
          const workspace = state.path(`workspace-${id}`);
          await mkdir(workspace, { recursive: true });
          entries[id] = { name: id === "main" ? "Main" : id, workspace };
        }
        const scopes = ["operator.admin", "operator.read", "operator.write"];
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: people,
          deviceAutoApprove: { enabled: true, scopes },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: { workspace: state.workspaceDir, model: "fixture/echo" },
            entries,
          },
          talk: { agentId: "main" },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              fixture: {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "synthetic-fixture-key",
                models: [{ id: "echo", name: "Fixture model" }],
              },
            },
          },
          gateway: {
            port,
            auth: { mode: "trusted-proxy", trustedProxy },
            trustedProxies: ["127.0.0.1", "::1"],
            controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
          },
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        const urls: string[] = [];
        for (const [index, email] of people.entries()) {
          const proxy = await createGatewayProxy(state.workspaceDir, {
            "/": gatewayProxyRoute(port, email, `192.0.2.${10 + index}`),
          });
          proxies.push(proxy);
          await proxy.listen();
          const url = new URL(proxy.resolvedUrls!.local[0]!);
          url.protocol = "ws:";
          urls.push(url.href);
        }
        const connect = async (index: number) => {
          // Do not copy storageState: this must prove Gateway sync, not shared browser storage.
          const context = await suite.newBrowserContext({
            locale: "en-US",
            reducedMotion: "reduce",
            serviceWorkers: "block",
            viewport: { width: 1280, height: 900 },
          });
          const page = await context.newPage();
          const url = new URL("new", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: urls[index]! }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: `Switch to ${new URL(urls[index]!).host}`, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);
          expect(await rpc(page, "users.self", {})).toMatchObject({
            profile: { id: profiles[index] },
          });
          await page.locator(".sidebar-agent-card__main, .sidebar-workspace-header__main").click();
          await page.getByRole("menuitem", { name: "Show all", exact: true }).click();
          await expect.poll(() => visibleOrder(page)).toContain("main");
          return page;
        };
        const first = await connect(0);
        const second = await connect(0);
        const other = await connect(1);
        const initialOrder = await visibleOrder(first);
        const roster = await rpc<{ agents: Array<{ id: string }> }>(first, "agents.list", {});
        const defaultOrder = roster.agents.map((agent) => agent.id);
        expect(defaultOrder).toEqual(agents);
        expect(initialOrder).toEqual(defaultOrder.slice(0, initialOrder.length));
        const prefs = (page: Page) => rpc(page, "users.prefs.get", { keys: [preference] });
        expect(await prefs(other)).toEqual({ status: "ok", entries: {} });
        await first.locator('[data-agent-group="beta"] .sidebar-agent-roster__row').click({
          button: "right",
        });
        await first.getByRole("menuitem", { name: "Move up", exact: true }).click();
        const movedOrder = ["main", "beta", "alpha", ...defaultOrder.slice(3)];
        await expect
          .poll(() => visibleOrder(first))
          .toEqual(movedOrder.slice(0, initialOrder.length));
        await expect
          .poll(() => prefs(first))
          .toEqual({
            status: "ok",
            entries: { [preference]: movedOrder },
          });
        await expect.poll(() => visibleOrder(second)).toEqual(await visibleOrder(first));
        expect(await visibleOrder(other)).toEqual(initialOrder);
        expect(await prefs(other)).toEqual({ status: "ok", entries: {} });
        await first.reload();
        await waitForControlUiGatewayReady(first);
        await expect.poll(() => visibleOrder(first)).toEqual(await visibleOrder(second));
        const fresh = await connect(0);
        await expect.poll(() => visibleOrder(fresh)).toEqual(await visibleOrder(second));
        await revealSidebarTarget(
          fresh.locator(".sidebar-shell__body"),
          fresh.locator('[data-agent-group="team-47"]'),
        );
        await suite.closeBrowserContext(fresh.context());
        await second.locator(".sidebar-workspace-header__main").click();
        await second.getByRole("menuitem", { name: "Reset agent order", exact: true }).click();
        await expect
          .poll(() => prefs(second))
          .toEqual({
            status: "ok",
            entries: { [preference]: [] },
          });
        await expect.poll(() => visibleOrder(first)).toEqual(initialOrder);
        await expect.poll(() => visibleOrder(second)).toEqual(initialOrder);
        expect(await visibleOrder(other)).toEqual(initialOrder);
        expect(await prefs(other)).toEqual({ status: "ok", entries: {} });
        await first.reload();
        await waitForControlUiGatewayReady(first);
        await expect.poll(() => visibleOrder(first)).toEqual(initialOrder);
        const report = {
          bundle: await readUiBundle(first),
          agents: agents.length,
          corePassed: true,
          durationMs: Date.now() - startedAt,
          isolatedStateRoot: state.root,
          proof: [
            "persisted preference",
            "same-profile push sync",
            "profile isolation",
            "reload",
            "fresh context",
            "reset sync",
            "reset reload",
            "last roster row reachable",
          ],
        };
        const reportPath = path.join(artifactDir, "sidebar-order-real-gateway.json");
        await writeFile(reportPath, JSON.stringify(report, null, 2));
      },
      close: async () =>
        runQaGatewayFixture(
          async () => {},
          ...proxies.map((proxy) => () => proxy.close()),
          () => gateway?.close({ reason: "sidebar order proof cleanup" }),
        ),
      release: async () => state?.cleanup(),
      retainedState: () => state?.root,
    });
  });
});
