import path from "node:path";
import { expect } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";

export async function runAuthFixture(mode: string, script?: string) {
  let stdout = "";
  let stderr = "";
  const code = await runManagedCommand({
    bin: "python3",
    args: [
      "-I",
      "-S",
      "test/scripts/fixtures/ci-checkout-auth.py",
      path.resolve(".github/actions/git-owner/owner.py"),
      mode,
      ...(script ? [script] : []),
    ],
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 30_000,
    timeoutKillGraceMs: 12_000,
    requireProcessTreeExit: true,
    onReady(child) {
      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    },
  });
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}
