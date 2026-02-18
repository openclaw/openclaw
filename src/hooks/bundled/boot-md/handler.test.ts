import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../../../hooks/internal-hooks.js";
import type { HookHandler } from "../../hooks.js";

const mockRunBootOnce = vi.fn();
vi.mock("../../../gateway/boot.js", () => ({
  runBootOnce: mockRunBootOnce,
}));

vi.mock("../../../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

describe("boot-md handler", () => {
  let handler: HookHandler;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Set up fake timers BEFORE importing the handler module
    // This ensures Date.now() is mocked when the module-level lastBootTime is initialized
    vi.useFakeTimers({ now: new Date("2024-01-01T00:00:00Z") });

    // Re-import handler for each test to reset module-level state
    // This clears the rate limiter's lastBootTime between tests
    vi.resetModules();
    handler = (await import("./handler.js")).default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createGatewayStartupEvent = (
    overrides?: Partial<InternalHookEvent>,
  ): InternalHookEvent => ({
    type: "gateway",
    action: "startup",
    sessionKey: "gateway:startup",
    context: {
      cfg: {},
      workspaceDir: "/tmp/workspace",
      deps: {},
    },
    timestamp: new Date(),
    messages: [],
    ...overrides,
  });

  it("runs boot on gateway startup", async () => {
    const event = createGatewayStartupEvent();
    await handler(event);
    expect(mockRunBootOnce).toHaveBeenCalledTimes(1);
    expect(mockRunBootOnce).toHaveBeenCalledWith({
      cfg: {},
      deps: {},
      workspaceDir: "/tmp/workspace",
    });
  });

  it("skips if event type is not gateway", async () => {
    const event = createGatewayStartupEvent({ type: "command" });
    await handler(event);
    expect(mockRunBootOnce).not.toHaveBeenCalled();
  });

  it("skips if action is not startup", async () => {
    const event = createGatewayStartupEvent({ action: "other" });
    await handler(event);
    expect(mockRunBootOnce).not.toHaveBeenCalled();
  });

  it("skips if cfg is missing", async () => {
    const event = createGatewayStartupEvent({
      context: { workspaceDir: "/tmp/workspace" },
    });
    await handler(event);
    expect(mockRunBootOnce).not.toHaveBeenCalled();
  });

  it("skips if workspaceDir is missing", async () => {
    const event = createGatewayStartupEvent({
      context: { cfg: {} },
    });
    await handler(event);
    expect(mockRunBootOnce).not.toHaveBeenCalled();
  });

  it("rate limits multiple calls within 60 seconds", async () => {
    const event = createGatewayStartupEvent();
    const startTime = new Date("2024-01-01T00:00:00Z").getTime();

    // First call should succeed
    await handler(event);
    expect(mockRunBootOnce).toHaveBeenCalledTimes(1);

    // Second call immediately after should be rate limited
    vi.setSystemTime(startTime + 100); // 100ms later
    await handler(event);
    expect(mockRunBootOnce).toHaveBeenCalledTimes(1); // Still 1, not 2

    // Third call after 30 seconds should still be rate limited
    vi.setSystemTime(startTime + 30_000);
    await handler(event);
    expect(mockRunBootOnce).toHaveBeenCalledTimes(1); // Still 1

    // Fourth call after exactly 60 seconds should succeed
    // (60000 - 60000 = 0, which is NOT < 60000, so rate limit check passes)
    vi.setSystemTime(startTime + 60_000); // Total 60 seconds
    await handler(event);
    expect(mockRunBootOnce).toHaveBeenCalledTimes(2); // Now 2
  });

  it("allows call after rate limit window expires", async () => {
    const event = createGatewayStartupEvent();
    const startTime = new Date("2024-01-01T00:00:00Z").getTime();

    // First call
    await handler(event);
    expect(mockRunBootOnce).toHaveBeenCalledTimes(1);

    // Wait for rate limit to expire
    vi.setSystemTime(startTime + 60_001); // 60 seconds + 1ms

    // Second call should succeed
    await handler(event);
    expect(mockRunBootOnce).toHaveBeenCalledTimes(2);
  });
});
