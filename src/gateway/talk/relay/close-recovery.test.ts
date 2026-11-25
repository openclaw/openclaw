/** Regression for #204615: an admission-failed close must stay retryable. */
import { beforeEach, expect, it, vi } from "vitest";
import { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import { closeRelaySession } from "./operations.js";
import { drainingRelaySessions, type RelaySession } from "./state.js";

const voiceSessionMocks = vi.hoisted(() => ({
  closeRelayVoiceSessionRecord: vi.fn(),
  captureClientVoiceSessionWriter: vi.fn(),
  captureClientVoiceSessionSource: vi.fn(),
}));

// mock-isolation: the recovery path exercises the durable close through the
// same mocked voice modules as the queue-only relay tests.
vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);
vi.mock("../../../talk/client-voice-session-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-lifecycle.js")>();
  return {
    ...actual,
    withClientVoiceSessionSettlement: vi.fn(actual.withClientVoiceSessionSettlement),
  };
});
vi.mock("../../../talk/client-voice-session-source.js", () => ({
  captureClientVoiceSessionWriter: voiceSessionMocks.captureClientVoiceSessionWriter,
  captureClientVoiceSessionSource: voiceSessionMocks.captureClientVoiceSessionSource,
}));
vi.mock("../../../utils/sleep.js", () => ({ sleep: async () => {} }));

const { closeRelayVoiceSessionRecord: closeRecord } = voiceSessionMocks;

function createRecoverableSession() {
  const queue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
  const source = { assertCurrent: () => {}, prepareCurrent: async () => {} };
  const session = {
    id: "relay-close-recovery",
    connId: "conn-1",
    provider: "openai",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
      assertCurrent: () => {},
    },
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
      broadcastToConnIds: vi.fn(),
    },
    transcriptReadiness: createClientVoiceTranscriptReadiness({
      flushTranscript: () => queue.flush(),
    }),
    voiceSessionCreated: true,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: queue,
    voiceSessionSource: source,
    harness: { close: vi.fn(), talk: { emit: vi.fn(() => undefined), cancelTurn: vi.fn() } },
    bridge: { close: vi.fn(async () => {}) },
    cleanupTimer: { unref: vi.fn() },
    activeAgentRuns: new Map(),
    activeAgentToolCalls: new Map(),
    outputOwnership: { drain: undefined },
    failSession: vi.fn(),
  } as unknown as RelaySession;
  return { session, source };
}

beforeEach(() => {
  voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
  voiceSessionMocks.captureClientVoiceSessionWriter.mockReset().mockImplementation(() => ({
    source: { assertCurrent: () => {}, prepareCurrent: async () => {} },
    release: async () => {},
  }));
  drainingRelaySessions.clear();
});

it("keeps an admission-failed close retryable and settles the durable record on retry", async () => {
  const { session, source } = createRecoverableSession();

  // Lose the close source: close admission throws, then recovers.
  session.voiceSessionSource = {
    assertCurrent: () => {
      throw new Error("close admission refused");
    },
    prepareCurrent: async () => {
      throw new Error("close admission refused");
    },
  } as never;

  await expect(Promise.resolve(closeRelaySession(session, "error"))).rejects.toThrow(
    "close admission refused",
  );
  // The transcript flush must not become the durable close latch, and the
  // session must stay discoverable for a later close attempt (#204615).
  expect(session.voiceSessionClose).toBeUndefined();
  expect(session.voiceTranscriptQueue.isIdle).toBe(true);
  expect(drainingRelaySessions.has(session)).toBe(true);
  expect(closeRecord).not.toHaveBeenCalled();

  // Restore the source; the next close attempt runs the real durable close.
  session.voiceSessionSource = source as never;
  const retried = closeRelaySession(session, "completed");
  expect(retried).toBeInstanceOf(Promise);
  // Later callers join the same retry completion instead of the rejected
  // close completion (#204615).
  expect(closeRelaySession(session, "completed")).toBe(retried);
  await Promise.resolve(retried);
  expect(closeRecord).toHaveBeenCalledOnce();
  expect(drainingRelaySessions.has(session)).toBe(false);
});
