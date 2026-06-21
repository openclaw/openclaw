import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PR_SCRIPT = path.resolve("scripts/pr");

describe("scripts/pr machine output", () => {
  it("disables inherited terminal color before calling gh", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-pr-machine-output-"));
    const binDir = path.join(root, "bin");
    const tracePath = path.join(root, "gh-env.txt");
    try {
      mkdirSync(binDir);
      const gitPath = path.join(binDir, "git");
      const ghPath = path.join(binDir, "gh");
      writeFileSync(gitPath, "#!/usr/bin/env bash\nexit 1\n", "utf8");
      writeFileSync(
        ghPath,
        [
          "#!/usr/bin/env bash",
          'printf "NO_COLOR=%s CLICOLOR=%s CLICOLOR_FORCE=%s GH_FORCE_TTY=%s GH_PAGER=%s\\n" "$NO_COLOR" "$CLICOLOR" "$CLICOLOR_FORCE" "${GH_FORCE_TTY-<unset>}" "$GH_PAGER" > "$TRACE_PATH"',
          "exit 1",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(gitPath, 0o755);
      chmodSync(ghPath, 0o755);

      const result = spawnSync("bash", [PR_SCRIPT, "review-init", "1"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLICOLOR: "1",
          CLICOLOR_FORCE: "1",
          GH_FORCE_TTY: "1",
          GH_PAGER: "less",
          NO_COLOR: "0",
          PATH: `${binDir}:${process.env.PATH}`,
          TRACE_PATH: tracePath,
        },
      });

      expect(result.status).toBe(1);
      expect(readFileSync(tracePath, "utf8")).toBe(
        "NO_COLOR=1 CLICOLOR=0 CLICOLOR_FORCE=0 GH_FORCE_TTY=<unset> GH_PAGER=cat\n",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
