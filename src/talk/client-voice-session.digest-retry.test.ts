import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import * as voiceSessionReads from "./client-voice-session-read.js";
import {
  completeRun,
  recordMutation,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import {
  appendRelayVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  resolveClientVoiceAgentSessionId,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VoiceTranscriptOperationRegistry } from "./voice-transcript.js";

const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: sendDurableMessageBatch,
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

describe("client voice session lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-digest-retry-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    await cleanupSessionStateForTest({ stateDir: tempDir });
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records post-close effects and defers the digest until the last consult completes", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    for (const runId of ["run-1", "run-2"]) {
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId,
      });
    }

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(resolveClientVoiceRunBinding("run-1")).toMatchObject({ voiceSessionId });

    for (const runId of ["run-1", "run-2"]) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolCallId: "call-1",
        toolName: "message",
        mutatingAction: true,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        runId,
        toolCallId: "call-1",
        toolName: "message",
        durationMs: 5,
      });
    }
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
      expect.objectContaining({ runId: "run-1", status: "succeeded" }),
      expect.objectContaining({ runId: "run-2", status: "succeeded" }),
    ]);

    await completeRun("run-1");
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    await completeRun("run-2");
    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1));
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Voice call changes\n- message: succeeded\n- message: succeeded" }],
      }),
    );
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });

  it("retries a deferred digest on the next lifecycle trigger after run completion", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-live",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      durationMs: 5,
    });
    // Call ends while the consult still runs, so the digest is deferred.
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));
    await completeRun("run-live");
    await vi.waitFor(() =>
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0),
    );
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
    await vi.waitFor(() =>
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number)),
    );
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed digest while a late consult owns the retry", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        active: 0,
        pending: 0,
        retained: 1,
      });

      // The run can register before config arrives; an identical replay must
      // still re-arm the closed session's digest, not return at binding reuse.
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId: "late-run",
      });
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId: "late-run",
        config: {},
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(
        clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
      );
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().retained).toBe(1);

      recordMutation(voiceSessionId, "late-run");
      await completeRun("late-run");
      await vi.advanceTimersByTimeAsync(0);
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers one mutation digest and skips webchat or missing targets", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const delivered = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(delivered);
    await completeRun(`run-${delivered}`);
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1));
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        durability: "required",
        requireUnknownSendReconciliation: true,
        payloads: [{ text: "Voice call changes\n- message: succeeded" }],
      }),
    );

    for (const [voiceSessionId, route] of [
      ["voice-webchat", { channel: "webchat", to: "browser" }],
      ["voice-no-target", {}],
    ] as const) {
      const sessionKey = `agent:main:${voiceSessionId}`;
      await seedSession(sessionKey, route);
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        voiceSessionId,
      });
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        runId: `run-${voiceSessionId}`,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId: `run-${voiceSessionId}`,
        toolCallId: `call-${voiceSessionId}`,
        toolName: "message",
        mutatingAction: true,
      });
      await completeRun(`run-${voiceSessionId}`);
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
    }
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });
  describe("stale recovery", () => {
    it("closes stale records and leaves recent records open", async () => {
      const stale = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:stale",
        origin: "client",
        now: 1,
      });
      const recent = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:recent",
        origin: "client",
        now: 6 * 60 * 60_000,
      });

      expect(
        await closeStaleClientVoiceSessions({
          agentId: "main",
          config: {},
          now: 6 * 60 * 60_000 + 2,
        }),
      ).toBe(1);
      expect(clientVoiceSessionTesting.readRecord("main", stale)?.status).toBe("closed");
      expect(clientVoiceSessionTesting.readRecord("main", recent)?.status).toBe("open");
    });

    it("does not close a call resumed after the stale candidate read", async () => {
      const now = 6 * 60 * 60_000 + 2;
      const target = { agentId: "main", sessionKey: "agent:main:main", origin: "client" as const };
      const voiceSessionId = createOrResumeClientVoiceSession({ ...target, now: 1 });
      const lookup = voiceSessionReads.lookupClientVoiceSessions;
      const read = vi
        .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
        .mockImplementationOnce(async (request) => {
          const candidates = await lookup(request);
          createOrResumeClientVoiceSession({ ...target, voiceSessionId, now });
          return candidates;
        });
      try {
        expect(await closeStaleClientVoiceSessions({ agentId: "main", config: {}, now })).toBe(0);
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
      } finally {
        read.mockRestore();
      }
    });

    it("honors an explicit close that joins skipped stale recovery", async () => {
      const now = 6 * 60 * 60_000 + 2;
      const target = { agentId: "main", sessionKey: "agent:main:main", origin: "client" as const };
      const voiceSessionId = createOrResumeClientVoiceSession({ ...target, now: 1 });
      const entered = createDeferred();
      const release = createDeferred();
      // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original registry receiver.
      const close = VoiceTranscriptOperationRegistry.prototype.close;
      const barrier = vi
        .spyOn(VoiceTranscriptOperationRegistry.prototype, "close")
        .mockImplementationOnce(function (this: VoiceTranscriptOperationRegistry, key, operation) {
          return close.call(this, key, async () => {
            entered.resolve();
            await release.promise;
            await operation();
          });
        });
      const stale = closeStaleClientVoiceSessions({ agentId: "main", config: {}, now });
      try {
        await entered.promise;
        createOrResumeClientVoiceSession({ ...target, voiceSessionId, now });
        const explicit = closeClientVoiceSession({ ...target, voiceSessionId, config: {}, now });
        release.resolve();
        await Promise.all([stale, explicit]);
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
      } finally {
        release.resolve();
        await stale;
        barrier.mockRestore();
      }
    });
  });
  describe("startup", () => {
    it("stamps required Talk creation once", async () => {
      const target = { agentId: "main", sessionKey: "agent:main:talk:new" };
      const actor = { type: "human" as const, source: "profile" as const, id: "profile-required" };
      const creation = { actor, sandbox: "required" as const };
      const sessionId = await ensureClientVoiceAgentSessionEntry({ ...target, creation });

      const original = loadSessionEntry(target);
      expect(original).toMatchObject({
        sessionId,
        createdVia: "talk",
        createdActor: actor,
        createdAt: expect.any(Number),
        sandbox: "required",
      });

      await ensureClientVoiceAgentSessionEntry({
        ...target,
        creation: {
          actor: { type: "human", source: "profile", id: "another-profile" },
          sandbox: "required",
        },
      });
      expect(loadSessionEntry(target)).toEqual(original);
    });

    it("writes relay transcripts to global without changing voice identity", async () => {
      const origin = "relay";
      const canonicalKey = "global";
      const sessionTarget = {
        sessionKey: canonicalKey,
        storePath: path.join(tempDir, "configured", "sessions.sqlite"),
      };
      const storage = { agentId: "main", ...sessionTarget };
      const sessionId = await ensureClientVoiceAgentSessionEntry(storage);
      expect(resolveClientVoiceAgentSessionId(storage)).toBe(sessionId);
      const voiceTarget = { agentId: "main", sessionKey: "main" };
      const voiceSessionId = createOrResumeClientVoiceSession({ ...voiceTarget, origin });
      await appendRelayVoiceTranscript({
        ...voiceTarget,
        sessionTarget,
        voiceSessionId,
        entryId: "canonical-transcript",
        role: "user",
        text: "Stored in the prepared session",
      });
      expect(readSessionTranscriptMessageEvents({ ...storage, sessionId })).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            message: expect.objectContaining({
              content: [{ type: "text", text: "Stored in the prepared session" }],
            }),
          }),
        }),
      ]);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
        sessionKey: "main",
        origin,
      });
      await expect(
        closeClientVoiceSession({
          agentId: "main",
          sessionKey: canonicalKey,
          voiceSessionId,
          config: {},
        }),
      ).rejects.toThrow("does not belong");
      await closeClientVoiceSession({ ...voiceTarget, voiceSessionId, config: {} });
      await closeClientVoiceSession({ ...voiceTarget, voiceSessionId, config: {} });
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
    });

    it("does not create an agent session after a browser-session deadline", async () => {
      const sessionKey = "agent:main:talk:expired";

      await expect(
        ensureClientVoiceAgentSessionEntry({
          agentId: "main",
          sessionKey,
          deadlineAt: Date.now() - 1,
        }),
      ).rejects.toThrow("Realtime browser session expired during startup");
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
    });

    it("repairs an incomplete existing row without claiming its creation actor", async () => {
      const sessionKey = "agent:main:talk:incomplete";
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId: "", updatedAt: 1, createdVia: "internal", createdAt: 1 },
      );

      await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey });

      const repaired = loadSessionEntry({ agentId: "main", sessionKey });
      expect(repaired?.sessionId).toBeTruthy();
      expect(repaired).toMatchObject({ createdVia: "internal", createdAt: 1 });
      expect(repaired?.createdActor).toBeUndefined();
    });

    it("does not create a chat when browser startup closes while its write is queued", async () => {
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = patchSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:voice-write-blocker" },
        async () => {
          entered.resolve();
          await release.promise;
          return null;
        },
        { fallbackEntry: { sessionId: "voice-write-blocker", updatedAt: 1 } },
      );
      await entered.promise;
      const target = { agentId: "main", sessionKey: "agent:main:voice-write-cancelled" };
      const controller = new AbortController();
      const creating = ensureClientVoiceAgentSessionEntry({
        ...target,
        assertCommitAllowed: () => controller.signal.throwIfAborted(),
      });
      controller.abort(new Error("browser disconnected"));
      const rejected = expect(creating).rejects.toThrow("browser disconnected");
      release.resolve();
      await blocker;
      await rejected;
      expect(loadSessionEntry(target)).toBeUndefined();
    });
  });
});
