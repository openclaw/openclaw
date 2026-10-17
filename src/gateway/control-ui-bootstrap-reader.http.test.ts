import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayControlUiConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "./control-ui-bootstrap-contract.js";
import { handleControlUiHttpRequest } from "./control-ui.js";

afterEach(() => resetPluginRuntimeStateForTest());

it("serves configured viewer policy without granting plugin or config access", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const root = state.workspaceDir;
    await fs.writeFile(path.join(root, "index.html"), "<html><head></head><body></body></html>");
    await fs.mkdir(path.join(root, "dist/control-ui"), { recursive: true });
    await fs.writeFile(path.join(root, "dist/control-ui/index.js"), "export default {};");
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "private-panel",
        origin: "bundled",
        rootDir: root,
        controlUi: { entry: "dist/control-ui/index.js" },
        uiCapabilities: ["page"],
      }),
    );
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({
        id: "private-panel",
        configSchema: { type: "object", additionalProperties: false },
        controlUi: { entry: "dist/control-ui/index.js" },
        uiCapabilities: ["page"],
      }),
    );
    setActivePluginRegistry(registry);
    const trustedProxy = { userHeader: "x-viewer-email", allowLoopback: true };
    const auth: ResolvedGatewayAuth = {
      mode: "trusted-proxy",
      trustedProxy,
      allowTailscale: false,
    };
    const controlUi: GatewayControlUiConfig = { basePath: "/control", embedSandbox: "scripts" };
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: root } } },
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy },
        trustedProxies: ["127.0.0.1"],
        controlUi,
      },
      mcp: { servers: { privateServer: { command: "private-command" } } },
    };
    setRuntimeConfigSnapshot(config);
    const {
      listener: server,
      claim,
      releaseListener,
    } = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          void handleControlUiHttpRequest(req, res, {
            basePath: "/control",
            config,
            getRuntimeConfig: () => config,
            auth,
            trustedProxies: ["127.0.0.1"],
            root: { kind: "resolved", path: root },
          }).catch(() => {
            res.statusCode = 500;
            res.end();
          });
        }),
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing bootstrap test address");
    }
    const origin = `http://127.0.0.1:${address.port}/control`;
    const read = (route: string, scopes?: string, method = "GET") =>
      fetch(`${origin}${route}`, {
        method,
        headers:
          scopes === undefined
            ? {}
            : {
                "x-viewer-email": "viewer@example.test",
                "x-forwarded-for": "203.0.113.42",
                "x-openclaw-scopes": scopes,
              },
      });
    try {
      for (const embedSandbox of ["scripts", "strict", "trusted"] as const) {
        controlUi.embedSandbox = embedSandbox;
        setRuntimeConfigSnapshot(config);
        const response = await read("/control-ui-config.json", "operator.sessions.read");
        expect(response.status, `${embedSandbox}: ${await response.clone().text()}`).toBe(200);
        const bootstrap = await response.json();
        expect(bootstrap).toMatchObject({
          basePath: "/control",
          embedSandbox,
          pluginAssetsRequireAuth: true,
          pluginControlUiModules: [],
          pluginFrameGrants: [],
        });
        expect(bootstrap.preferences.config).toBeUndefined();
        expect(JSON.stringify(bootstrap)).not.toContain("private-command");
        expect(response.headers.get("set-cookie")).toBeNull();
        const document = await read("/", "operator.sessions.read");
        expect(document.status).toBe(200);
        const html = await document.text();
        expect(html).toContain(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
        expect(html).toContain(`&quot;embedSandbox&quot;:&quot;${embedSandbox}&quot;`);
        expect(html).not.toMatch(/private-panel|private-command/);
      }
      const admin = await read("/control-ui-config.json", "operator.admin");
      expect(admin.status).toBe(200);
      const full = await admin.json();
      expect(full.pluginControlUiModules).toHaveLength(1);
      expect(full.pluginFrameGrants).toHaveLength(1);
      expect(full.preferences.config.mcp.servers.privateServer.command).toBe("private-command");
      const head = await read("/control-ui-config.json", "operator.sessions.read", "HEAD");
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      for (const scopes of [undefined, "operator.approvals"]) {
        const denied = await read("/control-ui-config.json", scopes);
        expect(denied.status).toBe(scopes === undefined ? 401 : 403);
        expect(await denied.text()).not.toContain("embedSandbox");
        const document = await read("/", scopes);
        expect(await document.text()).not.toContain(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
      }
    } finally {
      server.closeAllConnections();
      try {
        await releaseListener();
      } finally {
        await claim.release();
      }
    }
  });
});
