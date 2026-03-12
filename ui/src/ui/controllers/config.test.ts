import { describe, expect, it, vi } from "vitest";
import {
  applyConfigSnapshot,
  applyConfig,
  ensureAgentConfigEntry,
  findAgentConfigEntryIndex,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
  type ConfigState,
} from "./config.ts";

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

function createRequestWithConfigGet() {
  return vi.fn().mockImplementation(async (method: string) => {
    if (method === "config.get") {
      return { config: {}, valid: true, issues: [], raw: "{\n}\n" };
    }
    return {};
  });
}

describe("applyConfigSnapshot", () => {
  it("does not clobber form edits while dirty", () => {
    const state = createState();
    state.configFormMode = "form";
    state.configFormDirty = true;
    state.configForm = { gateway: { mode: "local", port: 18789 } };
    state.configRaw = "{\n}\n";

    applyConfigSnapshot(state, {
      config: { gateway: { mode: "remote", port: 9999 } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "remote", "port": 9999 }\n}\n',
    });

    expect(state.configRaw).toBe(
      '{\n  "gateway": {\n    "mode": "local",\n    "port": 18789\n  }\n}\n',
    );
  });

  it("updates config form when clean", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: "{}",
    });

    expect(state.configForm).toEqual({ gateway: { mode: "local" } });
  });

  it("sets configRawOriginal when clean for change detection", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{ "gateway": { "mode": "local" } }',
    });

    expect(state.configRawOriginal).toBe('{ "gateway": { "mode": "local" } }');
    expect(state.configFormOriginal).toEqual({ gateway: { mode: "local" } });
  });

  it("preserves configRawOriginal when dirty", () => {
    const state = createState();
    state.configFormDirty = true;
    state.configRawOriginal = '{ "original": true }';
    state.configFormOriginal = { original: true };

    applyConfigSnapshot(state, {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{ "gateway": { "mode": "local" } }',
    });

    // Original values should be preserved when dirty
    expect(state.configRawOriginal).toBe('{ "original": true }');
    expect(state.configFormOriginal).toEqual({ original: true });
  });

  it("replaces pending form state when explicitly discarding edits", () => {
    const state = createState();
    state.configFormDirty = true;
    state.configForm = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
    state.configRaw = '{ "agents": { "defaults": { "model": "anthropic/claude-opus-4-6" } } }';
    state.configRawOriginal = '{ "original": true }';
    state.configFormOriginal = { original: true };

    applyConfigSnapshot(
      state,
      {
        config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
        valid: true,
        issues: [],
        raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
      },
      { discardPendingEdits: true },
    );

    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({
      agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } },
    });
    expect(state.configRaw).toBe(
      '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    );
    expect(state.configRawOriginal).toBe(
      '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    );
    expect(state.configFormOriginal).toEqual({
      agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } },
    });
  });
});

describe("updateConfigFormValue", () => {
  it("seeds from snapshot when form is null", () => {
    const state = createState();
    state.configSnapshot = {
      config: { channels: { telegram: { botToken: "t" } }, gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: "{}",
    };

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      channels: { telegram: { botToken: "t" } },
      gateway: { mode: "local", port: 18789 },
    });
  });

  it("keeps raw in sync while editing the form", () => {
    const state = createState();
    state.configSnapshot = {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configRaw).toBe(
      '{\n  "gateway": {\n    "mode": "local",\n    "port": 18789\n  }\n}\n',
    );
  });
});

describe("agent config helpers", () => {
  it("finds explicit agent entries", () => {
    expect(
      findAgentConfigEntryIndex(
        {
          agents: {
            list: [{ id: "main" }, { id: "assistant" }],
          },
        },
        "assistant",
      ),
    ).toBe(1);
  });

  it("creates an agent override entry when editing an inherited agent", () => {
    const state = createState();
    state.configSnapshot = {
      config: {
        agents: {
          defaults: { model: "openai/gpt-5" },
        },
        tools: { profile: "messaging" },
      },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    const index = ensureAgentConfigEntry(state, "main");

    expect(index).toBe(0);
    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      agents: {
        defaults: { model: "openai/gpt-5" },
        list: [{ id: "main" }],
      },
      tools: { profile: "messaging" },
    });
  });

  it("reuses the existing agent entry instead of duplicating it", () => {
    const state = createState();
    state.configSnapshot = {
      config: {
        agents: {
          list: [{ id: "main", model: "openai/gpt-5" }],
        },
      },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    const index = ensureAgentConfigEntry(state, "main");

    expect(index).toBe(0);
    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toBeNull();
  });

  it("reuses an agent entry that already exists in the pending form state", () => {
    const state = createState();
    state.configSnapshot = {
      config: {},
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    updateConfigFormValue(state, ["agents", "list", 0, "id"], "main");

    const index = ensureAgentConfigEntry(state, "main");

    expect(index).toBe(0);
    expect(state.configForm).toEqual({
      agents: {
        list: [{ id: "main" }],
      },
    });
  });
});

describe("applyConfig", () => {
  it("sends config.apply with raw and session key", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:whatsapp:dm:+15555550123";
    state.configFormMode = "raw";
    state.configRaw = '{\n  agent: { workspace: "~/openclaw" }\n}\n';
    state.configSnapshot = {
      hash: "hash-123",
    };

    await applyConfig(state);

    expect(request).toHaveBeenCalledWith("config.apply", {
      raw: '{\n  agent: { workspace: "~/openclaw" }\n}\n',
      baseHash: "hash-123",
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });

  it("coerces schema-typed values before config.apply in form mode", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:web:dm:test";
    state.configFormMode = "form";
    state.configForm = {
      gateway: { port: "18789", debug: "true" },
    };
    state.configSchema = {
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: {
            port: { type: "number" },
            debug: { type: "boolean" },
          },
        },
      },
    };
    state.configSnapshot = { hash: "hash-apply-1" };

    await applyConfig(state);

    expect(request.mock.calls[0]?.[0]).toBe("config.apply");
    const params = request.mock.calls[0]?.[1] as {
      raw: string;
      baseHash: string;
      sessionKey: string;
    };
    const parsed = JSON.parse(params.raw) as {
      gateway: { port: unknown; debug: unknown };
    };
    expect(typeof parsed.gateway.port).toBe("number");
    expect(parsed.gateway.port).toBe(18789);
    expect(parsed.gateway.debug).toBe(true);
    expect(params.baseHash).toBe("hash-apply-1");
    expect(params.sessionKey).toBe("agent:main:web:dm:test");
  });

  it("refreshes the snapshot after apply hash conflicts without discarding edits", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "config.apply") {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      if (method === "config.get") {
        return {
          hash: "hash-apply-2",
          config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
          valid: true,
          issues: [],
          raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
        };
      }
      return {};
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:web:dm:test";
    state.configFormMode = "form";
    state.configFormDirty = true;
    state.configForm = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
    state.configRaw = '{ "agents": { "defaults": { "model": "anthropic/claude-opus-4-6" } } }';
    state.configSnapshot = { hash: "hash-apply-1" };

    await applyConfig(state);

    expect(request.mock.calls.map((call) => call[0])).toEqual(["config.apply", "config.get"]);
    expect(state.configSnapshot?.hash).toBe("hash-apply-2");
    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
    });
    expect(state.lastError).toContain("config changed since last load");
  });
});

describe("saveConfig", () => {
  it("coerces schema-typed values before config.set in form mode", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    state.configForm = {
      gateway: { port: "18789", enabled: "false" },
    };
    state.configSchema = {
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: {
            port: { type: "number" },
            enabled: { type: "boolean" },
          },
        },
      },
    };
    state.configSnapshot = { hash: "hash-save-1" };

    await saveConfig(state);

    expect(request.mock.calls[0]?.[0]).toBe("config.set");
    const params = request.mock.calls[0]?.[1] as { raw: string; baseHash: string };
    const parsed = JSON.parse(params.raw) as {
      gateway: { port: unknown; enabled: unknown };
    };
    expect(typeof parsed.gateway.port).toBe("number");
    expect(parsed.gateway.port).toBe(18789);
    expect(parsed.gateway.enabled).toBe(false);
    expect(params.baseHash).toBe("hash-save-1");
  });

  it("skips coercion when schema is not an object", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    state.configForm = {
      gateway: { port: "18789" },
    };
    state.configSchema = "invalid-schema";
    state.configSnapshot = { hash: "hash-save-2" };

    await saveConfig(state);

    expect(request.mock.calls[0]?.[0]).toBe("config.set");
    const params = request.mock.calls[0]?.[1] as { raw: string; baseHash: string };
    const parsed = JSON.parse(params.raw) as {
      gateway: { port: unknown };
    };
    expect(parsed.gateway.port).toBe("18789");
    expect(params.baseHash).toBe("hash-save-2");
  });

  it("refreshes the snapshot after save hash conflicts without discarding edits", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "config.set") {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      if (method === "config.get") {
        return {
          hash: "hash-save-2",
          config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
          valid: true,
          issues: [],
          raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
        };
      }
      return {};
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    state.configFormDirty = true;
    state.configForm = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
    state.configRaw = '{ "agents": { "defaults": { "model": "anthropic/claude-opus-4-6" } } }';
    state.configSnapshot = { hash: "hash-save-1" };

    await saveConfig(state);

    expect(request.mock.calls.map((call) => call[0])).toEqual(["config.set", "config.get"]);
    expect(state.configSnapshot?.hash).toBe("hash-save-2");
    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
    });
    expect(state.lastError).toContain("config changed since last load");
  });
});

describe("loadConfig", () => {
  it("keeps dirty form edits during passive refreshes", async () => {
    const request = vi.fn().mockResolvedValue({
      config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
      valid: true,
      issues: [],
      raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormDirty = true;
    state.configForm = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };

    await loadConfig(state);

    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
    });
  });

  it("discards dirty form edits for explicit reloads", async () => {
    const request = vi.fn().mockResolvedValue({
      config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
      valid: true,
      issues: [],
      raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormDirty = true;
    state.configForm = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
    state.configRaw = '{ "agents": { "defaults": { "model": "anthropic/claude-opus-4-6" } } }';

    await loadConfig(state, { discardPendingEdits: true });

    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({
      agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } },
    });
    expect(state.configRaw).toBe(
      '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    );
  });

  it("keeps dirty raw edits during passive refreshes", async () => {
    const request = vi.fn().mockResolvedValue({
      config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
      valid: true,
      issues: [],
      raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "raw";
    state.configRawOriginal =
      '{ "agents": { "defaults": { "model": "anthropic/claude-opus-4-6" } } }';
    state.configRaw = '{ "agents": { "defaults": { "model": "custom/raw-edit" } } }';

    await loadConfig(state);

    expect(state.configRaw).toBe('{ "agents": { "defaults": { "model": "custom/raw-edit" } } }');
  });

  it("updates raw mode from the snapshot when only form state is still dirty", async () => {
    const request = vi.fn().mockResolvedValue({
      config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
      valid: true,
      issues: [],
      raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "raw";
    state.configFormDirty = true;
    state.configForm = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
    state.configRawOriginal =
      '{ "agents": { "defaults": { "model": "anthropic/claude-opus-4-6" } } }';
    state.configRaw = state.configRawOriginal;

    await loadConfig(state);

    expect(state.configRaw).toBe(
      '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    );
    expect(state.configForm).toEqual({
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
    });
    expect(state.configFormDirty).toBe(true);
  });

  it("discards dirty raw edits for explicit reloads", async () => {
    const request = vi.fn().mockResolvedValue({
      config: { agents: { defaults: { model: "ollama/qwen3-coder:30b-64k" } } },
      valid: true,
      issues: [],
      raw: '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "raw";
    state.configRawOriginal =
      '{ "agents": { "defaults": { "model": "anthropic/claude-opus-4-6" } } }';
    state.configRaw = '{ "agents": { "defaults": { "model": "custom/raw-edit" } } }';

    await loadConfig(state, { discardPendingEdits: true });

    expect(state.configRaw).toBe(
      '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    );
    expect(state.configRawOriginal).toBe(
      '{ "agents": { "defaults": { "model": "ollama/qwen3-coder:30b-64k" } } }',
    );
  });
});

describe("runUpdate", () => {
  it("sends update.run with session key", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:whatsapp:dm:+15555550123";

    await runUpdate(state);

    expect(request).toHaveBeenCalledWith("update.run", {
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });
});
