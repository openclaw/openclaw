import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import {
  cleanupSessionStateForTest,
  resetSessionStateCleanupRuntimeForTests,
  setSessionStateCleanupRuntimeForTests,
} from "./session-state-cleanup.js";

const drainFileLockStateMock = vi.hoisted(() => vi.fn(async () => undefined));

describe("cleanupSessionStateForTest", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFileLockStateForTest();
    drainFileLockStateMock.mockClear();
    setSessionStateCleanupRuntimeForTests({
      drainFileLockStateForTest: drainFileLockStateMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFileLockStateForTest();
    resetSessionStateCleanupRuntimeForTests();
    vi.restoreAllMocks();
  });

  it("cleans file locks and closes SQLite state", async () => {
    await cleanupSessionStateForTest();

    expect(drainFileLockStateMock).toHaveBeenCalledTimes(1);
  });
});
