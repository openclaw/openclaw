import {
  createWorkerNativeSectionState,
  createWorkerTaskControl,
} from "@openclaw/worker-runtime/worker";
import { expect } from "vitest";
import { deliverSessionMemoryEntries } from "./session-memory-entry.worker.js";
import type {
  SessionEntriesWorkerInput,
  SessionEntriesWorkerResult,
} from "./session-transcript-worker-read.types.js";

type PreparedEntries = SessionEntriesWorkerResult["entries"];

/** Collect the production worker's acknowledged deliveries without starting another thread. */
export async function collectSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  publish?: (index: number, value: PreparedEntries[number]) => Promise<void>,
): Promise<PreparedEntries> {
  const collected: PreparedEntries = [];
  const result = await deliverSessionMemoryEntries(
    entries,
    {
      consumeInput() {},
      notify() {},
      async request(value) {
        // SAFETY: This fixture is the receiving end of the production export worker's protocol.
        const update = value as {
          kind: "session-entries";
          index: number;
          value: PreparedEntries[number];
        };
        expect(update.kind).toBe("session-entries");
        await publish?.(update.index, update.value);
        collected[update.index] = update.value;
        return { input: undefined, consumed() {} };
      },
    },
    createWorkerTaskControl(createWorkerNativeSectionState(), () => true),
  );
  expect(result).toEqual({ entries: [] });
  return collected;
}
