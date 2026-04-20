import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mergeScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "merge.sh");

function runMergeShell(body: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_MERGE_SH"
${body}
`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_MERGE_SH: mergeScriptPath,
        ...env,
      },
    },
  );
}

describe("scripts/pr-lib/merge.sh", () => {
  it("prints captured changelog diagnostics to stderr on failure", () => {
    const result = runMergeShell(`
ensure_pr_changelog_entry() {
  printf 'first diagnostic\\nsecond diagnostic\\n'
  return 1
}

run_merge_changelog_with_diagnostics 67082 contributor "PR title" Changes "Entry text"
`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("first diagnostic");
    expect(result.stderr).toContain("second diagnostic");
  });

  it("returns changelog output on success", () => {
    const result = runMergeShell(`
ensure_pr_changelog_entry() {
  printf 'pr_changelog_changed=true\\n'
}

run_merge_changelog_with_diagnostics 67082 contributor "PR title" Changes "Entry text"
`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pr_changelog_changed=true");
    expect(result.stderr).toBe("");
  });

  it("maps bug-fix labels to the Fixes section", () => {
    const result = runMergeShell(`
printf '%s\\n' "$(resolve_merge_changelog_section '{"labels":[{"name":"bug"}]}')"
`);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Fixes");
  });

  it("lets an explicit override choose the changelog section", () => {
    const result = runMergeShell(
      `
printf '%s\\n' "$(resolve_merge_changelog_section '{"labels":[{"name":"bug"}]}')"
`,
      { OPENCLAW_PR_CHANGELOG_SECTION: "changes" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Changes");
  });
});
