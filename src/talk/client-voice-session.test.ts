import { StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { resolveOpenClientVoiceSessionId } from "./client-voice-session-read.js";
import {
  completeRun,
  recordMutation,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  appendRelayVoiceTranscript,
  closeClientVoiceSession,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

// Install shared mocks before fixture imports load the voice persistence graph.
const { useClientVoiceSessionHarness } = await vi.hoisted(
  () => import("./client-voice-session.harness.test-support.js"),
);

describe("client voice session", () => {
  const { releaseHeldWrites, sendDurableMessageBatch, sessionTurnMocks } =
    useClientVoiceSessionHarness();

  const target = { agentId: "main", sessionKey: "agent:main:main" };
  const createVoiceSession = (
    params: Partial<Parameters<typeof createOrResumeClientVoiceSession>[0]> = {},
  ) => createOrResumeClientVoiceSession({ ...target, origin: "client", ...params });
  async function seededVoice(voiceSessionId: string) {
    await seedSession(target.sessionKey);
    return createVoiceSession({ voiceSessionId });
  }
  const readRecord = (id: string) => clientVoiceSessionTesting.readRecord("main", id);
  const closeVoice = (voiceSessionId: string, now?: number) =>
    closeClientVoiceSession({ ...target, voiceSessionId, config: {}, now });
  const appendTranscript = (
    voiceSessionId: string,
    entryId: string,
    text: string,
    role: "user" | "assistant" = "user",
    sessionKey = target.sessionKey,
  ) =>
    appendClientVoiceTranscript({
      ...target,
      sessionKey,
      sessionTarget: { sessionKey },
      voiceSessionId,
      entryId,
      role,
      text,
    });
  function realTranscriptAppend() {
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    return actualAppend;
  }
  function holdTranscript(failure?: Error) {
    const release = createDeferred();
    const entered = createDeferred();
    releaseHeldWrites.push(() => release.resolve());
    const actualAppend = realTranscriptAppend();
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      if (failure) {
        throw failure;
      }
      return await actualAppend(...args);
    });
    return { release, entered };
  }

  it("creates, resumes, and enforces ownership and open state", async () => {
    const voiceSessionId = await createVoiceSession({
      provider: "google",
      voiceSessionId: "voice-1",
      now: 10,
    });
    expect(
      await createVoiceSession({
        voiceSessionId,
        now: 20,
      }),
    ).toBe(voiceSessionId);
    expect(readRecord(voiceSessionId)).toMatchObject({ provider: "google" });
    await expect(
      createVoiceSession({
        provider: "openai",
        voiceSessionId,
      }),
    ).rejects.toThrow("provider does not match");
    await expect(
      createVoiceSession({
        sessionKey: "agent:main:other",
        voiceSessionId,
      }),
    ).rejects.toThrow("does not belong");

    await closeVoice(voiceSessionId, 30);
    await expect(createVoiceSession({ voiceSessionId })).rejects.toThrow("already closed");
  });

  it("preserves declared transcript capability and transport origin", async () => {
    const capable = await createVoiceSession({
      transcriptCapable: true,
      voiceSessionId: "voice-capable",
    });
    const legacy = await createVoiceSession({ voiceSessionId: "voice-legacy" });
    const relay = await createVoiceSession({
      origin: "relay",
      voiceSessionId: "voice-relay",
    });
    expect(readRecord(capable)).toMatchObject({
      transcriptCapable: true,
      origin: "client",
    });
    expect(readRecord(legacy)?.transcriptCapable).not.toBe(true);
    expect(readRecord(relay)?.origin).toBe("relay");
  });

  it("waits for transcript serialization but not mutation digest delivery", async ({ signal }) => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = await createVoiceSession({ voiceSessionId: "voice-durable-close" });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);

    const { release: transcriptWrite, entered: transcriptEntered } = holdTranscript();
    const append = appendTranscript(voiceSessionId, "final", "final answer", "assistant");
    await awaitGateBeforeSettlement(
      transcriptEntered.promise,
      append,
      "Transcript settled before entering the held append",
    );

    const digestSend = createDeferred<{ status: "sent" }>();
    const digestEntered = createDeferred();
    releaseHeldWrites.push(() => digestSend.resolve({ status: "sent" }));
    sendDurableMessageBatch.mockImplementationOnce(() => {
      digestEntered.resolve();
      return digestSend.promise;
    });
    let closeSettled = false;
    const close = closeVoice(voiceSessionId, 42).then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(readRecord(voiceSessionId)?.status).toBe("open");

    transcriptWrite.resolve();
    await Promise.all([append, close]);
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toBeUndefined();
    await withinTest(digestEntered.promise, signal);
    expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

    digestSend.resolve({ status: "sent" });
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
  });

  it("rejects a concurrent close when an accepted transcript fails", async () => {
    const voiceSessionId = await seededVoice("voice-concurrent-close-failure");
    const failure = new Error("transcript write failed");
    const { release: transcriptWrite, entered: transcriptEntered } = holdTranscript(failure);
    const append = appendTranscript(voiceSessionId, "failed", "persist me");
    await awaitGateBeforeSettlement(
      transcriptEntered.promise,
      append,
      "Transcript settled before entering the held append",
    );
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toEqual([expect.any(String)]);
    const close = closeVoice(voiceSessionId, 42);

    transcriptWrite.resolve();
    await expect(append).rejects.toBe(failure);
    await expect(close).rejects.toBe(failure);
    expect(readRecord(voiceSessionId)?.status).toBe("open");
  });

  it("keeps the session open when a failed transcript is retried after close", async () => {
    const voiceSessionId = await seededVoice("voice-close-after-failure");
    const failure = new Error("transcript write failed");
    const { release: transcriptWrite, entered: transcriptEntered } = holdTranscript(failure);
    const append = appendTranscript(voiceSessionId, "retryable", "persist me");
    const appendResult = append.then(
      () => undefined,
      (error: unknown) => error,
    );
    await awaitGateBeforeSettlement(
      transcriptEntered.promise,
      appendResult,
      "Transcript settled before entering the held append",
    );
    transcriptWrite.resolve();
    expect(await appendResult).toBe(failure);
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toEqual([expect.any(String)]);
    clientVoiceSessionTesting.reset();
    await expect(closeVoice(voiceSessionId, 42)).rejects.toThrow(
      "voice transcript persistence must be retried before close",
    );
    expect(readRecord(voiceSessionId)?.status).toBe("open");
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementation(realTranscriptAppend());
    await appendTranscript(voiceSessionId, "retryable", "persist me");
    await closeVoice(voiceSessionId, 99);
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 99,
      transcriptFailureKeys: [],
    });
  });

  it("terminally closes relay sessions while retaining unresolved transcript identity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({ origin: "relay" });
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockRejectedValueOnce(
      new Error("transcript write failed"),
    );

    await expect(
      appendRelayVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "relay-entry-1",
        role: "user",
        text: "persist me",
      }),
    ).rejects.toThrow("transcript write failed");
    const unresolved = readRecord(voiceSessionId)?.transcriptFailureKeys;
    expect(unresolved).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);

    await closeRelayVoiceSessionRecord({
      ...target,
      voiceSessionId,
      config: {},
    });
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      transcriptFailureKeys: unresolved,
    });
  });

  it("bounds stalled transcript operations and closes after the accepted prefix", async () => {
    const voiceSessionId = await seededVoice("voice-bounded");
    const { release: firstAppend, entered: appendEntered } = holdTranscript();

    const appends = Array.from({ length: 10_000 }, (_, index) =>
      appendTranscript(
        voiceSessionId,
        String(index + 1),
        `  ${"x".repeat(9_000)}  `,
        index % 2 === 0 ? "user" : "assistant",
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    await awaitGateBeforeSettlement(
      appendEntered.promise,
      Promise.all(appends),
      "Transcripts settled before entering the held append",
    );
    expect(readRecord(voiceSessionId)?.status).toBe("open");
    firstAppend.resolve();
    const results = await Promise.all(appends);

    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(41);
    expect(rejected).toHaveLength(9_959);
    expect(
      results.every(
        (result) =>
          result.ok ||
          (result.error instanceof Error &&
            result.error.message === "voice transcript persistence queue capacity exceeded"),
      ),
    ).toBe(true);
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).toHaveBeenCalledTimes(41);
    expect(
      sessionTurnMocks.appendExpectedSessionTranscriptTurn.mock.calls.map(
        ([, options]) => options.messages[0]?.eventId,
      ),
    ).toEqual(Array.from({ length: 41 }, (_, index) => `voice:${voiceSessionId}:${index + 1}`));
    const firstMessage = sessionTurnMocks.appendExpectedSessionTranscriptTurn.mock.calls[0]?.[1]
      .messages[0]?.message as { content?: Array<{ text?: string }> };
    expect(firstMessage.content?.[0]?.text).toHaveLength(8_000);
    await expect(
      appendTranscript(
        voiceSessionId,
        "after-overflow",
        "must remain rejected after the accepted prefix drains",
      ),
    ).rejects.toThrow("voice transcript persistence queue capacity exceeded");

    const close = closeVoice(voiceSessionId, 42);
    const duplicateClose = closeVoice(voiceSessionId, 99);
    await Promise.all([close, duplicateClose]);
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
  });

  it("ignores whitespace transcripts without consuming queue capacity", async () => {
    const voiceSessionId = await seededVoice("voice-whitespace");

    await Promise.all(
      Array.from({ length: 10_000 }, (_, index) =>
        appendTranscript(voiceSessionId, String(index + 1), " \t\n "),
      ),
    );
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).not.toHaveBeenCalled();

    await appendTranscript(voiceSessionId, "real", "persist me");
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).toHaveBeenCalledOnce();
    expect(
      sessionTurnMocks.appendExpectedSessionTranscriptTurn.mock.calls[0]?.[1].messages[0]?.eventId,
    ).toBe(`voice:${voiceSessionId}:real`);
  });

  it("requires every failed transcript entry to recover before close", async () => {
    const voiceSessionId = await seededVoice("voice-multiple-write-failures");
    sessionTurnMocks.appendExpectedSessionTranscriptTurn
      .mockRejectedValueOnce(new Error("first transcript write failed"))
      .mockRejectedValueOnce(new Error("second transcript write failed"));

    for (const entryId of ["1", "2"]) {
      await expect(appendTranscript(voiceSessionId, entryId, entryId)).rejects.toThrow(
        "transcript write failed",
      );
    }
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toHaveLength(2);

    await appendTranscript(voiceSessionId, "later", "later entry", "assistant");
    await appendTranscript(voiceSessionId, "1", "first");
    await expect(closeVoice(voiceSessionId)).rejects.toThrow(
      "voice transcript persistence must be retried before close",
    );

    await appendTranscript(voiceSessionId, "2", "second");
    await closeVoice(voiceSessionId);
    expect(readRecord(voiceSessionId)?.status).toBe("closed");
  });

  it("bounds unresolved transcript failure identity", async () => {
    const voiceSessionId = await seededVoice("voice-write-failure-bound");
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockRejectedValue(
      new Error("transcript write failed"),
    );

    for (let index = 0; index < VOICE_TRANSCRIPT_MAX_UNRESOLVED; index += 1) {
      await expect(appendTranscript(voiceSessionId, String(index), "failed entry")).rejects.toThrow(
        "transcript write failed",
      );
    }
    await expect(
      appendTranscript(voiceSessionId, "beyond-bound", "must wait for recovery"),
    ).rejects.toThrow("voice transcript persistence has too many unresolved entries");
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).toHaveBeenCalledTimes(
      VOICE_TRANSCRIPT_MAX_UNRESOLVED,
    );
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toHaveLength(
      VOICE_TRANSCRIPT_MAX_UNRESOLVED,
    );

    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementation(realTranscriptAppend());
    await appendTranscript(voiceSessionId, "0", "recovered entry");
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockRejectedValueOnce(
      new Error("replacement transcript write failed"),
    );
    await expect(
      appendTranscript(voiceSessionId, "replacement", "replacement entry"),
    ).rejects.toThrow("replacement transcript write failed");
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toHaveLength(
      VOICE_TRANSCRIPT_MAX_UNRESOLVED,
    );
  });

  it("keeps durable operation ownership independent between voice sessions", async () => {
    await seedSession("agent:main:first");
    await seedSession("agent:main:second");
    const firstVoiceSessionId = await createVoiceSession({
      sessionKey: "agent:main:first",
      voiceSessionId: "voice-first",
    });
    const secondVoiceSessionId = await createVoiceSession({
      sessionKey: "agent:main:second",
      voiceSessionId: "voice-second",
    });
    const { release: firstAppend, entered: appendEntered } = holdTranscript();

    const first = appendTranscript(firstVoiceSessionId, "1", "first", "user", "agent:main:first");
    await awaitGateBeforeSettlement(
      appendEntered.promise,
      first,
      "Transcript settled before entering the held append",
    );
    const second = appendTranscript(
      secondVoiceSessionId,
      "1",
      "second",
      "user",
      "agent:main:second",
    );

    await second;
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).toHaveBeenCalledTimes(2);
    firstAppend.resolve();
    await first;
  });

  it("resolves the open client record for legacy tool calls", async () => {
    const voiceSessionId = await createVoiceSession();

    const closed = await createVoiceSession({ voiceSessionId: "discarded-closed" });
    await closeVoice(closed);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(
        await resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:main" }),
      ).toBe(voiceSessionId);
      expect(
        observation.queries.filter((query) => /select.*value_json.*cache_entries/is.test(query)),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(
      await resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:other" }),
    ).toBeUndefined();
    await createVoiceSession();
    expect(
      await resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:main" }),
    ).toBeUndefined();
  });

  it("records only mutating started effects and updates their terminal status", async () => {
    const voiceSessionId = await createVoiceSession();
    await registerClientVoiceConsultRun({
      ...target,
      voiceSessionId,
      runId: "run-1",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolCallId: "read-1",
      toolName: "read",
      mutatingAction: false,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolCallId: "message-1",
      toolName: "message",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-1",
      toolCallId: "message-1",
      toolName: "message",
      durationMs: 4,
      errorCategory: "aborted",
      terminalReason: "cancelled",
    });

    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(readRecord(voiceSessionId)?.effects).toEqual([
      expect.objectContaining({
        toolCallId: "message-1",
        toolName: "message",
        status: "cancelled",
        finishedAt: expect.any(Number),
      }),
    ]);
  });
});
