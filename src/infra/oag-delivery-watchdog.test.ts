import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  clearInternalHooks,
  triggerInternalHook,
  createInternalHookEvent,
} from "../hooks/internal-hooks.js";

// Mock oag-event-bus
const mockEmitOagEvent = vi.fn();
vi.mock("./oag-event-bus.js", () => ({
  emitOagEvent: (...args: unknown[]) => mockEmitOagEvent(...args),
}));

// Mock logging
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("oag-delivery-watchdog", () => {
  beforeEach(() => {
    clearInternalHooks();
    mockEmitOagEvent.mockClear();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("emits anomaly_detected on message too long error", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    startDeliveryWatchdog();

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user123",
        content: "test",
        success: false,
        error: "Bad Request: message is too long",
        channelId: "telegram",
      }),
    );

    expect(mockEmitOagEvent).toHaveBeenCalledWith(
      "anomaly_detected",
      expect.objectContaining({
        type: "delivery_failure",
        channel: "telegram",
        error: "Bad Request: message is too long",
      }),
    );
  });

  it("does not emit on successful delivery", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    startDeliveryWatchdog();

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user123",
        content: "test",
        success: true,
        channelId: "telegram",
      }),
    );

    expect(mockEmitOagEvent).not.toHaveBeenCalled();
  });

  it("ignores recoverable errors like timeout", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    startDeliveryWatchdog();

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user123",
        content: "test",
        success: false,
        error: "timeout: request timed out",
        channelId: "telegram",
      }),
    );

    expect(mockEmitOagEvent).not.toHaveBeenCalled();
  });

  it("can be disabled via config", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    startDeliveryWatchdog({ enabled: false });

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user123",
        content: "test",
        success: false,
        error: "Bad Request: message is too long",
        channelId: "telegram",
      }),
    );

    expect(mockEmitOagEvent).not.toHaveBeenCalled();
  });

  it("emits anomaly for chat not found error", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    startDeliveryWatchdog();

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user456",
        content: "hello",
        success: false,
        error: "Bad Request: chat not found",
        channelId: "telegram",
      }),
    );

    expect(mockEmitOagEvent).toHaveBeenCalledWith(
      "anomaly_detected",
      expect.objectContaining({
        type: "delivery_failure",
        channel: "telegram",
        error: "Bad Request: chat not found",
      }),
    );
  });

  it("emits anomaly for bot was blocked error", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    startDeliveryWatchdog();

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user789",
        content: "notification",
        success: false,
        error: "Forbidden: bot was blocked by the user",
        channelId: "telegram",
      }),
    );

    expect(mockEmitOagEvent).toHaveBeenCalledWith(
      "anomaly_detected",
      expect.objectContaining({
        type: "delivery_failure",
        channel: "telegram",
        error: "Forbidden: bot was blocked by the user",
      }),
    );
  });

  it("includes isGroup flag in anomaly data", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    startDeliveryWatchdog();

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "group123",
        content: "group message",
        success: false,
        error: "Bad Request: message is too long",
        channelId: "telegram",
        isGroup: true,
      }),
    );

    expect(mockEmitOagEvent).toHaveBeenCalledWith(
      "anomaly_detected",
      expect.objectContaining({
        type: "delivery_failure",
        isGroup: true,
      }),
    );
  });

  it("cleanup function stops the watchdog", async () => {
    const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

    const cleanup = startDeliveryWatchdog();

    // Trigger once to verify it's working
    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user123",
        content: "test",
        success: false,
        error: "Bad Request: message is too long",
        channelId: "telegram",
      }),
    );

    expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);

    // Cleanup
    cleanup();

    // Trigger again - should not emit
    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "test-session", {
        to: "user123",
        content: "test",
        success: false,
        error: "Bad Request: message is too long",
        channelId: "telegram",
      }),
    );

    // Still 1, not 2
    expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);
  });
});
