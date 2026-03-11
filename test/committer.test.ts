import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function run(cwd: string, cmd: string, args: string[] = []) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

describe("scripts/committer", () => {
  it("keeps the repo clean when pre-commit rewrites a staged file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-committer-"));
    run(dir, "git", ["init", "-q"]);
    run(dir, "git", ["config", "user.email", "test@example.com"]);
    run(dir, "git", ["config", "user.name", "Test User"]);

    writeFileSync(path.join(dir, "seed.txt"), "seed\n");
    run(dir, "git", ["add", "seed.txt"]);
    run(dir, "git", ["commit", "-qm", "init"]);

    const hookDir = path.join(dir, "hooks");
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(
      path.join(hookDir, "pre-commit"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "python3 - <<'PY'",
        "from pathlib import Path",
        "p = Path('note.md')",
        "text = p.read_text()",
        "text = text.replace('\\n\\n- ', '\\n- ')",
        "p.write_text(text)",
        "PY",
        "git add note.md",
        "",
      ].join("\n"),
    );
    chmodSync(path.join(hookDir, "pre-commit"), 0o755);
    run(dir, "git", ["config", "core.hooksPath", "hooks"]);

    writeFileSync(path.join(dir, "note.md"), "# Title\n\n- item\n");
    execFileSync(path.join(process.cwd(), "scripts", "committer"), ["test commit", "note.md"], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(run(dir, "git", ["status", "--short"])).toBe("?? hooks/");

    const headContent = run(dir, "git", ["show", "HEAD:note.md"]);
    const indexContent = run(dir, "git", ["show", ":note.md"]);
    const worktreeContent = run(dir, "cat", ["note.md"]);
    expect(headContent).toBe("# Title\n- item");
    expect(indexContent).toBe(headContent);
    expect(worktreeContent).toBe(headContent);
  });
});
