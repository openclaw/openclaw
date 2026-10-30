import "./system-agent-transcript.mocks.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const { transcriptStoreMocks } = await import("./system-agent-transcript.mocks.test-support.js");
const inferenceFallbackMocks = vi.hoisted(() => ({ verify: vi.fn() }));

// mock-isolation: Control inference completion without contacting providers.
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback: inferenceFallbackMocks.verify,
}));
// mock-isolation: Keep greeting discovery and provider inference outside session-lifecycle tests.
vi.mock("../../system-agent/greeting.js", () => ({
  createSystemAgentGreetingCache: () => ({ assertCurrent: () => undefined }),
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  buildSystemAgentGreetingQuestion: vi.fn(() => undefined),
  loadSystemAgentGreetingFacts: vi.fn(() => ({
    recentExternalEdit: false,
    auditSequence: 0,
  })),
  resolveSystemAgentGreeting: vi.fn(async () => "welcome text"),
}));

type FakeEngine = ReturnType<typeof makeEngine>;

function makeEngine() {
  return {
    decorateRejoinReply: vi.fn((reply: Record<string, unknown>) => reply),
    dispose: vi.fn(async () => undefined),
    getPendingOperatorProposal: vi.fn(() => null),
    handle: vi.fn(async () => ({ text: "did the thing", action: "none" })),
    historyLength: vi.fn(() => 0),
    historySince: vi.fn(() => []),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn(),
    seedHistory: vi.fn(),
  };
}

const createdEngines = vi.hoisted(() => [] as FakeEngine[]);

// mock-isolation: Observe fixture engine ownership and disposal without provider or database startup.
vi.mock("../../system-agent/chat-engine.js", () => ({
  SystemAgentWizardAnswerError: class extends Error {},
  SystemAgentChatEngine: function FakeSystemAgentChatEngine(this: FakeEngine) {
    const engine = makeEngine();
    createdEngines.push(engine);
    Object.assign(this, engine);
  },
}));
vi.mock("../../system-agent/overview.js", () => ({
  formatSystemAgentStartupMessage: vi.fn(() => "welcome text"),
}));

const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

function seededSession(
  overrides: Omit<Partial<SystemAgentChatSession>, "engine"> & { engine?: FakeEngine } = {},
): SystemAgentChatSession {
  return {
    engine: makeEngine(),
    welcome: "welcome text",
    lastUsedAt: 1,
    ownerKey: "device:device-test",
    ...overrides,
  } as unknown as SystemAgentChatSession;
}

function fullSessions(oldest: SystemAgentChatSession) {
  return new Map([
    ["oldest", oldest],
    ...Array.from({ length: 7 }, (_, i): [string, SystemAgentChatSession] => [
      `existing-${i + 1}`,
      seededSession({ lastUsedAt: i + 1 }),
    ]),
  ]);
}

const welcomeQuestion = { id: "welcome-q", header: "Welcome", options: [] };
const chatHandler = expectDefined(systemAgentHandlers["openclaw.chat"], "chat handler");

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  hasCurrentClientAuthority = () => true,
  respond = vi.fn<RespondFn>(),
) {
  await chatHandler({
    params,
    client: defaultClient,
    context,
    respond,
    hasCurrentClientAuthority,
  } as never);
  const [ok, payload, error] = expectDefined(respond.mock.calls[0], "system-agent response");
  return { ok, payload, error };
}

const waitOneTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  createdEngines.length = 0;
  inferenceFallbackMocks.verify.mockResolvedValue({ ok: true, binding: {} });
  transcriptStoreMocks.appendReset.mockReset();
  transcriptStoreMocks.appendTurn.mockReset();
  transcriptStoreMocks.readTranscriptTailAsync.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
});

describe("openclaw.chat session lifecycle", () => {
  it.each([false, true])(
    "rejoins with the current wizard interaction when live=%s",
    async (live) => {
      const engine = makeEngine();
      const liveQuestion = { id: "wizard-q", header: "Pick", options: [{ label: "A" }] };
      const liveStep = { id: "step-1", type: "text", message: "Enter a value" };
      const interaction = {
        sensitive: true,
        wizardInputPending: true,
        question: liveQuestion,
        step: liveStep,
      };
      if (live) {
        engine.decorateRejoinReply = vi.fn((reply: Record<string, unknown>) => ({
          ...reply,
          ...interaction,
        }));
      }
      const session = seededSession({ engine, optionalWelcome: true });
      (session as { welcomeQuestion?: unknown }).welcomeQuestion = welcomeQuestion;
      const sessions = new Map<string, SystemAgentChatSession>([["s1", session]]);
      const call = await callChat(makeContext(sessions), { sessionId: "s1" });
      expect(call).toMatchObject({
        ok: true,
        payload: live
          ? {
              sessionId: "s1",
              optionalWelcome: false,
              ...interaction,
            }
          : { question: welcomeQuestion },
      });
      if (!live) {
        expect((call.payload as { step?: unknown }).step).toBeUndefined();
      }
    },
  );

  it("keeps the session map bounded during concurrent unique initialization", async () => {
    const evictionStarted = createDeferred();
    const releaseEviction = createDeferred();
    const oldest = seededSession({ lastUsedAt: 0 });
    oldest.engine.dispose = vi.fn(async () => {
      evictionStarted.resolve();
      await releaseEviction.promise;
    });
    const sessions = fullSessions(oldest);

    const context = makeContext(sessions);
    const first = callChat(context, { sessionId: "new-1" });
    const second = callChat(context, { sessionId: "new-2" });
    await evictionStarted.promise;
    await waitOneTask();
    releaseEviction.resolve();
    await Promise.all([first, second]);

    expect(oldest.engine.dispose).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(8);
    expect([sessions.has("new-1"), sessions.has("new-2")]).toEqual([true, true]);
  });

  it("disposes the unpublished engine when requester authority changes during eviction", async () => {
    let current = true;
    const oldest = seededSession({ lastUsedAt: 0 });
    oldest.engine.dispose = vi.fn(async () => {
      current = false;
    });
    const sessions = fullSessions(oldest);
    const respond = vi.fn();
    const pending = callChat(
      makeContext(sessions),
      { sessionId: "unpublished" },
      () => current,
      respond,
    );

    await expect(pending).rejects.toThrow("Gateway requester authority changed");
    expect(oldest.engine.dispose).toHaveBeenCalledOnce();
    expect(createdEngines[0]?.dispose).toHaveBeenCalledOnce();
    expect(sessions.has("unpublished")).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it("resets a session on request", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const reset = await callChat(context, { sessionId: "s1", reset: true });

    expect(engine.handle).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(reset.ok).toBe(true);
    expect(transcriptStoreMocks.appendReset).toHaveBeenCalledOnce();
    expect(createdEngines[0]?.seedHistory).not.toHaveBeenCalled();

    const turns = [
      { role: "user", text: "After reset" },
      { role: "assistant", text: "Fresh answer" },
    ] as const;
    transcriptStoreMocks.readTranscriptTailAsync.mockResolvedValue(
      turns.map((turn, at) => ({ ...turn, at })),
    );
    const fresh = await callChat(context, { sessionId: "fresh-after-reset" });

    expect(fresh.ok).toBe(true);
    expect(createdEngines.at(-1)?.seedHistory).toHaveBeenCalledWith(turns);
    expect(transcriptStoreMocks.readTranscriptTailAsync).toHaveBeenLastCalledWith(30, {
      afterLastReset: true,
    });
  });
});
