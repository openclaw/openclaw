/**
 * Tests for signal-killed process handling in exec invocations.
 *
 * When a subprocess is terminated by a signal (SIGKILL, SIGTERM, etc.)
 * rather than exiting normally, Node.js delivers `exit(null, "SIGKILL")`
 * instead of `exit(0)` or `exit(N)`. Previously this was silently treated
 * as `exitCode = undefined` with no error, making it impossible to
 * distinguish OOM kills from clean runs. This test suite verifies that
 * signal-killed processes are now surfaced with a structured error message
 * via the `resolveExitResult` helper.
 */

import { describe, it, expect } from "vitest";
import { resolveExitResult } from "./invoke.js";

describe("resolveExitResult", () => {
  it("surfaces SIGKILL as a structured error", () => {
    const result = resolveExitResult(null, "SIGKILL", false);
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toBe("process killed by signal SIGKILL");
  });

  it("surfaces SIGTERM as a structured error", () => {
    const result = resolveExitResult(null, "SIGTERM", false);
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toBe("process killed by signal SIGTERM");
  });

  it("leaves normal zero-exit unaffected", () => {
    const result = resolveExitResult(0, null, false);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeNull();
  });

  it("leaves non-zero exit unaffected", () => {
    const r1 = resolveExitResult(1, null, false);
    expect(r1.exitCode).toBe(1);
    expect(r1.error).toBeNull();

    const r127 = resolveExitResult(127, null, false);
    expect(r127.exitCode).toBe(127);
    expect(r127.error).toBeNull();
  });

  it("preserves timeout-kill semantics (timedOut=true suppresses signal error)", () => {
    // When the internal timeout fires child.kill("SIGKILL"), the exit event
    // delivers (null, "SIGKILL"). This should NOT set error — callers rely on
    // timedOut=true with error=null for intentional timeouts.
    const result = resolveExitResult(null, "SIGKILL", true);
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toBeNull();
  });

  it("handles null code with no signal", () => {
    const result = resolveExitResult(null, null, false);
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toBeNull();
  });
});
