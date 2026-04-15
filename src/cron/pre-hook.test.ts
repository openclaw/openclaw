import { describe, expect, it } from "vitest";
import { runPreHook } from "./pre-hook.js";

describe("runPreHook", () => {
  it("returns proceed on exit 0", async () => {
    const result = await runPreHook({ command: 'node -e "process.exit(0)"' });
    expect(result.outcome).toBe("proceed");
    expect(result.exitCode).toBe(0);
  });

  it("returns skip on exit 10", async () => {
    const result = await runPreHook({ command: 'node -e "process.exit(10)"' });
    expect(result.outcome).toBe("skip");
    expect(result.exitCode).toBe(10);
  });

  it("returns error on exit 1", async () => {
    const result = await runPreHook({ command: 'node -e "process.exit(1)"' });
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  it("returns error on exit 42", async () => {
    const result = await runPreHook({ command: 'node -e "process.exit(42)"' });
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBe(42);
  });

  it("captures stdout and stderr", async () => {
    const result = await runPreHook({
      command: "node -e \"process.stdout.write('out'); process.stderr.write('err')\"",
    });
    expect(result.outcome).toBe("proceed");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("returns error on timeout", async () => {
    const result = await runPreHook({
      command: 'node -e "setTimeout(() => {}, 60000)"',
      timeoutSeconds: 0.1,
    });
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/timed out/);
  });

  it("returns error when aborted before spawn", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runPreHook({ command: 'node -e "process.exit(0)"' }, ac.signal);
    expect(result.outcome).toBe("error");
    expect(result.error).toBe("aborted");
  });

  it("returns error when aborted during execution", async () => {
    const ac = new AbortController();
    const resultPromise = runPreHook(
      { command: 'node -e "setTimeout(() => {}, 60000)"', timeoutSeconds: 10 },
      ac.signal,
    );
    // Abort shortly after spawn — on slow CI runners the abort may race with
    // process startup, so we accept either abort or timeout as a valid error.
    setTimeout(() => ac.abort(), 200);
    const result = await resultPromise;
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/aborted|timed out/);
  });

  it("returns error on maxBuffer exceeded", async () => {
    // Generate output exceeding the 64KB buffer
    const result = await runPreHook({
      command: "node -e \"process.stdout.write('x'.repeat(128 * 1024))\"",
    });
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBeNull();
  });
});
