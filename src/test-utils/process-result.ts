import type { SpawnResult } from "../process/exec-result.js";

// Keep command doubles shaped like the real process helper.
export function createCommandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}
