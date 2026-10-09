import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  captureClientVoiceSessionSettlement,
  prepareClientVoiceSessionClose,
} from "./client-voice-session-lifecycle.js";
import * as voiceSessionReads from "./client-voice-session-read.js";
import {
  completeRun,
  createCompletedMutationSession,
  createVoiceSession,
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

// Install digest mocks before the persistence graph loads.
const { useClientVoiceDigestHarness, withClientVoiceDigestSettlement } = await vi.hoisted(
  () => import("./client-voice-session.digest-harness.test-support.js"),
);

describe("client voice session lifecycle", () => {
  const harness = useClientVoiceDigestHarness();
  const { sendDurableMessageBatch } = harness;

  it("does not replay or mark a partially delivered digest after expiry and re-record", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey, { channel: "discord", to: "channel:partial-digest" });
      const voiceSessionId = await createCompletedMutationSession();
      sendDurableMessageBatch.mockImplementationOnce(async () => ({
        status: "partial_failed",
        results: [],
        sentBeforeError: true,
        receipt: { platformMessageIds: ["partial-message"], parts: [], sentAt: 123 },
        error: new Error("partial delivery"),
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await settle();
        await vi.advanceTimersByTimeAsync(
          clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
        );
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
        await settle();
        expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toBeUndefined();
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          retained: 1,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("joins accepted digest delivery beyond both slots after the closing caller returns", async ({
    signal,
  }) => {
    await seedSession("agent:main:main", { channel: "discord", to: "channel:voice-updates" });
    const ids = Array.from({ length: 4 }, (_, index) =>
      createVoiceSession({ voiceSessionId: `queued-digest-${index}` }),
    );
    for (const id of ids) {
      recordMutation(id);
      await completeRun(`run-${id}`);
    }
    const close = prepareClientVoiceSessionClose();
    const caller = new AsyncWorkScope();
    const request = new AsyncLocalStorage<string>();
    const started = ids.map(() => createDeferred());
    const release = ids.map(() => createDeferred());
    const observedRequests: Array<string | undefined> = [];
    let calls = 0;
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation((message) => {
      failed.reject(new Error(String(message)));
    });
    sendDurableMessageBatch.mockImplementation(async () => {
      const index = calls++;
      observedRequests.push(request.getStore());
      started[index]!.resolve();
      await release[index]!.promise;
      return { status: "sent" };
    });
    let draining: Promise<void> | undefined;
    try {
      await request.run("closing-request", () =>
        caller.track(async () => {
          for (const voiceSessionId of ids) {
            await closeClientVoiceSession({
              agentId: "main",
              sessionKey: "agent:main:main",
              voiceSessionId,
              config: {},
            });
          }
        }),
      );
      await withinTest(Promise.race([started[1]!.promise, failed.promise]), signal);
      expect(calls).toBe(2);
      caller.beginClose();
      close.beginClose();
      let settled = false;
      draining = close.drain().then(() => {
        settled = true;
      });
      await nextEventLoopTurn();
      expect(settled, "accepted summaries must settle before voice persistence closes").toBe(false);
      release[0]!.resolve();
      release[1]!.resolve();
      await withinTest(Promise.race([started[3]!.promise, failed.promise]), signal);
      release[2]!.resolve();
      release[3]!.resolve();
      await withinTest(Promise.race([draining, failed.promise]), signal);
      expect(observedRequests).toEqual([undefined, undefined, undefined, undefined]);
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(4);
      expect(sendDurableMessageBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          to: "channel:voice-updates",
          payloads: [{ text: "Voice call changes\n- message: succeeded" }],
        }),
      );
      for (const id of ids) {
        expect(clientVoiceSessionTesting.readRecord("main", id)?.digestDeliveredAt).toEqual(
          expect.any(Number),
        );
      }
    } finally {
      for (const gate of release) {
        gate.resolve();
      }
      await draining;
      await nextEventLoopTurn();
      await caller.drain();
      warning.mockRestore();
    }
  });

  it.for([false, true])(
    "keeps a delayed digest in its original shutdown owner after a state switch (expired successor=%s)",
    async (expiredSuccessor, { signal }) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey, { channel: "discord", to: "channel:original-voice" });
      const closeOriginal = prepareClientVoiceSessionClose();
      const voiceSessionId = createVoiceSession();
      recordMutation(voiceSessionId);
      const successorStateDir = path.join(harness.stateDir, "successor");
      const sending = createDeferred();
      const releaseSend = createDeferred();
      const failed = createDeferred<never>();
      void failed.promise.catch(() => {});
      const warning = vi.spyOn(console, "warn").mockImplementation((message) => {
        failed.reject(new Error(String(message)));
      });
      let closeSuccessor: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
      const drains: Promise<void>[] = [];
      sendDurableMessageBatch.mockImplementationOnce(async () => {
        sending.resolve();
        await releaseSend.promise;
        return { status: "sent" };
      });
      try {
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await nextEventLoopTurn();
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          pending: 0,
          retained: 1,
        });
        expect(sendDurableMessageBatch).not.toHaveBeenCalled();

        setTestEnvValue("OPENCLAW_STATE_DIR", successorStateDir);
        closeSuccessor = prepareClientVoiceSessionClose();
        if (expiredSuccessor) {
          const acceptedSuccessor = captureClientVoiceSessionSettlement();
          const inSuccessor = acceptedSuccessor.run(() => AsyncLocalStorage.snapshot());
          acceptedSuccessor.release();
          await inSuccessor(() => completeRun(`run-${voiceSessionId}`));
        } else {
          await completeRun(`run-${voiceSessionId}`);
        }
        await withinTest(Promise.race([sending.promise, failed.promise]), signal);

        const settled = { original: false, successor: false };
        closeOriginal.beginClose();
        closeSuccessor.beginClose();
        drains.push(
          closeOriginal.drain().then(() => {
            settled.original = true;
          }),
          closeSuccessor.drain().then(() => {
            settled.successor = true;
          }),
        );
        await nextEventLoopTurn();
        expect({ ...settled }).toEqual({ original: false, successor: true });

        releaseSend.resolve();
        await withinTest(Promise.race([Promise.all(drains), failed.promise]), signal);
        setTestEnvValue("OPENCLAW_STATE_DIR", harness.stateDir);
        expect(sendDurableMessageBatch).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ to: "channel:original-voice" }),
        );
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
      } finally {
        releaseSend.resolve();
        setTestEnvValue("OPENCLAW_STATE_DIR", harness.stateDir);
        await Promise.allSettled([closeOriginal.drain(), closeSuccessor?.drain(), ...drains]);
        warning.mockRestore();
        await cleanupSessionStateForTest({ stateDir: successorStateDir });
      }
    },
  );

  it("records post-close effects and defers the digest until the last consult completes", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      await seedSession("agent:main:main", {
        channel: "discord",
        to: "channel:voice-updates",
      });
      const voiceSessionId = createVoiceSession();
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
      await settle();
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
      expect(sendDurableMessageBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text: "Voice call changes\n- message: succeeded\n- message: succeeded" }],
        }),
      );
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));

      await closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
      });
      await settle();
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    });
  });

  it("retries a deferred digest on the next lifecycle trigger after run completion", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      await seedSession("agent:main:main", {
        channel: "discord",
        to: "channel:voice-updates",
      });
      const voiceSessionId = createVoiceSession();
      recordMutation(voiceSessionId, "run-live");
      // Call ends while the consult still runs, so the digest is deferred.
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
      });
      sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));
      await completeRun("run-live");
      await settle();
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0);
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toBeUndefined();

      await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
      await settle();
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps a failed digest while a late consult owns the retry", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      await seedSession("agent:main:main", {
        channel: "discord",
        to: "channel:voice-updates",
      });
      const voiceSessionId = await createCompletedMutationSession();
      sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeClientVoiceSession({
          agentId: "main",
          sessionKey: "agent:main:main",
          voiceSessionId,
          config: {},
        });
        await settle();
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
        await settle();
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
        expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("delivers one mutation digest and skips webchat or missing targets", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      await seedSession("agent:main:main", {
        channel: "discord",
        to: "channel:voice-updates",
      });
      const delivered = await createCompletedMutationSession();
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
      await settle();
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
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
        createVoiceSession({ sessionKey, voiceSessionId });
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
      await settle();
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    });
  });
  describe("stale recovery", () => {
    it.each(["original", "successor"] as const)(
      "keeps stale recovery in its original admission when %s closes after lookup",
      async (closed) => {
        const now = 6 * 60 * 60_000 + 2;
        const target = {
          agentId: "main",
          sessionKey: "agent:main:main",
          origin: "client" as const,
        };
        const voiceSessionId = createOrResumeClientVoiceSession({ ...target, now: 1 });
        const originalClose = prepareClientVoiceSessionClose();
        let successorClose: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
        const successor = path.join(harness.stateDir, "successor");
        const env = captureEnv(["OPENCLAW_STATE_DIR"]);
        const lookup = voiceSessionReads.lookupClientVoiceSessions;
        const read = vi
          .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
          .mockImplementationOnce(async (...args) => {
            const candidates = await lookup(...args);
            setTestEnvValue("OPENCLAW_STATE_DIR", successor);
            createOrResumeClientVoiceSession({ ...target, voiceSessionId, now: 1 });
            successorClose = prepareClientVoiceSessionClose();
            await (closed === "original" ? originalClose : successorClose).drain();
            return candidates;
          });
        try {
          const warn = vi.fn();
          expect(
            await closeStaleClientVoiceSessions({ agentId: "main", config: {}, now, warn }),
          ).toBe(closed === "original" ? 0 : 1);
          expect(warn).toHaveBeenCalledTimes(closed === "original" ? 1 : 0);
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
          env.restore();
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe(
            closed === "original" ? "open" : "closed",
          );
        } finally {
          read.mockRestore();
          env.restore();
          await Promise.all([originalClose.drain(), successorClose?.drain()]);
          await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
        }
      },
    );
    it("closes stale records and leaves recent records open", async () => {
      const stale = createVoiceSession({ sessionKey: "agent:main:stale", now: 1 });
      const recent = createVoiceSession({
        sessionKey: "agent:main:recent",
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
        storePath: path.join(harness.stateDir, "configured", "sessions.sqlite"),
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
      const firstClosedAt = Date.now();
      await closeClientVoiceSession({
        ...voiceTarget,
        voiceSessionId,
        config: {},
        now: firstClosedAt,
      });
      await closeClientVoiceSession({
        ...voiceTarget,
        voiceSessionId,
        config: {},
        now: firstClosedAt + 1,
      });
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
        status: "closed",
        closedAt: firstClosedAt,
      });
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

    it.each(["opaque", "prepared"] as const)(
      "does not create a chat when browser startup closes while its write is queued (%s authority)",
      async (authority) => {
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
        const assertOpen = () => controller.signal.throwIfAborted();
        const creating = ensureClientVoiceAgentSessionEntry({
          ...target,
          deadlineAt: Date.now() + 60_000,
          assertCommitAllowed:
            authority === "prepared" ? composeSessionSourceAssertion([], assertOpen) : assertOpen,
        });
        controller.abort(new Error("browser disconnected"));
        const rejected = expect(creating).rejects.toThrow("browser disconnected");
        release.resolve();
        await blocker;
        await rejected;
        expect(loadSessionEntry(target)).toBeUndefined();
      },
    );
  });
});
