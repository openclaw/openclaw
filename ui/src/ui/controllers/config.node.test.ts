import { describe, expect, it } from "vitest";
import { ensureAgentConfigEntry, type ConfigState } from "./config.ts";

function createState(): ConfigState {
  return {
    applySessionKey: "main",
    client: null,
    configActiveSection: null,
    configActiveSubsection: null,
    configApplying: false,
    configForm: null,
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

describe("ensureAgentConfigEntry", () => {
  it("does not create a missing agent entry when creation is disabled", () => {
    const state = createState();
    state.configSnapshot = {
      config: { agents: { defaults: { workspace: "~/workspace" } } },
      valid: true,
      issues: [],
      raw: "{}",
    };

    const index = ensureAgentConfigEntry(state, "main", false);

    expect(index).toBe(-1);
    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toBeNull();
  });
});
