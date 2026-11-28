import "../test-utils/prepare-compiled-subprocesses.js";
import { describe, expect, it } from "vitest";
import { buildExecAutoReviewInputForShellCommand } from "./agent-harness-exec-review-runtime.js";

describe("agent harness exec auto-review input", () => {
  it("preserves ordinary single-command auto-review input", async () => {
    await expect(
      buildExecAutoReviewInputForShellCommand({
        command: "node --version",
        cwd: process.cwd(),
        host: "codex-app-server",
      }),
    ).resolves.toMatchObject({
      command: "node --version",
      argv: ["node", "--version"],
      host: "codex-app-server",
      reason: "approval-required",
    });
  });
});
