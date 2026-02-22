import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

// Mock pi-embedded to avoid actual agent runs
vi.mock("../../agents/pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
  runEmbeddedPiAgent: vi.fn(async () => ({ ok: true })),
  abortEmbeddedPiRun: vi.fn(),
  waitForEmbeddedPiRunEnd: vi.fn(async () => {}),
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveAgentDir: () => "/tmp/agent",
    resolveAgentModelFallbacksOverride: () => undefined,
  };
});

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn(
    async (params: { run: (p: string, m: string) => Promise<unknown> }) => {
      return params.run("test-provider", "test-model");
    },
  ),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    resolveSessionFilePath: () => "/tmp/session.jsonl",
    resolveSessionFilePathOptions: () => ({}),
  };
});

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: vi.fn(),
}));

const cfg: OpenClawConfig = {} as OpenClawConfig;

describe("handleSaveCommand", () => {
  it("returns null for non-save commands", async () => {
    const { handleSaveCommand } = await import("./commands-save.js");
    const params = buildCommandTestParams("/help", cfg);
    const result = await handleSaveCommand(params, true);
    expect(result).toBeNull();
  });

  it("handles /save command", async () => {
    const { handleSaveCommand } = await import("./commands-save.js");
    const params = buildCommandTestParams("/save", cfg);
    params.sessionEntry = {
      sessionId: "test-session-123",
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
    };
    const result = await handleSaveCommand(params, true);
    expect(result).not.toBeNull();
    expect(result!.shouldContinue).toBe(false);
    expect(result!.reply?.text).toContain("Memory saved");
  });

  it("rejects unauthorized senders", async () => {
    const { handleSaveCommand } = await import("./commands-save.js");
    const params = buildCommandTestParams("/save", cfg);
    params.command.isAuthorizedSender = false;
    const result = await handleSaveCommand(params, true);
    expect(result).not.toBeNull();
    expect(result!.shouldContinue).toBe(false);
    expect(result!.reply).toBeUndefined();
  });

  it("returns error when session id is missing", async () => {
    const { handleSaveCommand } = await import("./commands-save.js");
    const params = buildCommandTestParams("/save", cfg);
    params.sessionEntry = undefined;
    const result = await handleSaveCommand(params, true);
    expect(result).not.toBeNull();
    expect(result!.reply?.text).toContain("unavailable");
  });
});

describe("runMemorySave", () => {
  it("returns error when session id is missing", async () => {
    const { runMemorySave } = await import("./commands-save.js");
    const result = await runMemorySave({
      cfg,
      sessionEntry: undefined,
      sessionKey: "test",
      storePath: "/tmp/store",
      agentId: "main",
      workspaceDir: "/tmp",
      provider: "test",
      model: "test",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing session id");
  });

  it("returns error when agent is running", async () => {
    const piEmbedded = await import("../../agents/pi-embedded.js");
    vi.mocked(piEmbedded.isEmbeddedPiRunActive).mockReturnValueOnce(true);

    const { runMemorySave } = await import("./commands-save.js");
    const result = await runMemorySave({
      cfg,
      sessionEntry: {
        sessionId: "test-123",
        updatedAt: Date.now(),
        systemSent: false,
        abortedLastRun: false,
      },
      sessionKey: "test",
      storePath: "/tmp/store",
      agentId: "main",
      workspaceDir: "/tmp",
      provider: "test",
      model: "test",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("currently running");
  });
});

describe("runPreResetMemoryFlush", () => {
  it("uses reset-specific prompts", async () => {
    const piEmbedded = await import("../../agents/pi-embedded.js");
    const runAgent = vi.mocked(piEmbedded.runEmbeddedPiAgent);
    runAgent.mockClear();

    const { runPreResetMemoryFlush } = await import("./commands-save.js");
    const result = await runPreResetMemoryFlush({
      cfg,
      sessionEntry: {
        sessionId: "test-123",
        updatedAt: Date.now(),
        systemSent: false,
        abortedLastRun: false,
      },
      sessionKey: "test",
      storePath: "/tmp/store",
      agentId: "main",
      workspaceDir: "/tmp",
      provider: "test",
      model: "test",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(result.ok).toBe(true);

    // Verify reset-specific prompt was used
    expect(runAgent).toHaveBeenCalled();
    const callArgs = runAgent.mock.calls[0][0];
    expect(callArgs.prompt).toContain("Session is being reset");
    expect(callArgs.extraSystemPrompt).toContain("Pre-reset memory flush");
  });
});
