// Tests queue cleanup behavior for expired state and dedupe records.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionQueues, clearSessionQueuesByAuthorizationAffinity } from "./cleanup.js";
import { testing } from "./cleanup.test-support.js";

const followupQueueMocks = vi.hoisted(() => ({
  clearFollowupDrainCallback: vi.fn(),
  clearFollowupQueue: vi.fn(() => 2),
  clearFollowupQueueByAuthorizationAffinity: vi.fn(() => 2),
  getExistingFollowupQueue: vi.fn(() => ({ foreignWork: true })),
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(() => 3),
  clearCommandLaneByAuthorizationAffinity: vi.fn(() => 3),
}));

vi.mock("./drain.js", () => ({
  clearFollowupDrainCallback: followupQueueMocks.clearFollowupDrainCallback,
}));

vi.mock("./state.js", () => ({
  clearFollowupQueue: followupQueueMocks.clearFollowupQueue,
  clearFollowupQueueByAuthorizationAffinity:
    followupQueueMocks.clearFollowupQueueByAuthorizationAffinity,
  getExistingFollowupQueue: followupQueueMocks.getExistingFollowupQueue,
}));

vi.mock("../../../process/command-queue.js", () => ({
  clearCommandLane: commandQueueMocks.clearCommandLane,
  clearCommandLaneByAuthorizationAffinity:
    commandQueueMocks.clearCommandLaneByAuthorizationAffinity,
}));

vi.mock("../../../agents/embedded-agent-runner/lanes.js", () => ({
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

describe("clearSessionQueues", () => {
  afterEach(() => {
    testing.resetDepsForTests();
    followupQueueMocks.clearFollowupDrainCallback.mockReset();
    followupQueueMocks.clearFollowupQueue.mockReset().mockReturnValue(2);
    followupQueueMocks.clearFollowupQueueByAuthorizationAffinity.mockReset().mockReturnValue(2);
    followupQueueMocks.getExistingFollowupQueue.mockReset().mockReturnValue({ foreignWork: true });
    commandQueueMocks.clearCommandLane.mockReset().mockReturnValue(3);
    commandQueueMocks.clearCommandLaneByAuthorizationAffinity.mockReset().mockReturnValue(3);
  });

  it("falls back to default runtime deps when injected deps are invalid", () => {
    testing.setDepsForTests({
      resolveEmbeddedSessionLane: undefined,
      clearCommandLane: undefined,
    });

    const result = clearSessionQueues(["alpha"]);

    expect(result).toEqual({
      followupCleared: 2,
      laneCleared: 3,
      keys: ["alpha"],
    });
    expect(followupQueueMocks.clearFollowupQueue).toHaveBeenCalledWith("alpha");
    expect(followupQueueMocks.clearFollowupDrainCallback).toHaveBeenCalledWith("alpha");
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith("session:alpha");
  });

  it("falls back at call time when a test mutates deps to non-functions", () => {
    testing.setDepsForTests({
      resolveEmbeddedSessionLane: ((key: string) => `custom:${key}`) as never,
      clearCommandLane: ((lane: string) => (lane === "custom:alpha" ? 7 : 0)) as never,
    });
    (
      testing as {
        setDepsForTests: (deps: Partial<Record<string, unknown>> | undefined) => void;
      }
    ).setDepsForTests({
      resolveEmbeddedSessionLane: "broken",
      clearCommandLane: "broken",
    });

    const result = clearSessionQueues(["alpha"]);

    expect(result).toEqual({
      followupCleared: 2,
      laneCleared: 3,
      keys: ["alpha"],
    });
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith("session:alpha");
  });

  it("selectively clears one authority while preserving foreign queue state", () => {
    const result = clearSessionQueuesByAuthorizationAffinity(
      ["alpha", " alpha ", undefined],
      "owner-key",
    );

    expect(result).toEqual({
      followupCleared: 2,
      laneCleared: 3,
      keys: ["alpha"],
    });
    expect(followupQueueMocks.clearFollowupQueueByAuthorizationAffinity).toHaveBeenCalledWith(
      "alpha",
      "owner-key",
    );
    expect(followupQueueMocks.clearFollowupDrainCallback).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLaneByAuthorizationAffinity).toHaveBeenCalledWith(
      "session:alpha",
      "owner-key",
    );
    expect(followupQueueMocks.clearFollowupQueue).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLane).not.toHaveBeenCalled();
  });
});
