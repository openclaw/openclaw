import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export const baseConfigSnapshot = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

export type TestRuntime = {
  log: MockFn;
  error: MockFn;
  exit: MockFn;
};

export function createTestRuntime(): TestRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}
