import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FailoverError } from "../agents/failover/error.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence-error.js";
import { enqueueCommandInLane, GatewayDrainingError } from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";

const diag = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
// mock-isolation: Capture queue log severity without initializing real diagnostic sinks.
vi.mock("../logging/diagnostic-runtime.js", () => ({
  diagnosticLogger: diag,
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
});
afterEach(resetCommandQueueStateForTest);

it.each([
  ["Gateway shutdown", () => new GatewayDrainingError()],
  [
    "unavailable memory persistence tools",
    () =>
      Object.assign(new Error("memory flush skipped"), {
        name: "MemoryFlushToolsUnavailableError",
      }),
  ],
  [
    "transcript change",
    () => new SessionTranscriptReadFenceError("Session transcript changed during context read"),
  ],
  [
    "wrapped source authority revocation",
    () =>
      new Error("admitted run authority is no longer active", {
        cause: new SessionTranscriptReadFenceError(
          "Session transcript changed during context read",
        ),
      }),
  ],
])("keeps %s cancellation quiet while rejecting the task", async (_reason, createError) => {
  const error = createError();
  await expect(
    enqueueCommandInLane("nested", async () => {
      throw error;
    }),
  ).rejects.toBe(error);

  expect(diag.error).not.toHaveBeenCalled();
  expect(diag.debug).toHaveBeenCalledWith(
    expect.stringContaining("lane task interrupted: lane=nested"),
  );
});

it.each([
  new AggregateError([new GatewayDrainingError(), new Error("database close failed")]),
  new FailoverError("No model response completed", { reason: "rate_limit" }),
])("reports terminal task failures: %s", async (error) => {
  await expect(
    enqueueCommandInLane("nested", async () => {
      throw error;
    }),
  ).rejects.toBe(error);

  expect(diag.error).toHaveBeenCalledWith(
    expect.stringContaining("lane task error: lane=nested"),
    expect.any(Object),
  );
});
