import { describe, expect, it, vi } from "vitest";
import { loadConfig, type ConfigState } from "../ui/src/ui/controllers/config.ts";

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

describe("Control UI config reload", () => {
  it("clears dirty state so config form refreshes on reload", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { gateway: { mode: "remote" } },
          valid: true,
          issues: [],
          raw: '{\n  "gateway": { "mode": "remote" }\n}\n',
        };
      }
      return {};
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];

    state.configFormMode = "form";
    state.configFormDirty = true;
    state.configForm = { gateway: { mode: "local" } };
    state.configRaw = '{\n  "gateway": {\n    "mode": "local"\n  }\n}\n';

    await loadConfig(state);

    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({ gateway: { mode: "remote" } });
    expect(state.configRaw).toBe('{\n  "gateway": { "mode": "remote" }\n}\n');
  });
});
