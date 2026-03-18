import { describe, expect, it } from "vitest";
import { runPreHook } from "./pre-hook.js";

// All test commands use node -e for cross-platform portability (Windows + Unix).
describe("runPreHook", () => {
  it("returns proceed on exit 0", async () => {
    const result = await runPreHook({ command: 'node -e "process.exit(0)"' });
    expect(result.outcome).toBe("proceed");
  });

  it("returns skip on exit 10", async () => {
    const result = await runPreHook({
      command: "node -e \"process.stdout.write('skipping'); process.exit(10)\"",
    });
    expect(result.outcome).toBe("skip");
    if (result.outcome === "skip") {
      expect(result.stdout).toContain("skipping");
    }
  });

  it("returns error on exit 1", async () => {
    const result = await runPreHook({
      command: "node -e \"process.stderr.write('bad'); process.exit(1)\"",
    });
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("bad");
      expect(result.message).toBe("exited with code 1");
    }
  });

  it("returns error on timeout", async () => {
    const result = await runPreHook({
      command: 'node -e "setTimeout(() => {}, 60000)"',
      timeoutSeconds: 1,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") {
      expect(result.message).toContain("timed out");
    }
  });

  it("captures stdout and stderr on skip", async () => {
    const result = await runPreHook({
      command:
        "node -e \"process.stdout.write('out-line'); process.stderr.write('err-line'); process.exit(10)\"",
    });
    expect(result.outcome).toBe("skip");
    if (result.outcome === "skip") {
      expect(result.stdout).toContain("out-line");
      expect(result.stderr).toContain("err-line");
    }
  });

  it("returns error on non-zero non-10 exit", async () => {
    const result = await runPreHook({ command: 'node -e "process.exit(42)"' });
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") {
      expect(result.exitCode).toBe(42);
      expect(result.message).toBe("exited with code 42");
    }
  });

  it("returns error when output exceeds maxBuffer and exit is non-zero", async () => {
    const result = await runPreHook({
      command: "node -e \"process.stdout.write('x'.repeat(70000)); process.exit(1)\"",
    });
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") {
      expect(result.message).toContain("maxBuffer");
    }
  });
});
