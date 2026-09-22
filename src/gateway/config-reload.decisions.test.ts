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
      name: "adds a decision agent",
      previous: { agents: { entries: {} } },
      next: { agents: { entries: { worker: { decisionModel: "fixture/fast" } } } },
      reloadPlugins: true,
    },
    {
      name: "removes a decision agent",
      previous: { agents: { entries: { worker: { decisionModel: "fixture/fast" } } } },
      next: { agents: { entries: {} } },
      reloadPlugins: true,
    },
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
      name: "renames an agent",
      previous: { agents: { entries: { worker: { name: "Worker" } } } },
      next: { agents: { entries: { worker: { name: "Research" } } } },
      reloadPlugins: false,
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
    {
      name: "removes an agent without a decision override",
      previous: { agents: { entries: { worker: {} } } },
      next: { agents: { entries: {} } },
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

  it.each([
    { path: "agents.defaults.decisionModel", expected: { reloadPlugins: true } },
    {
      path: "agents.entries.worker.decisionModel",
      expected: { reloadPlugins: true, refreshHooksPolicy: true, reloadInternalHooks: true },
    },
  ])("hot-applies $path", ({ path, expected }) => {
    expect(buildGatewayReloadPlan([path])).toMatchObject({ restartGateway: false, ...expected });
  });
});
