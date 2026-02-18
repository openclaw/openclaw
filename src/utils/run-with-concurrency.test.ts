import { describe, expect, it, vi } from "vitest";
import { runTasksWithConcurrency } from "./run-with-concurrency.js";

describe("runTasksWithConcurrency", () => {
  it("preserves task order with bounded worker count", async () => {
    let running = 0;
    let peak = 0;
    const resolvers: Array<(() => void) | undefined> = [];
    const tasks = [0, 1, 2, 3].map((index) => async (): Promise<number> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => {
        resolvers[index] = resolve;
      });
      running -= 1;
      return index + 1;
    });

    const resultPromise = runTasksWithConcurrency({ tasks, limit: 2 });
    await vi.waitFor(() => {
      expect(typeof resolvers[0]).toBe("function");
      expect(typeof resolvers[1]).toBe("function");
    });
    resolvers[1]?.();
    await vi.waitFor(() => {
      expect(typeof resolvers[2]).toBe("function");
    });
    resolvers[0]?.();
    await vi.waitFor(() => {
      expect(typeof resolvers[3]).toBe("function");
    });
    resolvers[2]?.();
    resolvers[3]?.();

    const result = await resultPromise;
    expect(result.hasError).toBe(false);
    expect(result.firstError).toBeUndefined();
    expect(result.results).toEqual([1, 2, 3, 4]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops scheduling after first failure in stop mode", async () => {
    const err = new Error("boom");
    const seen: number[] = [];
    const tasks = [
      async () => {
        seen.push(0);
        return 10;
      },
      async () => {
        seen.push(1);
        throw err;
      },
      async () => {
        seen.push(2);
        return 30;
      },
    ];

    const result = await runTasksWithConcurrency({
      tasks,
      limit: 1,
      errorMode: "stop",
    });
    expect(result.hasError).toBe(true);
    expect(result.firstError).toBe(err);
    expect(result.results[0]).toBe(10);
    expect(result.results[2]).toBeUndefined();
    expect(seen).toEqual([0, 1]);
  });

  it("continues after failures and reports the first one", async () => {
    const firstErr = new Error("first");
    const onTaskError = vi.fn();
    const tasks = [
      async () => {
        throw firstErr;
      },
      async () => 20,
      async () => {
        throw new Error("second");
      },
      async () => 40,
    ];

    const result = await runTasksWithConcurrency({
      tasks,
      limit: 1,
      errorMode: "continue",
      onTaskError,
    });
    expect(result.hasError).toBe(true);
    expect(result.firstError).toBe(firstErr);
    expect(result.results[1]).toBe(20);
    expect(result.results[3]).toBe(40);
    expect(onTaskError).toHaveBeenCalledTimes(2);
    expect(onTaskError).toHaveBeenNthCalledWith(1, firstErr, 0);
    expect(onTaskError).toHaveBeenNthCalledWith(2, expect.any(Error), 2);
  });
});
