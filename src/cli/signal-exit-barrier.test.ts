// Signal-exit barrier tests cover coalesced cleanup across concurrent signal owners.
import { describe, expect, it, vi } from "vitest";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  requestSignalExit,
  waitForSignalExitBarriers,
} from "./signal-exit-barrier.js";

describe("signal exit barriers", () => {
  it("coalesces concurrent drains while cleanup unregisters itself", async () => {
    let finishGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finishGate = resolve;
    });
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const unregisterGate = registerSignalExitGate(gate);
    let unregisterBarrier = () => {};
    unregisterBarrier = registerSignalExitBarrier(async () => {
      unregisterBarrier();
      await cleanup();
    });

    try {
      const firstDrain = waitForSignalExitBarriers();
      const secondDrain = waitForSignalExitBarriers();
      expect(secondDrain).toBe(firstDrain);
      finishGate?.();
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      expect(finishCleanup).toBeTypeOf("function");
      finishCleanup?.();
      await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([undefined, undefined]);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      unregisterGate();
      unregisterBarrier();
    }
  });

  it("coalesces concurrent signal-exit requests and keeps the first exit code", async () => {
    let finishGate: (() => void) | undefined;
    const unregisterGate = registerSignalExitGate(
      new Promise<void>((resolve) => {
        finishGate = resolve;
      }),
    );
    const exit = vi.fn();

    try {
      requestSignalExit({ exitCode: 130, exit });
      requestSignalExit({ exitCode: 143, exit });
      expect(exit).not.toHaveBeenCalled();
      finishGate?.();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(130));
    } finally {
      unregisterGate();
    }
  });

  it("reports cleanup failure to a signal owner that joins an active exit", async () => {
    const failure = new Error("rollback failed");
    const unregisterBarrier = registerSignalExitBarrier(async () => {
      throw failure;
    });
    const onError = vi.fn();
    const exit = vi.fn();

    try {
      requestSignalExit({ exitCode: 143, exit });
      requestSignalExit({ exitCode: 130, exit, onError });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(143));
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errors: [failure] }),
      );
    } finally {
      unregisterBarrier();
    }
  });
});
