import { describe, expect, it, vi } from "vitest";
import { buildExecAutoReviewInputForShellCommand } from "./agent-harness-exec-review-runtime.js";

describe("agent harness exec auto-review input", () => {
  it.runIf(process.platform !== "win32").each(["bash", "sh", "/bin/sh"])(
    "does not bind %s login-shell startup as a reviewable command",
    async (shell) => {
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command: `${shell} -lc "echo auto-review-startup-proof"`,
          cwd: process.cwd(),
          host: "codex-app-server",
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps trusted suppression searches reviewable without admitting suppression edits",
    async () => {
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command: "grep security.audit.suppressions src",
          host: "gateway",
        }),
      ).resolves.toMatchObject({ command: "grep security.audit.suppressions src" });
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command: "openclaw config set security.audit.suppressions '[]'",
          host: "gateway",
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("preserves Windows config reads without reviewing writes", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      for (const verb of ["get", "set"]) {
        const input = await buildExecAutoReviewInputForShellCommand({
          command: `openclaw config ${verb} security.audit.suppressions`,
          host: "gateway",
        });
        expect(input?.command).toBe(
          verb === "get" ? "openclaw config get security.audit.suppressions" : undefined,
        );
      }
    } finally {
      platform.mockRestore();
    }
  });

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
