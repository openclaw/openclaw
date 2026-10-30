import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

type ForkSessionEntryFromParent =
  typeof import("../auto-reply/reply/session-fork.js").forkSessionEntryFromParent;

const forkSessionEntryFromParent = vi.hoisted(() => vi.fn<ForkSessionEntryFromParent>());

vi.mock("../auto-reply/reply/session-fork.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/reply/session-fork.js")>();
  return {
    ...actual,
    forkSessionEntryFromParent,
  };
});

let state: OpenClawTestState;

function createAgentRuntime(payloads: unknown[] = [{ text: "Speak this." }]) {
  const sessionStore: Record<string, SessionEntry> = {};
  const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    payloads,
    meta: {},
  }));
  const prepareSessionEntryPatch = vi.fn<
    ConsultParams["agentRuntime"]["session"]["prepareSessionEntryPatch"]
  >(async (params) => {
    const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
    if (!existing) {
      return null;
    }
    const patch = await params.prepare(
      { ...existing },
      { existingEntry: sessionStore[params.sessionKey] },
    );
    if (params.authority?.kind !== "host") {
      throw new Error("Expected host session authority");
    }
    params.authority.assertCurrent();
    if (!patch) {
      return existing;
    }
    const next = { ...existing, ...patch };
    sessionStore[params.sessionKey] = next;
    return next;
  });
  return {
    runtime: {
      resolveAgentDir: vi.fn(() => state.statePath("agent")),
      resolveAgentWorkspaceDir: vi.fn(() => state.statePath("workspace")),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      session: {
        resolveStorePath: vi.fn(() => state.statePath("sessions.json")),
        getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey],
        getSessionEntryAsync: async ({ sessionKey }: { sessionKey: string }) =>
          sessionStore[sessionKey],
        prepareSessionEntryPatch,
      },
      runEmbeddedAgent,
    },
    runEmbeddedAgent,
    sessionStore,
  };
}

type ConsultParams = Parameters<typeof consultRealtimeVoiceAgent>[0];
type TestRuntime = ReturnType<typeof createAgentRuntime>["runtime"];

function runConsult(runtime: TestRuntime, params: Partial<ConsultParams> = {}) {
  return consultRealtimeVoiceAgent({
    agentRuntime: runtime as never,
    cfg: {},
    logger: { warn: vi.fn() },
    messageProvider: "voice",
    lane: "voice",
    transcript: [],
    surface: "a live phone call",
    userLabel: "Caller",
    sessionKey: "voice:consult",
    runIdPrefix: "voice-consult",
    args: { question: "What should I say?" },
    ...params,
  });
}

function expectNoDispatch(runtime: TestRuntime) {
  expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
  expect(runtime.session.prepareSessionEntryPatch).not.toHaveBeenCalled();
  expect(runtime.runEmbeddedAgent).not.toHaveBeenCalled();
}

const requesterSessionKey = "agent:main:main";
const forkSessionKey = "agent:main:subagent:google-meet:meet-1";
const lockedEntry = { updatedAt: 1, agentHarnessId: "codex", modelSelectionLocked: true };
const forkConsult = (runtime: TestRuntime, params: Partial<ConsultParams> = {}) =>
  runConsult(runtime, {
    sessionKey: forkSessionKey,
    spawnedBy: requesterSessionKey,
    contextMode: "fork",
    messageProvider: "google-meet",
    lane: "google-meet",
    surface: "a private Google Meet",
    userLabel: "Participant",
    ...params,
  });

function requireEmbeddedAgentCall(
  runEmbeddedAgent: ReturnType<typeof createAgentRuntime>["runEmbeddedAgent"],
): RunEmbeddedAgentParams {
  return expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "embedded OpenClaw agent call");
}

function expectForkTarget(call: RunEmbeddedAgentParams, sessionId = call.sessionId) {
  expect(call.sessionFile).toBeUndefined();
  expect(call.spawnedBy).toBe(requesterSessionKey);
  expect(call.sessionTarget).toMatchObject({
    agentId: "main",
    sessionId,
    sessionKey: forkSessionKey,
    storePath: state.statePath("sessions.json"),
  });
}

describe("realtime voice agent consult runtime", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../auto-reply/reply/session-fork.js")>(
      "../auto-reply/reply/session-fork.js",
    );
    forkSessionEntryFromParent.mockImplementation(actual.forkSessionEntryFromParent);
    state = await createOpenClawTestState({ label: "talk-consult", layout: "state-only" });
  });

  afterEach(async () => {
    forkSessionEntryFromParent.mockReset();
    clientVoiceSessionTesting.reset();
    await state.cleanup();
  });

  it("does not start a consult after its caller has closed", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const controller = new AbortController();
    controller.abort(new Error("voice session closed"));

    await expect(runConsult(runtime, { abortSignal: controller.signal })).rejects.toThrow(
      "voice session closed",
    );
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "waits for run registration and releases it after cancellation=%s",
    async (cancelled) => {
      const { runtime, runEmbeddedAgent } = createAgentRuntime();
      const entered = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      const cleanup = vi.fn();
      const consult = runConsult(runtime, {
        abortSignal: controller.signal,
        onRunStarted: async () => {
          entered.resolve();
          await release.promise;
          return { cleanup };
        },
      });
      await entered.promise;
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      if (cancelled) {
        controller.abort(new Error("voice session closed during registration"));
      }
      release.resolve();
      if (cancelled) {
        await expect(consult).rejects.toThrow("voice session closed during registration");
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
      } else {
        await expect(consult).resolves.toEqual({ text: "Speak this." });
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      }
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  it("retains the voice binding until delegated run completion", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const started = createDeferred();
    const release = createDeferred();
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      transcriptCapable: true,
      voiceSessionId: "voice-gpt-live",
    });
    let runId: string | undefined;
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      const binding = resolveClientVoiceRunBinding(params.runId);
      expect(binding).toMatchObject({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
      });
      started.resolve();
      await release.promise;
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId: params.runId,
        durationMs: 5,
        outcome: "completed",
      });
      return { payloads: [{ text: "Done." }], meta: {} };
    });

    const consult = runConsult(runtime, {
      agentId: "main",
      sessionKey: "agent:main:main",
      messageProvider: "webchat",
      lane: "talk",
      onRunStarted: async (startedRun) => {
        runId = startedRun.runId;
        await registerClientVoiceConsultRun({
          agentId: "main",
          sessionKey: "agent:main:main",
          voiceSessionId,
          runId: startedRun.runId,
        });
      },
    });

    await started.promise;
    expect(runId).toEqual(expect.any(String));
    release.resolve();
    await expect(consult).resolves.toEqual({ text: "Done." });
    await waitForDiagnosticEventsDrained();
    expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
  });

  it("runs an embedded agent using the shared session and prompt contract", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
      setReplyPayloadMetadata({ text: "Earlier answer." }, { precedingInputAnswer: true }),
      { text: "Speak this." },
      { text: "Then this." },
    ]);

    const runOptions = {
      senderId: "+15550001234",
      senderIsOwner: true,
      toolsAllow: ["read"],
      toolBindings: { voice_call: { kind: "active-call", callId: "call-1" } },
      provider: "openai",
      model: "gpt-5.4",
      thinkLevel: "high",
      fastMode: true,
      timeoutMs: 10_000,
    } satisfies Partial<ConsultParams>;
    const result = await runConsult(runtime, {
      ...runOptions,
      cfg: { agents: { entries: { operator: {} } } },
      sessionKey: "voice:15550001234",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?", context: "Caller asked about PR #123." },
      transcript: [
        { role: "user", text: "Can you check this?" },
        { role: "assistant", text: "I'll verify." },
      ],
      assistantLabel: "Agent",
      questionSourceLabel: "caller",
    });

    expect(result).toEqual({ text: "Speak this.\n\nThen this." });
    const voiceSession = expectDefined(sessionStore["voice:15550001234"], "voice session");
    expect(voiceSession).toStrictEqual({
      createdAt: expect.any(Number),
      createdVia: "talk",
      sessionId: expect.any(String),
      updatedAt: expect.any(Number),
    });
    expect(voiceSession.createdAt).toBeGreaterThan(0);
    expect(voiceSession.sessionId).toMatch(/\S/u);
    expect(voiceSession.updatedAt).toBeGreaterThan(0);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call).toMatchObject({
      ...runOptions,
      sessionId: voiceSession.sessionId,
      sessionKey: "voice:15550001234",
      sandboxSessionKey: "agent:operator:voice:15550001234",
      agentId: "operator",
      messageProvider: "voice",
      lane: "voice",
    });
    expect(call.toolsAllow).toStrictEqual(runOptions.toolsAllow);
    expect(call.toolBindings).toStrictEqual(runOptions.toolBindings);
    expect(call.prompt).toBe(
      [
        "Live voice request from the caller during a live phone call.",
        "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
        "When finished, return only the concise result the realtime voice agent should speak back.",
        "Report a security or approval block only when an actual tool result says so. Distinguish tool errors from permission denials; do not invent a blocked attempt. If a read-only call fails, correct the tool or arguments and continue when possible.",
        "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
        "Recent voice transcript for context:\nCaller: Can you check this?\nAgent: I'll verify.",
        "Additional realtime context:\nCaller asked about PR #123.",
        "User request:\nWhat should I say?",
      ].join("\n\n"),
    );
    expect(call.extraSystemPrompt).toBe(
      "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
    );
  });

  it.each(["consult", "requester"])(
    "fails closed before forking or dispatching from a locked %s session",
    async (lockedSession) => {
      const { runtime, sessionStore } = createAgentRuntime();
      const requester = lockedSession === "requester";
      sessionStore[requester ? requesterSessionKey : "voice:locked"] = {
        ...lockedEntry,
        sessionId: requester ? "locked-requester" : "locked-session",
      };
      const consult = requester
        ? forkConsult(runtime, {
            sessionKey: "agent:main:subagent:google-meet:meet-locked",
          })
        : runConsult(runtime, { sessionKey: "voice:locked", provider: "openai", model: "gpt-5.4" });
      await expect(consult).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
      expect(forkSessionEntryFromParent).not.toHaveBeenCalled();
      expectNoDispatch(runtime);
    },
  );

  it("allows an independent consult when only the requester session is locked", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore[requesterSessionKey] = { ...lockedEntry, sessionId: "locked-requester" };

    await expect(
      forkConsult(runtime, {
        agentId: "meet-consult",
        sessionKey: "agent:meet-consult:subagent:google-meet:meet-independent",
      }),
    ).resolves.toEqual({ text: "Speak this." });
    expect(forkSessionEntryFromParent).not.toHaveBeenCalled();
    expect(requireEmbeddedAgentCall(runEmbeddedAgent).agentId).toBe("meet-consult");
  });

  it("fresh-checks archive state after a queued lifecycle mutation", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    const sessionKey = "voice:archive-race";
    sessionStore[sessionKey] = { sessionId: "active-session", updatedAt: 1 };
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: state.statePath("sessions.json"),
      identities: [sessionKey, "active-session"],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        const entry = sessionStore[sessionKey];
        if (entry) {
          entry.archivedAt = 2;
        }
      },
    });
    await mutationStarted.promise;

    const consult = runConsult(runtime, { sessionKey });
    await Promise.resolve();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await mutation;
    await expect(consult).rejects.toThrow(
      'Session "voice:archive-race" is archived. Restore it before starting new work.',
    );
    expectNoDispatch(runtime);
  });

  it.each([
    { label: "cancellation", meta: { aborted: true }, errorName: "AbortError" },
    {
      label: "timeout",
      meta: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      errorName: "TimeoutError",
    },
  ])("preserves $label instead of speaking a partial result", async ({ meta, errorName }) => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const cleanup = vi.fn();
    runEmbeddedAgent.mockResolvedValueOnce({ payloads: [{ text: "Partial answer." }], meta });

    await expect(runConsult(runtime, { onRunStarted: () => ({ cleanup }) })).rejects.toMatchObject({
      name: errorName,
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("returns a speakable fallback when the embedded agent has no visible text", async () => {
    const warn = vi.fn();
    const { runtime } = createAgentRuntime([
      setReplyPayloadMetadata({ text: "Earlier answer." }, { precedingInputAnswer: true }),
      { text: "hidden", isReasoning: true },
    ]);

    const result = await runConsult(runtime, {
      logger: { warn },
      fallbackText: "Let me verify that first.",
    });

    expect(result).toEqual({ text: "Let me verify that first." });
    expect(warn).toHaveBeenCalledWith(
      "[talk] agent consult produced no answer: agent returned no speakable text",
    );
  });

  it("returns a yielded acknowledgement immediately without waiting for a visible final", async () => {
    const warn = vi.fn();
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    runEmbeddedAgent.mockResolvedValueOnce({
      payloads: [],
      meta: { yielded: true, yieldAcknowledgment: "  Working on it.   I will report back.  " },
    });

    const result = await runConsult(runtime, { logger: { warn } });

    expect(result).toEqual({ text: "Working on it. I will report back.", yielded: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("forks requester context and inherits its required creator isolation", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    const parentEntry: SessionEntry = {
      sessionId: "parent-session",
      createdActor: { type: "human", source: "profile", id: "profile-required" },
      sandbox: "required",
      updatedAt: 1,
    };
    sessionStore[requesterSessionKey] = parentEntry;
    forkSessionEntryFromParent.mockImplementation(async (params) => {
      const fork = { sessionId: "forked-session", sessionFile: state.statePath("forked.jsonl") };
      const sessionEntry: SessionEntry = {
        ...(params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() }),
        ...params.entryPatch?.forked,
        sessionId: fork.sessionId,
        forkedFromParent: true,
      };
      sessionStore[params.sessionKey] = sessionEntry;
      return {
        status: "forked" as const,
        fork,
        parentEntry,
        sessionEntry,
        decision: { status: "fork", maxTokens: 100_000 },
      };
    });

    await forkConsult(runtime);

    const forkedEntry = expectDefined(sessionStore[forkSessionKey], "forked voice session");
    expect(forkedEntry).toStrictEqual({
      sessionId: "forked-session",
      spawnedBy: "agent:main:main",
      spawnedBySessionId: "parent-session",
      parentSessionLifecycleRevision: undefined,
      spawnedBySenderIsOwner: false,
      forkedFromParent: true,
      createdVia: "talk",
      createdActor: { type: "human", source: "profile", id: "profile-required" },
      sandbox: "required",
      createdAt: forkedEntry.createdAt,
      updatedAt: forkedEntry.updatedAt,
    });
    expect(forkedEntry.updatedAt).toEqual(expect.any(Number));
    expect(forkedEntry.updatedAt).toBeGreaterThan(0);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("forked-session");
    expectForkTarget(call, "forked-session");
  });

  it("falls back to a fresh isolated consult session when requester context is too large", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const warn = vi.fn();
    forkSessionEntryFromParent.mockImplementation(async (params) => ({
      status: "skipped",
      reason: "decision-skip",
      sessionEntry: { ...params.fallbackEntry, sessionId: "", updatedAt: Date.now() },
      decision: {
        status: "skip",
        reason: "parent-too-large",
        maxTokens: 100_000,
        parentTokens: 150_000,
        message:
          "Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
      },
    }));

    await forkConsult(runtime, { logger: { warn } });

    expect(warn).toHaveBeenCalledWith(
      "[talk] Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
    );
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toMatch(/\S/u);
    expectForkTarget(call);
  });

  it("reuses current call permissions and delivery without enabling owner trace", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:google-meet:meet-1"] = {
      sessionId: "call-session",
      permissionMode: "workspace",
      toolOverrides: { webSearch: false },
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          threadId: "thread-456",
        },
      }),
      updatedAt: 1,
    };

    await runConsult(runtime, { sessionKey: "voice:google-meet:meet-1", senderIsOwner: true });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call).toMatchObject({
      sessionId: "call-session",
      sessionKey: "voice:google-meet:meet-1",
      messageProvider: "discord",
      agentAccountId: "default",
      messageTo: "channel:123",
      messageThreadId: "thread-456",
      currentChannelId: "channel:123",
      currentThreadTs: "thread-456",
      permissionMode: "workspace",
      toolOverrides: { webSearch: false },
      traceAuthorized: false,
    });
  });
});
