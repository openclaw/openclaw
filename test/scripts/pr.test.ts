import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bashBin = "bash";

function run(dir: string, args: string[]) {
  return execFileSync(args[0], args.slice(1), {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
}

function makeScriptTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-script-"));
  run(dir, ["git", "init", "-q"]);
  run(dir, ["git", "config", "user.name", "Test User"]);
  run(dir, ["git", "config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  run(dir, ["git", "add", "tracked.txt"]);
  run(dir, ["git", "commit", "-qm", "base"]);

  const libDir = join(dir, "scripts");
  mkdirSync(libDir, { recursive: true });
  const prScript = readFileSync(join(repoRoot, "scripts", "pr"), "utf8").replace(
    /\nmain "\$@"\s*$/,
    "\n# main function call removed for test sourcing\n",
  );
  const libPath = join(libDir, "pr-lib.sh");
  writeFileSync(libPath, prScript);

  return { dir, libPath };
}

function bashEval(dir: string, libPath: string, script: string) {
  return execFileSync(bashBin, ["-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PR_LIB_PATH: libPath },
  });
}

describe("scripts/pr GraphQL preflight helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { force: true, recursive: true });
    }
  });

  it("returns success when file changes are representable", () => {
    const { dir, libPath } = makeScriptTestRepo();
    tempDirs.push(dir);
    const baseSha = run(dir, ["git", "rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");
    run(dir, ["git", "add", "tracked.txt"]);
    run(dir, ["git", "commit", "-qm", "change"]);

    const output = bashEval(
      dir,
      libPath,
      `
set -euo pipefail
source "$PR_LIB_PATH"
graphql_push_preflight "${baseSha}"
printf 'ok\\n'
`,
    );

    expect(output.trim()).toBe("ok");
  });

  it("preserves not-applicable preflight status for metadata-only GraphQL attempts", () => {
    const { dir, libPath } = makeScriptTestRepo();
    tempDirs.push(dir);
    const baseSha = run(dir, ["git", "rev-parse", "HEAD"]).trim();

    const output = bashEval(
      dir,
      libPath,
      `
set -euo pipefail
source "$PR_LIB_PATH"
set +e
attempt_graphql_push_pr_head test-branch "${baseSha}"
status=$?
set -e
printf '%s\\n%s\\n' "$status" "$GRAPHQL_PUSH_LAST_FAILURE_KIND"
`,
    );

    expect(output.trim()).toBe("2\nnot-applicable");
  });

  it("prints descriptive push-mode guidance for invalid values", () => {
    const { dir, libPath } = makeScriptTestRepo();
    tempDirs.push(dir);

    const output = bashEval(
      dir,
      libPath,
      `
set -euo pipefail
source "$PR_LIB_PATH"
export OPENCLAW_PR_PUSH_MODE=bogus
err_file="$(mktemp)"
out_file="$(mktemp)"
set +e
( resolve_pr_push_mode ) > "$out_file" 2> "$err_file"
status=$?
set -e
cat "$err_file"
rm -f "$out_file" "$err_file"
printf 'status=%s\\n' "$status"
`,
    );

    expect(output).toContain("Invalid OPENCLAW_PR_PUSH_MODE=bogus.");
    expect(output).toContain(
      "Use auto (try GraphQL first, then git push), git (skip GraphQL), or graphql (require GraphQL success).",
    );
    expect(output.trim().endsWith("status=1")).toBe(true);
  });

  it("rejects invalid GraphQL blob size overrides", () => {
    const { dir, libPath } = makeScriptTestRepo();
    tempDirs.push(dir);
    const baseSha = run(dir, ["git", "rev-parse", "HEAD"]).trim();

    const output = bashEval(
      dir,
      libPath,
      `
set -euo pipefail
source "$PR_LIB_PATH"
export OPENCLAW_PR_GRAPHQL_MAX_BLOB_BYTES=bogus
err_file="$(mktemp)"
out_file="$(mktemp)"
set +e
graphql_push_to_branch example/repo branch "${baseSha}" > "$out_file" 2> "$err_file"
status=$?
set -e
cat "$err_file"
rm -f "$out_file" "$err_file"
printf 'status=%s\\n' "$status"
`,
    );

    expect(output).toContain(
      "Invalid OPENCLAW_PR_GRAPHQL_MAX_BLOB_BYTES=bogus (expected positive integer bytes).",
    );
    expect(output.trim().endsWith("status=1")).toBe(true);
  });

  it("rejects invalid PR head sync remote names before git fetch", () => {
    const { dir, libPath } = makeScriptTestRepo();
    tempDirs.push(dir);
    const headSha = run(dir, ["git", "rev-parse", "HEAD"]).trim();

    const output = bashEval(
      dir,
      libPath,
      `
set -euo pipefail
source "$PR_LIB_PATH"
err_file="$(mktemp)"
set +e
sync_current_branch_to_remote_pr_head "bad name" main "${headSha}" 2> "$err_file"
status=$?
set -e
cat "$err_file"
rm -f "$err_file"
printf 'status=%s\\n' "$status"
`,
    );

    expect(output).toContain("Invalid git remote name for PR head sync: bad name");
    expect(output.trim().endsWith("status=1")).toBe(true);
  });

  it("rejects invalid sync attempt overrides", () => {
    const { dir, libPath } = makeScriptTestRepo();
    tempDirs.push(dir);
    const headSha = run(dir, ["git", "rev-parse", "HEAD"]).trim();

    const output = bashEval(
      dir,
      libPath,
      `
set -euo pipefail
source "$PR_LIB_PATH"
export OPENCLAW_PR_SYNC_MAX_ATTEMPTS=bogus
err_file="$(mktemp)"
set +e
sync_current_branch_to_remote_pr_head prhead main "${headSha}" 2> "$err_file"
status=$?
set -e
cat "$err_file"
rm -f "$err_file"
printf 'status=%s\\n' "$status"
`,
    );

    expect(output).toContain(
      "Invalid OPENCLAW_PR_SYNC_MAX_ATTEMPTS=bogus (expected positive integer).",
    );
    expect(output.trim().endsWith("status=1")).toBe(true);
  });
});
