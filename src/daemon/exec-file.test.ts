import { describe, expect, it } from "vitest";
import { execFileUtf8 } from "./exec-file.js";

describe("execFileUtf8", () => {
  it("returns stdout and stderr on success", async () => {
    const result = await execFileUtf8("echo", ["hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("returns exit code on failure", async () => {
    const result = await execFileUtf8("sh", ["-c", "exit 42"]);
    expect(result.code).toBe(42);
  });

  it("does not pollute stderr with Node.js error message when real stderr is empty", async () => {
    // A command that exits non-zero with stdout output but empty stderr
    const result = await execFileUtf8("sh", ["-c", "echo not-found; exit 4"]);
    expect(result.code).toBe(4);
    expect(result.stdout.trim()).toBe("not-found");
    // stderr must remain empty — not polluted with "Command failed: ..."
    expect(result.stderr).toBe("");
  });

  it("preserves real stderr when command writes to stderr", async () => {
    const result = await execFileUtf8("sh", ["-c", "echo real-error >&2; exit 1"]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("real-error");
  });
});
