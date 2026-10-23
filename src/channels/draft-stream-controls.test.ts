import { setImmediate as nextMacrotask } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearFinalizableDraftMessage,
  createFinalizableDraftLifecycle,
  takeMessageIdAfterStop,
} from "./draft-stream-controls.js";

type LifecycleOptions = Parameters<typeof createFinalizableDraftLifecycle<string>>[0];

function draft(messageId = "preview-old") {
  const message: { id: string | undefined } = { id: messageId };
  const options = {
    stopForClear: async () => {},
    readMessageId: () => message.id,
    clearMessageId: () => {
      message.id = undefined;
    },
    isValidMessageId: (value: unknown): value is string => typeof value === "string",
    warnPrefix: "cleanup failed",
  };
  const state = { stopped: false, final: false };
  const pending = createDeferred();
  const deleteMessage = vi.fn(() => pending.promise);
  const warn = vi.fn();
  const onFailure = vi.fn();
  const clear = () =>
    clearFinalizableDraftMessage({ ...options, deleteMessage, warn, onDeleteFailure: onFailure });
  const lifecycle = (overrides: Partial<LifecycleOptions> = {}) =>
    createFinalizableDraftLifecycle({
      ...options,
      state,
      throttleMs: 250,
      sendOrEditStreamMessage: async () => true,
      deleteMessage,
      warn,
      ...overrides,
    });
  return { message, state, lifecycle, pending, deleteMessage, warn, onFailure, clear };
}

describe("draft-stream-controls", () => {
  it("takeMessageIdAfterStop stops, reads, and clears message id", async () => {
    const events: string[] = [];
    let messageId: string | undefined = "m-1";

    const result = await takeMessageIdAfterStop({
      stopForClear: async () => {
        events.push("stop");
      },
      readMessageId: () => {
        events.push("read");
        return messageId;
      },
      clearMessageId: () => {
        events.push("clear");
        messageId = undefined;
      },
    });

    expect({ result, messageId, events }).toEqual({
      result: "m-1",
      messageId: undefined,
      events: ["stop", "read", "clear"],
    });
  });

  it("clearFinalizableDraftMessage claims a failed delete and reports its retry target", async () => {
    const { message, pending, onFailure, warn, clear } = draft("m-3");
    const clearing = clear();
    pending.reject(new Error("boom"));
    await clearing;

    expect(message.id).toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith("m-3");
    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");
  });

  it("clearFinalizableDraftMessage claims an id before concurrent clears", async () => {
    const { pending, deleteMessage, clear } = draft("m-3");

    const firstClear = clear();
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("m-3"));
    await clear();
    pending.resolve();
    await firstClear;

    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "preserves a replacement id after deletion (failed: %s)",
    async (failed) => {
      const { message, pending, deleteMessage, onFailure, clear } = draft();
      const clearPromise = clear();
      await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));

      message.id = "preview-new";
      if (failed) {
        pending.reject(new Error("boom"));
      } else {
        pending.resolve();
      }
      await clearPromise;
      expect(onFailure.mock.calls).toEqual(failed ? [["preview-old"]] : []);
      expect(message.id).toBe("preview-new");
    },
  );

  it("lifecycle retries a failed old deletion after the current id is replaced", async () => {
    const { message, pending, warn, lifecycle: createLifecycle } = draft();
    const deleteMessage = vi
      .fn<(messageId: string) => Promise<void>>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    const lifecycle = createLifecycle({ deleteMessage });

    const firstClear = lifecycle.clear();
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));
    message.id = "preview-new";
    pending.reject(new Error("boom"));
    await firstClear;

    expect(message.id).toBe("preview-new");
    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");

    await lifecycle.clear();

    expect(deleteMessage.mock.calls.map(([id]) => id)).toEqual([
      "preview-old",
      "preview-old",
      "preview-new",
    ]);
    expect(message.id).toBeUndefined();
  });

  it("lifecycle does not retry a successful delete when its success callback fails", async () => {
    const { message, warn, lifecycle: createLifecycle } = draft();
    const deleteMessage = vi.fn(async () => {});
    const lifecycle = createLifecycle({
      deleteMessage,
      onDeleteSuccess: () => {
        throw new Error("callback boom");
      },
    });

    await lifecycle.clear();
    await lifecycle.clear();

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(message.id).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("cleanup failed after delete: callback boom");
  });

  it("keeps deletion serialized when stop rejects during an earlier clear", async () => {
    const { message, state, lifecycle: createLifecycle } = draft();
    const deleteStarted = createDeferred();
    const releaseDelete = createDeferred();
    const pendingSend = createDeferred();
    const stopError = new Error("flush failed");
    const deletedIds: string[] = [];
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    const lifecycle = createLifecycle({
      throttleMs: 0,
      sendOrEditStreamMessage: () => pendingSend.promise,
      deleteMessage: async (id) => {
        deletedIds.push(id);
        activeDeletes += 1;
        maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
        try {
          if (id === "preview-old") {
            deleteStarted.resolve();
            await releaseDelete.promise;
          }
        } finally {
          activeDeletes -= 1;
        }
      },
    });
    const firstClear = lifecycle.clearWithStop(async () => {});
    let stopped: Promise<unknown> | undefined;
    let secondClear: Promise<void> | undefined;
    try {
      await deleteStarted.promise;
      message.id = "preview-new";
      lifecycle.update("Pending update");
      stopped = lifecycle.stop().catch((error: unknown) => error);
      expect(state.final).toBe(true);
      secondClear = lifecycle.clear();
      pendingSend.reject(stopError);
      // Let queued promise reactions run while the first physical deletion is still held.
      await nextMacrotask();
      expect(maxActiveDeletes).toBe(1);

      releaseDelete.resolve();
      await Promise.all([firstClear, secondClear]);
      expect(await stopped).toBe(stopError);
      expect(deletedIds).toEqual(["preview-old", "preview-new"]);
    } finally {
      pendingSend.resolve();
      releaseDelete.resolve();
      await Promise.allSettled([firstClear, stopped, secondClear]);
      lifecycle.loop.stop();
    }
  });

  it("lifecycle seal ignores late updates without clearing the preview id", async () => {
    const { message, state, deleteMessage, lifecycle: createLifecycle } = draft("m-5");
    const sendOrEditStreamMessage = vi.fn(async () => true);
    const lifecycle = createLifecycle({ sendOrEditStreamMessage });

    lifecycle.update("stale");
    await lifecycle.seal();
    lifecycle.update("late");
    await lifecycle.loop.flush();

    expect(state.final).toBe(true);
    expect(message.id).toBe("m-5");
    expect(sendOrEditStreamMessage).toHaveBeenCalledExactlyOnceWith("stale");
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
