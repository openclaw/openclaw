import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runVitestPlans } from "../../scripts/lib/vitest-plan-scheduling.mts";
import { createDeferred } from "../helpers/promise.js";

describe("ordered Vitest plan admission", () => {
  it("joins both ordinary lanes around an exclusive barrier without changing indices", async () => {
    const plans = ["pre-a", "pre-b", "exclusive", "post-a", "post-b"];
    const gates = plans.map(() => createDeferred());
    const seen: Array<[string, number, number]> = [];
    const running = runVitestPlans(plans, {
      concurrency: 2,
      isExclusive: (plan) => plan === "exclusive",
      shouldStop: () => false,
      run: async (plan, index, lane) => {
        seen.push([plan, index, lane]);
        await gates[index]!.promise;
      },
    });
    try {
      expect(seen).toEqual([
        ["pre-a", 0, 0],
        ["pre-b", 1, 1],
      ]);
      gates[0]!.resolve();
      await nextTurn();
      expect(seen).toHaveLength(2);
      gates[1]!.resolve();
      await nextTurn();
      expect(seen[2]).toEqual(["exclusive", 2, 0]);
      expect(seen).toHaveLength(3);
      gates[2]!.resolve();
      await nextTurn();
      expect(seen.slice(3)).toEqual([
        ["post-a", 3, 0],
        ["post-b", 4, 1],
      ]);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await running;
    }
  });

  it.each(["failure", "rejection", "cancellation"])(
    "stops future admission and drains the other lane after %s",
    async (outcome) => {
      const first = createDeferred();
      const peer = createDeferred();
      const seen: number[] = [];
      let stop = false;
      let settled = false;
      const running = runVitestPlans([0, 1, 2, 3], {
        concurrency: 2,
        isExclusive: (plan) => plan === 2,
        shouldStop: () => stop,
        run: async (plan) => {
          seen.push(plan);
          await (plan === 0 ? first.promise : peer.promise);
          if (plan === 0) {
            if (outcome === "rejection") {
              throw new Error("unjoined owner");
            }
            stop = true;
          }
        },
      }).finally(() => {
        settled = true;
      });
      const checked =
        outcome === "rejection" ? expect(running).rejects.toThrow("unjoined owner") : running;
      try {
        if (outcome === "cancellation") {
          stop = true;
        }
        first.resolve();
        await nextTurn();
        expect(seen).toEqual([0, 1]);
        expect(settled).toBe(false);
      } finally {
        peer.resolve();
        await checked;
      }
      expect(seen).toEqual([0, 1]);
    },
  );
});
