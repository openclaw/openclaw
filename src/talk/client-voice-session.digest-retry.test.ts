import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.entry-mutation.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { readSessionTranscriptBoundedMessageTailPageAsync } from "../gateway/session-transcript-readers.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  captureClientVoiceSessionSettlement,
  prepareClientVoiceSessionClose,
} from "./client-voice-session-lifecycle.js";
import * as voiceSessionReads from "./client-voice-session-read.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";
import {
  completeRun,
  createVoiceSession,
  recordMutation,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  appendRelayVoiceTranscript,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun as registerRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting as testing } from "./client-voice-session.test-support.js";
import { VoiceTranscriptOperationRegistry } from "./voice-transcript.js";

// Install digest mocks before the persistence graph loads.
const { useClientVoiceDigestHarness, withClientVoiceDigestSettlement } = await vi.hoisted(
  () => import("./client-voice-session.digest-harness.test-support.js"),
);
const mainTarget = { agentId: "main", sessionKey: "agent:main:main" };
const advanceRetention = () =>
  vi.advanceTimersByTimeAsync(testing.digestDeliveryPolicy.failureRetentionMs + 1);
function failOnWarning() {
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const warning = vi.spyOn(console, "warn").mockImplementation((message) => {
    failed.reject(new Error(String(message)));
  });
  return { failed, warning };
}

describe("client voice session lifecycle", () => {
  const harness = useClientVoiceDigestHarness();
  const {
    sendDurableMessageBatch: send,
    settleDigestAttempts,
    seedDigest,
    holdSend,
    readRecord,
    closeVoice,
    recoverStale,
    recordEffect,
  } = harness;

  it("does not replay or mark a partially delivered digest after expiry and re-record", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      const voiceSessionId = await seedDigest("channel:partial-digest");
      send.mockImplementationOnce(async () => ({
        status: "partial_failed",
        results: [],
        sentBeforeError: true,
        receipt: { platformMessageIds: ["partial-message"], parts: [], sentAt: 123 },
        error: new Error("partial delivery"),
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeVoice(voiceSessionId);
        await settle();
        await advanceRetention();
        await closeVoice(voiceSessionId);
        await recoverStale();
        await settle();
        expect(send).toHaveBeenCalledOnce();
        expect(readRecord(voiceSessionId)?.digestDeliveredAt).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("joins accepted digest delivery beyond both slots after the closing caller returns", async ({
    signal,
  }) => {
    await seedSession(mainTarget.sessionKey, { channel: "discord", to: "channel:voice-updates" });
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(await createVoiceSession({ voiceSessionId: `queued-digest-${index}` }));
    }
    for (const id of ids) {
      await recordMutation(id);
      await completeRun(`run-${id}`);
    }
    const close = prepareClientVoiceSessionClose();
    const caller = new AsyncWorkScope();
    const request = new AsyncLocalStorage<string>();
    const started = ids.map(() => createDeferred());
    const release = ids.map(() => createDeferred());
    const observedRequests: Array<string | undefined> = [];
    let calls = 0;
    const { failed, warning } = failOnWarning();
    send.mockImplementation(async () => {
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
            await closeVoice(voiceSessionId);
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
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "discord", to: "channel:voice-updates" }),
      );
      for (const id of ids) {
        expect(readRecord(id)?.digestDeliveredAt).toEqual(expect.any(Number));
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
      const { sessionKey } = mainTarget;
      await seedSession(sessionKey, { channel: "discord", to: "channel:original-voice" });
      const closeOriginal = prepareClientVoiceSessionClose();
      const voiceSessionId = await createVoiceSession({ sessionKey });
      await recordMutation(voiceSessionId);
      const successorStateDir = path.join(harness.stateDir, "successor");
      const { sending, finishSend: releaseSend } = holdSend();
      const { failed, warning } = failOnWarning();
      let closeSuccessor: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
      const drains: Promise<void>[] = [];
      try {
        await closeVoice(voiceSessionId, { sessionKey });
        await settleDigestAttempts();
        expect(send).not.toHaveBeenCalled();

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
        expect(send).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ to: "channel:original-voice" }),
        );
        expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
      } finally {
        releaseSend.resolve();
        setTestEnvValue("OPENCLAW_STATE_DIR", harness.stateDir);
        await Promise.allSettled([closeOriginal.drain(), closeSuccessor?.drain(), ...drains]);
        warning.mockRestore();
        await cleanupSessionStateForTest({ stateDir: successorStateDir });
      }
    },
  );

  it.each([false, true])(
    "records post-close effects and defers the digest until the last consult completes (incognito=%s)",
    async (incognito) => {
      await withClientVoiceDigestSettlement(async (settle) => {
        const sessionKey = incognito ? "agent:main:dashboard:incognito-digest" : "agent:main:main";
        const to = incognito ? "channel:incognito-voice-updates" : "channel:voice-updates";
        if (incognito) {
          await seedSession(mainTarget.sessionKey, {
            channel: "discord",
            to: "channel:durable-decoy",
          });
          await createSessionEntryWithTranscript({ agentId: "main", sessionKey }, () => ({
            ok: true as const,
            entry: {
              incognito: true as const,
              sessionId: "incognito-voice-digest",
              updatedAt: Date.now(),
              delivery: normalizeSessionDeliveryState({ context: { channel: "discord", to } }),
            },
          }));
        } else {
          await seedSession(sessionKey, { channel: "discord", to });
        }
        const voiceSessionId = await createVoiceSession({ sessionKey });
        for (const runId of ["run-1", "run-2"]) {
          await registerRun({ ...mainTarget, sessionKey, voiceSessionId, runId });
        }

        await closeVoice(voiceSessionId, { sessionKey });
        await settle();
        expect(send).not.toHaveBeenCalled();
        expect(resolveClientVoiceRunBinding("run-1")).toMatchObject({ voiceSessionId });

        for (const runId of ["run-1", "run-2"]) {
          recordEffect(runId, "call-1");
        }
        await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
        expect(readRecord(voiceSessionId)?.effects).toEqual([
          expect.objectContaining({ runId: "run-1", status: "succeeded" }),
          expect.objectContaining({ runId: "run-2", status: "succeeded" }),
        ]);

        await completeRun("run-1");
        await settle();
        expect(send).not.toHaveBeenCalled();
        await completeRun("run-2");
        await settle();
        expect(send).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to,
            payloads: [{ text: "Voice call changes\n- message: succeeded\n- message: succeeded" }],
          }),
        );
        expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));

        await closeVoice(voiceSessionId, { sessionKey });
        await settle();
        expect(send).toHaveBeenCalledTimes(1);
        if (incognito) {
          await expect(
            fs.stat(resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" })),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it.each([false, true])(
    "settles a queued consult replay after run completion without reviving its owner (replacement=%s)",
    async (replacement) => {
      const to = "channel:queued-consult-digest";
      await seedSession(mainTarget.sessionKey, { channel: "discord", to });
      const voiceSessionId = await createVoiceSession();
      const binding = { ...mainTarget, voiceSessionId, runId: "queued-consult" };
      const releaseOriginal = await registerRun(binding);
      await closeVoice(voiceSessionId, mainTarget);
      await settleDigestAttempts();
      expect(send).not.toHaveBeenCalled();

      const writerGate = createEnteredGate();
      const blocker = runOpenClawAgentWorkerWrite(mainTarget, writerGate.wait);
      await writerGate.entered;
      let settled = false;
      const registering = registerRun({ ...binding, config: {} }).then((release) => {
        settled = true;
        return release;
      });
      void registering.catch(() => {});
      let releaseReplacement: (() => void) | undefined;
      const successor = {
        agentId: "successor",
        sessionKey: "agent:successor:main",
        voiceSessionId: "successor-voice",
      };
      try {
        recordEffect(binding.runId, "queued-effect");
        await completeRun(binding.runId);
        expect(settled).toBe(false);
        expect(resolveClientVoiceRunBinding(binding.runId)).toBeUndefined();
        if (replacement) {
          await createOrResumeClientVoiceSession({ ...successor, origin: "client" });
          releaseReplacement = await registerRun({ ...successor, runId: binding.runId });
        }
        writerGate.release();
        const releaseReplay = await registering;
        await settleDigestAttempts();
        expect(readRecord(voiceSessionId)).toMatchObject({
          status: "closed",
          consultRunIds: [binding.runId],
          effects: [{ runId: binding.runId, toolCallId: "queued-effect", status: "succeeded" }],
          digestDeliveredAt: expect.any(Number),
        });
        expect(send).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to,
            durability: "required",
            payloads: [{ text: "Voice call changes\n- message: succeeded" }],
          }),
        );
        releaseReplay();
        expect(resolveClientVoiceRunBinding(binding.runId)).toEqual(
          replacement ? successor : undefined,
        );
        await closeVoice(voiceSessionId, mainTarget);
        await settleDigestAttempts();
        expect(send).toHaveBeenCalledOnce();
      } finally {
        writerGate.release();
        await blocker;
        (await registering)();
        releaseOriginal();
        releaseReplacement?.();
      }
    },
  );

  it("retries a deferred digest on the next lifecycle trigger after run completion", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      await seedSession(mainTarget.sessionKey, { channel: "discord", to: "channel:voice-updates" });
      const voiceSessionId = await createVoiceSession();
      await recordMutation(voiceSessionId, "run-live");
      // Call ends while the consult still runs, so the digest is deferred.
      await closeVoice(voiceSessionId);
      send.mockRejectedValueOnce(new Error("channel offline"));
      await completeRun("run-live");
      await settle();
      expect(readRecord(voiceSessionId)?.digestDeliveredAt).toBeUndefined();

      await recoverStale();
      await settle();
      expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps a failed digest while a late consult owns the retry", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      const voiceSessionId = await seedDigest();
      send.mockRejectedValueOnce(new Error("channel offline"));

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeVoice(voiceSessionId);
        await settle();

        // The run can register before config arrives; an identical replay must
        // still re-arm the closed session's digest, not return at binding reuse.
        const binding = { ...mainTarget, voiceSessionId, runId: "late-run" };
        await registerRun(binding);
        await registerRun({ ...binding, config: {} });
        await settle();
        await advanceRetention();

        await recordMutation(voiceSessionId, "late-run");
        await completeRun("late-run");
        await settle();
        expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
        expect(send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("delivers one mutation digest and skips webchat or missing targets", async () => {
    await withClientVoiceDigestSettlement(async (settle) => {
      const delivered = await seedDigest();
      await closeVoice(delivered);
      await closeVoice(delivered);
      await settle();
      expect(send).toHaveBeenCalledExactlyOnceWith(
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
        await createVoiceSession({ sessionKey, voiceSessionId });
        await registerRun({
          ...mainTarget,
          sessionKey,
          voiceSessionId,
          runId: `run-${voiceSessionId}`,
        });
        recordEffect(`run-${voiceSessionId}`, `call-${voiceSessionId}`);
        await completeRun(`run-${voiceSessionId}`);
        await closeVoice(voiceSessionId, { sessionKey });
        await settle();
      }
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
  describe("stale recovery", () => {
    it.each(["original", "successor"] as const)(
      "keeps stale recovery in its original admission when %s closes after lookup",
      async (closed) => {
        const now = 6 * 60 * 60_000 + 2;
        const voiceSessionId = await createVoiceSession({ now: 1 });
        const originalClose = prepareClientVoiceSessionClose();
        let successorClose: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
        const successor = path.join(harness.stateDir, "successor");
        const env = captureEnv(["OPENCLAW_STATE_DIR"]);
        const lookup = voiceSessionReads.lookupClientVoiceSessions;
        using _ = vi
          .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
          .mockImplementationOnce(async (...args) => {
            const candidates = await lookup(...args);
            setTestEnvValue("OPENCLAW_STATE_DIR", successor);
            await createVoiceSession({ voiceSessionId, now: 1 });
            successorClose = prepareClientVoiceSessionClose();
            await (closed === "original" ? originalClose : successorClose).drain();
            return candidates;
          });
        try {
          const warn = vi.fn();
          expect(await recoverStale({ now, warn })).toBe(closed === "original" ? 0 : 1);
          expect(warn).toHaveBeenCalledTimes(closed === "original" ? 1 : 0);
          expect(readRecord(voiceSessionId)?.status).toBe("open");
          env.restore();
          expect(readRecord(voiceSessionId)?.status).toBe(
            closed === "original" ? "open" : "closed",
          );
        } finally {
          env.restore();
          await Promise.all([originalClose.drain(), successorClose?.drain()]);
          await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
        }
      },
    );
    it("closes only stale calls, including when a candidate resumes after lookup", async () => {
      const now = 6 * 60 * 60_000 + 2;
      const stale = await createVoiceSession({ sessionKey: "agent:main:stale", now: 1 });
      const recent = await createVoiceSession({ sessionKey: "agent:main:recent", now });
      const voiceSessionId = await createVoiceSession({ now: 1 });
      const lookup = voiceSessionReads.lookupClientVoiceSessions;
      using read = vi.spyOn(voiceSessionReads, "lookupClientVoiceSessions");
      read.mockImplementationOnce(async (request) => {
        const candidates = await lookup(request);
        await createVoiceSession({ voiceSessionId, now });
        return candidates;
      });
      expect(await recoverStale({ now })).toBe(1);
      expect(readRecord(stale)?.status).toBe("closed");
      expect(readRecord(recent)?.status).toBe("open");
      expect(readRecord(voiceSessionId)?.status).toBe("open");
    });

    it("honors an explicit close that joins skipped stale recovery", async () => {
      const now = 6 * 60 * 60_000 + 2;
      const voiceSessionId = await createVoiceSession({ now: 1 });
      const entered = createDeferred();
      const release = createDeferred();
      // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original registry receiver.
      const close = VoiceTranscriptOperationRegistry.prototype.close;
      using _ = vi
        .spyOn(VoiceTranscriptOperationRegistry.prototype, "close")
        .mockImplementationOnce(function (this: VoiceTranscriptOperationRegistry, key, operation) {
          return close.call(this, key, async () => {
            entered.resolve();
            await release.promise;
            await operation();
          });
        });
      const stale = recoverStale({ now });
      try {
        await entered.promise;
        await createVoiceSession({ voiceSessionId, now });
        const explicit = closeVoice(voiceSessionId, { now });
        release.resolve();
        await Promise.all([stale, explicit]);
        expect(readRecord(voiceSessionId)?.status).toBe("closed");
      } finally {
        release.resolve();
        await stale;
      }
    });
  });
  describe("startup", () => {
    it("stamps required Talk creation once in a fresh agent", async () => {
      const agentId = "fresh";
      const target = { agentId, sessionKey: `agent:${agentId}:talk:new` };
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

    it.each([
      { origin: "relay" as const, canonicalKey: "global", incognito: false },
      {
        origin: "client" as const,
        canonicalKey: "agent:main:dashboard:incognito-voice",
        incognito: true,
      },
    ])(
      "writes $origin transcripts to $canonicalKey without changing voice identity",
      async ({ origin, canonicalKey, incognito }) => {
        const sessionTarget = {
          sessionKey: canonicalKey,
          storePath: path.join(harness.stateDir, "configured", "sessions.sqlite"),
        };
        const storage = { agentId: "main", ...sessionTarget };
        if (incognito) {
          await createSessionEntryWithTranscript(storage, () => ({
            ok: true as const,
            entry: { incognito: true as const, sessionId: "incognito-voice", updatedAt: 1 },
          }));
        }
        const sessionId = await ensureClientVoiceAgentSessionEntry(storage);
        expect(await voiceSessionReads.resolveClientVoiceAgentSessionId(storage)).toBe(sessionId);
        const voiceTarget = { agentId: "main", sessionKey: "main" };
        const voiceSessionId = await createOrResumeClientVoiceSession({ ...voiceTarget, origin });
        const append =
          origin === "client" ? appendClientVoiceTranscript : appendRelayVoiceTranscript;
        await append({
          ...voiceTarget,
          sessionTarget,
          voiceSessionId,
          entryId: "canonical-transcript",
          role: "user",
          text: "Stored in the prepared session",
        });
        const transcript = await readSessionTranscriptBoundedMessageTailPageAsync(
          { ...storage, sessionId },
          { maxBytes: 4096, maxMessages: 10, offset: 0 },
        );
        expect(transcript.events).toMatchObject([
          {
            event: {
              message: { content: [{ type: "text", text: "Stored in the prepared session" }] },
            },
          },
        ]);
        expect(readRecord(voiceSessionId)).toMatchObject({
          sessionKey: "main",
          origin,
          hasUserTranscript: true,
          transcriptFailureKeys: [],
        });
        await expect(closeVoice(voiceSessionId, { sessionKey: canonicalKey })).rejects.toThrow(
          "does not belong",
        );
        const firstClosedAt = Date.now();
        await closeVoice(voiceSessionId, { ...voiceTarget, now: firstClosedAt });
        await closeVoice(voiceSessionId, { ...voiceTarget, now: firstClosedAt + 1 });
        expect(readRecord(voiceSessionId)).toMatchObject({
          status: "closed",
          closedAt: firstClosedAt,
        });
      },
    );

    it("does not create an agent session after a browser-session deadline", async () => {
      const target = { ...mainTarget, sessionKey: "agent:main:talk:expired" };
      await expect(
        ensureClientVoiceAgentSessionEntry({ ...target, deadlineAt: Date.now() - 1 }),
      ).rejects.toThrow("Realtime browser session expired during startup");
      expect(loadSessionEntry(target)).toBeUndefined();
    });

    it("repairs an incomplete existing row without claiming its creation actor", async () => {
      const target = { ...mainTarget, sessionKey: "agent:main:talk:incomplete" };
      await replaceSessionEntry(target, {
        sessionId: "",
        updatedAt: 1,
        createdVia: "internal",
        createdAt: 1,
      });

      await ensureClientVoiceAgentSessionEntry(target);
      const repaired = loadSessionEntry(target);
      expect(repaired?.sessionId).toBeTruthy();
      expect(repaired).toMatchObject({ createdVia: "internal", createdAt: 1 });
      expect(repaired?.createdActor).toBeUndefined();
    });

    it.each(["lifetime", "opaque", "prepared"] as const)(
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
          assertCurrent: authority === "lifetime" ? assertOpen : undefined,
          requester:
            authority === "lifetime"
              ? undefined
              : authority === "prepared"
                ? composeSessionSourceAssertion([], assertOpen)
                : assertOpen,
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
