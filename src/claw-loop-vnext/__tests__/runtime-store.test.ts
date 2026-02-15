import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeStore } from "../runtime-store.js";

describe("RuntimeStore", () => {
  it("tracks seen signal keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-state-"));
    const store = new RuntimeStore(path.join(dir, "state.json"));

    expect(await store.hasSeenSignal("goal-1", "phase_complete:P1")).toBe(false);
    await store.markSignalSeen("goal-1", "phase_complete:P1");
    expect(await store.hasSeenSignal("goal-1", "phase_complete:P1")).toBe(true);
  });

  it("records delivery by idempotency key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-state-"));
    const store = new RuntimeStore(path.join(dir, "state.json"));

    await store.recordDelivery("goal-2", "idem-1", true, "sdk");
    const state = await store.load("goal-2");
    expect(state.lastDeliveryByIdempotencyKey["idem-1"]?.delivered).toBe(true);
    expect(state.lastDeliveryByIdempotencyKey["idem-1"]?.transport).toBe("sdk");
  });
});
