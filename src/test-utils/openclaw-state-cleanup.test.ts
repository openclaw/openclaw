import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import {
  cleanupOpenClawStateForTest,
  resetOpenClawStateCleanupRuntimeForTests,
  setOpenClawStateCleanupRuntimeForTests,
} from "./openclaw-state-cleanup.js";

const drainFileLockStateMock = vi.hoisted(() => vi.fn(async () => undefined));

describe("cleanupOpenClawStateForTest", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFileLockStateForTest();
    drainFileLockStateMock.mockClear();
    setOpenClawStateCleanupRuntimeForTests({
      drainFileLockStateForTest: drainFileLockStateMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFileLockStateForTest();
    resetOpenClawStateCleanupRuntimeForTests();
    vi.restoreAllMocks();
  });

  it("cleans file locks and closes SQLite state", async () => {
    await cleanupOpenClawStateForTest();

    expect(drainFileLockStateMock).toHaveBeenCalledTimes(1);
  });
});
