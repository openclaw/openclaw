import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ──────────────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  const spawnMock = vi.fn();
  const loadSessionStore = vi.fn();
  const resolveStorePath = vi.fn();
  const updateSessionStore = vi.fn();
  const resolveAgentIdFromSessionKey = vi.fn();
  const applyModelOverrideToSessionEntry = vi.fn();
  const resolveMainSessionAlias = vi.fn();
  const resolveInternalSessionKey = vi.fn();
  return {
    spawnMock,
    loadSessionStore,
    resolveStorePath,
    updateSessionStore,
    resolveAgentIdFromSessionKey,
    applyModelOverrideToSessionEntry,
    resolveMainSessionAlias,
    resolveInternalSessionKey,
  };
});

vi.mock("../subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnMock(...args),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStore(...args),
  resolveStorePath: (...args: unknown[]) => hoisted.resolveStorePath(...args),
  updateSessionStore: (...args: unknown[]) => hoisted.updateSessionStore(...args),
}));

vi.mock("../../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: (...args: unknown[]) =>
    hoisted.resolveAgentIdFromSessionKey(...args),
}));

vi.mock("../../sessions/model-overrides.js", () => ({
  applyModelOverrideToSessionEntry: (...args: unknown[]) =>
    hoisted.applyModelOverrideToSessionEntry(...args),
}));

vi.mock("./sessions-helpers.js", () => ({
  resolveMainSessionAlias: (...args: unknown[]) => hoisted.resolveMainSessionAlias(...args),
  resolveInternalSessionKey: (...args: unknown[]) => hoisted.resolveInternalSessionKey(...args),
}));

// ── import under test ──────────────────────────────────────────────────────────
let createModelSpawnTool: typeof import("./model-spawn-tool.js").createModelSpawnTool;

describe("model_spawn tool", () => {
  beforeAll(async () => {
    ({ createModelSpawnTool } = await import("./model-spawn-tool.js"));
  });

  beforeEach(() => {
    hoisted.spawnMock.mockReset().mockResolvedValue({ status: "ok", output: "done" });
    hoisted.loadSessionStore.mockReset().mockReturnValue({
      "agent:main:main": { providerOverride: "openai", modelOverride: "gpt-4o" },
    });
    hoisted.resolveStorePath.mockReset().mockReturnValue("/tmp/sessions.json");
    hoisted.updateSessionStore.mockReset().mockResolvedValue(undefined);
    hoisted.resolveAgentIdFromSessionKey.mockReset().mockReturnValue("main");
    hoisted.applyModelOverrideToSessionEntry.mockReset().mockReturnValue({ updated: true });
    hoisted.resolveMainSessionAlias
      .mockReset()
      .mockReturnValue({ mainKey: "main", alias: "agent:main:main", scope: "per-sender" });
    hoisted.resolveInternalSessionKey.mockReset().mockReturnValue("agent:main:main");
  });

  // ── live mode ──────────────────────────────────────────────────────────────

  describe("live mode", () => {
    it("writes model switch to session store and returns switchPending: true", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      const result = await tool.execute("call-1", {
        mode: "live",
        model: "together/MiniMaxAI/MiniMax-M2.7",
      });

      expect(hoisted.applyModelOverrideToSessionEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: { provider: "together", model: "MiniMaxAI/MiniMax-M2.7", isDefault: false },
          selectionSource: "user",
          markLiveSwitchPending: true,
        }),
      );
      expect(hoisted.updateSessionStore).toHaveBeenCalledWith(
        "/tmp/sessions.json",
        expect.any(Function),
      );
      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({
        status: "ok",
        mode: "live",
        switchPending: true,
      });
    });

    it("returns switchPending: false and skips store write when model already active", async () => {
      hoisted.applyModelOverrideToSessionEntry.mockReturnValue({ updated: false });

      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      const result = await tool.execute("call-2", {
        mode: "live",
        model: "together/MiniMaxAI/MiniMax-M2.7",
      });

      expect(hoisted.updateSessionStore).not.toHaveBeenCalled();
      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({
        status: "ok",
        mode: "live",
        switchPending: false,
      });
    });

    it("returns error result (not throw) when no session key", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "" });

      const result = await tool.execute("call-3", {
        mode: "live",
        model: "together/MiniMaxAI/MiniMax-M2.7",
      });

      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({ status: "error" });
      expect(hoisted.updateSessionStore).not.toHaveBeenCalled();
    });

    it("returns error result when no store path", async () => {
      hoisted.resolveStorePath.mockReturnValue(undefined);

      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      const result = await tool.execute("call-4", {
        mode: "live",
        model: "together/MiniMaxAI/MiniMax-M2.7",
      });

      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({ status: "error" });
    });

    it("returns error result when session not found in store", async () => {
      hoisted.loadSessionStore.mockReturnValue({});

      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      const result = await tool.execute("call-5", {
        mode: "live",
        model: "together/MiniMaxAI/MiniMax-M2.7",
      });

      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({ status: "error" });
    });

    it("throws ToolInputError for invalid model format (no slash)", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await expect(
        tool.execute("call-6", {
          mode: "live",
          model: "no-slash-model",
        }),
      ).rejects.toThrow("model must include a provider prefix");
    });

    it("uses requesterAgentIdOverride over session key parsing when provided", async () => {
      const tool = createModelSpawnTool({
        agentSessionKey: "agent:main:main",
        requesterAgentIdOverride: "cron-agent",
      });

      await tool.execute("call-7", {
        mode: "live",
        model: "together/MiniMaxAI/MiniMax-M2.7",
      });

      expect(hoisted.resolveStorePath).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ agentId: "cron-agent" }),
      );
      expect(hoisted.resolveAgentIdFromSessionKey).not.toHaveBeenCalled();
    });
  });

  // ── spawn single ───────────────────────────────────────────────────────────

  describe("spawn single", () => {
    it("calls spawnSubagentDirect with correct task/model/cleanup/timeout", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await tool.execute("call-s1", {
        mode: "spawn",
        model: "together/MiniMaxAI/MiniMax-M2.7",
        task: "summarize this document",
        cleanup: "keep",
        timeout_seconds: 30,
      });

      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "summarize this document",
          model: "together/MiniMaxAI/MiniMax-M2.7",
          cleanup: "keep",
          runTimeoutSeconds: 30,
          expectsCompletionMessage: true,
        }),
        expect.objectContaining({
          agentSessionKey: "agent:main:main",
        }),
      );
    });

    it("prepends context to task when both provided", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await tool.execute("call-s2", {
        mode: "spawn",
        model: "together/MiniMaxAI/MiniMax-M2.7",
        task: "analyze the code",
        context: "You are a code reviewer",
      });

      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "You are a code reviewer\n\nanalyze the code",
        }),
        expect.any(Object),
      );
    });

    it("throws ToolInputError when model is missing", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await expect(
        tool.execute("call-s3", {
          mode: "spawn",
          task: "do something",
        }),
      ).rejects.toThrow("model is required for single spawn mode");
    });

    it("throws ToolInputError when task is missing", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await expect(
        tool.execute("call-s4", {
          mode: "spawn",
          model: "together/MiniMaxAI/MiniMax-M2.7",
        }),
      ).rejects.toThrow("task is required for spawn mode");
    });
  });

  // ── spawn multi ────────────────────────────────────────────────────────────

  describe("spawn multi (spawns[])", () => {
    it("runs all entries and results array has label/index/model per entry", async () => {
      hoisted.spawnMock
        .mockResolvedValueOnce({ status: "ok", output: "result-a" })
        .mockResolvedValueOnce({ status: "ok", output: "result-b" });

      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      const result = await tool.execute("call-m1", {
        mode: "spawn",
        spawns: [
          { model: "openai/gpt-5.4", task: "task-a", label: "GPT" },
          { model: "together/MiniMaxAI/MiniMax-M2.7", task: "task-b", label: "MiniMax" },
        ],
      });

      const details = result.details as {
        results: Array<{ label: string; index: number; model: string }>;
      };
      expect(details.results).toHaveLength(2);
      expect(details.results[0]).toMatchObject({ label: "GPT", index: 0, model: "openai/gpt-5.4" });
      expect(details.results[1]).toMatchObject({
        label: "MiniMax",
        index: 1,
        model: "together/MiniMaxAI/MiniMax-M2.7",
      });
    });

    it("per-entry omitted task inherits top-level task", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await tool.execute("call-m2", {
        mode: "spawn",
        task: "shared task",
        spawns: [{ model: "openai/gpt-5.4" }],
      });

      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        expect.objectContaining({ task: "shared task" }),
        expect.any(Object),
      );
    });

    it("per-entry omitted context inherits top-level context", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await tool.execute("call-m3", {
        mode: "spawn",
        task: "do work",
        context: "You are an expert",
        spawns: [{ model: "openai/gpt-5.4" }],
      });

      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        expect.objectContaining({ task: "You are an expert\n\ndo work" }),
        expect.any(Object),
      );
    });

    it("one entry error doesn't discard other results (Promise.allSettled)", async () => {
      hoisted.spawnMock
        .mockResolvedValueOnce({ status: "ok", output: "good" })
        .mockRejectedValueOnce(new Error("spawn failed"));

      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      const result = await tool.execute("call-m4", {
        mode: "spawn",
        spawns: [
          { model: "openai/gpt-5.4", task: "task-a" },
          { model: "together/broken-model", task: "task-b" },
        ],
      });

      const details = result.details as {
        results: Array<{ status: string; error?: string; output?: string }>;
      };
      expect(details.results).toHaveLength(2);
      expect(details.results[0]).toMatchObject({ status: "ok" });
      expect(details.results[1]).toMatchObject({ status: "error", error: "spawn failed" });
    });
  });

  // ── mutual exclusion & invalid mode ────────────────────────────────────────

  describe("validation", () => {
    it("throws ToolInputError when top-level model and spawns[] are both provided", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await expect(
        tool.execute("call-v1", {
          mode: "spawn",
          model: "openai/gpt-5.4",
          spawns: [{ model: "together/MiniMaxAI/MiniMax-M2.7", task: "test" }],
        }),
      ).rejects.toThrow(
        "Provide either a top-level model (single spawn) or a spawns array (multi-spawn), not both",
      );
    });

    it("throws ToolInputError for invalid mode", async () => {
      const tool = createModelSpawnTool({ agentSessionKey: "agent:main:main" });

      await expect(
        tool.execute("call-v2", {
          mode: "invalid",
          model: "openai/gpt-5.4",
        }),
      ).rejects.toThrow('mode must be "live" or "spawn"');
    });
  });
});
