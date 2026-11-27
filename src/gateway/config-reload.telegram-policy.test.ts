import { afterEach, beforeEach, expect, it } from "vitest";
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
const utility = (size: string) => roster({ worker: { utilityModel: `fixture/${size}` } });
const telegram = (
  policy: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>,
  accountId?: string,
): OpenClawConfig => ({
  channels: { telegram: accountId ? { accounts: { [accountId]: policy } } : policy },
});
const planChange = (previous: OpenClawConfig, next: OpenClawConfig) =>
  buildGatewayReloadPlan(
    diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes()),
  );

it.each([
  ["adds the decision agent roster", {}, roster({ worker: decisionWorker }), true],
  ["removes the decision agent roster", roster({ worker: decisionWorker }), {}, true],
  ["changes a utility model", utility("small"), utility("large"), false],
  ["adds an agent without a decision override", roster({}), roster({ worker: {} }), false],
] satisfies [string, OpenClawConfig, OpenClawConfig, boolean][])(
  "preserves roster actions and scopes provider reloads when it %s",
  (_name, previous, next, reloadPlugins) => {
    expect(planChange(previous, next)).toMatchObject({
      restartGateway: false,
      reloadPlugins,
      refreshHooksPolicy: true,
      reloadInternalHooks: true,
    });
  },
);

it("hot-applies the default decision model", () => {
  expect(buildGatewayReloadPlan(["agents.defaults.decisionModel"])).toMatchObject({
    restartGateway: false,
    reloadPlugins: true,
  });
});

it("restarts Slack when plugin approvers are edited", async () => {
  const { slackSetupPlugin } = await loadBundledPluginFacade<{
    slackSetupPlugin: ChannelPlugin;
  }>({ pluginId: "slack", artifactBasename: "setup-plugin-api.ts" });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", plugin: slackSetupPlugin, source: "test" }]),
  );
  const configWithApprover = (user: number): OpenClawConfig => ({
    approvals: { plugin: { slack: { approvers: [`team:T123:user:U${user}`] } } },
  });
  expect(planChange(configWithApprover(111), configWithApprover(222))).toMatchObject({
    restartGateway: false,
    restartChannels: new Set(["slack"]),
    restartChannelAccounts: new Map(),
    reloadPlugins: false,
  });
});

const { telegramSetupPlugin } = await loadBundledPluginFacade<{
  telegramSetupPlugin: ChannelPlugin;
}>({ artifactBasename: "setup-plugin-api", pluginId: "telegram" });

function planTelegramChange(prev: OpenClawConfig, next: OpenClawConfig) {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramSetupPlugin, source: "bundled" }]),
  );
  return planChange(prev, next);
}

it.each([undefined, "support"])("retains the monitor for policy changes in %s", (accountId) => {
  const config = (next: boolean) =>
    telegram(
      {
        dmPolicy: next ? "disabled" : "allowlist",
        allowFrom: [next ? "43" : "42"],
        groupPolicy: next ? "disabled" : "allowlist",
        groupAllowFrom: [next ? "43" : "42"],
        replyToMode: next ? "first" : "off",
        streaming: next ? { mode: "partial", preview: { toolProgress: false } } : { mode: "off" },
        textChunkLimit: next ? 1000 : 4000,
      },
      accountId,
    );
  const plan = planTelegramChange(config(false), config(true));
  expect(isNoopGatewayReloadPlan(plan)).toBe(true);
});

it("keeps startup ownership for botToken even alongside live policy", () => {
  const plan = planTelegramChange(
    telegram({ dmPolicy: "disabled" }, "support"),
    telegram({ dmPolicy: "pairing", botToken: "123456:synthetic-token" }, "support"),
  );
  expect(plan).toMatchObject({ restartGateway: false, restartChannels: new Set(["telegram"]) });
});

it.each([
  { add: true, decisionAgent: false },
  { add: false, decisionAgent: true },
])("reloads accounts (add=$add, decisionAgent=$decisionAgent)", ({ add, decisionAgent }) => {
  const empty = { ...telegram({ accounts: {} }), ...(decisionAgent ? roster({}) : {}) };
  const configured = {
    ...telegram({ dmPolicy: "disabled" }, "support"),
    ...(decisionAgent ? roster({ worker: decisionWorker }) : {}),
  };
  const plan = planTelegramChange(add ? empty : configured, add ? configured : empty);
  expect(plan.restartChannels).toEqual(new Set(["telegram"]));
  expect(plan.reloadPlugins).toBe(decisionAgent);
});
