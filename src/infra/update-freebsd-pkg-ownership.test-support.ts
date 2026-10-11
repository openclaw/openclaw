import type { BufferedCommandResult } from "../process/exec.js";

export function pkgQueryResult(
  stdout = "",
  overrides: Partial<BufferedCommandResult> = {},
): BufferedCommandResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}
