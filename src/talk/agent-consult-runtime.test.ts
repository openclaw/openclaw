import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../config/sessions/paths.js";
import {
  __setRealtimeVoiceAgentConsultDepsForTest,
  consultRealtimeVoiceAgent,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "./agent-consult-tool.js";

function createAgentRuntime(payloads: unknown[] = [{ text: "Speak this." }]) {
  const sessionStore: Record<
    string,
    {
      sessionId?: string;
      updatedAt?: number;
      transcriptLocator?: string;
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

describe("realtime voice agent consult runtime", () => {
  afterEach(() => {
    __setRealtimeVoiceAgentConsultDepsForTest(null);
  });

  it("exposes the shared consult tool based on policy", () => {
    expect(resolveRealtimeVoiceAgentConsultTools("safe-read-only")).toEqual([
      expect.objectContaining({ name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME }),
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none")).toEqual([]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only")).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("owner")).toBeUndefined();
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("none")).toEqual([]);
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
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "Speak this." });
    const voiceSession = sessionStore["voice:15550001234"];
    if (!voiceSession) {
      throw new Error("Expected voice consult session entry");
    }
    expect(voiceSession.sessionId).toEqual(expect.stringMatching(/\S/));
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "voice:15550001234",
        sandboxSessionKey: "agent:main:voice:15550001234",
        agentId: "main",
        messageProvider: "voice",
        lane: "voice",
        toolsAllow: ["read"],
        provider: "openai",
        model: "gpt-5.4",
        thinkLevel: "high",
        timeoutMs: 10_000,
        prompt: expect.stringContaining("Caller: Can you check this?"),
        extraSystemPrompt: expect.stringContaining("delegated requests"),
      }),
    );
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

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "voice:15550001234",
        sandboxSessionKey: "agent:voice:voice:15550001234",
        agentId: "voice",
      }),
    );
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
      transcriptLocator: createSqliteSessionTranscriptLocator({
        agentId: "main",
        sessionId: "parent-session",
      }),
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
      transcriptLocator: "sqlite-transcript://main/forked-session",
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
    expect(sessionStore["agent:main:subagent:google-meet:meet-1"]).toMatchObject({
      sessionId: "forked-session",
      spawnedBy: "agent:main:main",
      forkedFromParent: true,
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "forked-session",
        spawnedBy: "agent:main:main",
      }),
    );
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

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "voice:google-meet:meet-1",
        spawnedBy: "agent:main:discord:channel:123",
        messageProvider: "discord",
        agentAccountId: "default",
        messageTo: "channel:123",
        currentChannelId: "channel:123",
      }),
    );
    expect(sessionStore["voice:google-meet:meet-1"]).toMatchObject({
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
      },
      lastChannel: "discord",
      lastTo: "channel:123",
      lastAccountId: "default",
    });
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

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "call-session",
        sessionKey: "voice:google-meet:meet-1",
        messageProvider: "discord",
        agentAccountId: "default",
        messageTo: "channel:123",
        messageThreadId: "thread-456",
        currentChannelId: "channel:123",
        currentThreadTs: "thread-456",
      }),
    );
  });
});
