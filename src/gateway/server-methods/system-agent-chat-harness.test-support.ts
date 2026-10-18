import { vi } from "vitest";
import {
  makePassiveEngine,
  quietGreetingFacts,
  transcriptModule,
} from "./system-agent-chat-fixture.test-support.js";
import type { SystemAgentChatSession } from "./system-agent.js";

export const chatFixture = vi.hoisted(() => ({
  mode: "ownership" as "ownership" | "greeting",
  inference: { verifySystemAgentInferenceWithFallback: vi.fn() },
  transcript: {
    appendReset: vi.fn(),
    appendTurn: vi.fn(),
    readTranscriptTailAsync:
      vi.fn<typeof import("../../system-agent/transcript-store.js").readTranscriptTailAsync>(),
  },
  greeting: {
    acknowledgeSystemAgentGreetingDelivery: vi.fn(),
    buildSystemAgentGreetingQuestion: vi.fn(),
    loadSystemAgentGreetingFacts: vi.fn(),
    resolveSystemAgentGreeting: vi.fn(),
  },
  ownershipEngines: [] as ReturnType<typeof makeOwnershipEngine>[],
  greetingEngines: [] as ReturnType<typeof makeGreetingEngine>[],
  engineOptions: [] as Array<Record<string, unknown>>,
  WizardAnswerError: class extends Error {},
}));

// Both suites isolate the same external inference, transcript and greeting owners.
vi.mock("../../system-agent/inference-fallback.js", () => chatFixture.inference);
vi.mock("../../system-agent/transcript-store.js", () => transcriptModule(chatFixture.transcript));
vi.mock("../../system-agent/greeting.js", () => ({
  createSystemAgentGreetingCache: () => ({ assertCurrent: () => undefined }),
  ...chatFixture.greeting,
}));
vi.mock("../../system-agent/chat-engine.js", () => ({
  SystemAgentWizardAnswerError: chatFixture.WizardAnswerError,
  SystemAgentChatEngine: function FakeSystemAgentChatEngine(
    this: object,
    options: Record<string, unknown>,
  ) {
    chatFixture.engineOptions.push(options);
    if (chatFixture.mode === "greeting") {
      const engine = makeGreetingEngine();
      chatFixture.greetingEngines.push(engine);
      Object.assign(this, engine);
      return;
    }
    const engine = makeOwnershipEngine();
    chatFixture.ownershipEngines.push(engine);
    Object.assign(this, engine);
  },
}));

export function makeOwnershipEngine() {
  return {
    ...makePassiveEngine(),
    answerWizard: vi.fn(async (): Promise<never> => {
      throw new chatFixture.WizardAnswerError("No hosted wizard is awaiting an answer.");
    }),
    cancelWizard: vi.fn<SystemAgentChatSession["engine"]["cancelWizard"]>(async () => {
      throw new chatFixture.WizardAnswerError("No hosted wizard is awaiting cancellation.");
    }),
  };
}

function makeGreetingEngine() {
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  return {
    ...makePassiveEngine(),
    seedHistory: vi.fn((turns: typeof history) => {
      history.push(...turns);
    }),
    historyLength: vi.fn(() => history.length),
    historySince: vi.fn((index: number) => history.slice(index)),
    noteAssistantMessage: vi.fn((text: string) => {
      history.push({ role: "assistant", text });
    }),
    planGreeting: vi.fn(),
  };
}

export function resetChatFixture(mode: "ownership" | "greeting") {
  chatFixture.mode = mode;
  chatFixture.ownershipEngines.length = 0;
  chatFixture.greetingEngines.length = 0;
  chatFixture.engineOptions.length = 0;
  chatFixture.inference.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    binding: {},
  });
  if (mode === "greeting") {
    chatFixture.transcript.appendTurn.mockReset();
    chatFixture.transcript.readTranscriptTailAsync.mockReset().mockResolvedValue([]);
  } else {
    chatFixture.transcript.readTranscriptTailAsync.mockResolvedValue([]);
    chatFixture.greeting.buildSystemAgentGreetingQuestion.mockReturnValue(undefined);
    chatFixture.greeting.loadSystemAgentGreetingFacts.mockReturnValue(quietGreetingFacts);
    chatFixture.greeting.resolveSystemAgentGreeting.mockResolvedValue({
      text: "welcome text",
      source: "template",
    });
  }
}
