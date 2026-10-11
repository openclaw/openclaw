import { vi } from "vitest";

const setupInferenceMocks = vi.hoisted(() => ({
  activateSetupInference: vi.fn(),
  resolvePersistentApplyInference: vi.fn(),
  verifySetupInference: vi.fn(),
}));
const inferenceFallbackMocks = vi.hoisted(() => ({ verify: vi.fn() }));
const setupInferenceDetectionMocks = vi.hoisted(() => ({
  detectSetupInferenceIsolated: vi.fn(),
}));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendReset: vi.fn(),
  appendTurn: vi.fn(),
  readTranscriptTailAsync: vi
    .fn<typeof import("../../system-agent/transcript-store.js").readTranscriptTailAsync>()
    .mockResolvedValue([]),
}));
const greetingMocks = vi.hoisted(() => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  loadSystemAgentGreetingFacts: vi.fn(),
  resolveSystemAgentGreeting: vi.fn(),
}));
const onboardingWelcomeMocks = vi.hoisted(() => ({
  buildOnboardingWelcome: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
  detectSetupInference: (_deps: unknown, agentId?: string) =>
    setupInferenceDetectionMocks.detectSetupInferenceIsolated({ agentId }),
  resolvePersistentApplyInference: setupInferenceMocks.resolvePersistentApplyInference,
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback: inferenceFallbackMocks.verify,
}));
// mock-isolation: Keep audit persistence local for gateway policy tests; audit-worker tests own durable proof.
vi.mock("../../system-agent/transcript-store.js", () => ({
  createSystemAgentTranscriptStore: () => ({
    assertCurrent: () => undefined,
    appendTurn: transcriptStoreMocks.appendTurn,
    appendReset: transcriptStoreMocks.appendReset,
    readTail: (limit: number, afterLastReset = false) =>
      afterLastReset
        ? transcriptStoreMocks.readTranscriptTailAsync(limit, { afterLastReset })
        : transcriptStoreMocks.readTranscriptTailAsync(limit),
  }),
  readTranscriptTailAsync: transcriptStoreMocks.readTranscriptTailAsync,
}));
vi.mock("../../system-agent/greeting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../system-agent/greeting.js")>();
  return {
    ...actual,
    createSystemAgentGreetingCache: () => ({ assertCurrent: () => undefined }),
    acknowledgeSystemAgentGreetingDelivery: greetingMocks.acknowledgeSystemAgentGreetingDelivery,
    loadSystemAgentGreetingFacts: greetingMocks.loadSystemAgentGreetingFacts,
    resolveSystemAgentGreeting: greetingMocks.resolveSystemAgentGreeting,
  };
});
vi.mock("../../system-agent/onboarding-welcome.js", () => ({
  buildOnboardingWelcome: onboardingWelcomeMocks.buildOnboardingWelcome,
}));

export {
  setupInferenceMocks,
  inferenceFallbackMocks,
  setupInferenceDetectionMocks,
  transcriptStoreMocks,
  greetingMocks,
  onboardingWelcomeMocks,
};
