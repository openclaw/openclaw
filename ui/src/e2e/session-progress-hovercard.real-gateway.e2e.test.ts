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
import { deviceGatewayEnv } from "./device-gateway.test-support.ts";
import { catalogList } from "./sidebar-assertions.test-support.ts";

type ProgressRequest = { outcome: "pending" | "ok"; sessionKey: string };
declare global {
  interface Window {
    catalogProgressRequests?: ProgressRequest[];
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI catalog progress hovercard with a real Gateway",
  startServerBeforeBrowser: true,
});

const threadId = "00000000-0000-0000-0000-000000135156";
const routeAgentId = "writer";
const catalogSessionKey = `agent:${routeAgentId}:catalog:codex:gateway%3Alocal:${threadId}`;

suite.define(() => {
  it("keeps the selected agent on native catalog progress-card requests", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-catalog-progress",
      layout: "home",
      env: deviceGatewayEnv,
    });
    let gateway: GatewayServer | undefined;
    const registry = createEmptyPluginRegistry();
    try {
      const mainWorkspace = state.path("workspace-main");
      const writerWorkspace = state.path("workspace-writer");
      await Promise.all([
        mkdir(mainWorkspace, { recursive: true }),
        mkdir(writerWorkspace, { recursive: true }),
      ]);
      await state.writeConfig({
        agents: {
          defaults: { workspace: mainWorkspace },
          ownership: "explicit",
          entries: {
            main: { name: "Main", workspace: mainWorkspace },
            [routeAgentId]: { name: "Writer", workspace: writerWorkspace },
          },
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
        name: "Native catalog progress",
        status: "idle",
        archive: false,
      });
      const host = expectDefined(catalog.catalogs[0]?.hosts[0], "catalog host");
      Object.assign(expectDefined(host.sessions[0], "catalog session"), {
        cwd: writerWorkspace,
        canContinue: false,
      });
      const provider: SessionCatalogProvider = {
        id: "codex",
        label: "Codex",
        list: async () => [{ ...host, kind: "gateway" }],
        read: async ({ hostId, threadId: requestedThreadId }) => ({
          hostId,
          threadId: requestedThreadId,
          items: [],
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

          const row = page.locator(
            '[data-session-section="catalog:codex"] .sidebar-recent-session',
            {
              hasText: "Native catalog progress",
            },
          );
          await row.waitFor({ state: "visible", timeout: 30_000 });
          expect(await row.getAttribute("data-session-key")).toBe(catalogSessionKey);
          await evaluateControlUiContext(page, (context) => {
            const client = context.gateway.snapshot.client;
            if (!client) {
              throw new Error("Control UI Gateway client is unavailable");
            }
            const request = client.request.bind(client);
            const observed: ProgressRequest[] = [];
            window.catalogProgressRequests = observed;
            client.request = async <T>(method: string, params?: unknown): Promise<T> => {
              if (method !== "progressCard.get") {
                return await request<T>(method, params);
              }
              const observedRequest: ProgressRequest = {
                outcome: "pending",
                sessionKey: (params as { sessionKey: string }).sessionKey,
              };
              observed.push(observedRequest);
              const result = await request<T>(method, params);
              observedRequest.outcome = "ok";
              return result;
            };
          });
          await row.locator("a.sidebar-recent-session__link").focus();
          const card = page.locator(".session-progress-hovercard");
          await card.waitFor({ state: "visible" });
          await expect
            .poll(() => page.evaluate(() => window.catalogProgressRequests))
            .toEqual([{ outcome: "ok", sessionKey: catalogSessionKey }]);
          await expect.poll(() => card.textContent()).toContain("Native catalog progress");
        },
      );
    } finally {
      await gateway?.close({ reason: "catalog progress hovercard e2e cleanup" });
      await clearActivePluginRegistry(registry);
      await state.cleanup();
    }
  });
});
