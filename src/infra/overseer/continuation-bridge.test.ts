import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  clearCompletionHandlers,
  getHandlerCount,
} from "../../auto-reply/continuation/registry.js";
import {
  startOverseerContinuationBridge,
  stopOverseerContinuationBridge,
  isBridgeRunning,
  getBridgeConfig,
} from "./continuation-bridge.js";

// Mock the store module
vi.mock("./store.js", () => ({
  updateOverseerStore: vi.fn(async (fn, _cfg) => {
    const store = {
      version: 1,
      goals: {},
      assignments: {},
      crystallizations: {},
      events: [],
    };
    const result = await fn(store);
    return result.result;
  }),
}));

// Mock the wake module
vi.mock("./wake.js", () => ({
  requestOverseerNow: vi.fn(),
}));

describe("OverseerContinuationBridge lifecycle", () => {
  beforeEach(() => {
    clearCompletionHandlers();
    stopOverseerContinuationBridge();
  });

  afterEach(() => {
    stopOverseerContinuationBridge();
    clearCompletionHandlers();
  });

  it("starts and registers a completion handler", () => {
    const config = {
      storePath: "/tmp/test-store.json",
      autoTriggerTick: false,
    };

    expect(isBridgeRunning()).toBe(false);
    expect(getHandlerCount()).toBe(0);

    startOverseerContinuationBridge(config);

    expect(isBridgeRunning()).toBe(true);
    expect(getHandlerCount()).toBe(1);
  });

  it("stops and unregisters the handler", () => {
    const config = {
      storePath: "/tmp/test-store.json",
    };

    startOverseerContinuationBridge(config);
    expect(getHandlerCount()).toBe(1);

    stopOverseerContinuationBridge();

    expect(isBridgeRunning()).toBe(false);
    expect(getHandlerCount()).toBe(0);
  });

  it("returns unsubscribe function that stops bridge", () => {
    const config = {
      storePath: "/tmp/test-store.json",
    };

    const unsubscribe = startOverseerContinuationBridge(config);
    expect(isBridgeRunning()).toBe(true);

    unsubscribe();

    expect(isBridgeRunning()).toBe(false);
  });

  it("updates config when called while running", () => {
    const config1 = {
      storePath: "/tmp/store1.json",
      autoTriggerTick: false,
    };
    const config2 = {
      storePath: "/tmp/store2.json",
      autoTriggerTick: true,
    };

    startOverseerContinuationBridge(config1);
    expect(getBridgeConfig()?.storePath).toBe("/tmp/store1.json");

    startOverseerContinuationBridge(config2);
    expect(getBridgeConfig()?.storePath).toBe("/tmp/store2.json");
    expect(getBridgeConfig()?.autoTriggerTick).toBe(true);

    // Should still only have one handler
    expect(getHandlerCount()).toBe(1);
  });

  it("handles multiple stop calls gracefully", () => {
    const config = {
      storePath: "/tmp/test-store.json",
    };

    startOverseerContinuationBridge(config);
    stopOverseerContinuationBridge();
    stopOverseerContinuationBridge();
    stopOverseerContinuationBridge();

    expect(isBridgeRunning()).toBe(false);
    expect(getBridgeConfig()).toBe(null);
  });

  it("can be restarted after stopping", () => {
    const config = {
      storePath: "/tmp/test-store.json",
    };

    startOverseerContinuationBridge(config);
    stopOverseerContinuationBridge();
    expect(isBridgeRunning()).toBe(false);

    startOverseerContinuationBridge(config);
    expect(isBridgeRunning()).toBe(true);
    expect(getHandlerCount()).toBe(1);
  });
});

describe("OverseerContinuationBridge when not started", () => {
  beforeEach(() => {
    clearCompletionHandlers();
    stopOverseerContinuationBridge();
  });

  it("isBridgeRunning returns false", () => {
    expect(isBridgeRunning()).toBe(false);
  });

  it("getBridgeConfig returns null", () => {
    expect(getBridgeConfig()).toBe(null);
  });

  it("stopOverseerContinuationBridge is safe to call", () => {
    expect(() => stopOverseerContinuationBridge()).not.toThrow();
  });
});

describe("OverseerContinuationBridge hooks", () => {
  beforeEach(() => {
    clearCompletionHandlers();
    stopOverseerContinuationBridge();
  });

  afterEach(() => {
    stopOverseerContinuationBridge();
    clearCompletionHandlers();
  });

  it("passes hooks to config", () => {
    const onTurnIssue = vi.fn();
    const onAssignmentStalled = vi.fn();

    const config = {
      storePath: "/tmp/test-store.json",
      hooks: {
        onTurnIssue,
        onAssignmentStalled,
      },
    };

    startOverseerContinuationBridge(config);

    const bridgeConfig = getBridgeConfig();
    expect(bridgeConfig?.hooks?.onTurnIssue).toBe(onTurnIssue);
    expect(bridgeConfig?.hooks?.onAssignmentStalled).toBe(onAssignmentStalled);
  });
});
