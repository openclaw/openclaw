// Proof overlay: real RPC handler, admitted-run owner, SQLite, transcript and media.
// Gateway test helpers replace inference; they do not replace the effect owners below.
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import * as attachments from "./chat-attachments.js";
import {
  createResetDeliveryFixture,
  holdExecution,
  installAgentAuthorityProofFixture,
  observe,
  PNG,
  reach,
  readEffectFile,
  rpcObservation,
  type Response,
} from "./server.agent-runtime-authority-proof.test-support.js";
import * as resets from "./session-reset-service.js";
import { loadSessionEntry } from "./session-utils.js";
import { agentCommandMock } from "./test-helpers.js";

describe("agent RPC real delegated-authority effects", () => {
  const fixture = installAgentAuthorityProofFixture();

  it.for(["live", "revoked"] as const)(
    "real reset transaction: %s caller",
    async (mode, { signal }) => {
      const f = await fixture();
      const entered = createDeferred();
      const release = createDeferred();
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      if (signal.aborted) {
        unblock();
      }
      let calls = 0;
      const hook = async (event: import("../hooks/internal-hooks.js").InternalHookEvent) => {
        if (event.sessionKey !== f.sessionKey) {
          return;
        }
        calls++;
        entered.resolve();
        await release.promise;
      };
      const before = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
      registerInternalHook("command:reset", hook);
      let request: Promise<Response> | undefined;
      try {
        request = f.dispatch({ message: "/reset" });
        await reach(entered.promise, request);
        expect(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry).toEqual(before);
        if (mode === "revoked") {
          f.owner.revoke();
        }
        release.resolve();
        const result = await request;
        await f.drain();
        const observedEntry = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
        observe("reset", {
          mode,
          ...f.effects(),
          ...rpcObservation(result),
          rowChanged: !isDeepStrictEqual(observedEntry, before),
          sessionPreserved: observedEntry?.sessionId === f.sessionId,
        });
        expect(calls).toBe(1);
        expect(agentCommandMock).not.toHaveBeenCalled();
        if (mode === "revoked") {
          expect(result.ok).toBe(false);
          expect(result.error?.message).toContain("authority is no longer active");
          expect(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry).toEqual(before);
          expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(f.before);
        } else {
          expect(result).toMatchObject({ ok: true, payload: { status: "ok" } });
          const after = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
          expect(after?.sessionId).toBe(f.sessionId);
          expect(after?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
          expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).not.toEqual(f.before);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([request]);
        await f.cleanup();
        unregisterInternalHook("command:reset", hook);
        signal.removeEventListener("abort", unblock);
      }
    },
  );

  it("retains an actually committed reset for a new valid caller's same-key retry", async ({
    signal,
  }) => {
    const f = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    if (signal.aborted) {
      unblock();
    }
    const before = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
    const perform = resets.performGatewaySessionReset;
    const observer = vi
      .spyOn(resets, "performGatewaySessionReset")
      .mockImplementationOnce(async (params) => {
        const result = await perform(params);
        expect(result.ok).toBe(true);
        entered.resolve();
        await release.promise;
        return result;
      });
    const execution = await holdExecution(signal);
    let request: Promise<Response> | undefined;
    try {
      const params = { message: "/reset continue with retained proof input" };
      request = f.dispatch(params);
      await reach(entered.promise, request);
      const committed = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
      observe("reset-committed", {
        ...f.effects(),
        rowChanged: !isDeepStrictEqual(committed, before),
        sessionPreserved: committed?.sessionId === f.sessionId,
      });
      expect(committed?.sessionId).toBe(f.sessionId);
      expect(committed?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
      const transcript = sessionAccessor.loadTranscriptEventsSync(f.scope);
      expect(transcript).not.toEqual(f.before);
      f.owner.revoke();
      release.resolve();
      const response = await request;
      observe("reset-after-close", {
        ...f.effects(),
        ...rpcObservation(response),
        executionCalls: execution.observer.mock.calls.length,
      });
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("authority is no longer active") },
      });
      await f.drain();
      expect(listSessionPendingInputs(f.scope).total).toBe(0);
      expect(execution.observer).not.toHaveBeenCalled();
      const retry = await f.dispatch(params, await f.freshCaller());
      await f.drain();
      observe("reset-retry", {
        ...f.effects(),
        ...rpcObservation(retry),
        rowChanged: !isDeepStrictEqual(
          loadSessionEntry(f.sessionKey, { agentId: "main" }).entry,
          committed,
        ),
      });
      expect(retry).toMatchObject({
        ok: true,
        meta: { cached: true },
        payload: { status: "ok", result: { meta: { agentMeta: { sessionId: f.sessionId } } } },
      });
      expect(retry.payload).toMatchObject({
        result: { payloads: [{ text: expect.stringContaining("before the follow-up ran") }] },
      });
      expect(observer).toHaveBeenCalledOnce();
      expect(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry).toEqual(committed);
      expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(transcript);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(validateAgentRunDelegatedAuthority(f.owner.authority)).toBe(false);
    } finally {
      release.resolve();
      await execution.cleanup();
      await Promise.allSettled([request]);
      await f.cleanup();
      observer.mockRestore();
      signal.removeEventListener("abort", unblock);
    }
  });

  it.for(["live", "revoked", "accepted custody"] as const)(
    "real pending-input transaction: %s",
    async (mode, { signal }) => {
      const f = await fixture();
      const execution = await holdExecution(signal);
      const entered = createDeferred();
      const release = createDeferred();
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      if (signal.aborted) {
        unblock();
      }
      let writer: Promise<unknown> | undefined;
      const stage = sessionAccessor.stageSessionPendingInput;
      const observer = vi
        .spyOn(sessionAccessor, "stageSessionPendingInput")
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
          return await pending;
        });
      let request: Promise<Response> | undefined;
      try {
        const params = { message: "real pending-input custody proof" };
        request = f.dispatch(params);
        await reach(entered.promise, request);
        expect(listSessionPendingInputs(f.scope).total).toBe(0);
        if (mode === "revoked") {
          f.owner.revoke();
        }
        release.resolve();
        const result = await request;
        observe("pending-input", {
          mode,
          ...f.effects(),
          ...rpcObservation(result),
          executionCalls: execution.observer.mock.calls.length,
        });
        if (mode === "revoked") {
          expect(result.ok).toBe(false);
          expect(result.error?.message).toContain("authority is no longer active");
          expect(execution.observer).not.toHaveBeenCalled();
          expect(listSessionPendingInputs(f.scope).total).toBe(0);
          expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(f.before);
          expect(agentCommandMock).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ ok: true, payload: { status: "accepted" } });
          const prepared = await execution.entered;
          expect(listSessionPendingInputs(f.scope)).toMatchObject({
            total: 1,
            items: [{ state: "queued", runId: f.runId, message: { content: params.message } }],
          });
          if (mode === "accepted custody") {
            f.owner.revoke();
          }
          expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
          const recorder = prepared.userTurn.recorder!;
          const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
          observe("accepted-custody", { mode, ...f.effects(), ...rpcObservation(result) });
          expect(persisted?.appended).toBe(true);
          expect(persisted?.message.content).toBe(params.message);
          expect(listSessionPendingInputs(f.scope).total).toBe(0);
          expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({ content: params.message }),
              }),
            ]),
          );
          const retry = await f.dispatch(params, await f.freshCaller());
          observe("pending-retry", {
            mode,
            ...f.effects(),
            ...rpcObservation(retry),
            executionCalls: execution.observer.mock.calls.length,
          });
          expect(retry).toMatchObject({
            ok: true,
            meta: { cached: true },
            payload: { runId: f.runId, status: "in_flight" },
          });
          expect(execution.observer).toHaveBeenCalledOnce();
          if (mode === "accepted custody") {
            expect(validateAgentRunDelegatedAuthority(f.owner.authority)).toBe(false);
          }
        }
      } finally {
        release.resolve();
        await execution.cleanup();
        await Promise.allSettled([writer, request]);
        await f.cleanup();
        observer.mockRestore();
        signal.removeEventListener("abort", unblock);
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
      const release = createDeferred();
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      if (signal.aborted) {
        unblock();
      }
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
        const media = await readEffectFile(image.path);
        observe("media", {
          mode,
          ...f.effects(),
          ...rpcObservation(result),
          mediaExists: media !== undefined,
          mediaBytesMatch: media?.equals(Buffer.from(PNG, "base64")) === true,
          executionCalls: execution.observer.mock.calls.length,
        });
        if (mode === "revoked") {
          expect(result.ok).toBe(false);
          expect(result.error?.message).toContain("authority is no longer active");
          await expect(fs.stat(image.path)).rejects.toMatchObject({ code: "ENOENT" });
          expect(listSessionPendingInputs(f.scope).total).toBe(0);
          expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(f.before);
          expect(execution.observer).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ ok: true, payload: { status: "accepted" } });
          const prepared = await execution.entered;
          const recorder = prepared.userTurn.recorder!;
          const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
          observe("media-transcript", {
            mode,
            ...f.effects(),
            ...rpcObservation(result),
            mediaExists: (await readEffectFile(image.path)) !== undefined,
          });
          expect(persisted?.appended).toBe(true);
          expect(JSON.stringify(sessionAccessor.loadTranscriptEventsSync(f.scope))).toContain(
            image.fact.url,
          );
          expect(await fs.readFile(image.path)).toEqual(Buffer.from(PNG, "base64"));
        }
      } finally {
        release.resolve();
        await execution.cleanup();
        await Promise.allSettled([request]);
        await f.cleanup();
        observer.mockRestore();
        signal.removeEventListener("abort", unblock);
      }
    },
  );

  it.for(["live", "revoked"] as const)(
    "delayed reset final delivery: %s caller",
    async (mode, { signal }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      if (signal.aborted) {
        unblock();
      }
      const { f, sink, recordingAdapterRetained } = await createResetDeliveryFixture(fixture, {
        beforeSendAttempt: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      observe("delivery-setup", { mode, ...f.owner.observation(), recordingAdapterRetained });
      const before = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
      let request: Promise<Response> | undefined;
      try {
        expect(recordingAdapterRetained).toBe(true);
        const params = {
          message: "/reset",
          deliver: true,
          bestEffortDeliver: false,
          channel: "matrix",
          to: "!proof:example.test",
        };
        request = f.dispatch(params);
        await reach(entered.promise, request);
        const committed = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
        expect(committed?.sessionId).toBe(f.sessionId);
        expect(committed?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
        await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
        if (mode === "revoked") {
          f.owner.revoke();
        }
        release.resolve();
        const result = await request;
        await f.drain();
        const delivered = await readEffectFile(sink);
        observe("delivery", {
          mode,
          ...f.effects(),
          ...rpcObservation(result),
          rowChanged: !isDeepStrictEqual(committed, before),
          sessionPreserved: committed?.sessionId === f.sessionId,
          deliveryCount: delivered?.toString("utf8").split("\n").filter(Boolean).length ?? 0,
        });
        if (mode === "revoked") {
          expect(result.ok).toBe(false);
          expect(result.error?.message).toContain("authority is no longer active");
          await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(result.ok).toBe(true);
          expect(await fs.readFile(sink, "utf8")).toBe("✅ Session reset.\n");
        }
        const retry = await f.dispatch(params, await f.freshCaller());
        await f.drain();
        const afterRetry = await readEffectFile(sink);
        observe("delivery-retry", {
          mode,
          ...f.effects(),
          ...rpcObservation(retry),
          deliveryCount: afterRetry?.toString("utf8").split("\n").filter(Boolean).length ?? 0,
        });
        expect(retry).toMatchObject({
          ok: true,
          meta: { cached: true },
          payload: { status: "ok" },
        });
        expect(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry?.lifecycleRevision).toBe(
          committed?.lifecycleRevision,
        );
        if (mode === "revoked") {
          await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
          expect(validateAgentRunDelegatedAuthority(f.owner.authority)).toBe(false);
        } else {
          expect(await fs.readFile(sink, "utf8")).toBe("✅ Session reset.\n");
        }
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([request]);
        await f.cleanup();
        signal.removeEventListener("abort", unblock);
      }
    },
  );

  it("admits ordinary raw agent input without a runtime identity", async ({ signal }) => {
    const f = await fixture();
    const execution = await holdExecution(signal);
    try {
      const params = { message: "ordinary raw RPC compatibility input" };
      // null omits the private runtime identity, without injecting a liveness guard.
      const response = await f.dispatch(params, null);
      observe("ordinary-admission", {
        ...rpcObservation(response),
        ...f.effects(),
        executionCalls: execution.observer.mock.calls.length,
      });
      expect(response).toMatchObject({ ok: true, payload: { status: "accepted" } });
      const prepared = await execution.entered;
      expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
      expect(listSessionPendingInputs(f.scope)).toMatchObject({
        total: 1,
        items: [{ state: "queued", runId: f.runId, message: { content: params.message } }],
      });
      const recorder = prepared.userTurn.recorder!;
      const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
      expect(persisted?.appended).toBe(true);
      expect(persisted?.message.content).toBe(params.message);
      expect(listSessionPendingInputs(f.scope).total).toBe(0);
      expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({ content: params.message }),
          }),
        ]),
      );
      const retry = await f.dispatch(params, null);
      expect(retry).toMatchObject({
        ok: true,
        meta: { cached: true },
        payload: { runId: f.runId, status: "in_flight" },
      });
      expect(execution.observer).toHaveBeenCalledOnce();
      expect(agentCommandMock).not.toHaveBeenCalled();
    } finally {
      await execution.cleanup();
      await f.cleanup();
    }
  });

  it.for(["bare", "with suffix"] as const)(
    "finishes adopted existing reset after parent closure: %s",
    async (mode, { signal }) => {
      const { f, sink, recordingAdapterRetained, attempts } =
        await createResetDeliveryFixture(fixture);
      const entered = createDeferred();
      const release = createDeferred();
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      if (signal.aborted) {
        unblock();
      }
      const cleanup = await import("../plugins/host-hook-cleanup.js");
      const performCleanup = cleanup.runPluginHostCleanup;
      const cleanupObserver = vi
        .spyOn(cleanup, "runPluginHostCleanup")
        .mockImplementation(async (params) => {
          const result = await performCleanup(params);
          if (params.reason === "reset" && params.sessionKey === f.sessionKey) {
            expect(result.failures).toEqual([]);
            // Real runtime cleanup has already adopted the existing generation;
            // the real lifecycle transaction has not begun. Do not fake its commit.
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const resetObserver = vi.spyOn(resets, "performGatewaySessionReset");
      const execution = await holdExecution(signal);
      const before = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
      let request: Promise<Response> | undefined;
      try {
        expect(recordingAdapterRetained).toBe(true);
        const followUpPending = mode === "with suffix";
        const params = {
          message: followUpPending ? "/reset do not admit this suffix" : "/reset",
          deliver: true,
          bestEffortDeliver: false,
          channel: "matrix",
          to: "!proof:example.test",
        };
        request = f.dispatch(params);
        await reach(entered.promise, request);
        expect(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry).toEqual(before);
        expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(f.before);
        expect(attempts()).toBe(0);
        await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
        f.owner.revoke();
        observe("reset-adopted", { followUpPending, ...f.effects() });
        release.resolve();
        const response = await request;
        const committed = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
        const transcript = sessionAccessor.loadTranscriptEventsSync(f.scope);
        observe("reset-after-close", {
          followUpPending,
          ...f.effects(),
          ...rpcObservation(response),
          rowChanged: !isDeepStrictEqual(committed, before),
          sessionPreserved: committed?.sessionId === f.sessionId,
          executionCalls: execution.observer.mock.calls.length,
          deliveryAttempts: attempts(),
          deliveryCount: (await readEffectFile(sink)) === undefined ? 0 : 1,
        });
        expect(committed?.sessionId).toBe(f.sessionId);
        expect(committed?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
        expect(transcript).not.toEqual(f.before);
        expect(response).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("authority is no longer active") },
        });
        expect(listSessionPendingInputs(f.scope).total).toBe(0);
        expect(execution.observer).not.toHaveBeenCalled();
        expect(attempts()).toBe(0);
        await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
        const retry = await f.dispatch(params, await f.freshCaller());
        await f.drain();
        observe("reset-adopted-retry", {
          followUpPending,
          ...rpcObservation(retry),
          ...f.effects(),
          resetCalls: resetObserver.mock.calls.length,
          deliveryAttempts: attempts(),
          executionCalls: execution.observer.mock.calls.length,
        });
        expect(retry).toMatchObject({
          ok: true,
          meta: { cached: true },
          payload: {
            status: "ok",
            result: {
              payloads: [
                {
                  text: followUpPending
                    ? expect.stringContaining("before the follow-up ran")
                    : "✅ Session reset.",
                },
              ],
              meta: { agentMeta: { sessionId: f.sessionId } },
            },
          },
        });
        expect(resetObserver).toHaveBeenCalledOnce();
        expect(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry).toEqual(committed);
        expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(transcript);
        expect(listSessionPendingInputs(f.scope).total).toBe(0);
        expect(execution.observer).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(attempts()).toBe(0);
        await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
        expect(validateAgentRunDelegatedAuthority(f.owner.authority)).toBe(false);
      } finally {
        release.resolve();
        await execution.cleanup();
        await Promise.allSettled([request]);
        await f.cleanup();
        resetObserver.mockRestore();
        cleanupObserver.mockRestore();
        signal.removeEventListener("abort", unblock);
      }
    },
  );

  it("retries ordinary strict reset delivery failure as a reset-only receipt", async () => {
    const { f, sink, recordingAdapterRetained, attempts } = await createResetDeliveryFixture(
      fixture,
      { failSend: true },
    );
    const before = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
    const resetObserver = vi.spyOn(resets, "performGatewaySessionReset");
    try {
      expect(recordingAdapterRetained).toBe(true);
      const params = {
        message: "/reset",
        deliver: true,
        bestEffortDeliver: false,
        channel: "matrix",
        to: "!proof:example.test",
      };
      const response = await f.dispatch(params, null);
      await f.drain();
      const committed = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
      const transcript = sessionAccessor.loadTranscriptEventsSync(f.scope);
      observe("strict-delivery-failure", {
        ...rpcObservation(response),
        ...f.effects(),
        rowChanged: !isDeepStrictEqual(committed, before),
        sessionPreserved: committed?.sessionId === f.sessionId,
        deliveryAttempts: attempts(),
      });
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("proof strict reset delivery failure") },
      });
      expect(committed?.sessionId).toBe(f.sessionId);
      expect(committed?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
      expect(transcript).not.toEqual(f.before);
      expect(attempts()).toBe(1);
      await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
      const retry = await f.dispatch(params, null);
      await f.drain();
      observe("strict-delivery-retry", {
        ...rpcObservation(retry),
        ...f.effects(),
        resetCalls: resetObserver.mock.calls.length,
        rowChanged: !isDeepStrictEqual(
          loadSessionEntry(f.sessionKey, { agentId: "main" }).entry,
          committed,
        ),
        deliveryAttempts: attempts(),
      });
      expect(retry).toMatchObject({ ok: true, meta: { cached: true } });
      // Exact projection: completed reset, not successful channel delivery. No
      // deliveryStatus, deliverySucceeded, message identity, or delivery receipt.
      expect(retry.payload).toEqual({
        runId: f.runId,
        status: "ok",
        summary: "completed",
        result: {
          payloads: [{ text: "✅ Session reset.", isStatusNotice: true }],
          meta: { durationMs: 0, agentMeta: { sessionId: f.sessionId } },
        },
      });
      expect(resetObserver).toHaveBeenCalledOnce();
      expect(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry).toEqual(committed);
      expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(transcript);
      expect(listSessionPendingInputs(f.scope).total).toBe(0);
      expect(attempts()).toBe(1);
      await expect(fs.stat(sink)).rejects.toMatchObject({ code: "ENOENT" });
      expect(agentCommandMock).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
      resetObserver.mockRestore();
    }
  });
});
