import fs from "node:fs/promises";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import adminHttpRpcPlugin from "../../../../extensions/admin-http-rpc/index.js";
import canvasPlugin from "../../../../extensions/canvas/index.js";
import { createCanvasDocument } from "../../../../src/canvas/documents.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../../../../src/gateway/test-helpers.listener.js";
import { registerPluginHttpRoute } from "../../../../src/plugins/http-registry.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../../../src/plugins/runtime.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";

const TOKEN = "qa-hosted-web-token";
const OPERATOR_SCOPES = ["operator.read", "operator.write", "operator.admin"];

afterEach(async () => {
  vi.useRealTimers();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

it(
  "serves the Control UI, admin RPC, and capability-scoped Canvas documents",
  { timeout: 90_000 },
  async () => {
    await withOpenClawTestState(
      {
        label: "qa-hosted-web",
        env: {
          ...snapshotGatewayStartupEnv(),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
        },
      },
      async (state) => {
        const controlUiRoot = state.path("control-ui");
        await fs.mkdir(controlUiRoot, { recursive: true });
        await fs.writeFile(
          state.path("control-ui", "index.html"),
          "<!doctype html><html><body>Gateway hosted Control UI</body></html>",
          "utf8",
        );
        const canvasHtml =
          "<!doctype html><html><body>Gateway hosted Canvas document</body></html>";
        const canvasDocument = await createCanvasDocument({
          title: "Gateway hosted Canvas document",
          html: canvasHtml,
        });

        const config: OpenClawConfig = {
          gateway: {
            mode: "local",
            bind: "loopback",
            auth: { mode: "token", token: TOKEN },
            controlUi: { enabled: true, root: controlUiRoot },
          },
        };
        await state.writeConfig(config);
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        const claim = await acquireGatewayE2ePortBlock();
        const server = await startClaimedGateway(claim, () =>
          startGatewayServer(claim.port, {
            auth: { mode: "token", token: TOKEN },
            bind: "loopback",
            controlUiEnabled: true,
            sidecarStartup: "defer",
          }),
        );
        // Deferred startup replaces the bootstrap registry; register routes only after the
        // server publishes the settled runtime so requests do not target a retired registry.
        await server.startupSettled;
        const registry = getActivePluginRegistry();
        if (!registry) {
          throw new Error("gateway did not publish an active plugin registry");
        }
        const routeCleanups: Array<() => void> = [];
        let operator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

        const registerEntry = (
          pluginId: string,
          entry: typeof adminHttpRpcPlugin,
          pluginConfig: Record<string, unknown> = {},
        ) => {
          entry.register(
            createTestPluginApi({
              id: pluginId,
              name: pluginId,
              config,
              pluginConfig,
              registerHttpRoute: (route) => {
                const routeCount = registry.httpRoutes.length;
                routeCleanups.push(
                  registerPluginHttpRoute({
                    ...route,
                    pluginId,
                    registry,
                    source: `extensions/${pluginId}/index.ts`,
                  }),
                );
                const registeredRoute = registry.httpRoutes[routeCount];
                if (registeredRoute && pluginId === "admin-http-rpc") {
                  registeredRoute.gatewayMethodDispatchAllowed = true;
                }
                if (registeredRoute && route.nodeCapability) {
                  registeredRoute.nodeCapability = { ...route.nodeCapability };
                }
              },
            }),
          );
        };

        try {
          registerEntry("admin-http-rpc", adminHttpRpcPlugin);
          registerEntry("canvas", canvasPlugin, { host: { enabled: true } });

          const origin = `http://127.0.0.1:${claim.port}`;
          const controlUi = await fetch(`${origin}/`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          });
          expect(controlUi.status).toBe(200);
          expect(Object.fromEntries(controlUi.headers)).toMatchObject({
            "content-type": expect.stringContaining("text/html"),
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            "content-security-policy": expect.stringContaining("frame-ancestors 'none'"),
          });
          expect(await controlUi.text()).toContain("Gateway hosted Control UI");

          const adminHealth = (id: string, headers: Record<string, string> = {}) =>
            fetch(`${origin}/api/v1/admin/rpc`, {
              method: "POST",
              headers: { "content-type": "application/json", ...headers },
              body: JSON.stringify({ id, method: "health", params: {} }),
            });
          const unauthorizedAdmin = await adminHealth("unauthorized");
          expect(unauthorizedAdmin.status).toBe(401);

          const admin = await adminHealth("health", {
            accept: "text/html",
            authorization: `Bearer ${TOKEN}`,
          });
          expect(admin.status).toBe(200);
          expect(admin.headers.get("content-type")).toContain("application/json");
          expect(await admin.json()).toMatchObject({
            id: "health",
            ok: true,
            payload: { ok: true },
          });

          const capabilityIssuedAtMs = Date.now();
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(capabilityIssuedAtMs);
          let helloCanvasUrl: string | undefined;
          operator = await connectGatewayClient({
            url: `ws://127.0.0.1:${claim.port}`,
            token: TOKEN,
            role: "operator",
            scopes: OPERATOR_SCOPES,
            onHelloOk: (hello) => {
              helloCanvasUrl = hello.pluginSurfaceUrls?.canvas;
            },
          });
          expect(helloCanvasUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__openclaw__\/cap\/[^/]+$/u);
          vi.useRealTimers();
          const scopedCanvasUrl = helloCanvasUrl ?? "";
          const wrongCapabilityUrl = scopedCanvasUrl.replace(
            /\/cap\/[^/]+$/,
            "/cap/wrong-capability",
          );

          const document = await fetch(`${scopedCanvasUrl}${canvasDocument.entryUrl}`);
          expect(document.status).toBe(200);
          expect(document.headers.get("content-type")).toContain("text/html");
          expect(await document.text()).toBe(canvasHtml);

          const wrongCapability = await fetch(`${wrongCapabilityUrl}${canvasDocument.entryUrl}`);
          expect(wrongCapability.status).toBe(401);

          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(capabilityIssuedAtMs + 24 * 60 * 60_000);
          const expiredCapability = await fetch(`${scopedCanvasUrl}${canvasDocument.entryUrl}`);
          expect(expiredCapability.status).toBe(401);
        } finally {
          if (operator) {
            await disconnectGatewayClient(operator).catch(() => undefined);
          }
          for (const cleanup of routeCleanups.toReversed()) {
            cleanup();
          }
          await server.close();
        }
      },
    );
  },
);
