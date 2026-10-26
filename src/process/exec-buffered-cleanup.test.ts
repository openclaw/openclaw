import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { CommandProcessCleanupError, hasCommandProcessCleanupError } from "./exec-result.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import { runCommandBuffered } from "./exec.js";

describe("runCommandBuffered cleanup uncertainty", () => {
  it("surfaces the canonical cleanup error when the native runner reports uncertain cleanup", async () => {
    // Real child that terminates itself; the native runner's tree cleanup then
    // cannot confirm that owned work stopped (gh-184237).
    const argv = [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"];
    const options = { killProcessTree: true, timeoutMs: 5000 };

    const raw = await runCommandWithTimeout(argv, options);
    expect(raw.termination).toBe("signal");

    const buffered = await runCommandBuffered(argv, options);

    expect(buffered.termination).toBe("signal");
    expect(hasCommandProcessCleanupError(buffered.error)).toBe(true);
    expect(buffered.error).toBeInstanceOf(CommandProcessCleanupError);
    // Signal and captured output remain available alongside the error.
    expect(buffered.signal).toBe("SIGTERM");
    expect(buffered.stdout instanceof Uint8Array).toBe(true);
  });
});
