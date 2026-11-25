/** Runtime isolation for direct directive-handler tests. */
import { vi, type Mock } from "vitest";

export const runEmbeddedAgentMock: Mock = vi.fn();
export const compactEmbeddedAgentSessionMock: Mock = vi.fn();
export const loadModelCatalogMock: Mock = vi.fn();
export const resolveCommandSecretRefsViaGatewayMock: Mock = vi.fn();
export const clearSessionAuthProfileOverrideMock: Mock = vi.fn();
export const resolveSessionAuthSelectionMock: Mock = vi.fn();

export const runReplyAgentMock: Mock = vi.fn();

export const runPreparedReplyMock: Mock = vi.fn();

vi.mock("../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent.js")>()),
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  compactEmbeddedAgentSession: (...args: unknown[]) => compactEmbeddedAgentSessionMock(...args),
  runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
  isSessionRunActive: vi.fn().mockReturnValue(false),
  isSessionNativeAttemptStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../agents/embedded-agent.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent.runtime.js")>()),
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  compactEmbeddedAgentSession: (...args: unknown[]) => compactEmbeddedAgentSessionMock(...args),
  runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
  resolveActiveSessionRunId: vi.fn().mockReturnValue(undefined),
  isSessionRunActive: vi.fn().mockReturnValue(false),
  isSessionNativeAttemptStreaming: vi.fn().mockReturnValue(false),
  waitForSessionRunEnd: vi.fn().mockResolvedValue(true),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: loadModelCatalogMock,
}));

vi.mock("../agents/thinking-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/thinking-runtime.js")>();
  return {
    ...actual,
    // These tests cover directive acknowledgements and persistence, not harness selection.
    // Keep each directive from loading unrelated provider-route metadata through auto selection.
    resolveCandidateAgentRuntime: () => "openclaw",
    resolveEffectiveAgentRuntime: () => "openclaw",
  };
});

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
    resolveCommandSecretRefsViaGatewayMock(...args),
}));

vi.mock("../agents/auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: (...args: unknown[]) =>
    clearSessionAuthProfileOverrideMock(...args),
  resolveSessionAuthSelection: (...args: unknown[]) => resolveSessionAuthSelectionMock(...args),
}));

vi.mock("../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/hook-runner-global.js")>();
  return {
    ...actual,
    getGlobalHookRunner: () => undefined,
    initializeGlobalHookRunner: vi.fn(),
    resetGlobalHookRunner: vi.fn(),
  };
});

vi.mock("./reply/agent-runner-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply/agent-runner-run.js")>()),
  runReplyAgent: (...args: unknown[]) => runReplyAgentMock(...args),
}));

vi.mock("./reply/get-reply-run.js", () => ({
  runPreparedReply: (...args: unknown[]) => runPreparedReplyMock(...args),
}));
