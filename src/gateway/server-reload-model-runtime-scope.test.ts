import { describe, expect, it } from "vitest";
import { doesReloadAffectProviderAuth } from "./config-reload-recovery.js";
import { createHotTailPlan } from "./server-reload-handlers.config.test-support.js";
import { resolveReloadAgentIds } from "./server-reload-model-runtime-scope.js";

describe("prepared model runtime reload scope", () => {
  it.each<[paths: string[], agentIds: string[] | undefined]>([
    [
      ["agents.entries.Alpha.model", "agents.entries.beta.name"],
      ["alpha", "beta"],
    ],
    [["agents.entries.alpha.model", "meta.lastTouchedAt"], ["alpha"]],
    [[], undefined],
    [["agents.entries"], undefined],
    [["agents.entries.alpha.model", "models.providers.openai.api"], undefined],
  ])("resolves the bounded agent scope for %j", (paths, agentIds) => {
    const result = resolveReloadAgentIds(paths);
    if (agentIds) {
      expect(result).toEqual(new Set(agentIds));
    } else {
      expect(result).toBeUndefined();
    }
  });
});

describe("prepared provider auth reload invalidation", () => {
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
    [["agents.defaults.compaction"], true],
    [["agents.defaults.compaction.model"], true],
    [["agents.defaults.compaction.provider"], true],
    [["agents.defaults.compaction.memoryFlush"], true],
    [["agents.defaults.compaction.memoryFlush.model"], true],
    [["agents.defaults.subagents"], true],
    [["agents.defaults.subagents.model.primary"], true],
    [["agents.entries"], true],
    [["agents.entries.main.model"], true],
    [["agents.defaults.compaction.enabled"], false],
    [["agents.defaults.compaction.memoryFlush.enabled"], false],
    [["agents.entries.main.tools"], false],
    [["agents.defaults.subagents.thinking"], false],
    [["logging.level"], false],
    [[], true, true],
    [["logging.level", "agents.defaults.workspace"], true],
  ])("classifies auth invalidation for %j", (changedPaths, invalidates, reloadPlugins = false) => {
    expect(
      doesReloadAffectProviderAuth(createHotTailPlan({ changedPaths, reloadPlugins }), {}, {}),
    ).toBe(invalidates);
  });
});
