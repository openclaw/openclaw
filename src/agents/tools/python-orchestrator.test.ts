import { describe, it, expect, beforeEach } from "vitest";
import { createPythonOrchestratorTool, __testing } from "./python-orchestrator.js";

const { ToolCallCache, ConcurrencyLimiter, calculateMaxConcurrent } = __testing;

describe("python_orchestrator tool", () => {
  it("creates the tool with correct name and schema", () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    expect(tool.name).toBe("python_orchestrator");
    expect(tool.label).toBe("Python Orchestrator");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
  });

  it("throws error when code is empty", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    await expect(
      tool.execute("test-1", {
        code: "",
        timeout_seconds: 30,
      }),
    ).rejects.toThrow("code required");
  });

  it("executes simple Python code", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    const result = await tool.execute("test-2", {
      code: "print('Hello from Python')",
      timeout_seconds: 30,
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Hello from Python");
    expect(result.details).toBeDefined();
    expect(result.details.exit_code).toBe(0);
  });

  it("handles Python errors", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    const result = await tool.execute("test-3", {
      code: "raise ValueError('Test error')",
      timeout_seconds: 30,
    });

    expect(result.content[0].text).toContain("failed");
    expect(result.details.exit_code).not.toBe(0);
  });

  it("respects timeout", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    const result = await tool.execute("test-4", {
      code: "import time; time.sleep(10)",
      timeout_seconds: 1, // Very short timeout
    });

    expect(result.content[0].text).toContain("Error");
  });
});

describe("ToolCallCache", () => {
  let cache: ToolCallCache;

  beforeEach(() => {
    cache = new ToolCallCache(3, 60); // Small cache for testing
  });

  it("stores and retrieves results", () => {
    cache.set("read", { path: "/test" }, { content: "hello" });
    const result = cache.get("read", { path: "/test" });

    expect(result).not.toBeNull();
    expect(result!.result).toEqual({ content: "hello" });
    expect(result!.cached).toBe(true);
  });

  it("returns null for missing entries", () => {
    const result = cache.get("read", { path: "/nonexistent" });
    expect(result).toBeNull();
  });

  it("evicts least recently used when full", () => {
    cache.set("tool1", {}, "result1");
    cache.set("tool2", {}, "result2");
    cache.set("tool3", {}, "result3");

    // tool1 has 1 hit, tool2 has 2 hits, tool3 has 1 hit
    cache.get("tool2", {}); // Increment hit
    cache.get("tool2", {}); // Increment hit

    // Add new entry - should evict tool1 or tool3 (lowest hits)
    cache.set("tool4", {}, "result4");

    expect(cache.get("tool1", {})).toBeNull(); // Evicted
    expect(cache.get("tool2", {})).not.toBeNull(); // Still there
  });

  it("evicts expired entries", async () => {
    const shortCache = new ToolCallCache(10, 1); // 1 second TTL
    shortCache.set("read", {}, "old_result");

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(shortCache.get("read", {})).toBeNull();
  });

  it("returns correct stats", () => {
    cache.set("tool1", {}, "result1");
    cache.set("tool2", {}, "result2");

    const stats = cache.stats;
    expect(stats.size).toBe(2);
    expect(stats.maxEntries).toBe(3);
    expect(stats.ttlSeconds).toBe(60);
  });

  it("clears all entries", () => {
    cache.set("tool1", {}, "result1");
    cache.set("tool2", {}, "result2");
    cache.clear();

    expect(cache.stats.size).toBe(0);
  });
});

describe("ConcurrencyLimiter", () => {
  it("calculates max concurrent based on RAM", () => {
    const max = calculateMaxConcurrent();
    // With 64GB RAM and 16GB reserved, ~48GB / 256MB = 192 processes max
    // But also bounded by CPU * 2
    expect(max).toBeGreaterThanOrEqual(1);
  });

  it("limits concurrent executions", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const results: number[] = [];
    const delays = [50, 50, 50, 50];

    const tasks = delays.map((delay, i) =>
      limiter.run(async () => {
        results.push(i);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return i;
      }),
    );

    const resolved = await Promise.all(tasks);

    // First two should start immediately, then queue
    expect(resolved).toEqual([0, 1, 2, 3]);
    expect(limiter.status.running).toBe(0);
    expect(limiter.status.maxConcurrent).toBe(2);
  });

  it("reports correct status", async () => {
    const limiter = new ConcurrencyLimiter(1);

    const task = limiter.run(async () => {
      expect(limiter.status.running).toBe(1);
      expect(limiter.status.queued).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 42;
    });

    expect(limiter.status.running).toBe(1);
    expect(limiter.status.queued).toBe(0);

    await task;
    expect(limiter.status.running).toBe(0);
  });
});
