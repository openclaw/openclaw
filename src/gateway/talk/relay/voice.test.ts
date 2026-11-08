import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
} from "../../../talk/client-voice-session-lifecycle.js";
import { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { RelaySession } from "./state.js";
import {
  closeRelayVoiceSession as closeVoice,
  enqueueRelayVoiceTranscript as enqueue,
  ensureRelayVoiceSession as ensureVoice,
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

const {
  appendRelayVoiceTranscript: appendTranscript,
  closeRelayVoiceSessionRecord: closeRecord,
  createOrResumeClientVoiceSession: createVoice,
  captureClientVoiceSessionWriter: captureWriter,
  captureClientVoiceSessionSource: captureSource,
} = voiceSessionMocks;

const agent = { agentId: "main", sessionKey: "main" };
const transcriptTarget = {
  sessionKey: "agent:main:work",
  storePath: "/tmp/relay-voice-sessions.sqlite",
};

function createRelaySession(refuseCloseSource = false) {
  const queue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
  const failSession = vi.fn(() => {
    if (refuseCloseSource) {
      const capture = captureWriter.getMockImplementation()!;
      captureWriter.mockImplementation((...args) => {
        if (queue.isIdle) {
          throw new Error("Voice source was replaced before close");
        }
        return capture(...args);
      });
    }
    void closeVoice(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      ...agent,
      canonicalKey: transcriptTarget.sessionKey,
      storePath: transcriptTarget.storePath,
      assertCurrent: () => {},
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    transcriptReadiness: createClientVoiceTranscriptReadiness({
      flushTranscript: () => queue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: queue,
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

function blockFirstAppend() {
  const entered = createDeferred();
  const resume = createDeferred();
  appendTranscript.mockImplementation(async ({ entryId }: { entryId: string }) => {
    if (entryId === "1") {
      entered.resolve();
      await resume.promise;
    }
  });
  return { entered: entered.promise, resume: resume.resolve };
}

function expectWarning(session: RelaySession, message: string) {
  expect(session.context.logGateway.warn).toHaveBeenCalledWith(expect.stringContaining(message));
}

beforeEach(() => {
  vi.mocked(withClientVoiceSessionSettlement).mockImplementation((run) => run());
  appendTranscript.mockReset();
  closeRecord.mockReset().mockResolvedValue(undefined);
  createVoice.mockReset().mockResolvedValue("voice");
  const source = { assertCurrent: () => {} };
  captureSource.mockReset().mockReturnValue(source);
  captureWriter.mockReset().mockImplementation(() => ({ source, release: async () => {} }));
});

it.each([
  ["transient append", 2, 0],
  ["persistent append", 3, 0],
  ["voice close", 1, 0],
  ["later succeeds", 3, 1],
  ["later fails", 3, 3],
] as const)("settles detached answer recovery (%s)", async (_kind, firstCalls, laterCalls) => {
  const { session } = createRelaySession();
  session.voiceSessionCreated = true;
  const hasLater = laterCalls > 0;
  const failure = new Error(hasLater ? "First answer failed" : "Answer append failed");
  const laterError = new Error("Later answer failed");
  const first = vi.fn().mockRejectedValue(failure);
  const later =
    laterCalls === 3 ? vi.fn().mockRejectedValue(laterError) : vi.fn().mockResolvedValue(undefined);
  const release = vi.fn(async () => {});
  captureWriter.mockReturnValue({
    source: { assertCurrent() {} },
    release,
  });
  session.unspokenAnswers = new Map([["first", first]]);
  if (hasLater) {
    session.unspokenAnswers.set("later", later);
  }
  if (firstCalls === 2) {
    first.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
  }
  if (firstCalls === 1) {
    first.mockResolvedValue(undefined);
    closeRecord.mockRejectedValue(failure);
  }
  const closing = closeVoice(session, "detach");
  if (firstCalls === 2) {
    await expect(closing).resolves.toBeUndefined();
    expect(session.context.logGateway.warn).not.toHaveBeenCalled();
  } else if (laterCalls === 3) {
    await expect(closing).rejects.toMatchObject({ errors: [failure, laterError] });
  } else {
    await expect(closing).rejects.toBe(failure);
  }
  if (!hasLater && firstCalls !== 2) {
    expect(session.context.logGateway.warn).toHaveBeenCalledWith(
      "realtime relay voice session close failed: Answer append failed",
    );
  }
  expect([first, later, closeRecord, release].map((mock) => mock.mock.calls.length)).toEqual([
    firstCalls,
    laterCalls,
    1,
    1,
  ]);
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
    const blocked = blockFirstAppend();
    const { session } = createRelaySession();
    const entryError = new Error("relay queue entry refused");
    const enqueueSpy = vi
      .spyOn(session.voiceTranscriptQueue, "enqueue")
      .mockImplementationOnce(() => {
        throw entryError;
      });
    try {
      expect(enqueue(session, "user", "not accepted")).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expectWarning(session, entryError.message);
    } finally {
      enqueueSpy.mockRestore();
    }
    expect(session.voiceTranscriptSeq).toBe(0);
    expect(enqueue(session, "user", "accepted")).toBe(true);
    const accepted = captureClientVoiceSessionSettlement();
    const close = accepted.run(() => AsyncLocalStorage.bind(() => closeVoice(session)));
    accepted.release();
    const closing = close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    try {
      await blocked.entered;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(closeRecord).not.toHaveBeenCalled();
      blocked.resume();
      await closing;
      expect(session.voiceTranscriptQueue.isIdle).toBe(true);
      expect(closeRecord).not.toHaveBeenCalled();
    } finally {
      blocked.resume();
      await closing;
      vi.useRealTimers();
    }
  });
});

it.each([false, true])("retries only a known failed creation (unknown=%s)", async (unknown) => {
  const failure = unknown
    ? new SqliteWorkerError("Creation settlement is unknown", "outcome-unknown")
    : new Error("Creation was refused");
  createVoice.mockRejectedValueOnce(failure);
  const { session } = createRelaySession();
  expect(await ensureVoice(session)).toBe(false);
  expect(await ensureVoice(session)).toBe(!unknown);
  expect(createVoice).toHaveBeenCalledTimes(unknown ? 1 : 2);
});

it("does not replay an append after an unknown worker outcome", async () => {
  appendTranscript.mockRejectedValue(
    new SqliteWorkerError("Transcript settlement is unknown", "outcome-unknown"),
  );
  const { session } = createRelaySession();
  expect(enqueue(session, "user", "Keep this accepted utterance")).toBe(true);
  await session.voiceTranscriptQueue.flush();
  await closeVoice(session);
  expect(appendTranscript).toHaveBeenCalledOnce();
  expectWarning(session, "Transcript settlement is unknown");
});

it("closes a voice created by a later accepted transcript after the first creation fails", async () => {
  const firstCreation = createDeferred<string>();
  createVoice.mockReturnValueOnce(firstCreation.promise);
  const { session } = createRelaySession();
  expect(enqueue(session, "user", "First accepted utterance")).toBe(true);
  expect(enqueue(session, "user", "Later accepted utterance")).toBe(true);
  const closing = closeVoice(session);
  firstCreation.reject(new Error("First creation was refused"));
  await closing;
  expect(createVoice).toHaveBeenCalledTimes(2);
  expect(appendTranscript.mock.calls[0]?.[0]).toMatchObject({
    entryId: "2",
    text: "Later accepted utterance",
  });
  expect(session.voiceTranscriptQueue.isIdle).toBe(true);
  expect(closeRecord).toHaveBeenCalledOnce();
});

it("drains bounded finals even when the closing source is refused", async () => {
  const blocked = blockFirstAppend();
  const { session, failSession } = createRelaySession(true);
  const text = `  ${"x".repeat(9_000)}  `;
  let accepted = enqueue(session, "user", text) ? 1 : 0;

  expect(enqueue(session, "user", " \t\n ")).toBe(true);

  for (let index = 1; index < 10_000; index += 1) {
    if (enqueue(session, index % 2 === 0 ? "user" : "assistant", text)) {
      accepted += 1;
    }
  }

  expect(accepted).toBe(41);
  await blocked.entered;
  expect(failSession).toHaveBeenCalledOnce();
  const close = session.voiceSessionClose;
  expect(close).toBeDefined();
  expect(closeVoice(session)).toBe(close);
  expect(closeRecord).not.toHaveBeenCalled();

  blocked.resume();
  await close;

  expect(appendTranscript.mock.calls.map(([params]) => params)).toMatchObject(
    Array.from({ length: 41 }, (_, index) => ({
      entryId: String(index + 1),
      text: "x".repeat(8_000),
    })),
  );
  expect(closeRecord).not.toHaveBeenCalled();
  expectWarning(session, "Voice source was replaced before close");
  expect(enqueue(session, "user", "too late")).toBe(false);
});
