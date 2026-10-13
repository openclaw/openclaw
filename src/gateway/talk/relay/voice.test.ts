import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
} from "../../../talk/client-voice-session-lifecycle.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { RelaySession } from "./state.js";
import {
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
  ensureRelayVoiceSession,
} from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
  captureClientVoiceSessionWriter: vi.fn(),
  captureClientVoiceSessionSource: vi.fn(),
}));

// mock-isolation: The queue policy is exercised without durable voice state.
vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);
// mock-isolation: Queue-only cases bypass state admission; the refusal regression restores it.
vi.mock("../../../talk/client-voice-session-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-lifecycle.js")>();
  return {
    ...actual,
    withClientVoiceSessionSettlement: vi.fn(actual.withClientVoiceSessionSettlement),
  };
});
// mock-isolation: The mocked voice store has no physical database to borrow.
vi.mock("../../../talk/client-voice-session-write.js", () => ({
  captureClientVoiceSessionWriter: voiceSessionMocks.captureClientVoiceSessionWriter,
}));
// mock-isolation: The queue-only fixture has no physical voice database to capture.
vi.mock("../../../talk/client-voice-session-source.js", () => ({
  captureClientVoiceSessionSource: voiceSessionMocks.captureClientVoiceSessionSource,
}));
// mock-isolation: Exercise retry decisions without wall-clock backoff.
vi.mock("../../../utils/sleep.js", () => ({ sleep: async () => {} }));

function createRelaySession(refuseCloseSource = false): {
  session: RelaySession;
  failSession: ReturnType<typeof vi.fn>;
} {
  const failSession = vi.fn(() => {
    if (refuseCloseSource) {
      const capture = voiceSessionMocks.captureClientVoiceSessionWriter.getMockImplementation()!;
      voiceSessionMocks.captureClientVoiceSessionWriter.mockImplementation((...args) => {
        if (session.voiceTranscriptQueue.isIdle) {
          throw new Error("Voice source was replaced before close");
        }
        return capture(...args);
      });
    }
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
    confirmationReadiness: createClientVoiceConfirmationReadiness({
      agentId: "main",
      voiceSessionId: "relay-voice-bounded",
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
    vi.mocked(withClientVoiceSessionSettlement).mockImplementation((run) => run());
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset().mockResolvedValue("voice");
    const source = { assertCurrent: () => {} };
    voiceSessionMocks.captureClientVoiceSessionSource.mockReset().mockReturnValue(source);
    voiceSessionMocks.captureClientVoiceSessionWriter
      .mockReset()
      .mockImplementation(() => ({ source, release: () => Promise.resolve() }));
  });

  it("joins its accepted prefix after close settlement admission is lost", async () => {
    const lifecycle = await vi.importActual<
      typeof import("../../../talk/client-voice-session-lifecycle.js")
    >("../../../talk/client-voice-session-lifecycle.js");
    vi.mocked(withClientVoiceSessionSettlement).mockImplementation(
      lifecycle.withClientVoiceSessionSettlement,
    );
    await withOpenClawTestState({ scenario: "minimal", label: "relay-close-refusal" }, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const append = createDeferred();
      const entered = createDeferred();
      voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(async () => {
        entered.resolve();
        await append.promise;
      });
      const { session } = createRelaySession();
      const entryError = new Error("relay queue entry refused");
      const enqueue = vi
        .spyOn(session.voiceTranscriptQueue, "enqueue")
        .mockImplementationOnce(() => {
          throw entryError;
        });
      try {
        expect(enqueueRelayVoiceTranscript(session, "user", "not accepted")).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(session.context.logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining(entryError.message),
        );
      } finally {
        enqueue.mockRestore();
      }
      expect(session.voiceTranscriptSeq).toBe(0);
      expect(enqueueRelayVoiceTranscript(session, "user", "accepted")).toBe(true);
      const accepted = captureClientVoiceSessionSettlement();
      const close = accepted.run(() =>
        AsyncLocalStorage.bind(() => closeRelayVoiceSession(session)),
      );
      accepted.release();
      const closing = close();
      let settled = false;
      void closing.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
        append.resolve();
        await closing;
        expect(session.voiceTranscriptQueue.isIdle).toBe(true);
        expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
      } finally {
        append.resolve();
        await closing;
        vi.useRealTimers();
      }
    });
  });

  it.each([false, true])("retries only a known failed creation (unknown=%s)", async (unknown) => {
    const failure = unknown
      ? new SqliteWorkerError("Creation settlement is unknown", "outcome-unknown")
      : new Error("Creation was refused");
    voiceSessionMocks.createOrResumeClientVoiceSession.mockRejectedValueOnce(failure);
    const { session } = createRelaySession();
    expect(await ensureRelayVoiceSession(session)).toBe(false);
    expect(await ensureRelayVoiceSession(session)).toBe(!unknown);
    expect(voiceSessionMocks.createOrResumeClientVoiceSession).toHaveBeenCalledTimes(
      unknown ? 1 : 2,
    );
  });

  it("does not replay an append after an unknown worker outcome", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockRejectedValue(
      new SqliteWorkerError("Transcript settlement is unknown", "outcome-unknown"),
    );
    const { session } = createRelaySession();
    expect(enqueueRelayVoiceTranscript(session, "user", "Keep this accepted utterance")).toBe(true);
    await session.voiceTranscriptQueue.flush();
    await closeRelayVoiceSession(session);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
    expect(session.context.logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("Transcript settlement is unknown"),
    );
  });

  it("closes a voice created by a later accepted transcript after the first creation fails", async () => {
    const firstCreation = createDeferred<string>();
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReturnValueOnce(firstCreation.promise);
    const { session } = createRelaySession();
    expect(enqueueRelayVoiceTranscript(session, "user", "First accepted utterance")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "user", "Later accepted utterance")).toBe(true);
    const closing = closeRelayVoiceSession(session);
    firstCreation.reject(new Error("First creation was refused"));
    await closing;
    expect(voiceSessionMocks.createOrResumeClientVoiceSession).toHaveBeenCalledTimes(2);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entryId: "2", text: "Later accepted utterance" }),
      expect.objectContaining({ release: expect.any(Function) }),
    );
    expect(session.voiceTranscriptQueue.isIdle).toBe(true);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ voiceSessionId: session.id }),
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it.each([false, true])(
    "drains bounded finals before close settles (source refused=%s)",
    async (refuseCloseSource) => {
      const firstAppend = createDeferred();
      const appendEntered = createDeferred();
      voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
        async ({ entryId }: { entryId: string }) => {
          if (entryId === "1") {
            appendEntered.resolve();
            await firstAppend.promise;
          }
        },
      );
      const { session, failSession } = createRelaySession(refuseCloseSource);
      let accepted = enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `)
        ? 1
        : 0;

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
      await appendEntered.promise;
      expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey: "main",
          sessionTarget: {
            sessionKey: "agent:main:work",
            storePath: "/tmp/relay-voice-sessions.sqlite",
          },
        }),
        expect.objectContaining({ release: expect.any(Function) }),
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
      expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledTimes(
        refuseCloseSource ? 0 : 1,
      );
      if (refuseCloseSource) {
        expect(session.context.logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("Voice source was replaced before close"),
        );
      }
      expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
    },
  );
});
