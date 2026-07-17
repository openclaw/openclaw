// Guards the resolveMocks serialization pin: concurrent callers must coalesce
// into one shared drain so a late second pass cannot re-register and invalidate
// already-evaluated manual mock modules mid-import-chain, while ids queued
// during an in-flight pass still get registered before callers proceed.
import { describe, expect, it } from "vitest";
import { serializeMockerResolveMocks } from "./non-isolated-runner.js";

// Mirrors BareModuleMocker.resolveMocks: snapshots the static queue's contents
// at pass start, awaits its RPCs, then reassigns the static to [] so ids
// pushed during the await land in the abandoned array.
class FakeMocker {
  static pendingIds: unknown[] = [];
  passes = 0;
  active = 0;
  maxConcurrentPasses = 0;
  processed: unknown[] = [];

  async resolveMocks(): Promise<void> {
    if (FakeMocker.pendingIds.length === 0) {
      return;
    }
    this.active += 1;
    this.maxConcurrentPasses = Math.max(this.maxConcurrentPasses, this.active);
    this.passes += 1;
    const snapshot = [...FakeMocker.pendingIds];
    // Simulate the parallel resolveId RPC round-trips inside one pass.
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
    this.processed.push(...snapshot);
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
    expect(mocker.processed).toEqual(["mock-a", "mock-b"]);
    expect(FakeMocker.pendingIds).toEqual([]);
  });

  it("registers ids queued while a pass is in flight before callers proceed", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    serializeMockerResolveMocks(mocker);

    const first = mocker.resolveMocks();
    // Upstream would abandon this push when it reassigns pendingIds to [];
    // the wrapper must requeue it into a follow-up pass.
    FakeMocker.pendingIds.push("mock-late");
    const coalesced = mocker.resolveMocks();
    await Promise.all([first, coalesced]);

    expect(mocker.processed).toEqual(["mock-a", "mock-late"]);
    expect(mocker.maxConcurrentPasses).toBe(1);
    expect(mocker.passes).toBe(2);
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
    expect(mocker.processed).toEqual(["mock-a", "mock-b"]);
    expect(FakeMocker.pendingIds).toEqual([]);
  });
});
