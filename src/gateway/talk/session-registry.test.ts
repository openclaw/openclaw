import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runWithProcessCleanupBudget } from "../../process/supervisor/cleanup-budget.js";
import { GatewayRetainedWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState as drain } from "../../shared/global-singleton.js";
import * as database from "../../state/openclaw-state-db.js";
import { captureClientVoiceSessionSettlement } from "../../talk/client-voice-session-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isGatewayCleanupRetainedError } from "../server-shutdown.js";
import {
  cleanupTalkConnection as disconnect,
  prepareTalkConnectionClose as prepareClose,
  registerTalkConnectionCleanup as register,
} from "./session-registry.js";

const log = { warn: vi.fn() };
beforeEach(() => log.warn.mockClear());

it.each(["reopened", "revoked"])("drains cleanup with %s admission", (admission) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const gate = createDeferred();
    const cleanup = vi.fn(() => gate.promise);
    const second = vi.fn();
    const original = prepareClose([{ connId: "original" }], log);
    register("original", "realtime-relay", cleanup);
    register("original", "browser-control", second);
    let nested: ReturnType<typeof prepareClose> | undefined;
    try {
      if (admission === "reopened") {
        await database.closeOpenClawStateDatabaseAsync();
        database.openOpenClawStateDatabase();
        nested = prepareClose([], log);
        await nested.drain();
      } else {
        const accepted = captureClientVoiceSessionSettlement();
        const beginClose = accepted.run(() => AsyncLocalStorage.bind(original.beginClose));
        accepted.release();
        beginClose();
      }
      const draining = original.drain();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      gate.resolve();
      if (admission === "revoked") {
        await expect(draining).rejects.toThrow("lost its accepted owner");
      } else {
        await draining;
        expect(log.warn).not.toHaveBeenCalled();
      }
    } finally {
      gate.resolve();
      await Promise.allSettled([original.drain(), nested?.drain()]);
      disconnect("original", log);
    }
  }),
);
it.each(["sync", "abort", "ignore"])("retries failed cleanup and drains %s settlement", (mode) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const first = createDeferred();
    const retry = createDeferred();
    let signal: AbortSignal | undefined;
    const fail = () => {
      throw new Error("cleanup failed");
    };
    const cleanup = vi
      .fn()
      .mockImplementationOnce(mode === "sync" ? fail : () => first.promise)
      .mockImplementation(() => {
        signal = getAsyncWorkSignal();
        if (mode === "abort") {
          signal!.addEventListener("abort", () => retry.resolve(), { once: true });
        }
        return retry.promise;
      });
    const replaced = vi.fn();
    const sibling = vi.fn();
    register("retry", "realtime-relay", replaced);
    register("retry", "realtime-relay", cleanup);
    register("retry", "transcription-relay", sibling);
    disconnect("retry", log);
    expect(replaced).not.toHaveBeenCalled();
    expect(sibling).toHaveBeenCalledOnce();
    if (mode !== "sync") {
      disconnect("retry", log);
      expect(cleanup).toHaveBeenCalledOnce();
      first.reject(new Error("cleanup failed"));
      await first.promise.catch(() => undefined);
    }
    const close = prepareClose([{ connId: "retry" }], log);
    const generic = new GatewayRetainedWorkScope();
    const genericWork = createDeferred();
    void generic.scope.track(() => genericWork.promise);
    const genericDrain = generic.retainGateway().drain();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = vi.fn();
    const drains = [
      runWithProcessCleanupBudget({ deadline: performance.now() + 4_000, warn: log.warn }, () =>
        close.drain(),
      ),
      drain("restart"),
      drain("restart"),
    ];
    const joined = Promise.all(drains).then(
      () => result("settled"),
      (error: unknown) => result(isGatewayCleanupRetainedError(error) ? "retained" : error),
    );
    try {
      expect(cleanup).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(signal?.aborted).toBe(false);
      expect(result).not.toHaveBeenCalled();
      if (mode === "sync") {
        retry.resolve();
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(generic.scope.signal.aborted).toBe(false);
      expect(result).toHaveBeenCalledWith(mode === "ignore" ? "retained" : "settled");
      expect(signal?.aborted).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
    } finally {
      retry.resolve();
      genericWork.resolve();
      await Promise.allSettled([...drains, genericDrain, joined]);
      vi.useRealTimers();
    }
    disconnect("retry", log);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(sibling).toHaveBeenCalledOnce();
  }),
);
