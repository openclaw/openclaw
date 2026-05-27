import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEMORY_AUDIT_SETTINGS,
  buildMemoryAuditConfigPatch,
  loadMemoryAuditSettings,
  loadMemoryAuditSuggestions,
  normalizeMemoryAuditSuggestions,
  readMemoryAuditSettings,
  runMemoryAuditAction,
  saveMemoryAuditSettings,
  validateMemoryAuditSettings,
  type MemoryAuditState,
} from "./memory-audit.ts";

function createState(): { state: MemoryAuditState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  return {
    request,
    state: {
      client: { request } as unknown as MemoryAuditState["client"],
      connected: true,
      hello: null,
      memoryAuditLoading: false,
      memoryAuditError: null,
      memoryAuditSuggestions: null,
      memoryAuditActionId: null,
      memoryAuditActionMessage: null,
      memoryAuditTab: "settings",
      memoryAuditSettingsLoading: false,
      memoryAuditSettingsSaving: false,
      memoryAuditSettingsError: null,
      memoryAuditSettingsMessage: null,
      memoryAuditSettingsDraft: { ...DEFAULT_MEMORY_AUDIT_SETTINGS },
      memoryAuditSettingsOriginal: { ...DEFAULT_MEMORY_AUDIT_SETTINGS },
      memoryAuditSettingsPluginId: "memory-core",
      configSnapshot: null,
      applySessionKey: "main",
      lastError: null,
    },
  };
}

function rawSuggestion() {
  return {
    id: "audit-1",
    status: "pending",
    action: "edit",
    text: "Prefer terse status updates.",
    rationale: "The existing durable memory is too broad.",
    confidence: 0.91,
    source: {
      surfaceId: "agent-memory:hex",
      kind: "agent-memory",
      path: "MEMORY.md",
      workspaceDir: "/workspace/hex",
      agentId: "hex",
      startLine: 2,
      endLine: 3,
      hash: "abc123",
    },
    target: {
      surfaceId: "agent-memory:hex",
      kind: "agent-memory",
      path: "MEMORY.md",
      workspaceDir: "/workspace/hex",
      agentId: "hex",
    },
    createdAt: "2026-05-01T06:10:00.000Z",
    updatedAt: "2026-05-01T06:10:00.000Z",
  };
}

describe("memory audit controller", () => {
  it("reads audit settings from the configured memory plugin slot", () => {
    const result = readMemoryAuditSettings({
      plugins: {
        slots: { memory: "memory-plus" },
        entries: {
          "memory-plus": {
            enabled: true,
            config: {
              memoryAudit: {
                enabled: true,
                agentId: "hex",
                sessionTarget: "session:audit",
                model: "gpt-5.5",
                timezone: "Asia/Tokyo",
                daily: { enabled: true, cron: "15 8 * * *" },
                weekly: { enabled: false, cron: "0 20 * * 1" },
                delivery: {
                  mode: "announce",
                  channel: "discord",
                  to: "hex",
                  threadId: "123",
                  accountId: "bot",
                },
              },
            },
          },
        },
      },
    });

    expect(result.pluginId).toBe("memory-plus");
    expect(result.draft).toMatchObject({
      enabled: true,
      agentId: "hex",
      sessionTarget: "session:audit",
      model: "gpt-5.5",
      timezone: "Asia/Tokyo",
      dailyCron: "15 8 * * *",
      weeklyEnabled: false,
      deliveryMode: "announce",
      deliveryChannel: "discord",
      deliveryTo: "hex",
      deliveryThreadId: "123",
      deliveryAccountId: "bot",
    });
  });

  it("builds a config patch under the memory audit plugin id", () => {
    const patch = buildMemoryAuditConfigPatch("memory-plus", {
      ...DEFAULT_MEMORY_AUDIT_SETTINGS,
      enabled: true,
      agentId: "hex",
      model: "gpt-5.5",
      deliveryMode: "webhook",
      deliveryTo: "https://example.test/hook",
    });

    expect(patch).toMatchObject({
      plugins: {
        entries: {
          "memory-plus": {
            config: {
              memoryAudit: {
                enabled: true,
                agentId: "hex",
                model: "gpt-5.5",
                delivery: { mode: "webhook", to: "https://example.test/hook" },
              },
            },
          },
        },
      },
    });
  });

  it("uses null merge-patch values when optional settings are cleared", () => {
    const patch = buildMemoryAuditConfigPatch("memory-core", {
      ...DEFAULT_MEMORY_AUDIT_SETTINGS,
      deliveryMode: "none",
    }) as {
      plugins: {
        entries: {
          "memory-core": {
            enabled?: true;
            config: {
              memoryAudit: {
                agentId: null;
                model: null;
                timezone: null;
                delivery: {
                  channel: null;
                  to: null;
                  threadId: null;
                  accountId: null;
                };
              };
            };
          };
        };
      };
    };

    expect(patch.plugins.entries["memory-core"].enabled).toBeUndefined();
    expect(patch.plugins.entries["memory-core"].config.memoryAudit.agentId).toBeNull();
    expect(patch.plugins.entries["memory-core"].config.memoryAudit.model).toBeNull();
    expect(patch.plugins.entries["memory-core"].config.memoryAudit.timezone).toBeNull();
    expect(patch.plugins.entries["memory-core"].config.memoryAudit.delivery).toMatchObject({
      channel: null,
      to: null,
      threadId: null,
      accountId: null,
    });
  });

  it("validates session targets, enabled crons, and webhook URLs", () => {
    const errors = validateMemoryAuditSettings({
      ...DEFAULT_MEMORY_AUDIT_SETTINGS,
      sessionTarget: "bad",
      dailyCron: "",
      deliveryMode: "webhook",
      deliveryTo: "example.test/hook",
    });

    expect(errors).toMatchObject({
      sessionTarget: "memoryAudit.errors.sessionTarget",
      dailyCron: "memoryAudit.errors.dailyCron",
      deliveryTo: "memoryAudit.errors.webhookInvalid",
    });
  });

  it("loads audit settings from the config snapshot", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                memoryAudit: { enabled: true, sessionTarget: "session:audit" },
              },
            },
          },
        },
      },
    });

    await loadMemoryAuditSettings(state);

    expect(request).toHaveBeenCalledWith("config.get", {});
    expect(state.configSnapshot?.hash).toBe("hash-1");
    expect(state.memoryAuditSettingsDraft.enabled).toBe(true);
    expect(state.memoryAuditSettingsDraft.sessionTarget).toBe("session:audit");
  });

  it("saves audit settings with config.patch", async () => {
    const { state, request } = createState();
    state.configSnapshot = { hash: "hash-1", config: {} };
    state.memoryAuditSettingsDraft = {
      ...DEFAULT_MEMORY_AUDIT_SETTINGS,
      enabled: true,
      agentId: "hex",
    };
    request.mockImplementation(async (method: string) => {
      if (method === "config.patch") {
        return { restart: { ok: true, signal: "SIGUSR1" } };
      }
      if (method === "config.get") {
        return { hash: "hash-2", config: {} };
      }
      return {};
    });

    await saveMemoryAuditSettings(state);

    const patchCall = request.mock.calls.find((call) => call[0] === "config.patch");
    expect(patchCall?.[1]).toMatchObject({
      baseHash: "hash-1",
      sessionKey: "main",
      note: "Memory Audit settings updated from the Audit tab.",
    });
    expect(JSON.parse(String(patchCall?.[1].raw))).toMatchObject({
      plugins: {
        entries: {
          "memory-core": {
            config: { memoryAudit: { enabled: true, agentId: "hex" } },
          },
        },
      },
    });
    expect(state.memoryAuditSettingsMessage).toEqual({
      kind: "success",
      text: "Memory Audit settings saved. Gateway restart scheduled to reconcile audit schedules.",
    });
  });

  it("reports no-op audit settings saves without restart copy", async () => {
    const { state, request } = createState();
    state.configSnapshot = { hash: "hash-1", config: {} };
    request.mockImplementation(async (method: string) => {
      if (method === "config.patch") {
        return { noop: true };
      }
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return {};
    });

    await saveMemoryAuditSettings(state);

    expect(state.memoryAuditSettingsMessage).toEqual({
      kind: "success",
      text: "Memory Audit settings already matched the saved config.",
    });
  });

  it("reports manual restart when audit settings save without a scheduled restart", async () => {
    const { state, request } = createState();
    state.configSnapshot = { hash: "hash-1", config: {} };
    state.memoryAuditSettingsDraft = {
      ...DEFAULT_MEMORY_AUDIT_SETTINGS,
      enabled: true,
    };
    request.mockImplementation(async (method: string) => {
      if (method === "config.patch") {
        return {};
      }
      if (method === "config.get") {
        return { hash: "hash-2", config: {} };
      }
      return {};
    });

    await saveMemoryAuditSettings(state);

    expect(state.memoryAuditSettingsMessage).toEqual({
      kind: "success",
      text: "Memory Audit settings saved. Restart the Gateway to reconcile audit schedules.",
    });
  });

  it("normalizes the suggestion queue payload", () => {
    const result = normalizeMemoryAuditSuggestions({
      agentId: "hex",
      workspaces: ["/workspace/hex", ""],
      total: 1,
      pending: 1,
      suggestions: [rawSuggestion(), { id: "missing-fields" }],
    });

    expect(result.agentId).toBe("hex");
    expect(result.workspaces).toEqual(["/workspace/hex"]);
    expect(result.total).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.source?.startLine).toBe(2);
  });

  it("keeps delete suggestions with empty replacement text", () => {
    const result = normalizeMemoryAuditSuggestions({
      suggestions: [
        {
          ...rawSuggestion(),
          id: "delete-1",
          action: "delete",
          text: "",
          rationale: "This memory is stale.",
        },
      ],
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toEqual(
      expect.objectContaining({
        id: "delete-1",
        action: "delete",
        text: "",
      }),
    );
  });

  it("loads suggestions from the gateway", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      agentId: "hex",
      workspaces: ["/workspace/hex"],
      total: 1,
      pending: 1,
      suggestions: [rawSuggestion()],
    });

    await loadMemoryAuditSuggestions(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.auditSuggestions", {});
    expect(state.memoryAuditSuggestions?.suggestions[0]?.id).toBe("audit-1");
    expect(state.memoryAuditError).toBeNull();
    expect(state.memoryAuditLoading).toBe(false);
  });

  it("skips loading when the gateway does not advertise audit suggestions", async () => {
    const { state, request } = createState();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["doctor.memory.status"] },
    };

    await loadMemoryAuditSuggestions(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.memoryAuditSuggestions).toBeNull();
    expect(state.memoryAuditError).toContain("doctor.memory.auditSuggestions");
  });

  it("applies pending suggestions and refreshes the queue", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.auditApply") {
        return { action: "apply", applied: true };
      }
      if (method === "doctor.memory.auditSuggestions") {
        return { suggestions: [{ ...rawSuggestion(), status: "applied" }] };
      }
      return {};
    });

    await runMemoryAuditAction(state, suggestion, "apply");

    expect(request).toHaveBeenCalledWith("doctor.memory.auditApply", {
      id: "audit-1",
      workspaceDir: "/workspace/hex",
    });
    expect(state.memoryAuditActionMessage).toEqual({
      kind: "success",
      text: "Suggestion applied.",
    });
    expect(state.memoryAuditSuggestions?.applied).toBe(1);
    expect(state.memoryAuditActionId).toBeNull();
  });

  it("does not mutate suggestions while the queue is refreshing", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    state.memoryAuditLoading = true;

    await runMemoryAuditAction(state, suggestion, "apply");

    expect(request).not.toHaveBeenCalled();
    expect(state.memoryAuditActionId).toBeNull();
    expect(state.memoryAuditActionMessage).toBeNull();
  });

  it("reports apply conflicts without losing the refreshed queue", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.auditApply") {
        return { action: "apply", applied: false, conflict: "source range changed" };
      }
      return {
        suggestions: [{ ...rawSuggestion(), status: "conflict", conflict: "source range changed" }],
      };
    });

    await runMemoryAuditAction(state, suggestion, "apply");

    expect(state.memoryAuditActionMessage).toEqual({
      kind: "error",
      text: "Could not apply suggestion: source range changed",
    });
    expect(state.memoryAuditSuggestions?.conflict).toBe(1);
  });

  it("reports no-op action responses as errors", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.auditReject") {
        return { action: "reject", rejected: false };
      }
      return { suggestions: [rawSuggestion()] };
    });

    await runMemoryAuditAction(state, suggestion, "reject");

    expect(state.memoryAuditActionMessage).toEqual({
      kind: "error",
      text: "Suggestion was not rejected.",
    });
  });
});
