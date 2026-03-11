import { describe, expect, it } from "vitest";
import { createNoopLogger } from "../service.test-harness.js";
import { locked, storeLocks_TEST_ONLY } from "./locked.js";
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

describe("locked", () => {
  it("prunes storeLocks entry after the last queued operation completes", async () => {
    const storePath = "/tmp/locked-test-prune";
    const state = createTestState(storePath);

    await locked(state, async () => "done");

    expect(storeLocks_TEST_ONLY().has(storePath)).toBe(false);
  });

  it("retains storeLocks entry while operations are still queued", async () => {
    const storePath = "/tmp/locked-test-retain";
    const state = createTestState(storePath);

    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const op1 = locked(state, async () => {
      await firstBlocked;
      return 1;
    });

    // Enqueue op2 while op1 is still running — storeLocks should exist
    const op2 = locked(state, async () => 2);

    expect(storeLocks_TEST_ONLY().has(storePath)).toBe(true);

    resolveFirst();
    await Promise.all([op1, op2]);

    // After both complete, entry should be pruned
    expect(storeLocks_TEST_ONLY().has(storePath)).toBe(false);
  });
});
