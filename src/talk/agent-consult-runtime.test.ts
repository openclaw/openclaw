import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedPiAgentParams } from "../agents/pi-embedded-runner/run/params.js";
import {
  __setRealtimeVoiceAgentConsultDepsForTest,
  consultRealtimeVoiceAgent,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "./agent-consult-tool.js";

function createAgentRuntime(payloads: unknown[] = [{ text: "Speak this." }]) {
  const sessionStore: Record<
    string,
    {
      sessionId?: string;
      updatedAt?: number;
      sessionFile?: string;
      spawnedBy?: string;
      forkedFromParent?: boolean;
      totalTokens?: number;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
      };
      lastChannel?: string;
      lastTo?: string;
      lastAccountId?: string;
      lastThreadId?: string | number;
    }
  > = {};
  const runEmbeddedPiAgent = vi.fn(async () => ({
    payloads,
    meta: {},
  }));
  const getSessionEntry = vi.fn(
    (params: { sessionKey: string }) => sessionStore[params.sessionKey],
  );
  const listSessionEntries = vi.fn(() =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  );
  const upsertSessionEntry = vi.fn(
    (params: { sessionKey: string; entry: (typeof sessionStore)[string] }) => {
      sessionStore[params.sessionKey] = params.entry;
    },
  );
  const patchSessionEntry = vi.fn(
    async (params: {
      sessionKey: string;
      fallbackEntry?: (typeof sessionStore)[string];
      update: (
        entry: (typeof sessionStore)[string],
      ) =>
        | Promise<Partial<(typeof sessionStore)[string]> | null>
        | Partial<(typeof sessionStore)[string]>
        | null;
    }) => {
      const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await params.update(existing);
      if (!patch) {
        return existing;
      }
      const next = { ...existing, ...patch };
      sessionStore[params.sessionKey] = next;
      return next;
    },
  );
  return {
    runtime: {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      session: {
        getSessionEntry,
        listSessionEntries,
        patchSessionEntry,
        upsertSessionEntry,
      },
      runEmbeddedPiAgent,
    },
    runEmbeddedPiAgent,
    sessionStore,
  };
}

function requireEmbeddedPiAgentCall(runEmbeddedPiAgent: {
  mock: { calls: unknown[][] };
}): RunEmbeddedPiAgentParams {
  const call = runEmbeddedPiAgent.mock.calls[0]?.[0] as RunEmbeddedPiAgentParams | undefined;
  if (!call) {
    throw new Error("Expected embedded PI agent call");
  }
  return call;
}

function expectPositiveTimestamp(value: unknown) {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThan(0);
}

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe("string");
  expect((value as string).trim()).not.toBe("");
}

describe("realtime voice agent consult runtime", () => {
  afterEach(() => {
    __setRealtimeVoiceAgentConsultDepsForTest(null);
  });

  it("exposes the shared consult tool based on policy", () => {
    expect(resolveRealtimeVoiceAgentConsultTools("safe-read-only")).toStrictEqual([
      REALTIME_VOICE_AGENT_CONSULT_TOOL,
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none")).toStrictEqual([]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only")).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("owner")).toBeUndefined();
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("none")).toStrictEqual([]);
  });

  it("runs an embedded agent using the shared session and prompt contract", async () => {
    const { runtime, runEmbeddedPiAgent, sessionStore } = createAgentRuntime();

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?", context: "Caller asked about PR #123." },
      transcript: [{ role: "user", text: "Can you check this?" }],
      surface: "a live phone call",
      userLabel: "Caller",
      questionSourceLabel: "caller",
      toolsAllow: ["read"],
      provider: "openai",
      model: "gpt-5.4",
      thinkLevel: "high",
      fastMode: true,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "Speak this." });
    const voiceSession = sessionStore["voice:15550001234"];
    if (!voiceSession) {
      throw new Error("Expected voice consult session entry");
    }
    expect(Object.keys(voiceSession).toSorted()).toStrictEqual(["sessionId", "updatedAt"]);
    expectNonEmptyString(voiceSession.sessionId);
    expectPositiveTimestamp(voiceSession.updatedAt);
    const call = requireEmbeddedPiAgentCall(runEmbeddedPiAgent);
    expect(call.sessionId).toBe(voiceSession.sessionId);
    expect(call.sessionKey).toBe("voice:15550001234");
    expect(call.sandboxSessionKey).toBe("agent:main:voice:15550001234");
    expect(call.agentId).toBe("main");
    expect(call.messageProvider).toBe("voice");
    expect(call.lane).toBe("voice");
    expect(call.toolsAllow).toStrictEqual(["read"]);
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-5.4");
    expect(call.thinkLevel).toBe("high");
    expect(call.fastMode).toBe(true);
    expect(call.timeoutMs).toBe(10_000);
    expect(call.prompt).toContain("Caller: Can you check this?");
    expect(call.extraSystemPrompt).toContain("delegated requests");
  });

  it("scopes sandbox resolution to the configured consult agent", async () => {
    const { runtime, runEmbeddedPiAgent } = createAgentRuntime();

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "voice",
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedPiAgentCall(runEmbeddedPiAgent);
    expect(call.sessionKey).toBe("voice:15550001234");
    expect(call.sandboxSessionKey).toBe("agent:voice:voice:15550001234");
    expect(call.agentId).toBe("voice");
  });

  it("returns a speakable fallback when the embedded agent has no visible text", async () => {
    const warn = vi.fn();
    const { runtime } = createAgentRuntime([{ text: "hidden", isReasoning: true }]);

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn },
      sessionKey: "google-meet:meet-1",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What now?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
      fallbackText: "Let me verify that first.",
    });

    expect(result).toEqual({ text: "Let me verify that first." });
    expect(warn).toHaveBeenCalledWith(
      "[talk] agent consult produced no answer: agent returned no speakable text",
    );
  });

  it("forks requester context when fork mode has a parent session", async () => {
    const { runtime, runEmbeddedPiAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:main"] = {
      sessionId: "parent-session",
      sessionFile: "/tmp/parent.jsonl",
      totalTokens: 100,
      updatedAt: 1,
    };
    const resolveParentForkDecision = vi.fn(async () => ({
      status: "fork" as const,
      maxTokens: 100_000,
      parentTokens: 100,
    }));
    const forkSessionFromParent = vi.fn(async () => ({
      sessionId: "forked-session",
      sessionFile: "sqlite-transcript://main/forked-session.jsonl",
    }));
    __setRealtimeVoiceAgentConsultDepsForTest({
      resolveParentForkDecision,
      forkSessionFromParent,
    });

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      spawnedBy: "agent:main:main",
      contextMode: "fork",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
    });

    expect(resolveParentForkDecision).toHaveBeenCalledWith({
      parentEntry: sessionStore["agent:main:main"],
      agentId: "main",
    });
    expect(forkSessionFromParent).toHaveBeenCalledWith({
      parentEntry: sessionStore["agent:main:main"],
      agentId: "main",
    });
    const forkedEntry = sessionStore["agent:main:subagent:google-meet:meet-1"];
    if (!forkedEntry) {
      throw new Error("Expected forked consult session entry");
    }
    expect(forkedEntry).toMatchObject({
      sessionId: "forked-session",
      spawnedBy: "agent:main:main",
      forkedFromParent: true,
    });
    expectPositiveTimestamp(forkedEntry.updatedAt);
    const call = requireEmbeddedPiAgentCall(runEmbeddedPiAgent);
    expect(call.sessionId).toBe("forked-session");
    expect(call.spawnedBy).toBe("agent:main:main");
  });

  it("inherits requester message routing for forked consult sessions", async () => {
    const { runtime, runEmbeddedPiAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:discord:channel:123"] = {
      sessionId: "parent-session",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
      },
      updatedAt: 1,
    };

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "voice:google-meet:meet-1",
      spawnedBy: "agent:main:discord:channel:123",
      contextMode: "fork",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "Send a status message." },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedPiAgentCall(runEmbeddedPiAgent);
    expect(call.sessionKey).toBe("voice:google-meet:meet-1");
    expect(call.spawnedBy).toBe("agent:main:discord:channel:123");
    expect(call.messageProvider).toBe("discord");
    expect(call.agentAccountId).toBe("default");
    expect(call.messageTo).toBe("channel:123");
    expect(call.currentChannelId).toBe("channel:123");
    const voiceEntry = sessionStore["voice:google-meet:meet-1"];
    if (!voiceEntry) {
      throw new Error("Expected voice consult session entry");
    }
    expect(voiceEntry).toStrictEqual({
      sessionId: voiceEntry.sessionId,
      spawnedBy: "agent:main:discord:channel:123",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
      },
      lastChannel: "discord",
      lastTo: "channel:123",
      lastAccountId: "default",
      lastThreadId: undefined,
      updatedAt: voiceEntry.updatedAt,
    });
    expectNonEmptyString(voiceEntry.sessionId);
    expectPositiveTimestamp(voiceEntry.updatedAt);
  });

  it("reuses the call session delivery context when requester metadata is absent", async () => {
    const { runtime, runEmbeddedPiAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:google-meet:meet-1"] = {
      sessionId: "call-session",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
        threadId: "thread-456",
      },
      updatedAt: 1,
    };

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "voice:google-meet:meet-1",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "Send this to the original chat." },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedPiAgentCall(runEmbeddedPiAgent);
    expect(call.sessionId).toBe("call-session");
    expect(call.sessionKey).toBe("voice:google-meet:meet-1");
    expect(call.messageProvider).toBe("discord");
    expect(call.agentAccountId).toBe("default");
    expect(call.messageTo).toBe("channel:123");
    expect(call.messageThreadId).toBe("thread-456");
    expect(call.currentChannelId).toBe("channel:123");
    expect(call.currentThreadTs).toBe("thread-456");
  });
});
