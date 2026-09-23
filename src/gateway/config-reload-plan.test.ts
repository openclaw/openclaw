import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildGatewayReloadPlan, resolveConfigReloadMetadata } from "./config-reload-plan.js";

describe("Gateway core reload policy", () => {
  beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each<{
    path: string;
    restart: boolean;
    reason?: string;
    hot?: string;
    restartHeartbeat?: boolean;
  }>([
    {
      path: "mcp.apps.enabled",
      restart: true,
      reason: "mcp.apps.enabled",
    },
    {
      path: "gateway.auth.token",
      restart: true,
      reason: "gateway.auth.token",
    },
    {
      path: "agents.defaults.model",
      restart: false,
      hot: "agents.defaults.model",
      restartHeartbeat: true,
    },
    ...[
      "tools.codeMode.enabled",
      "tools.toolSearch.enabled",
      "gateway.controlUi.experimental.customPlugins",
      "desktop.host.enabled",
      "cloudWorkers.desktop",
    ].map((path) => ({ path, restart: false, hot: path })),
    {
      path: "unknownField",
      restart: true,
      reason: "unknownField",
    },
  ])("classifies reload path: $path", (testCase) => {
    const plan = buildGatewayReloadPlan([testCase.path]);
    expect(plan.restartGateway).toBe(testCase.restart);
    if (testCase.reason) {
      expect(plan.restartReasons).toContain(testCase.reason);
    }
    if (testCase.hot) {
      expect(plan.hotReasons).toContain(testCase.hot);
      expect(resolveConfigReloadMetadata(testCase.path).kind).toBe("hot");
    }
    if (testCase.restartHeartbeat) {
      expect(plan.restartHeartbeat).toBe(true);
    }
  });

  it.each([
    "gateway.port",
    "gateway.bind",
    "gateway.tls.enabled",
    "gateway.controlUi.basePath",
    "gateway.controlUi.root",
    "browser.enabled",
    "browser.evaluateEnabled",
    "browser.ssrfPolicy.allowedHostnames",
    "browser.extensionRelay.allowLegacyAuth",
    "gateway.auth.mode",
    "discovery.wideArea.domain",
    "diagnostics.otel.endpoint",
    "memory.search.enabled",
    "security.unknownPolicy",
    "secrets.egressProxy.enabled",
    "secrets.egressProxy.allowedHosts",
    "secrets.egressProxy.bypassHosts",
  ])("keeps restart-owned path restart-backed: %s", (path) => {
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual([path]);
    expect(plan.hotReasons).toStrictEqual([]);
  });
});
