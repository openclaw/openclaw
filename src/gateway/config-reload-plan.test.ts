import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  resolveConfigReloadMetadata,
} from "./config-reload-plan.js";

describe("Gateway core reload policy", () => {
  beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each([
    { change: "allow", mode: "noop" },
    { change: "deny", mode: "noop" },
    { change: "source", mode: "noop" },
    { change: "add-policy", mode: "noop" },
    { change: "remove-policy", mode: "noop" },
    { change: "unchanged", mode: "noop" },
    { change: "scopes", mode: "hot" },
    { change: "agents", mode: "hot" },
    { change: "sessions", mode: "hot" },
    { change: "sandbox", mode: "hot" },
    { change: "plugin", mode: "hot" },
    { change: "default", mode: "hot" },
    { change: "add-role", mode: "hot" },
    { change: "remove-role", mode: "hot" },
    { change: "mixed-role", mode: "hot" },
    { change: "mixed-gateway", mode: "restart" },
    { change: "effective-scopes", mode: "hot" },
    { change: "authored-scopes", mode: "hot" },
    { change: "missing-effective", mode: "hot" },
    { change: "missing-authored", mode: "hot" },
  ])("preserves reload ownership for role change: $change", ({ change, mode }) => {
    const roleName = "reader.modelPolicy.allow";
    const previous: OpenClawConfig = {
      gateway: {
        roles: {
          default: roleName,
          definitions: {
            [roleName]: {
              agents: "*",
              scopes: ["operator.write"],
              sessions: { others: "view" },
              modelPolicy: { allow: ["fixture/a", "fixture/b"] },
            },
            staff: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
          },
        },
      },
    };
    const candidate = structuredClone(previous);
    const roles = candidate.gateway!.roles!;
    const role = roles.definitions[roleName]!;
    switch (change) {
      case "allow":
        role.modelPolicy = { allow: ["fixture/b"] };
        break;
      case "deny":
        role.modelPolicy!.deny = ["fixture/a"];
        break;
      case "source":
        role.modelPolicy!.sourceAgent = "backup";
        break;
      case "add-policy":
        delete previous.gateway!.roles!.definitions[roleName]!.modelPolicy;
        break;
      case "remove-policy":
        delete role.modelPolicy;
        break;
      case "scopes":
        role.scopes = ["operator.read"];
        break;
      case "agents":
        role.agents = ["main"];
        break;
      case "sessions":
        role.sessions.others = "none";
        break;
      case "sandbox":
        role.sandbox = "required";
        break;
      case "plugin":
        role.accessPolicyPlugin = "fixture";
        break;
      case "default":
        roles.default = "staff";
        break;
      case "add-role":
        roles.definitions.newRole = { ...role };
        break;
      case "remove-role":
        delete roles.definitions.staff;
        break;
      case "mixed-role":
        role.modelPolicy!.deny = ["fixture/a"];
        roles.definitions.staff!.agents = [];
        break;
      case "mixed-gateway":
        role.modelPolicy!.deny = ["fixture/a"];
        candidate.gateway!.port = 18790;
        break;
      case "effective-scopes":
      case "authored-scopes":
        role.modelPolicy!.deny = ["fixture/a"];
        role.scopes = ["operator.read"];
        break;
      case "missing-effective":
      case "missing-authored":
        role.modelPolicy!.deny = ["fixture/a"];
        break;
    }
    const previousCompareConfig = structuredClone(previous);
    const candidateCompareConfig = structuredClone(candidate);
    if (change === "effective-scopes") {
      candidateCompareConfig.gateway!.roles!.definitions[roleName]!.scopes = ["operator.write"];
    } else if (change === "authored-scopes") {
      role.scopes = ["operator.write"];
    }
    const changedPaths = diffGatewayReloadPaths(
      previousCompareConfig,
      candidateCompareConfig,
      listConfigReloadRefinementPrefixes(),
    );
    const plan = buildGatewayReloadPlan(changedPaths, {
      previousConfig: change === "missing-effective" ? undefined : previous,
      candidateConfig: candidate,
      previousCompareConfig: change === "missing-authored" ? undefined : previousCompareConfig,
      candidateCompareConfig,
    });
    expect(plan.restartGateway).toBe(mode === "restart");
    expect(isNoopGatewayReloadPlan(plan)).toBe(mode === "noop");
    if (mode === "noop") {
      expect(plan.noopPaths).toEqual(changedPaths);
    } else if (mode === "hot") {
      expect(plan.hotReasons).toEqual(changedPaths);
    }
  });

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
