import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState as drain } from "../../shared/global-singleton.js";
import * as database from "../../state/openclaw-state-db.js";
import { captureClientVoiceSessionSettlement } from "../../talk/client-voice-session-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
it("replaces relay callbacks and retries failures without blocking sibling cleanup", () => {
  const replaced = vi.fn();
  const transcription = vi.fn();
  const realtime = vi.fn().mockImplementationOnce(() => {
    throw new Error("realtime cleanup failed");
  });

  register("conn-dedupe", "realtime-relay", replaced);
  register("conn-dedupe", "realtime-relay", realtime);
  register("conn-dedupe", "transcription-relay", transcription);

  disconnect("conn-dedupe", log);
  expect(replaced).not.toHaveBeenCalled();
  expect(transcription).toHaveBeenCalledOnce();
  expect(log.warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("realtime cleanup failed"),
  );
  disconnect("conn-dedupe", log);
  expect(realtime).toHaveBeenCalledTimes(2);
  expect(transcription).toHaveBeenCalledOnce();
});

it("retains failed async cleanup for shutdown retry without replacing its owner", async () => {
  const first = createDeferred();
  const retry = createDeferred();
  const cleanup = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  register("conn-async-retry", "browser-control", cleanup);
  disconnect("conn-async-retry", log);
  disconnect("conn-async-retry", log);
  expect(cleanup).toHaveBeenCalledOnce();
  first.reject(new Error("physical cleanup failed"));
  await first.promise.catch(() => undefined);
  const drained = vi.fn();
  const drains = [1, 2].map(() => drain("restart").then(drained));
  try {
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
