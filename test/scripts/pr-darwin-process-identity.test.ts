import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const describeDarwin = process.platform === "darwin" ? describe : describe.skip;
describeDarwin("Darwin PR-operation identity", () => {
  it("preserves kernel identity, v3 locks, drain and source-deletion custody without an app graph", () => {
    const result = spawnSync(
      "python3",
      ["-I", "-B", join(process.cwd(), "test/scripts/pr-darwin-process-identity.test.py")],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 95_000);
});
