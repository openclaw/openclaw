import { afterEach, describe, it, vi } from "vitest";
import { createTypingLease } from "./typing-lease.js";
import {
  expectDefaultTypingLeaseInterval,
  registerSharedTypingLeaseTests,
} from "./typing-lease.test-support.js";

const TEST_TYPING_INTERVAL_MS = 2_000;
const TEST_TYPING_DEFAULT_INTERVAL_MS = 4_000;

function buildTypingLeaseParams(
  pulse: (params: { target: string; lane?: string }) => Promise<unknown>,
) {
  return {
    defaultIntervalMs: TEST_TYPING_DEFAULT_INTERVAL_MS,
    errorLabel: "test",
    intervalMs: TEST_TYPING_INTERVAL_MS,
    pulse,
    pulseArgs: {
      target: "target-1",
      lane: "answer",
    },
  };
}

describe("createTypingLease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  registerSharedTypingLeaseTests({
    createLease: createTypingLease,
    buildParams: buildTypingLeaseParams,
  });

  it("falls back to the default interval for non-finite values", async () => {
    await expectDefaultTypingLeaseInterval({
      createLease: createTypingLease,
      buildParams: buildTypingLeaseParams,
      defaultIntervalMs: TEST_TYPING_DEFAULT_INTERVAL_MS,
    });
  });
});
