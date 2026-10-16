import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const inferenceFallbackMocks = vi.hoisted(() => ({
  verifySystemAgentInferenceWithFallback: vi.fn(),
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
  buildSystemAgentGreetingQuestion: vi.fn(),
  loadSystemAgentGreetingFacts: vi.fn(),
  resolveSystemAgentGreeting: vi.fn(),
}));
const onboardingWelcomeMocks = vi.hoisted(() => ({ buildOnboardingWelcome: vi.fn() }));

vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback:
    inferenceFallbackMocks.verifySystemAgentInferenceWithFallback,
}));
// mock-isolation: Keep transcript effects local while checking welcome delivery and acknowledgement ordering.
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
// mock-isolation: Use deterministic caretaker facts and avoid provider inference in welcome-policy tests.
vi.mock("../../system-agent/greeting.js", () => ({
  createSystemAgentGreetingCache: () => ({ assertCurrent: () => undefined }),
  acknowledgeSystemAgentGreetingDelivery: greetingMocks.acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion: greetingMocks.buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts: greetingMocks.loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting: greetingMocks.resolveSystemAgentGreeting,
}));
vi.mock("../../system-agent/onboarding-welcome.js", () => ({
  buildOnboardingWelcome: onboardingWelcomeMocks.buildOnboardingWelcome,
}));

type FakeEngine = ReturnType<typeof makeEngine>;

function makeEngine() {
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  return {
    handle: vi.fn(async () => ({ text: "did the thing", action: "none" })),
    seedHistory: vi.fn((turns: typeof history) => {
      history.push(...turns);
    }),
    historyLength: vi.fn(() => history.length),
    historySince: vi.fn((index: number) => history.slice(index)),
    getPendingOperatorProposal: vi.fn(() => null),
    resolveOperatorApproval: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn((text: string) => {
      history.push({ role: "assistant", text });
    }),
    planGreeting: vi.fn(),
    decorateRejoinReply: vi.fn((reply: unknown) => reply),
  };
}

const createdEngines = vi.hoisted(() => [] as FakeEngine[]);

vi.mock("../../system-agent/chat-engine.js", () => ({
  SystemAgentChatEngine: function FakeSystemAgentChatEngine(this: FakeEngine) {
    const engine = makeEngine();
    createdEngines.push(engine);
    Object.assign(this, engine);
  },
}));

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient = defaultClient,
): Promise<RespondCall> {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({ params, respond, context, client } as never);
  return expectDefined(calls[0], "system-agent response");
}

const quickActions = {
  id: "system-agent-quick-actions",
  header: "Quick actions",
  question: "What would you like me to do?",
  options: [
    { label: "Show update", reply: "status" },
    { label: "Talk to my agent", reply: "talk to agent" },
    { label: "Review recent changes", reply: "audit" },
  ],
};

beforeEach(() => {
  createdEngines.length = 0;
  transcriptStoreMocks.appendTurn.mockReset();
  transcriptStoreMocks.readTranscriptTailAsync.mockReset().mockResolvedValue([]);
  inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    binding: {},
  });
  greetingMocks.loadSystemAgentGreetingFacts.mockReturnValue({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  });
  greetingMocks.resolveSystemAgentGreeting.mockResolvedValue({
    text: "I'm OpenClaw. All systems nominal.",
    source: "model",
  });
  greetingMocks.buildSystemAgentGreetingQuestion.mockReturnValue(quickActions);
  onboardingWelcomeMocks.buildOnboardingWelcome.mockImplementation(
    async ({ engine }: { engine: { noteAssistantMessage: (text: string) => void } }) => {
      const text = "Inference is ready. Let's finish setup.";
      engine.noteAssistantMessage(text);
      return { text };
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
  transcriptStoreMocks.readTranscriptTailAsync.mockResolvedValue([]);
  resetCommandQueueStateForTest();
});

describe("openclaw.chat caretaker welcome", () => {
  it.each([undefined, "new-agent"] as const)(
    "opens creation choices on the retained %s session without duplicating passive history",
    async (welcomeVariant) => {
      transcriptStoreMocks.readTranscriptTailAsync.mockResolvedValue([
        { role: "user", text: "Earlier conversation", at: 1 },
      ]);
      const sessions = new Map<string, SystemAgentChatSession>();
      const context = makeContext(sessions);
      const initial = await callChat(context, {
        sessionId: "retained",
        ...(welcomeVariant ? { welcomeVariant } : {}),
      });
      const session = expectDefined(sessions.get("retained"), "retained session");
      const originalHistory = session.engine.historySince(0);
      const [creation, overlapping] = await Promise.all([
        callChat(context, { sessionId: "retained", welcomeVariant: "new-agent" }),
        callChat(context, { sessionId: "retained", welcomeVariant: "new-agent" }),
      ]);

      expect(creation.ok).toBe(true);
      expect(overlapping).toEqual(creation);
      expect(creation.payload).toMatchObject({
        sessionId: "retained",
        reply: expect.stringContaining("Let's create an agent."),
        action: "none",
      });
      expect(creation.payload).not.toHaveProperty("question");
      const history = session.engine.historySince(0);
      expect(history.slice(0, originalHistory.length)).toEqual(originalHistory);
      expect(history.filter((turn) => turn.text.startsWith("Let's create an agent."))).toHaveLength(
        1,
      );

      const retry = await callChat(context, {
        sessionId: "retained",
        welcomeVariant: "new-agent",
      });
      expect(retry).toEqual(creation);
      expect(session.engine.historySince(0)).toEqual(history);
      expect(await callChat(context, { sessionId: "retained" })).toEqual(initial);
      expect(sessions.get("retained")).toBe(session);
      expect(createdEngines).toHaveLength(1);
      expect(session.engine.dispose).not.toHaveBeenCalled();
      expect(transcriptStoreMocks.appendReset).not.toHaveBeenCalled();
      expect(transcriptStoreMocks.appendTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["wizard", "question", "proposal", "approval"] as const)(
    "keeps an active %s ahead of the creation entry",
    async (pending) => {
      const sessions = new Map<string, SystemAgentChatSession>();
      const context = makeContext(sessions);
      await callChat(context, { sessionId: "busy" });
      const session = expectDefined(sessions.get("busy"), "busy session");
      const history = session.engine.historySince(0);
      const liveQuestion = {
        id: "live-question",
        header: "Choose",
        question: "Which option?",
        options: [{ label: "A" }],
      };
      if (pending === "wizard" || pending === "question") {
        vi.spyOn(session.engine, "decorateRejoinReply").mockImplementation((reply) => ({
          ...reply,
          question: liveQuestion,
          ...(pending === "wizard"
            ? {
                sensitive: true,
                wizardInputPending: true,
                step: { id: "live-step", type: "text" as const, message: "Enter a value" },
              }
            : {}),
        }));
      } else if (pending === "proposal") {
        vi.spyOn(session.engine, "getPendingOperatorProposal").mockReturnValue({
          operation: { kind: "setup", workspace: "/synthetic/workspace" },
          hash: "proposal-hash",
        });
      } else {
        session.pendingApproval = {
          id: "approval-id",
          proposalHash: "proposal-hash",
          completion: new Promise(() => {}),
        };
      }
      const proposal = session.engine.getPendingOperatorProposal();
      const approval = session.pendingApproval;
      const before = await callChat(context, { sessionId: "busy" });
      const creation = await callChat(context, {
        sessionId: "busy",
        welcomeVariant: "new-agent",
      });
      expect(creation).toEqual(before);
      expect(session.engine.historySince(0)).toEqual(history);
      expect(session.engine.getPendingOperatorProposal()).toBe(proposal);
      expect(session.pendingApproval).toBe(approval);
      expect(session.engine.dispose).not.toHaveBeenCalled();
      expect(session.engine.resolveOperatorApproval).not.toHaveBeenCalled();
      expect(sessions.get("busy")).toBe(session);

      vi.spyOn(session.engine, "decorateRejoinReply").mockImplementation((reply) => reply);
      vi.spyOn(session.engine, "getPendingOperatorProposal").mockReturnValue(null);
      delete session.pendingApproval;
      const available = await callChat(context, {
        sessionId: "busy",
        welcomeVariant: "new-agent",
      });
      expect(available.payload).toMatchObject({
        reply: expect.stringContaining("Let's create an agent."),
      });
    },
  );

  it.each([
    { label: "caretaker", welcomeVariant: undefined },
    { label: "onboarding", welcomeVariant: "onboarding" },
    { label: "new-agent", welcomeVariant: "new-agent" },
  ])(
    "does not replay an earlier passive $label welcome on reconnect",
    async ({ welcomeVariant }) => {
      const transcript: Array<{ role: "user" | "assistant"; text: string; at: number }> = [];
      transcriptStoreMocks.appendTurn.mockImplementation(
        (turn: { role: "user" | "assistant"; text: string; at: number }) => {
          transcript.push(turn);
        },
      );
      transcriptStoreMocks.readTranscriptTailAsync.mockImplementation(async () =>
        transcript.slice(),
      );
      const context = makeContext(new Map());
      const variant = welcomeVariant ? { welcomeVariant } : {};

      const first = await callChat(context, { sessionId: "first-welcome", ...variant });
      const second = await callChat(context, { sessionId: "second-welcome", ...variant });

      expect(first.ok).toBe(true);
      expect(first.payload).toMatchObject({ optionalWelcome: welcomeVariant === undefined });
      const rejoin = await callChat(context, { sessionId: "first-welcome", ...variant });
      expect(rejoin.payload).toMatchObject({ optionalWelcome: welcomeVariant === undefined });
      expect(second.payload).toMatchObject({
        reply: expectDefined(first.payload as { reply?: string }, "first welcome").reply,
      });
      expect(
        expectDefined(createdEngines[1], "second welcome engine").seedHistory,
      ).toHaveBeenCalledWith([]);
      expect(transcript).toEqual([]);
    },
  );

  it("does not plan a greeting when a fresh session is created with a message", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    greetingMocks.resolveSystemAgentGreeting.mockResolvedValueOnce({
      text: "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
      source: "template",
    });

    const context = makeContext(sessions);
    const call = await callChat(context, {
      sessionId: "fresh-with-message",
      message: "status",
    });

    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
    expect(greetingMocks.resolveSystemAgentGreeting).toHaveBeenCalledWith(
      expect.objectContaining({ allowInference: false }),
    );
    expect(createdEngines[0]?.planGreeting).not.toHaveBeenCalled();
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).not.toHaveBeenCalled();

    expect(sessions.get("fresh-with-message")?.welcomeAuditSequence).toBe(0);
    const welcome = await callChat(context, { sessionId: "fresh-with-message" });
    expect(welcome.payload).toMatchObject({
      reply: "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
    });
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ auditSequence: 0 }),
    );
    expect(sessions.get("fresh-with-message")?.welcomeAuditSequence).toBeUndefined();
  });

  it.each([false, true])(
    "persists audit greetings before acknowledgement (delivery fails=%s)",
    async (fails) => {
      const sessions = new Map<string, SystemAgentChatSession>();
      const context = makeContext(sessions);
      const text = "I'm healthy. An update is ready, and I noticed a manual config edit.";
      greetingMocks.loadSystemAgentGreetingFacts.mockReturnValueOnce({
        updateAvailable: "2026.7.20",
        channelHealth: { available: true, degraded: [] },
        recentExternalEdit: true,
        auditSequence: 42,
      });
      greetingMocks.resolveSystemAgentGreeting.mockResolvedValueOnce({ text, source: "model" });
      if (fails) {
        await expect(
          expectDefined(
            systemAgentHandlers["openclaw.chat"],
            "openclaw.chat",
          )({
            params: { sessionId: "audit-welcome" },
            respond: () => {
              throw new Error("socket closed");
            },
            context,
            client: defaultClient,
          } as never),
        ).rejects.toThrow("socket closed");
        expect(transcriptStoreMocks.appendTurn).toHaveBeenCalled();
        expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).not.toHaveBeenCalled();
        expect(sessions.get("audit-welcome")?.welcomeAuditSequence).toBe(42);
        const creation = await callChat(context, {
          sessionId: "audit-welcome",
          welcomeVariant: "new-agent",
        });
        expect(creation.payload).toMatchObject({
          reply: expect.stringContaining("Let's create an agent."),
        });
        expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).not.toHaveBeenCalled();
        expect(sessions.get("audit-welcome")?.welcomeAuditSequence).toBe(42);
      }
      const call = await callChat(context, { sessionId: "audit-welcome" });
      expect(call.payload).toMatchObject({
        reply: text,
        optionalWelcome: false,
        question: { header: quickActions.header, options: quickActions.options },
      });
      expect(greetingMocks.resolveSystemAgentGreeting).toHaveBeenCalledWith(
        expect.objectContaining({ allowInference: true }),
      );
      expect(transcriptStoreMocks.appendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "assistant", text }),
      );
      expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ auditSequence: 42 }),
      );
      expect(transcriptStoreMocks.appendTurn.mock.invocationCallOrder[0]).toBeLessThan(
        greetingMocks.acknowledgeSystemAgentGreetingDelivery.mock.invocationCallOrder[0] ?? 0,
      );
      expect(sessions.get("audit-welcome")?.welcomeAuditSequence).toBeUndefined();
    },
  );

  it("renders the onboarding welcome in the connected client's locale", async () => {
    const { buildOnboardingWelcome } = await vi.importActual<
      typeof import("../../system-agent/onboarding-welcome.js")
    >("../../system-agent/onboarding-welcome.js");
    onboardingWelcomeMocks.buildOnboardingWelcome.mockImplementationOnce(({ locale }) =>
      buildOnboardingWelcome({
        locale,
        workspace: "/workspace/example",
        engine: {
          loadOverview: async () => ({
            config: { exists: false, valid: true },
            defaultModel: "example/verified-model",
          }),
          propose: () => undefined,
          noteAssistantMessage: () => undefined,
        } as never,
      }),
    );
    const call = await callChat(
      makeContext(new Map()),
      { sessionId: "localized-onboarding", welcomeVariant: "onboarding" },
      { ...defaultClient, connect: { ...defaultClient.connect, locale: "zh-TW" } },
    );

    expect(onboardingWelcomeMocks.buildOnboardingWelcome).toHaveBeenCalledOnce();
    expect(greetingMocks.loadSystemAgentGreetingFacts).not.toHaveBeenCalled();
    expect(greetingMocks.resolveSystemAgentGreeting).not.toHaveBeenCalled();
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).not.toHaveBeenCalled();
    expect(call.payload).toMatchObject({
      reply: expect.stringContaining("你好，我是 OpenClaw — 我們來孵化你的智慧代理吧。"),
      question: {
        options: expect.arrayContaining([
          expect.objectContaining({ label: "是的 — 開始設定", reply: "yes" }),
        ]),
      },
    });
  });
});
