import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler, DEFAULT_SHUTDOWN_TIMEOUT_MS } from "./server-close.js";

describe("gateway close handler graceful shutdown timeout", () => {
  // Track exit calls
  const originalExit = process.exit;
  let exitCalled = false;
  let exitCode: number | undefined;

  afterEach(() => {
    process.exit = originalExit;
    exitCalled = false;
    exitCode = undefined;
  });

  // Create minimal mock params for the close handler
  const createMockParams = (
    overrides?: Partial<Parameters<typeof createGatewayCloseHandler>[0]>,
  ) => ({
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: vi.fn().mockResolvedValue(undefined),
    pluginServices: null,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() },
    nodePresenceTimers: new Map(),
    broadcast: vi.fn(),
    tickInterval: setInterval(() => {}, 1000),
    healthInterval: setInterval(() => {}, 1000),
    dedupeCleanup: setInterval(() => {}, 1000),
    agentUnsub: null,
    heartbeatUnsub: null,
    chatRunState: { clear: vi.fn() },
    clients: new Set<{ socket: { close: (code: number, reason: string) => void } }>(),
    configReloader: { stop: vi.fn().mockResolvedValue(undefined) },
    browserControl: null,
    wss: { close: vi.fn((cb: () => void) => cb()) } as never,
    httpServer: {
      close: vi.fn((cb: (err?: Error) => void) => cb()),
      closeIdleConnections: vi.fn(),
    } as never,
    ...overrides,
  });

  it("exports DEFAULT_SHUTDOWN_TIMEOUT_MS constant", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(30_000);
  });

  it("completes shutdown when all steps finish quickly", async () => {
    const params = createMockParams();
    const closeHandler = createGatewayCloseHandler(params);

    // Clear intervals to avoid test pollution
    clearInterval(params.tickInterval);
    clearInterval(params.healthInterval);
    clearInterval(params.dedupeCleanup);

    await expect(closeHandler({ reason: "test" })).resolves.not.toThrow();
  });

  it("accepts custom timeout via options", async () => {
    const params = createMockParams();
    const closeHandler = createGatewayCloseHandler(params);

    // Clear intervals
    clearInterval(params.tickInterval);
    clearInterval(params.healthInterval);
    clearInterval(params.dedupeCleanup);

    // Should complete with custom timeout (1 second is plenty for a fast shutdown)
    await expect(closeHandler({ reason: "test", timeoutMs: 1000 })).resolves.not.toThrow();
  });

  it("times out and forces exit when shutdown hangs", async () => {
    // Mock process.exit to capture the call
    process.exit = ((code?: number) => {
      exitCalled = true;
      exitCode = code;
    }) as never;

    // Create a handler where tailscaleCleanup hangs forever
    const params = createMockParams({
      tailscaleCleanup: () => new Promise(() => {}), // Never resolves
    });
    const closeHandler = createGatewayCloseHandler(params);

    // Clear intervals
    clearInterval(params.tickInterval);
    clearInterval(params.healthInterval);
    clearInterval(params.dedupeCleanup);

    // Start shutdown with a very short timeout (100ms)
    await closeHandler({ reason: "test", timeoutMs: 100 });

    // Verify exit was called with error code
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(1);
  });

  it("has a shutdown timeout constant defined in source", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(`${process.cwd()}/src/gateway/server-close.ts`, "utf-8");

    // Should have the timeout constant
    expect(source.includes("DEFAULT_SHUTDOWN_TIMEOUT_MS")).toBe(true);
    expect(source.includes("30_000")).toBe(true);
  });

  it("uses Promise.race for shutdown timeout", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(`${process.cwd()}/src/gateway/server-close.ts`, "utf-8");

    // Should use Promise.race for the timeout
    expect(source.includes("Promise.race")).toBe(true);
    expect(source.includes("shutdownSequence()")).toBe(true);
    expect(source.includes("timeoutPromise")).toBe(true);
  });
});
