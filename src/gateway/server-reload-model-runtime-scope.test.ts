import { describe, expect, it } from "vitest";
import { doesReloadAffectProviderAuth } from "./config-reload-recovery.js";
import { createHotTailPlan } from "./server-reload-handlers.config.test-support.js";
import { resolveReloadAgentIds } from "./server-reload-model-runtime-scope.js";

describe("prepared model runtime reload scope", () => {
  it("collects normalized agent ids from agent-entry-local paths", () => {
    expect(
      resolveReloadAgentIds(["agents.entries.Alpha.model", "agents.entries.beta.name"]),
    ).toEqual(new Set(["alpha", "beta"]));
  });

  it("ignores machine-managed metadata beside an agent-local path", () => {
    expect(resolveReloadAgentIds(["agents.entries.alpha.model", "meta.lastTouchedAt"])).toEqual(
      new Set(["alpha"]),
    );
  });

  it.each([
    [[]],
    [["agents.entries"]],
    [["agents.entries.alpha.model", "models.providers.openai.api"]],
  ])("falls back to full refresh for an unbounded path set: %j", (paths) => {
    expect(resolveReloadAgentIds(paths)).toBeUndefined();
  });
});

describe("prepared provider auth reload invalidation", () => {
  it.each([
    "auth",
    "env.vars.OPENAI_API_KEY",
    "models.providers.openai.api",
    "plugins.entries.openai.enabled",
    "secrets.providers.default.path",
    "agents",
    "agents.list",
    "agents.defaults",
    "agents.defaults.model",
    "agents.defaults.heartbeat",
    "agents.defaults.heartbeat.model",
    "agents.defaults.compaction",
    "agents.defaults.compaction.model",
    "agents.defaults.compaction.provider",
    "agents.defaults.compaction.memoryFlush",
    "agents.defaults.compaction.memoryFlush.model",
    "agents.defaults.subagents",
    "agents.defaults.subagents.model.primary",
    "agents.entries",
    "agents.entries.main.model",
    "agents.entries.main.heartbeat.model",
  ])("invalidates prepared auth for config path %s", (changedPath) => {
    expect(
      doesReloadAffectProviderAuth(createHotTailPlan({ changedPaths: [changedPath] }), {}, {}),
    ).toBe(true);
  });

  it.each([
    "agents.defaults.heartbeat.target",
    "agents.entries.main.heartbeat.every",
    "agents.defaults.compaction.enabled",
    "agents.defaults.compaction.memoryFlush.enabled",
    "agents.entries.main.tools",
    "agents.defaults.subagents.thinking",
    "logging.level",
  ])("can retain prepared auth for unrelated config path %s", (changedPath) => {
    expect(
      doesReloadAffectProviderAuth(createHotTailPlan({ changedPaths: [changedPath] }), {}, {}),
    ).toBe(false);
  });

  it("invalidates prepared auth when plugins reload without a config path", () => {
    expect(
      doesReloadAffectProviderAuth(
        createHotTailPlan({ changedPaths: [], reloadPlugins: true }),
        {},
        {},
      ),
    ).toBe(true);
  });

  it("retains auth-relevant changes mixed with unrelated config paths", () => {
    expect(
      doesReloadAffectProviderAuth(
        createHotTailPlan({
          changedPaths: ["logging.level", "agents.defaults.workspace"],
        }),
        {},
        {},
      ),
    ).toBe(true);
  });
});
