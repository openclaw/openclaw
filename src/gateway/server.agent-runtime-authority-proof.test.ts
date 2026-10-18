// Proof overlay: real RPC handler, admitted-run owner, SQLite, transcript and media.
// Gateway test helpers replace inference; they do not replace the effect owners below.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as pendingInputs from "../config/sessions/session-accessor.pending-inputs.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import {
  captureSessionTarget,
  startSessionControllerInterruption,
} from "../sessions/session-controller.lifecycle.js";
import { createAgentAdmissionController } from "./agent-turn/agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "./agent-turn/agent-dedupe-lifecycle.js";
import { createAgentRunAdmissionRevalidator } from "./agent-turn/agent-run-admission-revalidation.js";
import { registerChatAbortController } from "./chat-abort.js";
import * as attachments from "./chat-attachments.js";
import {
  createResetDeliveryFixture,
  holdExecution,
  installAgentAuthorityProofFixture,
  PNG,
  reach,
  readEffectFile,
  type Response,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import * as resets from "./session-reset-service.js";
import { agentCommandMock } from "./test-helpers.js";

const resetDelivery = {
  message: "/reset",
  deliver: true,
  bestEffortDeliver: false,
  channel: "matrix",
  to: "!proof:example.test",
};

describe("agent RPC real delegated-authority effects", () => {
  const fixture = installAgentAuthorityProofFixture();
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function reserve(
    f: Fixture,
    message: string,
    runId: string = f.runId,
    keys = [`agent:${runId}`],
    io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
  ) {
    const lifecycle = createAgentDedupeLifecycle({
      cfg: f.context.getRuntimeConfig(),
      request: { message, idempotencyKey: runId },
      runId,
      agentDedupeKeys: keys,
      suppressVisibleSessionEffects: false,
      context: f.context,
      io,
    });
    lifecycle.reserve(f.sessionKey, "main");
    return lifecycle;
  }
  const readEntry = async (f: Fixture) =>
    (await loadSessionEntryAsync(f.sessionKey, { agentId: "main" })).entry;
  const transcript = (f: Fixture) => sessionAccessor.loadTranscriptEventsSync(f.scope);
  const pendingCount = async (f: Fixture) => (await listSessionPendingInputs(f.scope)).total;
  const expectAbsent = (file: string) =>
    expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  function expectInactive(response: Response, message = "authority is no longer active") {
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(message) },
    });
  }
  function expectCached(retry: Response, response: Response) {
    expect(retry).toMatchObject({ ok: response.ok, meta: { cached: true } });
    expect(retry.error).toEqual(response.error);
    expect(retry.payload).toEqual(response.payload);
  }
  async function expectReset(f: Fixture, before: SessionEntry | undefined) {
    const committed = await readEntry(f);
    expect(committed?.sessionId).toBe(f.sessionId);
    expect(committed?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
    return committed;
  }
  function expectResetReply(retry: Response, f: Fixture, text: unknown) {
    expect(retry).toMatchObject({
      ok: true,
      meta: { cached: true },
      payload: {
        status: "ok",
        result: { payloads: [{ text }], meta: { agentMeta: { sessionId: f.sessionId } } },
      },
    });
  }
  function pause(
    f: Fixture,
    signal: AbortSignal,
    execution?: Awaited<ReturnType<typeof holdExecution>>,
  ) {
    const entered = createDeferred();
    const release = createDeferred();
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    if (signal.aborted) {
      unblock();
    }
    const finish = async (
      requests: (Promise<unknown> | undefined)[],
      observers: { mockRestore: () => unknown }[] = [],
      reservation?: ReturnType<typeof createAgentDedupeLifecycle>,
    ) => {
      release.resolve();
      await execution?.cleanup();
      await Promise.allSettled(requests.filter((request) => request !== undefined));
      reservation?.clearUnaccepted();
      await f.cleanup();
      observers.forEach((observer) => observer.mockRestore());
      signal.removeEventListener("abort", unblock);
    };
    return { entered, release, finish };
  }

  it("rejects a revoked caller before the real reset transaction", async ({ signal }) => {
    const f = await fixture();
    const { entered, release, finish } = pause(f, signal);
    let calls = 0;
    const hook = async (event: import("../hooks/internal-hooks.js").InternalHookEvent) => {
      if (event.sessionKey !== f.sessionKey) {
        return;
      }
      calls++;
      entered.resolve();
      await release.promise;
    };
    const before = await readEntry(f);
    registerInternalHook("command:reset", hook);
    let request: Promise<Response> | undefined;
    try {
      request = f.dispatch({ message: "/reset" });
      await reach(entered.promise, request);
      expect(await readEntry(f)).toEqual(before);
      f.owner.revoke();
      release.resolve();
      const result = await request;
      await f.drain();

      expect(calls).toBe(1);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expectInactive(result);
      expect(await readEntry(f)).toEqual(before);
      expect(transcript(f)).toEqual(f.before);
    } finally {
      await finish([request]);
      unregisterInternalHook("command:reset", hook);
    }
  });

  it.for(["revoked", "accepted custody", "ordinary raw input", "replaced after reset"] as const)(
    "real pending-input transaction: %s",
    async (mode, { signal }) => {
      const f = await fixture();
      const execution = await holdExecution(signal);
      const { entered, release, finish } = pause(f, signal, execution);
      let writer: Promise<unknown> | undefined;
      let replacement: ReturnType<typeof createAgentDedupeLifecycle> | undefined;
      let inputRecorded = false;
      const stage = pendingInputs.stageSessionPendingInput;
      const observer = vi
        .spyOn(pendingInputs, "stageSessionPendingInput")
        .mockImplementationOnce(async (...args) => {
          const writerEntered = createDeferred();
          writer = runExclusiveSqliteSessionWrite(
            resolveSqliteStoreScope(f.scope.storePath, { agentId: "main" }),
            async () => {
              writerEntered.resolve();
              await release.promise;
            },
            "session.transcript.batch",
          );
          await writerEntered.promise;
          const pending = stage(...args);
          entered.resolve();
          const result = await pending;
          inputRecorded = (await pendingCount(f)) > 0;
          return result;
        });
      let request: Promise<Response> | undefined;
      try {
        const params = {
          message:
            mode === "replaced after reset"
              ? "/reset do not persist this suffix"
              : "real pending-input custody proof",
        };
        request = f.dispatch(params, mode === "ordinary raw input" ? null : f.owner);
        await reach(entered.promise, request);
        expect(await pendingCount(f)).toBe(0);
        const beforeInput = transcript(f);
        if (mode === "revoked") {
          f.owner.revoke();
        } else if (mode === "replaced after reset") {
          expect(beforeInput).not.toEqual(f.before);
          replacement = reserve(f, params.message);
        }
        release.resolve();
        const result = await request;
        if (mode === "revoked" || mode === "replaced after reset") {
          expectInactive(result, "is no longer active");
          expect(inputRecorded).toBe(false);
          expect(execution.observer).not.toHaveBeenCalled();
          expect(await pendingCount(f)).toBe(0);
          expect(transcript(f)).toEqual(beforeInput);
          expect(agentCommandMock).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ ok: true, payload: { status: "accepted" } });
          const prepared = await execution.entered;
          expect(await listSessionPendingInputs(f.scope)).toMatchObject({
            total: 1,
            items: [{ state: "queued", runId: f.runId, message: { content: params.message } }],
          });
          if (mode === "accepted custody") {
            f.owner.revoke();
          }
          expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
          const recorder = prepared.userTurn.recorder!;
          const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
          expect(persisted).toMatchObject({ appended: true, message: { content: params.message } });
          expect(await pendingCount(f)).toBe(0);
          expect(transcript(f)).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({ content: params.message }),
            }),
          );
          const retry = await f.dispatch(
            params,
            mode === "ordinary raw input" ? null : await f.freshCaller(),
          );
          expect(retry).toMatchObject({
            ok: true,
            meta: { cached: true },
            payload: { runId: f.runId, status: "in_flight" },
          });
          expect(execution.observer).toHaveBeenCalledOnce();
          if (mode === "accepted custody") {
            expect(validateAgentRunDelegatedAuthority(f.owner.authority)).toBe(false);
          }
          expect(agentCommandMock).not.toHaveBeenCalled();
        }
      } finally {
        await finish([writer, request], [observer], replacement);
      }
    },
  );

  it.for(["live", "revoked"] as const)(
    "real managed media persistence: %s caller",
    async (mode, { signal }) => {
      const f = await fixture({ imageCapable: true });
      const execution = await holdExecution(signal);
      const entered =
        createDeferred<Awaited<ReturnType<typeof attachments.persistInboundImagesForTranscript>>>();
      const { release, finish } = pause(f, signal, execution);
      const persist = attachments.persistInboundImagesForTranscript;
      const observer = vi
        .spyOn(attachments, "persistInboundImagesForTranscript")
        .mockImplementationOnce(async (...args) => {
          const saved = await persist(...args);
          entered.resolve(saved);
          await release.promise;
          return saved;
        });
      let request: Promise<Response> | undefined;
      try {
        request = f.dispatch({
          message: "managed image proof",
          attachments: [{ mimeType: "image/png", fileName: "proof.png", content: PNG }],
        });
        const saved = await reach(entered.promise, request);
        expect(saved.omission).toBe("none");
        expect(saved.entries).toHaveLength(1);
        const image = saved.entries[0]!;
        expect(await fs.readFile(image.path)).toEqual(Buffer.from(PNG, "base64"));
        if (mode === "revoked") {
          f.owner.revoke();
        }
        release.resolve();
        const result = await request;

        if (mode === "revoked") {
          expectInactive(result);
          await expectAbsent(image.path);
          expect(await pendingCount(f)).toBe(0);
          expect(transcript(f)).toEqual(f.before);
          expect(execution.observer).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ ok: true, payload: { status: "accepted" } });
          const prepared = await execution.entered;
          const recorder = prepared.userTurn.recorder!;
          const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
          expect(persisted?.appended).toBe(true);
          expect(JSON.stringify(transcript(f))).toContain(image.fact.url);
          expect(await fs.readFile(image.path)).toEqual(Buffer.from(PNG, "base64"));
        }
      } finally {
        await finish([request], [observer]);
      }
    },
  );

  it.for(["live", "revoked", "stopped", "replaced"] as const)(
    "delayed reset final delivery: %s caller",
    async (mode, { signal }) => {
      const { f, sink, recordingAdapterRetained } = await createResetDeliveryFixture(fixture, {
        beforeSendAttempt: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const { entered, release, finish } = pause(f, signal);
      const before = await readEntry(f);
      let request: Promise<Response> | undefined;
      let replacement: ReturnType<typeof createAgentDedupeLifecycle> | undefined;
      try {
        expect(recordingAdapterRetained).toBe(true);
        const params = resetDelivery;
        request = f.dispatch(params);
        await reach(entered.promise, request);
        const committed = await expectReset(f, before);
        await expectAbsent(sink);
        if (mode === "revoked") {
          f.owner.revoke();
        } else if (mode === "stopped") {
          expect(await f.stop()).toMatchObject({ ok: true, payload: { aborted: true } });
        } else if (mode === "replaced") {
          replacement = reserve(f, "/reset");
        }
        const retained = f.context.dedupe.get(`agent:${f.runId}`);
        release.resolve();
        const result = await request;
        await f.drain();

        if (mode !== "live") {
          expectInactive(result, "is no longer active");
          await expectAbsent(sink);
        } else {
          expect(result.ok).toBe(true);
          expect(await fs.readFile(sink, "utf8")).toBe("✅ Session reset.\n");
        }
        const retry = await f.dispatch(params, await f.freshCaller());
        await f.drain();

        if (mode === "stopped" || mode === "replaced") {
          expect(f.context.dedupe.get(`agent:${f.runId}`)).toBe(retained);
          expect(retry).toMatchObject({
            ok: true,
            meta: { cached: true },
            payload: { status: mode === "stopped" ? "timeout" : "in_flight" },
          });
        } else {
          expectCached(retry, result);
        }
        expect((await readEntry(f))?.lifecycleRevision).toBe(committed?.lifecycleRevision);
        if (mode !== "live") {
          await expectAbsent(sink);
          if (mode === "revoked") {
            expect(validateAgentRunDelegatedAuthority(f.owner.authority)).toBe(false);
          }
        } else {
          expect(await fs.readFile(sink, "utf8")).toBe("✅ Session reset.\n");
        }
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        await finish([request], [], replacement);
      }
    },
  );

  it.for(["already committed", "adopted bare", "adopted with suffix"] as const)(
    "retains reset across parent closure and same-key retry: %s",
    async (mode, { signal }) => {
      const adopted = mode !== "already committed";
      const delivery = adopted ? await createResetDeliveryFixture(fixture) : undefined;
      const f = delivery?.f ?? (await fixture());
      const execution = await holdExecution(signal);
      const { entered, release, finish } = pause(f, signal, execution);
      const cleanup = await import("../plugins/host-hook-cleanup.js");
      const performCleanup = cleanup.runPluginHostCleanup;
      const performReset = resets.performGatewaySessionReset;
      const resetObserver = vi.spyOn(resets, "performGatewaySessionReset");
      const cleanupObserver = vi.spyOn(cleanup, "runPluginHostCleanup");
      if (adopted) {
        cleanupObserver.mockImplementation(async (params) => {
          const result = await performCleanup(params);
          if (params.reason === "reset" && params.sessionKey === f.sessionKey) {
            expect(result.failures).toEqual([]);
            // Pause after real generation adoption, before the reset transaction.
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      } else {
        resetObserver.mockImplementationOnce(async (params) => {
          const result = await performReset(params);
          expect(result.ok).toBe(true);
          entered.resolve();
          await release.promise;
          return result;
        });
      }
      const before = await readEntry(f);
      const captureReset = async () => {
        const entry = await expectReset(f, before);
        const events = transcript(f);
        expect(events).not.toEqual(f.before);
        return { entry, events };
      };
      const expectNoDelivery = async () => {
        if (delivery) {
          expect(delivery.attempts()).toBe(0);
          await expectAbsent(delivery.sink);
        }
      };
      let request: Promise<Response> | undefined;
      try {
        if (delivery) {
          expect(delivery.recordingAdapterRetained).toBe(true);
        }
        const followUpPending = mode !== "adopted bare";
        const params = {
          ...(adopted ? resetDelivery : {}),
          message: followUpPending ? "/reset do not admit this suffix" : "/reset",
        };
        request = f.dispatch(params);
        await reach(entered.promise, request);
        const alreadyCommitted = adopted ? undefined : await captureReset();
        if (adopted) {
          expect(await readEntry(f)).toEqual(before);
          expect(transcript(f)).toEqual(f.before);
          await expectNoDelivery();
        }
        f.owner.revoke();
        release.resolve();
        const response = await request;
        const committed = alreadyCommitted ?? (await captureReset());
        expectInactive(response);
        await f.drain();
        expect(await pendingCount(f)).toBe(0);
        expect(execution.observer).not.toHaveBeenCalled();
        await expectNoDelivery();
        const retry = await f.dispatch(params, await f.freshCaller());
        await f.drain();
        expectResetReply(
          retry,
          f,
          followUpPending
            ? expect.stringContaining("before the follow-up ran")
            : "✅ Session reset.",
        );
        expect(resetObserver).toHaveBeenCalledOnce();
        expect(await readEntry(f)).toEqual(committed.entry);
        expect(transcript(f)).toEqual(committed.events);
        expect(await pendingCount(f)).toBe(0);
        expect(execution.observer).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
        await expectNoDelivery();
        expect(validateAgentRunDelegatedAuthority(f.owner.authority)).toBe(false);
      } finally {
        await finish([request], [resetObserver, cleanupObserver]);
      }
    },
  );

  it.for([
    { phase: "pre-registration", replaceAlias: false },
    { phase: "pre-registration", replaceAlias: true },
    { phase: "preaccept revalidation", replaceAlias: false },
    { phase: "preaccept revalidation", replaceAlias: true },
  ] as const)(
    "keeps alias ownership during $phase (replacement=$replaceAlias)",
    async ({ phase, replaceAlias }) => {
      const f = await fixture();
      const alias = "agent:exec-approval-followup:" + f.runId;
      const keys = ["agent:" + f.runId, alias];
      const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
      const lifecycle = reserve(f, "work", f.runId, keys, io);
      let admissionEntry: SessionEntry | undefined = { sessionId: f.sessionId, updatedAt: 1 };
      const admission = createAgentAdmissionController({
        runId: f.runId,
        agentDedupeKeys: keys,
        context: f.context,
        io,
        dedupeLifecycle: lifecycle,
        getRequestedSessionKey: () => f.sessionKey,
        getResolvedSessionKey: () => f.sessionKey,
        getResolvedSessionId: () => f.sessionId,
        getSessionEntry: () => admissionEntry,
        setSessionEntry: (entry) => {
          admissionEntry = entry;
        },
        getResolvedSessionAgentId: () => "main",
        getAgentId: () => "main",
        getSessionPersisted: () => true,
        getSupersededSessionId: () => undefined,
        setAdmittedSessionId: vi.fn(),
      });
      let registration: ReturnType<typeof registerChatAbortController> | undefined;
      let newer: ReturnType<typeof createAgentDedupeLifecycle> | undefined;
      let interrupted: ReturnType<typeof startSessionControllerInterruption> | undefined;
      try {
        await admission.acquire(f.scope.storePath);
        if (replaceAlias) {
          const runId = f.runId + "-replacement";
          newer = reserve(f, "other", runId, ["agent:" + runId, alias], io);
        }
        const retained = f.context.dedupe.get(alias);
        if (phase === "pre-registration") {
          interrupted = startSessionControllerInterruption({
            scope: f.scope.storePath,
            identities: [f.sessionKey, f.sessionId],
          });
        } else {
          registration = registerChatAbortController({
            target: captureSessionTarget({
              storeScope: f.scope.storePath,
              sessionKey: f.sessionKey,
              incarnation: f.sessionId,
              agentId: "main",
            }),
            runId: f.runId,
            sessionKey: f.sessionKey,
            sessionId: f.sessionId,
            agentId: "main",
            timeoutMs: 60_000,
            kind: "agent",
          });
          registration.controller.abort(new Error("stop old admission"));
          const source = {
            context: f.context,
            agentDedupeKeys: keys,
            getOwnedAgentDedupeKeys: () => lifecycle.ownedReservationKeys(),
            admissionAgentId: () => "main",
            runId: f.runId,
            assertGatewayWorkAdmissionAllowed: admission.assertAllowed,
            client: null,
            cfg: f.context.getRuntimeConfig(),
            resolvedSessionKey: f.sessionKey,
            getAdmittedSessionId: () => f.sessionId,
            hasGatewayAdmissionOutcome: admission.hasOutcome,
            respondToGatewayAdmissionOutcome: admission.respondToOutcome,
          };
          await createAgentRunAdmissionRevalidator({
            source,
            activeRunAbort: registration,
            parentResume: undefined,
            rejectPreaccept: async () => undefined,
            cleanupPreaccept: async () => admission.release(),
          })();
        }
        expect(f.context.dedupe.get(keys[0]!)).toMatchObject({
          ok: true,
          payload: { status: "timeout" },
        });
        if (replaceAlias) {
          expect(f.context.dedupe.get(alias)).toBe(retained);
        } else {
          expect(f.context.dedupe.get(alias)).toMatchObject({
            ok: true,
            payload: { status: "timeout", runId: f.runId },
          });
        }
      } finally {
        admission.release();
        registration?.cleanup();
        await interrupted?.released;
        newer?.clearUnaccepted();
        lifecycle.clearUnaccepted();
        await f.cleanup();
      }
    },
  );

  it.for(["best effort", "ambiguous"] as const)(
    "preserves ordinary reset delivery failure on same-key retry: %s",
    async (mode) => {
      const { f, sink, recordingAdapterRetained, attempts } = await createResetDeliveryFixture(
        fixture,
        { failSend: mode === "ambiguous" ? "after write" : true },
      );
      const before = await readEntry(f);
      const resetObserver = vi.spyOn(resets, "performGatewaySessionReset");
      try {
        expect(recordingAdapterRetained).toBe(true);
        const params = { ...resetDelivery, bestEffortDeliver: mode === "best effort" };
        const response = await f.dispatch(params, null);
        await f.drain();
        const committed = await expectReset(f, before);
        const resetTranscript = transcript(f);
        if (mode !== "best effort") {
          expect(response).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("proof strict reset delivery failure") },
          });
          expect(response.payload).toBeUndefined();
        } else {
          expect(response).toMatchObject({
            ok: true,
            payload: {
              result: { deliveryStatus: { status: "failed", succeeded: false, attempted: true } },
            },
          });
        }
        expect(resetTranscript).not.toEqual(f.before);
        expect(attempts()).toBe(1);
        const delivered = await readEffectFile(sink);
        expect(delivered?.toString()).toBe(
          mode === "ambiguous" ? "✅ Session reset.\n" : undefined,
        );
        const retry = await f.dispatch(params, null);
        await f.drain();
        expectCached(retry, response);
        expect(resetObserver).toHaveBeenCalledOnce();
        expect(await readEntry(f)).toEqual(committed);
        expect(transcript(f)).toEqual(resetTranscript);
        expect(await pendingCount(f)).toBe(0);
        expect(attempts()).toBe(1);
        expect(await readEffectFile(sink)).toEqual(delivered);
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
        resetObserver.mockRestore();
      }
    },
  );
});
