import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { readSessionStoreSummaryReadOnly } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createStatusSessionStoreReader } from "./session-stores.js";

it("finishes cheap fleet reads without waiting behind every queued background turn", async () => {
  await withOpenClawTestState({ label: "status-read-scheduling" }, async (state) => {
    let workMs = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
    let backgroundTurns = 0;
    let active = true;
    let scheduled: ReturnType<typeof setImmediate>;
    const background = () => {
      backgroundTurns += 1;
      workMs += 20;
      if (active) {
        scheduled = setImmediate(background);
      }
    };
    scheduled = setImmediate(background);
    const read = vi.fn<typeof readSessionStoreSummaryReadOnly>(() => {
      workMs += 0.1;
      return { count: 1, recent: [], byAgent: new Map() };
    });
    try {
      const reader = createStatusSessionStoreReader([], 10, { readSummary: read });
      for (let index = 0; index < 600; index += 1) {
        await expect(reader.read(state.path(`store-${index}.sqlite`))).resolves.toMatchObject({
          count: 1,
        });
      }
      expect(reader.stores.size).toBe(600);
      expect(read).toHaveBeenCalledTimes(600);
      expect(backgroundTurns).toBeGreaterThan(0);
      expect(backgroundTurns).toBeLessThan(30);
    } finally {
      active = false;
      clearImmediate(scheduled);
      clock.mockRestore();
      await nextTurn();
    }
  });
});
