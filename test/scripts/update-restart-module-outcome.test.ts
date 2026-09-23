import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const regression = fileURLToPath(
  new URL("../../scripts/tests/update-restart-module-outcome.mjs", import.meta.url),
);

test("retains package backups after unverified post-swap module failures", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-vm-modules", "--test", "--test-reporter=tap", regression],
    {
      cwd: sourceRoot,
      // Bind the child to this checkout, not a historical proof override.
      env: {
        ...process.env,
        RESTART_SOURCE_ROOT: sourceRoot,
        RESTART_TRANSACTION_SOURCE_ROOT: sourceRoot,
        RESTART_DEPENDENCY_ROOT: sourceRoot,
        RESTART_VARIANT: "main",
      },
      timeout: 30_000,
    },
  );
  expect(stdout).toContain("# fail 0");
}, 35_000);
