import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("gateway_health_watchdog.py", () => {
  it("matches the gateway protocol, port, and SecretInput contracts", () => {
    const result = spawnSync(
      "python3",
      ["-m", "unittest", "test/scripts/test_gateway_health_watchdog.py"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
