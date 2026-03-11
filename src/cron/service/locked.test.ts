import { describe, expect, it } from "vitest";
import { createNoopLogger } from "../service.test-harness.js";
import { locked } from "./locked.js";
import { createCronServiceState } from "./state.js";

function createTestState(storePath: string) {
  return createCronServiceState({
    cronEnabled: true,
    storePath,
    log: createNoopLogger(),
    enqueueSystemEvent: () => {},
    requestHeartbeatNow: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
}

/** Flush enough microtask ticks for locked() to await + enter fn. */
async function flush(n = 5) {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

describe("locked", () => {
  it("serializes concurrent operations on the same instance", async () => {
    const state = createTestState("/tmp/locked-test-serial");
    const order: string[] = [];

    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const op1 = locked(state, async () => {
      order.push("op1:start");
      await firstBlocked;
      order.push("op1:end");
      return 1;
    });

    const op2 = locked(state, async () => {
      order.push("op2:start");
      return 2;
    });

    // Let microtasks settle — op1 should have started, op2 should be waiting
    await flush();
    expect(order).toEqual(["op1:start"]);

    // Release op1
    resolveFirst();
    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(["op1:start", "op1:end", "op2:start"]);
  });

  it("serializes across different instances sharing the same store", async () => {
    const storePath = "/tmp/locked-test-cross-instance";
    const stateA = createTestState(storePath);
    const stateB = createTestState(storePath);
    const order: string[] = [];

    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const op1 = locked(stateA, async () => {
      order.push("A:start");
      await firstBlocked;
      order.push("A:end");
      return "a";
    });

    const op2 = locked(stateB, async () => {
      order.push("B:start");
      return "b";
    });

    await flush();
    expect(order).toEqual(["A:start"]);

    resolveFirst();
    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(order).toEqual(["A:start", "A:end", "B:start"]);
  });

  it("continues the chain when an operation throws", async () => {
    const state = createTestState("/tmp/locked-test-error");
    const order: string[] = [];

    const op1 = locked(state, async () => {
      order.push("op1:start");
      throw new Error("boom");
    }).catch((e: Error) => e.message);

    const op2 = locked(state, async () => {
      order.push("op2:start");
      return "ok";
    });

    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1).toBe("boom");
    expect(r2).toBe("ok");
    expect(order).toEqual(["op1:start", "op2:start"]);
  });
});
