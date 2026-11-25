// @vitest-environment node
// Control UI tests cover canonical per-agent model config writes.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createConfigCapabilityHarness } from "../../lib/config/config-test-harness.ts";
import { createAgentConfigActions } from "./agent-config-actions.ts";

type Entries = Record<string, Record<string, unknown>>;
async function loadAgentConfig(agents: { defaults?: Record<string, unknown>; entries?: Entries }) {
  const sourceConfig = { agents: structuredClone(agents) };
  const shared = agents.defaults ? { defaults: agents.defaults } : {};
  const { runtimeConfig, state } = createConfigCapabilityHarness(async (method) =>
    method === "config.get"
      ? { sourceConfig, hash: "hash-1", valid: true, issues: [] }
      : { hash: "hash-2" },
  );
  onTestFinished(() => runtimeConfig.dispose());
  await runtimeConfig.ensureLoaded();
  const actions = createAgentConfigActions({
    getRuntimeConfig: () => runtimeConfig,
    getReport: () => null,
    canUpdate: () => true,
    onPrimaryChanged: () => undefined,
  }).models;
  const expectEntries = (entries?: Entries) =>
    expect(state.configForm).toEqual({ agents: entries ? { ...shared, entries } : shared });
  return { runtimeConfig, state, actions, expectEntries };
}

describe("agent model config", () => {
  it("rechecks the current agent and permissions before editing the current config", async () => {
    const original = await loadAgentConfig({ entries: { main: {} } });
    const replacement = await loadAgentConfig({ entries: { scout: {} } });
    let current = original;
    let selected = "main";
    let allowed = true;
    const onPrimaryChanged = vi.fn();
    const actions = createAgentConfigActions({
      getRuntimeConfig: () => current.runtimeConfig,
      getReport: () => null,
      canUpdate: (agentId) => allowed && agentId === selected,
      onPrimaryChanged,
    }).models;
    const changeModels = (id: string, decision: string) => {
      actions.onModelChange(id, "fixture/chat");
      actions.onDecisionModelChange(id, decision);
      actions.onModelFallbacksChange(id, ["fixture/fallback"]);
    };
    current = replacement;
    selected = "scout";
    changeModels("main", "typesafe/jev-latest");
    allowed = false;
    changeModels("scout", "typesafe/jev-latest");
    expect(original.state.configFormDirty).toBe(false);
    expect(replacement.state.configFormDirty).toBe(false);
    expect(onPrimaryChanged).not.toHaveBeenCalled();
    allowed = true;
    changeModels("scout", "");
    replacement.expectEntries({
      scout: {
        model: { primary: "fixture/chat", fallbacks: ["fixture/fallback"] },
        decisionModel: "",
      },
    });
    expect(original.state.configFormDirty).toBe(false);
    expect(onPrimaryChanged).toHaveBeenCalledOnce();
  });

  it("keeps the agent's own utility fallbacks for every utility choice", async () => {
    const defaults = { utilityModel: "openai/gpt-5-mini" };
    const fallbacks = ["local/backup"];
    const { actions, expectEntries } = await loadAgentConfig({
      defaults,
      entries: { main: { utilityModel: { primary: "anthropic/claude-sonnet-4-6", fallbacks } } },
    });
    for (const primary of ["openai/gpt-5.4", "", null]) {
      actions.onUtilityModelChange("main", primary);
      expectEntries({
        main: { utilityModel: primary === null ? { fallbacks } : { primary, fallbacks } },
      });
    }
  });

  it("writes a bare utility model and clears it back to inheritance without fallbacks", async () => {
    const { actions, expectEntries } = await loadAgentConfig({ entries: { main: {} } });
    actions.onUtilityModelChange("main", "openai/gpt-5.4");
    expectEntries({ main: { utilityModel: "openai/gpt-5.4" } });
    actions.onUtilityModelChange("main", null);
    expectEntries({ main: {} });
  });

  it("sets the agent's subagent model and clears it without leaving an empty block", async () => {
    const primary = "openai/gpt-5.4";
    const fallbacks = ["fixture/first", "fixture/second"];
    const allowAgents = ["main"];
    const entries = { main: {}, scout: { subagents: { allowAgents, model: { fallbacks } } } };
    const { actions, expectEntries } = await loadAgentConfig({ entries });
    actions.onSubagentModelChange("main", primary);
    actions.onSubagentModelChange("scout", primary);
    expectEntries({
      main: { subagents: { model: primary } },
      scout: { subagents: { allowAgents, model: { primary, fallbacks } } },
    });
    actions.onSubagentModelChange("main", null);
    actions.onSubagentModelChange("scout", null);
    expectEntries(entries);
  });

  it("distinguishes an explicit decision disable from inheritance without changing other settings", async () => {
    const defaults = { decisionModel: "typesafe/jev-latest", model: "openai/gpt-5.4" };
    const { actions, state, expectEntries } = await loadAgentConfig({ defaults });
    actions.onDecisionModelChange("main", null);
    expect(state.configFormDirty).toBe(false);
    for (const decisionModel of ["", "typesafe/jev-preview"]) {
      actions.onDecisionModelChange("main", decisionModel);
      expectEntries({ main: { decisionModel } });
    }
    actions.onDecisionModelChange("main", null);
    expectEntries({ main: {} });
  });

  it("keeps false distinct from inherited speed and preserves neighboring model settings", async () => {
    const defaults = { fastModeDefault: "auto", utilityModel: { fallbacks: ["global/backup"] } };
    const entry = {
      utilityModel: "",
      subagents: { allowAgents: ["worker"] },
      model: { fallbacks: ["chat/a", "chat/b"] },
    };
    const { actions, expectEntries } = await loadAgentConfig({
      defaults,
      entries: { coder: entry },
    });
    const fallbacks = ["local/b", "local/a"];
    actions.onFastModeDefaultChange("coder", false);
    actions.onUtilityFallbacksChange("coder", [...fallbacks]);
    expectEntries({
      coder: { ...entry, fastModeDefault: false, utilityModel: { primary: "", fallbacks } },
    });
    actions.onUtilityFallbacksChange("coder", null);
    actions.onFastModeDefaultChange("coder", null);
    expectEntries({ coder: entry });
    actions.onModelFallbacksChange("coder", null);
    expectEntries({ coder: { subagents: entry.subagents, utilityModel: "" } });
  });

  it("sets and clears the agent's thinking default without touching the global one", async () => {
    const defaults = { thinkingDefault: "low" };
    const { actions, expectEntries } = await loadAgentConfig({ defaults, entries: { coder: {} } });
    actions.onThinkingDefaultChange("coder", "high");
    expectEntries({ coder: { thinkingDefault: "high" } });
    actions.onThinkingDefaultChange("coder", null);
    expectEntries({ coder: {} });
  });

  it("writes primary and fallback changes through keyed agent entries", async () => {
    const defaults = { model: { primary: "openai/gpt-5.4" } };
    const { actions, state, expectEntries } = await loadAgentConfig({
      defaults,
      entries: { main: {} },
    });
    const primary = "anthropic/claude-sonnet-4-6";
    const fallbacks = ["openai/gpt-5.4"];
    actions.onModelChange("main", primary);
    actions.onModelFallbacksChange("main", [...fallbacks]);
    expectEntries({ main: { model: { primary, fallbacks } } });
    expect(state.configForm?.agents).not.toHaveProperty("list");
  });

  it("preserves inherited primary and shared defaults when editing fallbacks", async () => {
    const defaults = { model: { primary: "openai/gpt-5.4", fallbacks: ["google/gemini-3-pro"] } };
    const { actions, expectEntries } = await loadAgentConfig({ defaults, entries: { main: {} } });
    const fallbacks = ["google/gemini-3-pro", "anthropic/claude-sonnet-4-6"];
    actions.onModelFallbacksChange("main", [...fallbacks]);
    expectEntries({ main: { model: { fallbacks } } });
  });

  it.each([
    {
      name: "an inherited primary",
      defaultModel: { primary: "openai/gpt-5.4", fallbacks: ["google/gemini-3-pro"] },
      model: { fallbacks: ["anthropic/claude-sonnet-4-6"] },
      expectedModel: { fallbacks: [] },
    },
    {
      name: "an authored primary",
      defaultModel: { primary: "google/gemini-3-pro" },
      model: { primary: "openai/gpt-5.4", fallbacks: ["anthropic/claude-sonnet-4-6"] },
      expectedModel: { primary: "openai/gpt-5.4", fallbacks: [] },
    },
  ])(
    "keeps an explicitly cleared fallback chain with $name",
    async ({ defaultModel, model, expectedModel }) => {
      const other = { model: "google/gemini-3-pro" };
      const { actions, expectEntries } = await loadAgentConfig({
        defaults: { model: defaultModel },
        entries: { main: { name: "Main", model }, other },
      });
      actions.onModelFallbacksChange("main", []);
      expectEntries({ main: { name: "Main", model: expectedModel }, other });
    },
  );

  it("creates an empty override for an implicit agent only after an explicit clear", async () => {
    const defaults = { model: { fallbacks: ["google/gemini-3-pro"] } };
    const { actions, state, expectEntries } = await loadAgentConfig({ defaults });
    expectEntries();
    expect(state.configFormDirty).toBe(false);
    actions.onModelFallbacksChange("main", []);
    expectEntries({ main: { model: { fallbacks: [] } } });
  });

  it.each([{ fallbacks: ["openai/gpt-5.4"] }, { fallbacks: [] }])(
    "keeps authored fallbacks $fallbacks when the primary model is cleared",
    async ({ fallbacks }) => {
      const defaults = { model: { primary: "openai/gpt-5.4" } };
      const model = { primary: "anthropic/claude-sonnet-4-6", fallbacks };
      const { actions, expectEntries } = await loadAgentConfig({
        defaults,
        entries: { main: { model } },
      });
      actions.onModelChange("main", null);
      expectEntries({ main: { model: { fallbacks } } });
    },
  );

  it("still removes the model node when clearing a primary with no fallbacks", async () => {
    const { actions, expectEntries } = await loadAgentConfig({
      entries: { main: { model: "anthropic/claude-sonnet-4-6" } },
    });
    actions.onModelChange("main", null);
    expectEntries({ main: {} });
  });
});
