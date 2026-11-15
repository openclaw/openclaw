import {
  createWorkerNativeSectionState,
  createWorkerTaskControl,
} from "@openclaw/worker-runtime/worker";
import { expect } from "vitest";
import { deliverSessionMemoryEntries } from "./session-memory-entry.worker.js";
import type {
  SessionEntriesWorkerInput,
  SessionEntriesWorkerUpdate,
} from "./session-transcript-worker-read.types.js";

type Value = Extract<SessionEntriesWorkerUpdate, { value: unknown }>["value"];
type Exported = Extract<Value, { summary: unknown }>;
type Collected =
  | { cold: true }
  | {
      entry: (NonNullable<Exported["summary"]> & { content: string }) | null;
      resetRecallCutoff: Exported["resetRecallCutoff"];
      pages: number;
    };
type Request = Omit<SessionEntriesWorkerInput["entries"][number], "pages" | "messages"> &
  Partial<Pick<SessionEntriesWorkerInput["entries"][number], "pages" | "messages">>;

/** Collect the production worker's acknowledged deliveries without starting another thread. */
export async function collectSessionMemoryEntries(
  entries: readonly Request[],
  publish?: (index: number, value: Collected) => Promise<void>,
  observe?: (
    index: number,
    update: Exclude<SessionEntriesWorkerUpdate, { value: unknown }>,
  ) => void,
): Promise<Collected[]> {
  const collected: Collected[] = [];
  const lines = entries.map((): string[] => []);
  const pages = entries.map(() => 0);
  const result = await deliverSessionMemoryEntries(
    entries.map((entry) => ({ pages: true, messages: false, ...entry })),
    {
      consumeInput() {},
      notify() {},
      async request(value) {
        // SAFETY: This fixture is the receiving end of the production export worker's protocol.
        const update = value as {
          kind: "session-entries";
          index: number;
        } & SessionEntriesWorkerUpdate;
        expect(update.kind).toBe("session-entries");
        if (!("value" in update)) {
          observe?.(update.index, update);
        }
        if ("reset" in update) {
          lines[update.index] = [];
        } else if ("page" in update) {
          expect(update.page.startLine).toBe(lines[update.index]!.length);
          lines[update.index]!.push(...update.page.lines);
          pages[update.index]!++;
        } else {
          const done = update.value;
          const entry: Collected =
            "cold" in done
              ? done
              : {
                  entry: done.summary
                    ? { ...done.summary, content: lines[update.index]!.join("\n") }
                    : null,
                  resetRecallCutoff: done.resetRecallCutoff,
                  pages: pages[update.index]!,
                };
          await publish?.(update.index, entry);
          collected[update.index] = entry;
        }
        return { input: undefined, consumed() {} };
      },
    },
    createWorkerTaskControl(createWorkerNativeSectionState(), () => true),
  );
  expect(result).toEqual({ entries: [] });
  return collected;
}
