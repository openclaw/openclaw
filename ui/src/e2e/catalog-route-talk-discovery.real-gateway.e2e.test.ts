import { mkdir } from "node:fs/promises";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.ts";
import {
  clearActivePluginRegistry,
  setActivePluginRegistry,
} from "../../../src/plugins/runtime.ts";
import type { SessionCatalogProvider } from "../../../src/plugins/session-catalog.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { expectDefined } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { catalogList } from "./sidebar-assertions.test-support.ts";

type TalkRequest = { method: string; sessionKey?: string };
declare global {
  interface Window {
    talkDiscoveryRequests?: TalkRequest[];
    catalogRpcMethods?: string[];
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI catalog route Talk discovery with a real Gateway",
  startServerBeforeBrowser: true,
});

const threadId = "00000000-0000-0000-0000-000000207250";
const routeAgentId = "main";

suite.define(() => {
  it("sends no Talk discovery for a catalog key on open, reopen, or focus refresh", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-catalog-talk-discovery",
      layout: "home",
      env: deviceGatewayEnv,
    });
    let gateway: GatewayServer | undefined;
    const registry = createEmptyPluginRegistry();
    try {
      const workspace = state.path("workspace-main");
      await mkdir(workspace, { recursive: true });
      await state.writeConfig({
        agents: {
          defaults: { workspace },
          ownership: "explicit",
          entries: { [routeAgentId]: { name: "Main", workspace } },
        },
        // Keep the injected registry active without loading unrelated runtime plugins.
        plugins: { allow: ["codex"], entries: { codex: { enabled: false } } },
        gateway: {
          auth: { mode: "none" },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
        },
      });
      state.applyEnv();
      const catalog = catalogList({
        id: "codex",
        label: "Codex",
        host: "Local Codex",
        thread: threadId,
        name: "Native catalog talk discovery",
        status: "idle",
        archive: false,
      });
      const host = expectDefined(catalog.catalogs[0]?.hosts[0], "catalog host");
      Object.assign(expectDefined(host.sessions[0], "catalog session"), {
        cwd: workspace,
        canContinue: false,
      });
      const provider: SessionCatalogProvider = {
        id: "codex",
        label: "Codex",
        list: async () => [{ ...host, kind: "gateway" }],
        read: async ({ hostId, threadId: requestedThreadId }) => ({
          hostId,
          threadId: requestedThreadId,
          items: [{ type: "agentMessage", text: "native transcript" }],
        }),
      };
      // Minimal startup adopts the explicit fixture registry before requests can observe it.
      registry.sessionCatalogs.push({ pluginId: "codex", provider, source: import.meta.url });
      setActivePluginRegistry(registry);
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "start",
      });

      await suite.withPage(
        {
          hasTouch: false,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        async ({ page }) => {
          const url = new URL(`chat/${routeAgentId}`, suite.server.baseUrl);
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
            .click();

          // Observe every Talk discovery RPC the composer issues from here on.
          await evaluateControlUiContext(page, (context) => {
            const client = context.gateway.snapshot.client;
            if (!client) {
              throw new Error("Control UI Gateway client is unavailable");
            }
            const request = client.request.bind(client);
            const observed: TalkRequest[] = [];
            window.talkDiscoveryRequests = observed;
            client.request = async <T>(method: string, params?: unknown): Promise<T> => {
              if (method === "talk.catalog" || method === "talk.config") {
                observed.push({
                  method,
                  sessionKey: (params as { sessionKey?: string } | undefined)?.sessionKey,
                });
              }
              (window.catalogRpcMethods ??= []).push(method);
              return await request<T>(method, params);
            };
          });

          const talkRequests = () =>
            page.evaluate(() =>
              (window.talkDiscoveryRequests ?? []).filter((entry) =>
                String(entry.sessionKey ?? "").includes(":catalog:"),
              ),
            );
          const catalogSearch = `?${new URLSearchParams({
            catalog: "codex",
            host: "gateway:local",
            thread: threadId,
          })}`;
          const navigateToCatalog = async () => {
            const listCallsBefore = await page.evaluate(
              () =>
                (window.catalogRpcMethods ?? []).filter((m) => m === "sessions.catalog.list")
                  .length,
            );
            await evaluateControlUiContext(
              page,
              (context, { agentId, search }) => {
                context.navigate("chat", { pathname: `/chat/${agentId}`, search });
              },
              { agentId: routeAgentId, search: catalogSearch },
            );
            // The catalog route announces itself with a fresh catalog list; wait for it, then
            // give any misdirected Talk discovery a chance to fire before asserting absence.
            await expect
              .poll(
                async () =>
                  page.evaluate(
                    () =>
                      (window.catalogRpcMethods ?? []).filter((m) => m === "sessions.catalog.list")
                        .length,
                  ),
                { timeout: 30_000 },
              )
              .toBeGreaterThan(listCallsBefore);
            await page.waitForTimeout(500);
          };

          // Open the catalog entry: its external key must not reach Talk discovery.
          await navigateToCatalog();
          expect(await talkRequests()).toEqual([]);

          // Reopen the original catalog URL: still no discovery for the catalog key.
          await navigateToCatalog();
          expect(await talkRequests()).toEqual([]);

          // A focus refresh cannot revive discovery while the route names a catalog entry.
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await page.waitForTimeout(300);
          expect(await talkRequests()).toEqual([]);
        },
      );
    } finally {
      await gateway?.close({ reason: "catalog talk discovery e2e cleanup" });
      await clearActivePluginRegistry(registry);
      await state.cleanup();
    }
  });
});
