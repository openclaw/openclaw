// Guards the resolveMocks serialization pin: concurrent callers must coalesce
// into one shared pass so a late second pass cannot re-register and invalidate
// already-evaluated manual mock modules mid-import-chain.
import { describe, expect, it } from "vitest";
import { serializeMockerResolveMocks } from "./non-isolated-runner.js";

// Mirrors BareModuleMocker: pendingIds is a static queue that each pass
// snapshots at start and reassigns to [] at the end.
class FakeMocker {
  static pendingIds: unknown[] = [];
  passes = 0;
  active = 0;
  maxConcurrentPasses = 0;

  async resolveMocks(): Promise<void> {
    this.active += 1;
    this.maxConcurrentPasses = Math.max(this.maxConcurrentPasses, this.active);
    this.passes += 1;
    // Simulate the parallel resolveId RPC round-trips inside one pass.
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
    FakeMocker.pendingIds = [];
    this.active -= 1;
  }
}

describe("serializeMockerResolveMocks", () => {
  it("coalesces concurrent resolveMocks callers into one pass", async () => {
    FakeMocker.pendingIds = ["mock-a", "mock-b"];
    const mocker = new FakeMocker();
    serializeMockerResolveMocks(mocker);

    await Promise.all([mocker.resolveMocks(), mocker.resolveMocks(), mocker.resolveMocks()]);

    expect(mocker.maxConcurrentPasses).toBe(1);
    expect(mocker.passes).toBe(1);
    expect(FakeMocker.pendingIds).toEqual([]);
  });

  it("does not double-wrap when installed repeatedly", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    serializeMockerResolveMocks(mocker);
    // Identity check: a second install must keep the first wrapper in place.
    const wrapped: unknown = Reflect.get(mocker, "resolveMocks");
    serializeMockerResolveMocks(mocker);

    expect(Reflect.get(mocker, "resolveMocks")).toBe(wrapped);
    await mocker.resolveMocks();
    expect(mocker.passes).toBe(1);
  });

  it("allows a fresh pass after the previous one settles", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    serializeMockerResolveMocks(mocker);
    await mocker.resolveMocks();

    FakeMocker.pendingIds = ["mock-b"];
    await mocker.resolveMocks();

    expect(mocker.passes).toBe(2);
    expect(FakeMocker.pendingIds).toEqual([]);
  });
});
