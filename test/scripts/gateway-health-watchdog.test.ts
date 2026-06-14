import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../..");
const PYTHON_TEST = path.join(TEST_DIR, "test_gateway_health_watchdog.py");

describe("gateway_health_watchdog.py", () => {
  it("matches the gateway protocol, port, and SecretInput contracts", () => {
    const result = spawnSync("python3", [PYTHON_TEST], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
