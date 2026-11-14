import { expect, it, vi } from "vitest";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

it.each([false, true])(
  "notifies every collected run observer before surfacing a callback failure (throws: %s)",
  async (throws) => {
    const q = createQueueCase();
    const error = new Error("first observer failed");
    const first = vi.fn(() => {
      if (throws) {
        throw error;
      }
    });
    const second = vi.fn();
    const firstPartial = vi.fn(async () => {
      if (throws) {
        throw error;
      }
      return true;
    });
    const secondPartial = vi.fn(async () => true);
    const onModelSelected = vi.fn();
    for (const [prompt, runObservers] of [
      ["first", { onAgentRunTerminalOutcome: first, onPartialReply: firstPartial }],
      ["second", { onAgentRunTerminalOutcome: second, onPartialReply: secondPartial }],
      ["last", { onModelSelected }],
    ] as const) {
      q.add({ ...createRun({ prompt, originatingChannel: "a2a" }), runObservers });
    }
    await q.drain();
    expect(q.calls).toHaveLength(1);
    const observers = q.calls[0]!.runObservers;
    expect(observers?.onModelSelected).toBe(onModelSelected);
    const fail = () => observers?.onAgentRunTerminalOutcome?.("failed");
    if (throws) {
      expect(fail).toThrow(error);
    } else {
      fail();
    }
    expect(first).toHaveBeenCalledExactlyOnceWith("failed");
    expect(second).toHaveBeenCalledExactlyOnceWith("failed");
    const partial = observers?.onPartialReply?.({ text: "collected native preview" });
    if (throws) {
      await expect(partial).rejects.toBe(error);
    } else {
      await expect(partial).resolves.toBe(true);
    }
    expect(firstPartial).toHaveBeenCalledExactlyOnceWith({ text: "collected native preview" });
    expect(secondPartial).toHaveBeenCalledExactlyOnceWith({ text: "collected native preview" });
  },
);
