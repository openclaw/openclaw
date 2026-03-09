import { vi } from "vitest";

export function registerGetReplyCommonMocks(): void {
  vi.mock("../../agents/agent-scope.js", () => ({
    resolveAgentDir: vi.fn(() => "/tmp/agent"),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    resolveSessionAgentId: vi.fn(() => "main"),
    resolveAgentSkillsFilter: vi.fn(() => undefined),
  }));
  vi.mock("../../agents/model-selection.js", () => ({
    resolveModelRefFromString: vi.fn(() => null),
  }));
  vi.mock("../../agents/timeout.js", () => ({
    resolveAgentTimeoutMs: vi.fn(() => 60000),
  }));
  vi.mock("../../agents/workspace.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../agents/workspace.js")>();
    return {
      ...actual,
      DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/workspace",
      ensureAgentWorkspace: vi.fn(async () => ({ dir: "/tmp/workspace" })),
    };
  });
  vi.mock("../../channels/model-overrides.js", () => ({
    resolveChannelModelOverride: vi.fn(() => undefined),
  }));
  vi.mock("../../config/config.js", () => ({
    loadConfig: vi.fn(() => ({})),
  }));
  vi.mock("../../runtime.js", () => ({
    defaultRuntime: { log: vi.fn() },
  }));
  vi.mock("../command-auth.js", () => ({
    resolveCommandAuthorization: vi.fn(() => ({ isAuthorizedSender: true })),
  }));
  vi.mock("./directive-handling.js", () => ({
    resolveDefaultModel: vi.fn(() => ({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: new Map(),
    })),
  }));
  vi.mock("./get-reply-run.js", () => ({
    runPreparedReply: vi.fn(async () => undefined),
  }));
  vi.mock("./inbound-context.js", () => ({
    finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
  }));
  vi.mock("./session-reset-model.js", () => ({
    applyResetModelOverride: vi.fn(async () => undefined),
  }));
  vi.mock("./stage-sandbox-media.js", () => ({
    stageSandboxMedia: vi.fn(async () => undefined),
  }));
  vi.mock("./typing.js", () => ({
    createTypingController: vi.fn(() => ({
      onReplyStart: async () => undefined,
      startTypingLoop: async () => undefined,
      startTypingOnText: async () => undefined,
      refreshTypingTtl: () => undefined,
      isActive: () => false,
      markRunComplete: () => undefined,
      markDispatchIdle: () => undefined,
      cleanup: () => undefined,
    })),
  }));
}
