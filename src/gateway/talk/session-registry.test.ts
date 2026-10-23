import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import * as database from "../../state/openclaw-state-db.js";
import { captureClientVoiceSessionSettlement } from "../../talk/client-voice-session-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  cleanupTalkConnection as disconnect,
  prepareTalkConnectionClose as prepareClose,
  registerTalkConnectionCleanup as register,
} from "./session-registry.js";

function cleanupGate() {
  const started = createDeferred();
  const completion = createDeferred();
  const run = () => {
    started.resolve();
    return completion.promise;
  };
  return { ...completion, started: started.promise, run };
}
const withState = (run: () => Promise<void>) => withOpenClawTestState({ scenario: "minimal" }, run);

const log = { warn: vi.fn() };
beforeEach(() => log.warn.mockClear());

it("keeps a live Gateway's cleanup admission after its store reopens", () =>
  withState(async () => {
    database.openOpenClawStateDatabase();
    const cleanup = vi.fn();
    const original = prepareClose([{ connId: "original" }], log);
    register("original", "realtime-relay", cleanup);
    let nested: ReturnType<typeof prepareClose> | undefined;
    try {
      await database.closeOpenClawStateDatabaseAsync();
      database.openOpenClawStateDatabase();
      nested = prepareClose([], log);
      await nested.drain();
      await original.drain();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([original.drain(), nested?.drain()]);
    }
  }));

it("joins all connection cleanups after settlement admission is lost", () =>
  withState(async () => {
    const connId = "conn-close-refusal";
    const gate = cleanupGate();
    const second = vi.fn();
    register(connId, "realtime-relay", gate.run);
    register(connId, "browser-control", second);
    const close = prepareClose([{ connId }], log);
    const accepted = captureClientVoiceSessionSettlement();
    const beginClose = accepted.run(() => AsyncLocalStorage.bind(() => close.beginClose()));
    accepted.release();
    beginClose();
    const draining = close.drain();
    try {
      await awaitGateBeforeSettlement(gate.started, draining, "Talk cleanup was skipped");
      expect(second).toHaveBeenCalledOnce();
      gate.resolve();
      await expect(draining).rejects.toThrow("lost its accepted owner");
    } finally {
      gate.resolve();
      await draining.catch(() => {});
      disconnect(connId, log);
    }
  }));
it.each([false, true])("cleans relay kinds (failure=%s)", (throws) => {
  const warning =
    "failed to run realtime-relay Talk cleanup after connection disconnect: realtime cleanup failed";
  const replaced = vi.fn();
  const transcription = vi.fn();
  const realtime = vi.fn().mockImplementationOnce(() => {
    if (throws) {
      throw new Error("realtime cleanup failed");
    }
  });

  register("conn-dedupe", "realtime-relay", replaced);
  register("conn-dedupe", "realtime-relay", realtime);
  register("conn-dedupe", "transcription-relay", transcription);

  disconnect("conn-dedupe", log);
  expect(replaced).not.toHaveBeenCalled();
  expect(realtime.mock.contexts).toEqual([undefined]);
  expect(transcription).toHaveBeenCalledOnce();
  expect(log.warn.mock.calls).toEqual(throws ? [[warning]] : []);
  disconnect("conn-dedupe", log);
  expect(realtime).toHaveBeenCalledTimes(throws ? 2 : 1);
});

it("retains failed async cleanup for shutdown retry without replacing its owner", async () => {
  const first = cleanupGate();
  const retry = cleanupGate();
  const cleanup = vi.fn().mockImplementationOnce(first.run).mockImplementationOnce(retry.run);
  register("conn-async-retry", "browser-control", cleanup);
  disconnect("conn-async-retry", log);
  disconnect("conn-async-retry", log);
  await first.started;
  expect(cleanup).toHaveBeenCalledOnce();
  first.reject(new Error("physical cleanup failed"));
  await first.promise.catch(() => undefined);
  const drained = vi.fn();
  const drains = [
    drainGlobalSingletonLifecycleState("restart").then(drained),
    drainGlobalSingletonLifecycleState("restart").then(drained),
  ];
  try {
    await retry.started;
    expect(cleanup).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    retry.resolve();
    await Promise.all(drains);
    disconnect("conn-async-retry", log);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("physical cleanup failed"));
  } finally {
    retry.resolve();
    await Promise.all(drains);
  }
});
