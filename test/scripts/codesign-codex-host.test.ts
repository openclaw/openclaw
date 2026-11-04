import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The production signer and its focused regression require a POSIX Bash host.
describe.skipIf(process.platform === "win32")("Codex code-mode host signing", () => {
  it("preserves the exact host JIT entitlements without broadening other payloads", () => {
    const result = spawnSync(
      "python3",
      [path.join(process.cwd(), "scripts", "codesign-codex-host.test.py")],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
