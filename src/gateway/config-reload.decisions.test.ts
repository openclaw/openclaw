import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => resetPluginRuntimeStateForTest());

describe("decision model reload planning", () => {
  it.each<{
    name: string;
    previous: OpenClawConfig;
    next: OpenClawConfig;
    reloadPlugins: boolean;
  }>([
    {
      name: "adds the decision agent roster",
      previous: {},
      next: { agents: { entries: { worker: { decisionModel: "fixture/fast" } } } },
      reloadPlugins: true,
    },
    {
      name: "removes the decision agent roster",
      previous: { agents: { entries: { worker: { decisionModel: "fixture/fast" } } } },
      next: {},
      reloadPlugins: true,
    },
    {
      name: "changes a utility model",
      previous: { agents: { entries: { worker: { utilityModel: "fixture/small" } } } },
      next: { agents: { entries: { worker: { utilityModel: "fixture/large" } } } },
      reloadPlugins: false,
    },
    {
      name: "adds an agent without a decision override",
      previous: { agents: { entries: {} } },
      next: { agents: { entries: { worker: {} } } },
      reloadPlugins: false,
    },
  ])(
    "preserves roster actions and scopes provider reloads when it $name",
    ({ previous, next, reloadPlugins }) => {
      const paths = diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes());
      expect(buildGatewayReloadPlan(paths)).toMatchObject({
        restartGateway: false,
        reloadPlugins,
        refreshHooksPolicy: true,
        reloadInternalHooks: true,
        restartHeartbeat: true,
      });
    },
  );

  it("hot-applies the default decision model", () => {
    expect(buildGatewayReloadPlan(["agents.defaults.decisionModel"])).toMatchObject({
      restartGateway: false,
      reloadPlugins: true,
    });
  });
});
