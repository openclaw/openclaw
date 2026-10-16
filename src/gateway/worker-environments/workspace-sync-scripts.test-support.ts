import { expect } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";

export async function initializeScriptGitWorkspace(workspace: string, stagedPath: string) {
  for (const args of [
    ["init", "--quiet"],
    ["add", stagedPath],
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@openclaw.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ],
  ]) {
    const result = await runCommandWithTimeout(["git", "-C", workspace, ...args], {
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
  }
  const head = await runCommandWithTimeout(["git", "-C", workspace, "rev-parse", "HEAD"], {
    timeoutMs: 10_000,
  });
  expect(head.code).toBe(0);
  return head.stdout.trim();
}
