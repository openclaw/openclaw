import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureClientVoiceSessionSettlement } from "../../talk/client-voice-session-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  cleanupTalkConnection,
  prepareTalkConnectionClose,
  registerTalkConnectionCleanup,
} from "./session-registry.js";

describe("Talk connection cleanup registry", () => {
  it("keeps a live Gateway's cleanup admission after its store reopens", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "talk-cleanup-store-reopen" },
      async () => {
        openOpenClawStateDatabase();
        const log = { warn: vi.fn() };
        const cleanup = vi.fn();
        const original = prepareTalkConnectionClose([{ connId: "original" }], log);
        registerTalkConnectionCleanup("original", "realtime-relay", cleanup);
        let nested: ReturnType<typeof prepareTalkConnectionClose> | undefined;
        try {
          await closeOpenClawStateDatabaseAsync();
          openOpenClawStateDatabase();
          nested = prepareTalkConnectionClose([], log);
          await nested.drain();
          await original.drain();
          expect(cleanup).toHaveBeenCalledOnce();
          expect(log.warn).not.toHaveBeenCalled();
        } finally {
          await Promise.allSettled([original.drain(), nested?.drain()]);
        }
      },
    );
  });

  it("joins all connection cleanups after settlement admission is lost", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "talk-cleanup-refusal" },
      async () => {
        const connId = "conn-close-refusal";
        const entered = createDeferred();
        const finish = createDeferred();
        const second = vi.fn();
        const log = { warn: vi.fn() };
        registerTalkConnectionCleanup(connId, "realtime-relay", () => {
          entered.resolve();
          return finish.promise;
        });
        registerTalkConnectionCleanup(connId, "browser-control", second);
        const close = prepareTalkConnectionClose([{ connId }], log);
        const accepted = captureClientVoiceSessionSettlement();
        const beginClose = accepted.run(() => AsyncLocalStorage.bind(() => close.beginClose()));
        accepted.release();
        beginClose();
        const draining = close.drain();
        void draining.catch(() => {});
        try {
          await awaitGateBeforeSettlement(entered.promise, draining, "Talk cleanup was skipped");
          expect(second).toHaveBeenCalledOnce();
          finish.resolve();
          await expect(draining).rejects.toThrow("lost its accepted owner");
        } finally {
          finish.resolve();
          await draining.catch(() => {});
          cleanupTalkConnection(connId, log);
        }
      },
    );
  });
  it("keeps one cleanup per relay kind and fences reentrant cleanup", () => {
    const replacedRealtimeCleanup = vi.fn();
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };
    const realtimeCleanup = vi.fn(() => {
      cleanupTalkConnection("conn-dedupe", log);
    });

    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", replacedRealtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", realtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-dedupe", log);
    cleanupTalkConnection("conn-dedupe", log);

    expect(replacedRealtimeCleanup).not.toHaveBeenCalled();
    expect(realtimeCleanup).toHaveBeenCalledOnce();
    expect(realtimeCleanup.mock.contexts).toEqual([undefined]);
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("continues cleanup after one relay owner throws", () => {
    const cleanupError = new Error("realtime cleanup failed");
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup(
      "conn-error",
      "realtime-relay",
      vi.fn().mockImplementationOnce(() => {
        throw cleanupError;
      }),
    );
    registerTalkConnectionCleanup("conn-error", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-error", log);

    expect(log.warn).toHaveBeenCalledWith(
      "failed to run realtime-relay Talk cleanup after connection disconnect: realtime cleanup failed",
    );
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    cleanupTalkConnection("conn-error", log);
  });

  it("retains failed async cleanup for shutdown retry without replacing its owner", async () => {
    const first = createDeferred();
    const finish = createDeferred();
    const log = { warn: vi.fn() };
    const queued = createDeferred();
    const queuedStarted = createDeferred();
    const replacement = vi.fn(() => {
      queuedStarted.resolve();
      return queued.promise;
    });
    const cleanup = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => finish.promise);
    registerTalkConnectionCleanup("conn-async-retry", "browser-control", cleanup);
    cleanupTalkConnection("conn-async-retry", log);
    cleanupTalkConnection("conn-async-retry", log);
    expect(cleanup).toHaveBeenCalledOnce();
    const firstObserved = first.promise.catch(() => undefined);
    first.reject(new Error("physical cleanup failed"));
    await firstObserved;
    await Promise.resolve();
    registerTalkConnectionCleanup("conn-async-retry", "browser-control", replacement);
    let drained = false;
    const draining = drainGlobalSingletonLifecycleState("restart").then(() => {
      drained = true;
    });
    let concurrentDrained = false;
    const concurrentDrain = drainGlobalSingletonLifecycleState("restart").then(() => {
      concurrentDrained = true;
    });
    try {
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(replacement).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(drained).toBe(false);
      finish.resolve();
      await queuedStarted.promise;
      expect(drained).toBe(false);
      expect(concurrentDrained).toBe(false);
      expect(replacement).toHaveBeenCalledOnce();
      queued.resolve();
      await Promise.all([draining, concurrentDrain]);
      cleanupTalkConnection("conn-async-retry", log);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("physical cleanup failed"));
    } finally {
      finish.resolve();
      queued.resolve();
      await Promise.all([draining, concurrentDrain]);
    }
  });

  it("joins a restart drain started before the cleanup callback returns", async () => {
    const finish = createDeferred();
    let drained = false;
    let draining = Promise.resolve();
    registerTalkConnectionCleanup("conn-reentrant-drain", "browser-control", () => {
      draining = drainGlobalSingletonLifecycleState("restart").then(() => {
        drained = true;
      });
      return finish.promise;
    });
    cleanupTalkConnection("conn-reentrant-drain", { warn: vi.fn() });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(drained).toBe(false);
    } finally {
      finish.resolve();
      await draining;
    }
    expect(drained).toBe(true);
  });
});
