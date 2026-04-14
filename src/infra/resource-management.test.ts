import { describe, expect, it, vi } from "vitest";
import {
  ResourceRegistry,
  withResource,
  withResources,
  ResourcePool,
  withPooledResource,
  ShutdownCoordinator,
  type Disposable,
  type DisposableResource,
} from "./resource-management.js";

describe("ResourceRegistry", () => {
  it("registers and tracks resources", () => {
    const registry = new ResourceRegistry();
    const resource: Disposable = { dispose: vi.fn() };
    registry.register("test", resource);
    expect(registry.has("test")).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("unregisters resources", () => {
    const registry = new ResourceRegistry();
    registry.register("test", { dispose: vi.fn() });
    expect(registry.unregister("test")).toBe(true);
    expect(registry.has("test")).toBe(false);
  });

  it("disposes all resources in reverse order", async () => {
    const registry = new ResourceRegistry();
    const order: string[] = [];
    registry.register("first", {
      dispose: () => {
        order.push("first");
      },
    });
    registry.register("second", {
      dispose: () => {
        order.push("second");
      },
    });
    await registry.disposeAll();
    expect(order).toEqual(["second", "first"]);
  });

  it("reports succeeded and failed disposals", async () => {
    const registry = new ResourceRegistry();
    registry.register("success", { dispose: vi.fn() });
    registry.register("fail", {
      dispose: () => {
        throw new Error("disposal failed");
      },
    });
    const { succeeded, failed } = await registry.disposeAll();
    expect(succeeded).toContain("success");
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe("fail");
  });

  it("prevents registration after disposal", async () => {
    const registry = new ResourceRegistry();
    await registry.disposeAll();
    expect(registry.isDisposed).toBe(true);
    registry.register("late", { dispose: vi.fn() });
    expect(registry.has("late")).toBe(false);
  });
});

describe("withResource", () => {
  it("disposes resource after use", async () => {
    const dispose = vi.fn();
    const resource: DisposableResource<{ value: number }> = {
      value: 42,
      dispose,
    };
    const result = await withResource(
      () => resource,
      async (r) => r.value * 2,
    );
    expect(result).toBe(84);
    expect(dispose).toHaveBeenCalled();
  });

  it("disposes resource on error", async () => {
    const dispose = vi.fn();
    const resource: DisposableResource<{ value: number }> = {
      value: 42,
      dispose,
    };
    await expect(
      withResource(
        () => resource,
        async () => {
          throw new Error("fail");
        },
      ),
    ).rejects.toThrow("fail");
    expect(dispose).toHaveBeenCalled();
  });
});

describe("withResources", () => {
  it("creates and disposes multiple resources", async () => {
    const disposals: string[] = [];
    const result = await withResources(
      [
        { name: "a", create: () => ({ dispose: () => disposals.push("a") }) },
        { name: "b", create: () => ({ dispose: () => disposals.push("b") }) },
      ],
      async () => "result",
    );
    expect(result).toBe("result");
    expect(disposals).toContain("a");
    expect(disposals).toContain("b");
  });
});

describe("ResourcePool", () => {
  it("creates resources up to maxSize", async () => {
    let created = 0;
    const pool = new ResourcePool({
      create: () => {
        created++;
        return { id: created };
      },
      maxSize: 2,
    });
    const r1 = await pool.acquire();
    const r2 = await pool.acquire();
    expect(created).toBe(2);
    expect(pool.stats.inUse).toBe(2);
    pool.release(r1);
    pool.release(r2);
  });

  it("reuses released resources", async () => {
    let created = 0;
    const pool = new ResourcePool({
      create: () => {
        created++;
        return { id: created };
      },
      maxSize: 1,
    });
    const r1 = await pool.acquire();
    pool.release(r1);
    const r2 = await pool.acquire();
    expect(r2).toBe(r1);
    expect(created).toBe(1);
    pool.release(r2);
  });

  it("queues requests when at max capacity", async () => {
    const pool = new ResourcePool({
      create: () => ({ id: Date.now() }),
      maxSize: 1,
      acquireTimeoutMs: 100,
    });
    const r1 = await pool.acquire();

    // This will wait in queue
    const acquirePromise = pool.acquire();

    // Release after a short delay
    setTimeout(() => pool.release(r1), 10);

    const r2 = await acquirePromise;
    expect(r2).toBe(r1);
    pool.release(r2);
  });

  it("times out when waiting too long", async () => {
    const pool = new ResourcePool({
      create: () => ({ id: 1 }),
      maxSize: 1,
      acquireTimeoutMs: 10,
    });
    await pool.acquire(); // take the only slot

    await expect(pool.acquire()).rejects.toThrow("Acquire timeout");
  });

  it("validates resources before reuse", async () => {
    let created = 0;
    const pool = new ResourcePool({
      create: () => {
        created++;
        return { id: created, valid: true };
      },
      validate: (item) => item.valid,
      maxSize: 2,
    });
    const r1 = await pool.acquire();
    r1.valid = false;
    pool.release(r1);

    const r2 = await pool.acquire();
    expect(r2.id).toBe(2); // new resource created
    expect(created).toBe(2);
    pool.release(r2);
  });

  it("provides stats", async () => {
    const pool = new ResourcePool({
      create: () => ({}),
      maxSize: 3,
    });
    const r1 = await pool.acquire();
    expect(pool.stats).toEqual({ available: 0, inUse: 1, waiting: 0 });
    pool.release(r1);
    expect(pool.stats).toEqual({ available: 1, inUse: 0, waiting: 0 });
  });

  it("disposes all resources", async () => {
    const destroyed: number[] = [];
    const pool = new ResourcePool({
      create: () => ({ id: Date.now() }),
      destroy: (item) => {
        destroyed.push(item.id);
      },
      maxSize: 2,
    });
    const r1 = await pool.acquire();
    pool.release(r1);

    await pool.dispose();
    expect(destroyed).toHaveLength(1);
  });

  it("rejects new acquires after disposal", async () => {
    const pool = new ResourcePool({
      create: () => ({}),
      maxSize: 1,
    });
    await pool.dispose();
    await expect(pool.acquire()).rejects.toThrow("Pool has been disposed");
  });
});

describe("withPooledResource", () => {
  it("acquires and releases resource", async () => {
    const pool = new ResourcePool({
      create: () => ({ value: 42 }),
      maxSize: 1,
    });
    const result = await withPooledResource(pool, async (r) => r.value * 2);
    expect(result).toBe(84);
    expect(pool.stats.inUse).toBe(0);
    expect(pool.stats.available).toBe(1);
  });

  it("releases resource on error", async () => {
    const pool = new ResourcePool({
      create: () => ({ value: 42 }),
      maxSize: 1,
    });
    await expect(
      withPooledResource(pool, async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(pool.stats.inUse).toBe(0);
  });
});

describe("ShutdownCoordinator", () => {
  it("executes handlers in priority order", async () => {
    const coordinator = new ShutdownCoordinator();
    const order: string[] = [];

    coordinator.register("low", () => order.push("low"), 200);
    coordinator.register("high", () => order.push("high"), 100);
    coordinator.register("medium", () => order.push("medium"), 150);

    await coordinator.shutdown();
    expect(order).toEqual(["high", "medium", "low"]);
  });

  it("reports succeeded and failed handlers", async () => {
    const coordinator = new ShutdownCoordinator();
    coordinator.register("success", () => {});
    coordinator.register("fail", () => {
      throw new Error("shutdown failed");
    });

    const { succeeded, failed } = await coordinator.shutdown();
    expect(succeeded).toContain("success");
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe("fail");
  });

  it("returns unregister function", async () => {
    const coordinator = new ShutdownCoordinator();
    const handler = vi.fn();
    const unregister = coordinator.register("test", handler);

    unregister();
    await coordinator.shutdown();
    expect(handler).not.toHaveBeenCalled();
  });

  it("sets isShuttingDown flag", async () => {
    const coordinator = new ShutdownCoordinator();
    expect(coordinator.isShuttingDown).toBe(false);
    const promise = coordinator.shutdown();
    expect(coordinator.isShuttingDown).toBe(true);
    await promise;
  });

  it("prevents duplicate shutdowns", async () => {
    const coordinator = new ShutdownCoordinator();
    const handler = vi.fn();
    coordinator.register("test", handler);

    await Promise.all([coordinator.shutdown(), coordinator.shutdown()]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
