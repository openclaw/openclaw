import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
};

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-"));
    run(dir, "git", ["init", "-q"]);

    // Use the real hook script and lightweight helper stubs.
    mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
    mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-commit"),
      path.join(dir, "git-hooks", "pre-commit"),
    );
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
      {
        encoding: "utf8",
        mode: 0o755,
      },
    );
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
      "process.exit(0);\n",
      "utf8",
    );
    const fakeBinDir = path.join(dir, "bin");
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(path.join(fakeBinDir, "node"), "#!/usr/bin/env bash\nexit 0\n", {
      encoding: "utf8",
      mode: 0o755,
    });

    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual(["--all"]);
  });
});
