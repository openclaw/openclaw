import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

vi.mock("../../infra/push-apns.js", () => mocks);

import { nodeWakeByOwner, nodeWakeStateKey } from "./nodes-wake-state.js";
import { maybeWakeNodeWithApns } from "./nodes.js";

describe("maybeWakeNodeWithApns no-registration cleanup", () => {
  beforeEach(() => {
    nodeWakeByOwner.clear();
    vi.clearAllMocks();
    mocks.loadApnsRegistration.mockResolvedValue(null);
  });

  afterEach(() => {
    nodeWakeByOwner.clear();
  });

  it("does not retain state for unregistered node ids", async () => {
    for (let index = 0; index < 50; index += 1) {
      await expect(maybeWakeNodeWithApns(`unregistered-node-${index}`)).resolves.toMatchObject({
        available: false,
        throttled: false,
        path: "no-registration",
      });
    }

    expect(nodeWakeByOwner.size).toBe(0);
  });

  it("cleans up after a single no-registration result", async () => {
    await maybeWakeNodeWithApns("stale-node-id");
    expect(nodeWakeByOwner.has(nodeWakeStateKey("stale-node-id"))).toBe(false);
  });
});
