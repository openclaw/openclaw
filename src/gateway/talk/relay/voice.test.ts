import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import type { RelaySession } from "./state.js";
import { closeRelayVoiceSession, enqueueRelayVoiceTranscript } from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
}));

vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);

function createRelaySession(): {
  session: RelaySession;
  failSession: ReturnType<typeof vi.fn>;
} {
  const failSession = vi.fn(() => {
    void closeRelayVoiceSession(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    transcriptReadiness: createClientVoiceTranscriptReadiness({
      flushTranscript: async () => await session.voiceTranscriptQueue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset();
  });

  it("bounds stalled finals, drains the accepted prefix, and closes once", async () => {
    const firstAppend = createDeferred();
    voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
      async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") {
          await firstAppend.promise;
        }
      },
    );
    const { session, failSession } = createRelaySession();
    let accepted = enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `) ? 1 : 0;

    for (let index = 0; index < 10_000; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
    }

    for (let index = 1; index < 10_000; index += 1) {
      if (
        enqueueRelayVoiceTranscript(
          session,
          index % 2 === 0 ? "user" : "assistant",
          `  ${"x".repeat(9_000)}  `,
        )
      ) {
        accepted += 1;
      }
    }

    expect(accepted).toBe(41);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "main",
        sessionTarget: {
          sessionKey: "agent:main:work",
          storePath: "/tmp/relay-voice-sessions.sqlite",
        },
      }),
    );
    expect(failSession).toHaveBeenCalledOnce();
    const close = session.voiceSessionClose;
    expect(close).toBeDefined();
    expect(closeRelayVoiceSession(session)).toBe(close);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();

    firstAppend.resolve();
    await close;

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(41);
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { entryId: string }).entryId,
      ),
    ).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.every(
        ([params]) => (params as { text: string }).text.length === 8_000,
      ),
    ).toBe(true);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
    expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
  });
});
