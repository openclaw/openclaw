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
    { change: "remove-policy", mode: "noop" },
    { change: "default", mode: "hot" },
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
      case "remove-policy":
        delete role.modelPolicy;
        break;
      case "default":
        roles.default = "staff";
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

  it.each([
    ...[
      "mcp.apps.enabled",
      "gateway.auth.token",
      "gateway.bind",
      "gateway.controlUi.root",
      "browser.enabled",
      "gateway.auth.mode",
      "discovery.wideArea.domain",
      "security.unknownPolicy",
      "secrets.egressProxy.enabled",
    ].map((path) => ({ path, restart: true, heartbeat: false })),
    ...["tools.codeMode.enabled", "gateway.controlUi.experimental.customPlugins"].map((path) => ({
      path,
      restart: false,
      heartbeat: false,
    })),
    { path: "agents.defaults.model", restart: false, heartbeat: true },
  ])("classifies reload path: $path", ({ path, restart, heartbeat }) => {
    const plan = buildGatewayReloadPlan([path]);
    expect(plan.restartGateway).toBe(restart);
    expect(plan.restartReasons).toEqual(restart ? [path] : []);
    expect(plan.hotReasons).toEqual(restart ? [] : [path]);
    expect(plan.restartHeartbeat).toBe(heartbeat);
    expect(resolveConfigReloadMetadata(path).kind).toBe(restart ? "restart" : "hot");
  });
});
