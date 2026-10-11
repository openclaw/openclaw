import { StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  authorizeClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
} from "./client-voice-confirmation.js";
import { noteClientVoiceConfirmationUtteranceForTest as noteClientVoiceConfirmationUtterance } from "./client-voice-confirmation.test-support.js";
import { resolveOpenClientVoiceSessionId } from "./client-voice-session-read.js";
import {
  completeRun,
  createVoiceSession,
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
  isClientVoiceSessionConfirmable,
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

  it("creates, resumes, and enforces ownership and open state", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    const voiceSessionId = await createOrResumeClientVoiceSession({
      ...target,
      provider: "google",
      origin: "client",
      voiceSessionId: "voice-1",
      now: 10,
    });
    expect(
      await createOrResumeClientVoiceSession({
        ...target,
        origin: "client",
        voiceSessionId,
        now: 20,
      }),
    ).toBe(voiceSessionId);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      provider: "google",
    });
    await expect(
      createOrResumeClientVoiceSession({
        ...target,
        provider: "openai",
        origin: "client",
        voiceSessionId,
      }),
    ).rejects.toThrow("provider does not match");
    await expect(
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:other",
        origin: "client",
        voiceSessionId,
      }),
    ).rejects.toThrow("does not belong");

    await closeClientVoiceSession({
      ...target,
      voiceSessionId,
      config: {},
      now: 30,
    });
    await expect(
      createOrResumeClientVoiceSession({
        ...target,
        origin: "client",
        voiceSessionId,
      }),
    ).rejects.toThrow("already closed");
  });

  it("marks confirmability by declared capability, relay origin, or observed transcript", async () => {
    const capable = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      transcriptCapable: true,
      voiceSessionId: "voice-capable",
    });
    const legacy = await createVoiceSession({ voiceSessionId: "voice-legacy" });
    const relay = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "relay",
      voiceSessionId: "voice-relay",
    });
    const binding = (voiceSessionId: string) => ({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
    });
    expect(isClientVoiceSessionConfirmable(binding(capable))).toBe(true);
    expect(isClientVoiceSessionConfirmable(binding(legacy))).toBe(false);
    expect(isClientVoiceSessionConfirmable(binding(relay))).toBe(true);
  });

  it("waits for transcript serialization but not mutation digest delivery", async ({ signal }) => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = await createVoiceSession({ voiceSessionId: "voice-durable-close" });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);

    const confirmation = checkClientVoiceToolConfirmationPolicy({
      agentId: "main",
      voiceSessionId,
      toolName: "message",
      toolParams: { channel: "discord", message: "send it" },
      isConfirmable: () => true,
      now: 10,
    });
    if (confirmation.allowed) {
      throw new Error("expected a pending voice confirmation");
    }
    const confirmationId = confirmation.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    if (!confirmationId) {
      throw new Error("expected a voice confirmation id");
    }

    const transcriptWrite = createDeferred();
    const transcriptEntered = createDeferred();
    releaseHeldWrites.push(() => transcriptWrite.resolve());
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn!;
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async (...args) => {
      transcriptEntered.resolve();
      await transcriptWrite.promise;
      return await actualAppend(...args);
    });
    const append = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "final",
      role: "assistant",
      text: "final answer",
    });
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
    const close = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 42,
    }).then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");

    transcriptWrite.resolve();
    await Promise.all([append, close]);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();
    await withinTest(digestEntered.promise, signal);
    expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

    noteClientVoiceConfirmationUtterance({
      agentId: "main",
      voiceSessionId,
      text: "yes",
      timestamp: 11,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        agentId: "main",
        voiceSessionId,
        confirmationId,
        now: 12,
      }),
    ).toThrow("voice confirmation is missing");

    digestSend.resolve({ status: "sent" });
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );
  });

  it("rejects a concurrent close when an accepted transcript fails", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({
      voiceSessionId: "voice-concurrent-close-failure",
    });
    const transcriptWrite = createDeferred();
    const transcriptEntered = createDeferred();
    releaseHeldWrites.push(() => transcriptWrite.resolve());
    const failure = new Error("transcript write failed");
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async () => {
      transcriptEntered.resolve();
      await transcriptWrite.promise;
      throw failure;
    });
    const append = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "failed",
      role: "user",
      text: "persist me",
    });
    await awaitGateBeforeSettlement(
      transcriptEntered.promise,
      append,
      "Transcript settled before entering the held append",
    );
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toEqual([expect.any(String)]);
    const close = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 42,
    });

    transcriptWrite.resolve();
    await expect(append).rejects.toBe(failure);
    await expect(close).rejects.toBe(failure);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
  });

  it("keeps the session open when a failed transcript is retried after close", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({
      voiceSessionId: "voice-close-after-failure",
    });
    const transcriptWrite = createDeferred();
    const transcriptEntered = createDeferred();
    releaseHeldWrites.push(() => transcriptWrite.resolve());
    const failure = new Error("transcript write failed");
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn!;
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async () => {
      transcriptEntered.resolve();
      await transcriptWrite.promise;
      throw failure;
    });
    const append = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "retryable",
      role: "user",
      text: "persist me",
    });
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
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toEqual([expect.any(String)]);
    clientVoiceSessionTesting.reset();
    await expect(
      closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
        now: 42,
      }),
    ).rejects.toThrow("voice transcript persistence must be retried before close");
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementation(actualAppend);
    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "retryable",
      role: "user",
      text: "persist me",
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 99,
    });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 99,
    });
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toEqual([]);
  });

  it("terminally closes relay sessions while retaining unresolved transcript identity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "relay",
    });
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockRejectedValueOnce(
      new Error("transcript write failed"),
    );

    await expect(
      appendRelayVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionTarget: { sessionKey: "agent:main:main" },
        voiceSessionId,
        entryId: "relay-entry-1",
        role: "user",
        text: "persist me",
      }),
    ).rejects.toThrow("transcript write failed");
    const unresolved = clientVoiceSessionTesting.readRecord(
      "main",
      voiceSessionId,
    )?.transcriptFailureKeys;
    expect(unresolved).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);

    await closeRelayVoiceSessionRecord({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      transcriptFailureKeys: unresolved,
    });
  });

  it("bounds stalled transcript operations and closes after the accepted prefix", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({ voiceSessionId: "voice-bounded" });
    const firstAppend = createDeferred();
    const appendEntered = createDeferred();
    releaseHeldWrites.push(() => firstAppend.resolve());
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async (...args) => {
      appendEntered.resolve();
      await firstAppend.promise;
      return await actualAppend(...args);
    });

    const appends = Array.from({ length: 10_000 }, (_, index) =>
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionTarget: { sessionKey: "agent:main:main" },
        voiceSessionId,
        entryId: String(index + 1),
        role: index % 2 === 0 ? "user" : "assistant",
        text: `  ${"x".repeat(9_000)}  `,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    await awaitGateBeforeSettlement(
      appendEntered.promise,
      Promise.all(appends),
      "Transcripts settled before entering the held append",
    );
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
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
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionTarget: { sessionKey: "agent:main:main" },
        voiceSessionId,
        entryId: "after-overflow",
        role: "user",
        text: "must remain rejected after the accepted prefix drains",
      }),
    ).rejects.toThrow("voice transcript persistence queue capacity exceeded");

    const close = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 42,
    });
    const duplicateClose = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 99,
    });
    await Promise.all([close, duplicateClose]);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
  });

  it("ignores whitespace transcripts without consuming queue capacity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({ voiceSessionId: "voice-whitespace" });

    await Promise.all(
      Array.from({ length: 10_000 }, (_, index) =>
        appendClientVoiceTranscript({
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionTarget: { sessionKey: "agent:main:main" },
          voiceSessionId,
          entryId: String(index + 1),
          role: "user",
          text: " \t\n ",
        }),
      ),
    );
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).not.toHaveBeenCalled();

    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "real",
      role: "user",
      text: "persist me",
    });
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).toHaveBeenCalledOnce();
    expect(
      sessionTurnMocks.appendExpectedSessionTranscriptTurn.mock.calls[0]?.[1].messages[0]?.eventId,
    ).toBe(`voice:${voiceSessionId}:real`);
  });

  it("requires every failed transcript entry to recover before close", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({
      voiceSessionId: "voice-multiple-write-failures",
    });
    sessionTurnMocks.appendExpectedSessionTranscriptTurn
      .mockRejectedValueOnce(new Error("first transcript write failed"))
      .mockRejectedValueOnce(new Error("second transcript write failed"));

    for (const entryId of ["1", "2"]) {
      await expect(
        appendClientVoiceTranscript({
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionTarget: { sessionKey: "agent:main:main" },
          voiceSessionId,
          entryId,
          role: "user",
          text: entryId,
        }),
      ).rejects.toThrow("transcript write failed");
    }
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toHaveLength(2);

    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "later",
      role: "assistant",
      text: "later entry",
    });
    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "first",
    });
    await expect(
      closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
      }),
    ).rejects.toThrow("voice transcript persistence must be retried before close");

    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "2",
      role: "user",
      text: "second",
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
  });

  it("bounds unresolved transcript failure identity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({
      voiceSessionId: "voice-write-failure-bound",
    });
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockRejectedValue(
      new Error("transcript write failed"),
    );

    for (let index = 0; index < VOICE_TRANSCRIPT_MAX_UNRESOLVED; index += 1) {
      await expect(
        appendClientVoiceTranscript({
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionTarget: { sessionKey: "agent:main:main" },
          voiceSessionId,
          entryId: String(index),
          role: "user",
          text: "failed entry",
        }),
      ).rejects.toThrow("transcript write failed");
    }
    await expect(
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionTarget: { sessionKey: "agent:main:main" },
        voiceSessionId,
        entryId: "beyond-bound",
        role: "user",
        text: "must wait for recovery",
      }),
    ).rejects.toThrow("voice transcript persistence has too many unresolved entries");
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).toHaveBeenCalledTimes(
      VOICE_TRANSCRIPT_MAX_UNRESOLVED,
    );
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toHaveLength(VOICE_TRANSCRIPT_MAX_UNRESOLVED);

    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementation(actualAppend);
    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: { sessionKey: "agent:main:main" },
      voiceSessionId,
      entryId: "0",
      role: "user",
      text: "recovered entry",
    });
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockRejectedValueOnce(
      new Error("replacement transcript write failed"),
    );
    await expect(
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionTarget: { sessionKey: "agent:main:main" },
        voiceSessionId,
        entryId: "replacement",
        role: "user",
        text: "replacement entry",
      }),
    ).rejects.toThrow("replacement transcript write failed");
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toHaveLength(VOICE_TRANSCRIPT_MAX_UNRESOLVED);
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
    const firstAppend = createDeferred();
    const appendEntered = createDeferred();
    releaseHeldWrites.push(() => firstAppend.resolve());
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async (...args) => {
      appendEntered.resolve();
      await firstAppend.promise;
      return await actualAppend(...args);
    });

    const first = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:first",
      sessionTarget: { sessionKey: "agent:main:first" },
      voiceSessionId: firstVoiceSessionId,
      entryId: "1",
      role: "user",
      text: "first",
    });
    await awaitGateBeforeSettlement(
      appendEntered.promise,
      first,
      "Transcript settled before entering the held append",
    );
    const second = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:second",
      sessionTarget: { sessionKey: "agent:main:second" },
      voiceSessionId: secondVoiceSessionId,
      entryId: "1",
      role: "user",
      text: "second",
    });

    await second;
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).toHaveBeenCalledTimes(2);
    firstAppend.resolve();
    await first;
  });

  it("resolves the open client record for legacy tool calls", async () => {
    const voiceSessionId = await createVoiceSession();

    const closed = await createVoiceSession({ voiceSessionId: "discarded-closed" });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: closed,
      config: {},
    });
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
      agentId: "main",
      sessionKey: "agent:main:main",
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
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
      expect.objectContaining({
        toolCallId: "message-1",
        toolName: "message",
        status: "cancelled",
        finishedAt: expect.any(Number),
      }),
    ]);
  });
});
