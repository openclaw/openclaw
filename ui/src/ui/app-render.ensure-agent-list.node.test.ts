import { describe, expect, it } from "vitest";
import type { ConfigState } from "./controllers/config.ts";
import { ensureAgentListEntry } from "./app-render.ts";

function createConfigState(form: Record<string, unknown> | null): ConfigState {
  return {
    applySessionKey: "main",
    client: null,
    configActiveSection: null,
    configActiveSubsection: null,
    configApplying: false,
    configForm: form,
    configFormDirty: false,
    configFormMode: "form",
    configFormOriginal: null,
    configIssues: [],
    configLoading: false,
    configRaw: "",
    configRawOriginal: "",
    configSaving: false,
    configSchema: null,
    configSchemaLoading: false,
    configSchemaVersion: null,
    configSearchQuery: "",
    configSnapshot: null,
    configUiHints: {},
    configValid: null,
    connected: false,
    lastError: null,
    updateRunning: false,
  };
}

describe("ensureAgentListEntry", () => {
  it("returns -1 when configValue is null", () => {
    const state = createConfigState(null);
    const index = ensureAgentListEntry(state, null, "main");
    expect(index).toBe(-1);
  });

  it("creates agents.list when missing and returns index 0", () => {
    const config: Record<string, unknown> = { gateway: { mode: "local" } };
    const state = createConfigState(config);
    const index = ensureAgentListEntry(state, config, "main");
    expect(index).toBe(0);
    expect(state.configFormDirty).toBe(true);
    const form = state.configForm as { agents?: { list?: Array<{ id: string }> } };
    expect(form?.agents?.list?.[0]?.id).toBe("main");
  });

  it("appends agent when agents.list exists but agent is missing", () => {
    const config: Record<string, unknown> = {
      agents: { list: [{ id: "other-agent" }] },
    };
    const state = createConfigState(config);
    const index = ensureAgentListEntry(state, config, "main");
    expect(index).toBe(1);
    expect(state.configFormDirty).toBe(true);
    const form = state.configForm as { agents?: { list?: Array<{ id: string }> } };
    expect(form?.agents?.list?.[1]?.id).toBe("main");
  });

  it("returns existing index when agent is already in the list", () => {
    const config: Record<string, unknown> = {
      agents: { list: [{ id: "main", model: "gpt-4o" }] },
    };
    const state = createConfigState(config);
    const index = ensureAgentListEntry(state, config, "main");
    expect(index).toBe(0);
    // Should not have mutated the form since agent already exists.
    expect(state.configFormDirty).toBe(false);
  });

  it("creates agents.list when agents exists but list is not an array", () => {
    const config: Record<string, unknown> = {
      agents: { defaults: { model: "gpt-4o" } },
    };
    const state = createConfigState(config);
    const index = ensureAgentListEntry(state, config, "main");
    expect(index).toBe(0);
    expect(state.configFormDirty).toBe(true);
  });
});
