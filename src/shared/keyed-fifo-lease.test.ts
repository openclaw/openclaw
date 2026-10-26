import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { drainGlobalSingletonLifecycleState } from "./global-singleton.js";
import { createKeyedFifoLeaseRegistry } from "./keyed-fifo-lease.js";

const TEST_KEY = Symbol.for("openclaw.test.keyedFifoLease");

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
  delete (globalThis as Record<PropertyKey, unknown>)[TEST_KEY];
});

describe("keyed FIFO leases", () => {
  it("reserves order before reverse-completing work reaches wait", async () => {
    const registry = createKeyedFifoLeaseRegistry(TEST_KEY);
    const older = registry.reserve(["target"])!;
    const newer = registry.reserve(["target"])!;
    let newerReady = false;

    const newerWait = newer.wait().then(() => {
      newerReady = true;
    });
    await Promise.resolve();
    expect(newerReady).toBe(false);

    older.release();
    await newerWait;
    expect(newerReady).toBe(true);
    newer.release();
  });

  it("keeps a reserved slot until its idempotent release", async () => {
    const registry = createKeyedFifoLeaseRegistry(TEST_KEY);
    const older = registry.reserve(["target"])!;
    const middle = registry.reserve(["target"])!;
    const newer = registry.reserve(["target"])!;
    const newerWait = newer.wait();
    let newerReady = false;
    void newerWait.then(() => {
      newerReady = true;
    });

    older.release();
    await Promise.resolve();
    expect(newerReady).toBe(false);

    middle.release();
    middle.release();
    await expect(newerWait).resolves.toBeUndefined();
    newer.release();
  });

  it("reserves sorted unique multi-key leases without deadlock", async () => {
    const registry = createKeyedFifoLeaseRegistry(TEST_KEY);
    const first = registry.reserve(["b", "a", "b"])!;
    const second = registry.reserve(["a", "b"])!;
    let secondReady = false;
    const secondWait = second.wait().then(() => {
      secondReady = true;
    });

    await expect(first.wait()).resolves.toBeUndefined();
    await Promise.resolve();
    expect(secondReady).toBe(false);
    first.release();
    await secondWait;
    expect(secondReady).toBe(true);
    second.release();
  });

  it("keeps a newer tail when an older tail cleans up", async () => {
    const registry = createKeyedFifoLeaseRegistry(TEST_KEY);
    const first = registry.reserve(["target"])!;
    first.release();
    const second = registry.reserve(["target"])!;
    await expect(second.wait()).resolves.toBeUndefined();
    const third = registry.reserve(["target"])!;
    let thirdReady = false;
    void third.wait().then(() => {
      thirdReady = true;
    });

    await Promise.resolve();
    expect(thirdReady).toBe(false);
    second.release();
    await expect(third.wait()).resolves.toBeUndefined();
    third.release();
  });

  it("releases an idle key independently when a mixed lease exits before its predecessor", async () => {
    const registry = createKeyedFifoLeaseRegistry(TEST_KEY);
    const older = registry.reserve(["busy"])!;
    const mixed = registry.reserve(["idle", "busy"])!;
    const idle = registry.reserve(["idle"])!;
    const busy = registry.reserve(["busy"])!;
    let busyReady = false;
    const busyWait = busy.wait().then(() => {
      busyReady = true;
    });

    mixed.release();
    await expect(idle.wait()).resolves.toBeUndefined();
    expect(busyReady).toBe(false);
    idle.release();

    older.release();
    await busyWait;
    expect(busyReady).toBe(true);
    busy.release();
  });

  it("shares reservations across duplicate runtime chunks", async () => {
    const moduleA = await importFreshModule<typeof import("./keyed-fifo-lease.js")>(
      import.meta.url,
      "./keyed-fifo-lease.js?scope=duplicate-a",
    );
    const moduleB = await importFreshModule<typeof import("./keyed-fifo-lease.js")>(
      import.meta.url,
      "./keyed-fifo-lease.js?scope=duplicate-b",
    );
    const firstRegistry = moduleA.createKeyedFifoLeaseRegistry(TEST_KEY);
    const secondRegistry = moduleB.createKeyedFifoLeaseRegistry(TEST_KEY);
    const first = firstRegistry.reserve(["target"])!;
    const second = secondRegistry.reserve(["target"])!;
    let secondReady = false;
    void second.wait().then(() => {
      secondReady = true;
    });

    await Promise.resolve();
    expect(secondReady).toBe(false);
    first.release();
    await expect(second.wait()).resolves.toBeUndefined();
    second.release();
  });

  it("releases live gates on full close but not restart", async () => {
    const registry = createKeyedFifoLeaseRegistry(TEST_KEY);
    registry.reserve(["target"]);
    registry.reserve(["target"]);
    const last = registry.reserve(["target"])!;
    let ready = false;
    const lastWait = last.wait().then(() => {
      ready = true;
    });

    await drainGlobalSingletonLifecycleState("restart");
    await Promise.resolve();
    expect(ready).toBe(false);

    await drainGlobalSingletonLifecycleState("close");
    await expect(lastWait).resolves.toBeUndefined();

    const fresh = registry.reserve(["target"])!;
    await expect(fresh.wait()).resolves.toBeUndefined();
    fresh.release();
  });
});
