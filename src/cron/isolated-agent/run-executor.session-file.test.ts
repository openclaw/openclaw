import { describe, expect, it, vi } from "vitest";
import { createCronPromptExecutor } from "./run-executor.js";

// Mock dependencies
vi.mock("./run-execution.runtime.js", () => ({
  resolveSessionTranscriptPath: vi.fn().mockReturnValue("/tmp/transcripts/cron-session.jsonl"),
  runWithModelFallback: vi.fn(),
  runCliAgent: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  isCliProvider: vi.fn().mockReturnValue(false),
  getCliSessionId: vi.fn(),
  logWarn: vi.fn(),
  normalizeVerboseLevel: vi.fn().mockReturnValue("normal"),
  registerAgentRunContext: vi.fn(),
  resolveBootstrapWarningSignaturesSeen: vi.fn().mockReturnValue([]),
  resolveFastModeState: vi.fn(),
  resolveNestedAgentLane: vi.fn().mockReturnValue("main"),
  countActiveDescendantRuns: vi.fn().mockReturnValue(0),
  listDescendantRunsForRequester: vi.fn().mockReturnValue([]),
  LiveSessionModelSwitchError: class LiveSessionModelSwitchError extends Error {},
}));

vi.mock("./run-fallback-policy.js", () => ({
  resolveCronFallbacksOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./subagent-followup-hints.js", () => ({
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: vi.fn().mockReturnValue({ isFastMode: false }),
}));

describe("createCronPromptExecutor - sessionFile persistence (#65151)", () => {
  function makeMockCronSession(overrides?: Record<string, unknown>) {
    return {
      store: {},
      storePath: "/tmp/sessions.json",
      sessionEntry: {
        sessionId: "cron-test-session-123",
        updatedAt: Date.now(),
        systemSent: false,
        skillsSnapshot: {},
        sessionFile: undefined as string | undefined,
        ...overrides,
      },
      systemSent: false,
      isNewSession: true,
      ...overrides,
    };
  }

  function makeMockParams(overrides?: Record<string, unknown>) {
    const cronSession = makeMockCronSession(overrides?.cronSession);
    return {
      cfg: {},
      cfgWithAgentDefaults: {},
      job: {
        id: "test-job",
        name: "Test Job",
        schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "test" },
      },
      agentId: "test-agent",
      agentDir: "/tmp/agent",
      agentSessionKey: "agent:test-agent:cron-test-session-123",
      workspaceDir: "/tmp/workspace",
      lane: "main",
      resolvedVerboseLevel: "normal",
      thinkLevel: undefined,
      timeoutMs: 60000,
      messageChannel: undefined,
      resolvedDelivery: {},
      toolPolicy: {
        requireExplicitMessageTarget: false,
        disableMessageTool: false,
      },
      skillsSnapshot: {},
      agentPayload: null,
      liveSelection: {
        provider: "openai",
        model: "gpt-4",
      },
      cronSession,
      abortReason: () => "aborted",
      ...overrides,
    };
  }

  it("persists sessionFile to sessionEntry when executor is created", () => {
    const params = makeMockParams();
    
    // Verify sessionFile is initially undefined
    expect(params.cronSession.sessionEntry.sessionFile).toBeUndefined();
    
    // Create the executor (this should set sessionFile)
    createCronPromptExecutor(params);
    
    // Verify sessionFile is now set
    expect(params.cronSession.sessionEntry.sessionFile).toBe("/tmp/transcripts/cron-session.jsonl");
  });

  it("persists sessionFile with correct path format", () => {
    const params = makeMockParams({
      cronSession: {
        sessionEntry: {
          sessionId: "my-cron-job-456",
        },
      },
      agentId: "my-agent",
    });
    
    const { resolveSessionTranscriptPath } = await import("./run-execution.runtime.js");
    (resolveSessionTranscriptPath as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "/custom/path/agent:my-agent:my-cron-job-456.jsonl"
    );
    
    createCronPromptExecutor(params);
    
    expect(params.cronSession.sessionEntry.sessionFile).toBe(
      "/custom/path/agent:my-agent:my-cron-job-456.jsonl"
    );
  });

  it("overwrites existing sessionFile if already set", () => {
    const params = makeMockParams({
      cronSession: {
        sessionEntry: {
          sessionFile: "/old/path/old-session.jsonl",
        },
      },
    });
    
    // Verify old value exists
    expect(params.cronSession.sessionEntry.sessionFile).toBe("/old/path/old-session.jsonl");
    
    // Create executor
    createCronPromptExecutor(params);
    
    // Verify it's updated to new value
    expect(params.cronSession.sessionEntry.sessionFile).toBe("/tmp/transcripts/cron-session.jsonl");
  });

  it("calls resolveSessionTranscriptPath with correct arguments", () => {
    const params = makeMockParams({
      cronSession: {
        sessionEntry: {
          sessionId: "test-session-id-789",
        },
      },
      agentId: "test-agent-id",
    });
    
    const { resolveSessionTranscriptPath } = await import("./run-execution.runtime.js");
    const mockResolve = resolveSessionTranscriptPath as ReturnType<typeof vi.fn>;
    mockResolve.mockClear();
    
    createCronPromptExecutor(params);
    
    expect(mockResolve).toHaveBeenCalledWith("test-session-id-789", "test-agent-id");
  });

  it("handles session with existing sessionFile field gracefully", () => {
    const params = makeMockParams({
      cronSession: {
        sessionEntry: {
          sessionId: "session-with-file",
          sessionFile: "/existing/path.jsonl",
        },
      },
    });
    
    // Should not throw and should update the value
    expect(() => createCronPromptExecutor(params)).not.toThrow();
    expect(params.cronSession.sessionEntry.sessionFile).toBe("/tmp/transcripts/cron-session.jsonl");
  });
});
