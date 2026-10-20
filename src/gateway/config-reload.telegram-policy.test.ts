import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => resetPluginRuntimeStateForTest());

const decisionWorker = { decisionModel: "fixture/fast" };
const roster = (entries: NonNullable<OpenClawConfig["agents"]>["entries"]): OpenClawConfig => ({
  agents: { entries },
});
const telegram = (
  policy: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>,
  accountId?: string,
): OpenClawConfig => ({
  channels: { telegram: accountId ? { accounts: { [accountId]: policy } } : policy },
});

describe("decision model reload planning", () => {
  it.each([
    ["adds the decision agent roster", {}, roster({ worker: decisionWorker }), true],
    ["removes the decision agent roster", roster({ worker: decisionWorker }), {}, true],
    [
      "changes a utility model",
      roster({ worker: { utilityModel: "fixture/small" } }),
      roster({ worker: { utilityModel: "fixture/large" } }),
      false,
    ],
    ["adds an agent without a decision override", roster({}), roster({ worker: {} }), false],
  ] satisfies [string, OpenClawConfig, OpenClawConfig, boolean][])(
    "preserves roster actions and scopes provider reloads when it %s",
    (_name, previous, next, reloadPlugins) => {
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

it("restarts Slack when plugin approvers are edited", async () => {
  const { slackSetupPlugin } = await loadBundledPluginFacade<{
    slackSetupPlugin: ChannelPlugin;
  }>({ pluginId: "slack", artifactBasename: "setup-plugin-api.ts" });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", plugin: slackSetupPlugin, source: "test" }]),
  );
  const configWithApprover = (approver: string): OpenClawConfig => ({
    approvals: { plugin: { slack: { approvers: [approver] } } },
  });
  const plan = buildGatewayReloadPlan(
    diffGatewayReloadPaths(
      configWithApprover("team:T123:user:U111"),
      configWithApprover("team:T123:user:U222"),
      listConfigReloadRefinementPrefixes(),
    ),
  );
  expect(plan.restartGateway).toBe(false);
  expect(plan.restartChannels).toEqual(new Set(["slack"]));
  expect(plan.restartChannelAccounts).toEqual(new Map());
  expect(plan.reloadPlugins).toBe(false);
});

const { telegramSetupPlugin } = await loadBundledPluginFacade<{
  telegramSetupPlugin: ChannelPlugin;
}>({ artifactBasename: "setup-plugin-api", pluginId: "telegram" });

function planTelegramChange(prev: OpenClawConfig, next: OpenClawConfig) {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramSetupPlugin, source: "bundled" }]),
  );
  return buildGatewayReloadPlan(
    diffGatewayReloadPaths(prev, next, listConfigReloadRefinementPrefixes()),
  );
}

describe("Telegram live policy reload", () => {
  it.each([undefined, "support"])("retains the monitor for policy changes in %s", (accountId) => {
    const previous = {
      dmPolicy: "allowlist" as const,
      allowFrom: ["42"],
      groupPolicy: "allowlist" as const,
      groupAllowFrom: ["42"],
      replyToMode: "off" as const,
      streaming: { mode: "off" as const },
      textChunkLimit: 4000,
    };
    const next = {
      dmPolicy: "disabled" as const,
      allowFrom: ["43"],
      groupPolicy: "disabled" as const,
      groupAllowFrom: ["43"],
      replyToMode: "first" as const,
      streaming: { mode: "partial" as const, preview: { toolProgress: false } },
      textChunkLimit: 1000,
    };
    const plan = planTelegramChange(telegram(previous, accountId), telegram(next, accountId));
    expect(plan.changedPaths.length).toBeGreaterThanOrEqual(7);
    expect(isNoopGatewayReloadPlan(plan)).toBe(true);
    expect(plan.restartChannels.size).toBe(0);
  });

  it("keeps startup ownership for botToken even alongside live policy", () => {
    const plan = planTelegramChange(
      telegram({ dmPolicy: "disabled" }, "support"),
      telegram({ dmPolicy: "pairing", botToken: "123456:synthetic-token" }, "support"),
    );
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["telegram"]));
  });

  it.each([
    { add: true, decisionAgent: false },
    { add: false, decisionAgent: false },
    { add: true, decisionAgent: true },
    { add: false, decisionAgent: true },
  ])(
    "refreshes account creation/removal (add: $add, decision agent: $decisionAgent)",
    ({ add, decisionAgent }) => {
      const empty = { ...telegram({ accounts: {} }), ...(decisionAgent ? roster({}) : {}) };
      const configured = {
        ...telegram({ dmPolicy: "disabled" }, "support"),
        ...(decisionAgent ? roster({ worker: decisionWorker }) : {}),
      };
      const plan = planTelegramChange(add ? empty : configured, add ? configured : empty);
      expect(plan.restartChannels).toEqual(new Set(["telegram"]));
      expect(plan.reloadPlugins).toBe(decisionAgent);
    },
  );
});
