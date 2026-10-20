import { expect, it } from "vitest";
import { pruneAgentConfig } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diffConfigPaths } from "./config-diff.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { doesReloadAffectProviderAuth } from "./config-reload-recovery.js";
import { createHotTailPlan } from "./server-reload-handlers.config.test-support.js";
import { createGatewayModelRuntimeReload } from "./server-reload-model-runtime-scope.js";

const agentConfig = (model?: string): OpenClawConfig => ({
  agents: { entries: { main: {}, other: model ? { model } : {} } },
});

it.each<[paths: string[], agentIds: string[] | undefined]>([
  [["agents.entries.Alpha.model", "agents.entries.beta.name"], ["alpha"]],
  [["agents.entries.alpha.model", "meta.lastTouchedAt"], ["alpha"]],
  [[], []],
  [["logging.level"], []],
  [["agents.entries"], undefined],
  [["agents.entries.alpha.model", "models.providers.openai.api"], undefined],
])("resolves the bounded agent scope for %j", (paths, agentIds) => {
  const plan = createHotTailPlan({ changedPaths: paths });
  const { agentIds: result } = createGatewayModelRuntimeReload().prepare(plan, {}, {});
  expect(result).toEqual(agentIds ? new Set(agentIds) : undefined);
});

it.each<[string, Pick<OpenClawConfig, "bindings" | "hooks">]>([
  ["binding", { bindings: [{ agentId: "other", match: { channel: "slack" } }] }],
  ["hook", { hooks: { allowedAgentIds: ["main", "other"] } }],
])("keeps deletion of another agent scoped while pruning its %s", (_name, references) => {
  const previous: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: {
        main: { subagents: { allowAgents: ["other"] } },
        codex: {},
        other: {},
      },
    },
    ...references,
  };
  const next = pruneAgentConfig(previous, "other").config;
  const plan = buildGatewayReloadPlan(diffConfigPaths(previous, next));
  const prepared = createGatewayModelRuntimeReload().prepare(plan, previous, next);

  expect(prepared).toMatchObject({ required: true, agentIds: new Set(["other"]) });
});

it("keeps pending recovery scoped when a successor reverts the agent edit", () => {
  const initial = agentConfig();
  const changed = agentConfig("openai/gpt-5.5");
  const reload = createGatewayModelRuntimeReload();
  const plan = createHotTailPlan({ changedPaths: ["agents.entries.other.model"] });
  reload.prepare(plan, initial, changed).defer();
  const successor = reload.prepare(createHotTailPlan({ changedPaths: [] }), changed, initial);

  expect(successor).toMatchObject({ required: true, agentIds: new Set() });
});

it.each(["plugin replacement", "channel activation"] as const)(
  "retains a full scope for %s alongside an agent edit",
  (change) => {
    const previous = agentConfig();
    const next: OpenClawConfig = {
      ...agentConfig("openai/gpt-5.5"),
      ...(change === "channel activation" ? { channels: { slack: { enabled: true } } } : {}),
    };
    const plan = createHotTailPlan({
      changedPaths: ["agents.entries.other.model"],
      reloadPlugins: change === "plugin replacement",
    });
    const prepared = createGatewayModelRuntimeReload().prepare(plan, previous, next);

    expect(prepared).toMatchObject({ required: true, agentIds: undefined });
  },
);
it.each<[changedPaths: string[], invalidates: boolean, reloadPlugins?: boolean]>([
  [["auth"], true],
  [["env.vars.OPENAI_API_KEY"], true],
  [["models.providers.openai.api"], true],
  [["plugins.entries.openai.enabled"], true],
  [["secrets.providers.default.path"], true],
  [["agents"], true],
  [["agents.list"], true],
  [["agents.defaults"], true],
  [["agents.defaults.model"], true],
  [["agents.defaults.heartbeat"], true],
  [["agents.defaults.heartbeat.model"], true],
  [["agents.defaults.compaction"], true],
  [["agents.defaults.compaction.model"], true],
  [["agents.defaults.compaction.provider"], true],
  [["agents.defaults.compaction.memoryFlush"], true],
  [["agents.defaults.compaction.memoryFlush.model"], true],
  [["agents.defaults.subagents"], true],
  [["agents.defaults.subagents.model.primary"], true],
  [["agents.entries"], true],
  [["agents.entries.main.model"], true],
  [["agents.entries.main.heartbeat.model"], true],
  [["agents.defaults.heartbeat.target"], false],
  [["agents.entries.main.heartbeat.every"], false],
  [["agents.defaults.compaction.enabled"], false],
  [["agents.defaults.compaction.memoryFlush.enabled"], false],
  [["agents.entries.main.tools"], false],
  [["agents.defaults.subagents.thinking"], false],
  [["logging.level"], false],
  [[], true, true],
  [["logging.level", "agents.defaults.workspace"], true],
])(
  "classifies provider-auth invalidation for %j",
  (changedPaths, invalidates, reloadPlugins = false) => {
    expect(
      doesReloadAffectProviderAuth(createHotTailPlan({ changedPaths, reloadPlugins }), {}, {}),
    ).toBe(invalidates);
  },
);
