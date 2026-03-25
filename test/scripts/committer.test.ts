import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const committerPath = join(repoRoot, "scripts", "committer");

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const [command, ...commandArgs] = normalizeCommandArgs(args);
  return execFileSync(command, commandArgs, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runResult(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const [command, ...commandArgs] = normalizeCommandArgs(args);
  return spawnSync(command, commandArgs, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function normalizeCommandArgs(args: string[]) {
  if (args[0] === committerPath) {
    return ["bash", committerPath, ...args.slice(1)];
  }
  return args;
}

function writeGhStub(binDir: string) {
  const ghPath = join(binDir, "gh");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "repo" && "\${2:-}" == "view" ]]; then
  printf '%s\\n' "\${GH_TEST_DEFAULT_BRANCH:-main}"
  exit 0
fi

if [[ "\${1:-}" != "api" ]]; then
  echo "unsupported gh invocation: $*" >&2
  exit 1
fi
shift

if [[ "\${1:-}" == "graphql" ]]; then
  shift
  repo=""
  branch=""
  headline=""
  body=""
  expected=""
  declare -a addition_paths=()
  declare -a addition_contents=()
  declare -a deletions=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -F)
        field="$2"
        shift 2
        case "$field" in
          repo=*) repo="\${field#repo=}" ;;
          branch=*) branch="\${field#branch=}" ;;
          headline=*) headline="\${field#headline=}" ;;
          body=*) body="\${field#body=}" ;;
          expectedHeadOid=*) expected="\${field#expectedHeadOid=}" ;;
          fileAdditions\\[\\]\\[path\\]=*) addition_paths+=("\${field#*=}") ;;
          fileAdditions\\[\\]\\[contents\\]=@*) addition_contents+=("\${field#*=@}") ;;
          fileDeletions\\[\\]\\[path\\]=*) deletions+=("\${field#*=}") ;;
          fileAdditions\\[\\]|fileDeletions\\[\\]|query=*) ;;
          *)
            echo "unsupported graphql field: $field" >&2
            exit 1
            ;;
        esac
        ;;
      *)
        echo "unsupported graphql arg: $1" >&2
        exit 1
        ;;
    esac
  done

  if [[ "\${GH_TEST_GRAPHQL_FAIL:-0}" == "1" ]]; then
    echo "synthetic gh graphql failure" >&2
    exit 1
  fi

  tmp_repo_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_repo_root"' EXIT
  git clone -q "$GH_TEST_REMOTE" "$tmp_repo_root/repo"
  if git -C "$tmp_repo_root/repo" rev-parse --verify "$branch" >/dev/null 2>&1; then
    git -C "$tmp_repo_root/repo" checkout -q "$branch"
  else
    git -C "$tmp_repo_root/repo" checkout -q -b "$branch" "$expected"
  fi
  current_head="$(git -C "$tmp_repo_root/repo" rev-parse HEAD)"
  if [[ "$current_head" != "$expected" ]]; then
    echo "expectedHeadOid mismatch: current=$current_head expected=$expected" >&2
    exit 1
  fi

  if (( \${#deletions[@]} > 0 )); then
    for path in "\${deletions[@]}"; do
      rm -f "$tmp_repo_root/repo/$path"
    done
  fi

  if (( \${#addition_paths[@]} > 0 )); then
    for idx in "\${!addition_paths[@]}"; do
      path="\${addition_paths[$idx]}"
      contents_file="\${addition_contents[$idx]}"
      mkdir -p "$(dirname "$tmp_repo_root/repo/$path")"
      CONTENTS_FILE="$contents_file" TARGET_PATH="$tmp_repo_root/repo/$path" node - <<'NODE'
const fs = require("node:fs");
const encoded = fs.readFileSync(process.env.CONTENTS_FILE, "utf8").trim();
fs.writeFileSync(process.env.TARGET_PATH, Buffer.from(encoded, "base64"));
NODE
    done
  fi

  git -C "$tmp_repo_root/repo" config user.name "API Bot"
  git -C "$tmp_repo_root/repo" config user.email "api@example.com"
  git -C "$tmp_repo_root/repo" add -A
  if [[ -n "$body" ]]; then
    message_file="$tmp_repo_root/message.txt"
    printf '%s\\n\\n%s\\n' "$headline" "$body" >"$message_file"
    git -C "$tmp_repo_root/repo" commit -q -F "$message_file"
  else
    git -C "$tmp_repo_root/repo" commit -q -m "$headline"
  fi
  git -C "$tmp_repo_root/repo" push -q origin "HEAD:refs/heads/$branch"
  commit_oid="$(git -C "$tmp_repo_root/repo" rev-parse HEAD)"
  if [[ "\${GH_TEST_GRAPHQL_MISSING_OID:-0}" == "1" ]]; then
    printf '{"data":{"createCommitOnBranch":{"commit":{"url":"https://example.test/%s/%s"}}}}\\n' "$repo" "$branch"
    exit 0
  fi
  printf '{"data":{"createCommitOnBranch":{"commit":{"url":"https://example.test/%s/%s","oid":"%s"}}}}\\n' "$repo" "$branch" "$commit_oid"
  exit 0
fi

if [[ "\${1:-}" == "-X" && "\${2:-}" == "POST" ]]; then
  shift 2
  endpoint="$1"
  shift
  ref=""
  sha=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f)
        field="$2"
        shift 2
        case "$field" in
          ref=*) ref="\${field#ref=}" ;;
          sha=*) sha="\${field#sha=}" ;;
        esac
        ;;
      *)
        shift
        ;;
    esac
  done
  if [[ -n "\${GH_TEST_CREATE_REF_FAIL_WITH_REMOTE_HEAD:-}" ]]; then
    git --git-dir="$GH_TEST_REMOTE" update-ref "$ref" "$GH_TEST_CREATE_REF_FAIL_WITH_REMOTE_HEAD"
    echo "synthetic gh create-ref failure" >&2
    exit 1
  fi
  git --git-dir="$GH_TEST_REMOTE" update-ref "$ref" "$sha"
  printf '{}\\n'
  exit 0
fi

echo "unsupported gh api invocation: $*" >&2
exit 1
`,
  );
  chmodSync(ghPath, 0o755);
}

function makeScriptRepo() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-committer-test-"));
  const originDir = join(root, "origin.git");
  const workDir = join(root, "work");
  const binDir = join(root, "bin");

  run(root, ["git", "init", "--bare", "-q", originDir]);
  run(root, ["git", "clone", "-q", originDir, workDir]);
  run(workDir, ["git", "config", "user.name", "Test User"]);
  run(workDir, ["git", "config", "user.email", "test@example.com"]);
  run(workDir, ["git", "config", "core.filemode", "true"]);
  writeFileSync(join(workDir, "tracked.txt"), "base\n");
  writeFileSync(join(workDir, "tool.sh"), "#!/usr/bin/env bash\necho base\n");
  chmodSync(join(workDir, "tool.sh"), 0o755);
  run(workDir, ["git", "add", "tracked.txt"]);
  run(workDir, ["git", "add", "tool.sh"]);
  run(workDir, ["git", "update-index", "--chmod=+x", "tool.sh"]);
  run(workDir, ["git", "commit", "-qm", "base"]);
  run(workDir, ["git", "branch", "-M", "main"]);
  run(workDir, ["git", "push", "-u", "origin", "main"]);
  run(root, ["git", "--git-dir", originDir, "symbolic-ref", "HEAD", "refs/heads/main"]);

  run(workDir, ["git", "fetch", "origin", "main"]);
  writeGhStub(binDir);

  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const env = {
    PATH: `${binDir}${delimiter}${pathEnv}`,
    GH_TEST_DEFAULT_BRANCH: "main",
    GH_TEST_REMOTE: originDir,
    OPENCLAW_COMMITTER_REPO_SLUG: "openclaw/openclaw",
  };

  return { root, originDir, workDir, env };
}

describe("scripts/committer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { force: true, recursive: true });
    }
  });

  it("creates signed-style commits through the GitHub API on synced branches", () => {
    const { root, originDir, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tracked.txt"), "api commit\n");
    const output = run(workDir, [committerPath, "fix: signed commit", "tracked.txt"], env);

    expect(output).toContain('Committed "fix: signed commit" with 1 files via GitHub API:');
    expect(run(workDir, ["git", "log", "-1", "--format=%s"])).toBe("fix: signed commit\n");
    expect(run(workDir, ["git", "status", "--short"])).toBe("");
    expect(run(workDir, ["git", "rev-parse", "HEAD"])).toBe(
      run(workDir, ["git", "rev-parse", "origin/main"]),
    );
    expect(run(root, ["git", "--git-dir", originDir, "show", "main:tracked.txt"])).toBe(
      "api commit\n",
    );
  });

  it("creates the remote branch first when the local branch matches origin/main", () => {
    const { root, originDir, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    run(workDir, ["git", "checkout", "-q", "-b", "feature/signed-api"]);
    writeFileSync(join(workDir, "tracked.txt"), "feature branch\n");
    const output = run(workDir, [committerPath, "feat: branch via api", "tracked.txt"], env);

    expect(output).toContain('Committed "feat: branch via api" with 1 files via GitHub API:');
    expect(run(workDir, ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).toBe(
      "origin/feature/signed-api\n",
    );
    expect(run(workDir, ["git", "rev-parse", "HEAD"])).toBe(
      run(workDir, ["git", "rev-parse", "origin/feature/signed-api"]),
    );
    expect(run(workDir, ["git", "ls-remote", "--heads", "origin", "feature/signed-api"])).toContain(
      "refs/heads/feature/signed-api",
    );
    expect(
      run(root, ["git", "--git-dir", originDir, "show", "feature/signed-api:tracked.txt"]),
    ).toBe("feature branch\n");
  });

  it("fails when remote branch creation races with a different remote head", () => {
    const { root, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tracked.txt"), "updated main\n");
    run(workDir, ["git", "add", "tracked.txt"]);
    run(workDir, ["git", "commit", "-qm", "updated main"]);
    run(workDir, ["git", "push", "-q", "origin", "main"]);
    const previousMain = run(workDir, ["git", "rev-parse", "HEAD^"]).trim();

    run(workDir, ["git", "checkout", "-q", "-b", "feature/signed-api-race"]);
    writeFileSync(join(workDir, "tracked.txt"), "feature branch\n");
    const result = runResult(workDir, [committerPath, "feat: branch race", "tracked.txt"], {
      ...env,
      GH_TEST_CREATE_REF_FAIL_WITH_REMOTE_HEAD: previousMain,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "remote branch feature/signed-api-race was created concurrently but points to",
    );
    expect(result.stderr).toContain(previousMain);
  });

  it("preserves executable mode for existing executable files", () => {
    const { root, originDir, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tool.sh"), "#!/usr/bin/env bash\necho updated\n");
    const output = run(workDir, [committerPath, "fix: preserve executable mode", "tool.sh"], env);

    expect(output).toContain(
      'Committed "fix: preserve executable mode" with 1 files via GitHub API:',
    );
    expect(run(workDir, ["git", "ls-tree", "HEAD", "tool.sh"])).toContain("100755 blob");
    expect(run(workDir, ["git", "ls-tree", "origin/main", "tool.sh"])).toContain("100755 blob");
    expect(run(root, ["git", "--git-dir", originDir, "show", "main:tool.sh"])).toBe(
      "#!/usr/bin/env bash\necho updated\n",
    );
  });

  it("handles tracked renames through the signed API flow", () => {
    const { root, originDir, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    mkdirSync(join(workDir, "renamed"), { recursive: true });
    renameSync(join(workDir, "tracked.txt"), join(workDir, "renamed", "tracked.txt"));
    const output = run(
      workDir,
      [committerPath, "refactor: rename tracked file", "tracked.txt", "renamed/tracked.txt"],
      env,
    );

    expect(output).toContain(
      'Committed "refactor: rename tracked file" with 2 files via GitHub API:',
    );
    expect(
      runResult(root, ["git", "--git-dir", originDir, "cat-file", "-e", "main:tracked.txt"]).status,
    ).not.toBe(0);
    expect(run(root, ["git", "--git-dir", originDir, "show", "main:renamed/tracked.txt"])).toBe(
      "base\n",
    );
  });

  it("rejects executable renames that would create a new executable path", () => {
    const { root, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    mkdirSync(join(workDir, "bin"), { recursive: true });
    renameSync(join(workDir, "tool.sh"), join(workDir, "bin", "tool.sh"));
    const result = runResult(
      workDir,
      [committerPath, "refactor: rename executable", "tool.sh", "bin/tool.sh"],
      env,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "signed API commits do not support new executable files for bin/tool.sh",
    );
  });

  it("keeps the source file when copy detection emits C* entries", () => {
    const { root, originDir, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tracked-copy.txt"), "base\n");
    const output = run(
      workDir,
      [committerPath, "test: copy tracked file", "tracked-copy.txt"],
      env,
    );

    expect(output).toContain('Committed "test: copy tracked file" with 1 files via GitHub API:');
    expect(run(root, ["git", "--git-dir", originDir, "show", "main:tracked.txt"])).toBe("base\n");
    expect(run(root, ["git", "--git-dir", originDir, "show", "main:tracked-copy.txt"])).toBe(
      "base\n",
    );
  });

  it("supports deletion-only commits without GraphQL placeholder entries", () => {
    const { root, originDir, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    rmSync(join(workDir, "tracked.txt"));
    const output = run(workDir, [committerPath, "test: delete tracked file", "tracked.txt"], env);

    expect(output).toContain('Committed "test: delete tracked file" with 1 files via GitHub API:');
    expect(
      runResult(root, ["git", "--git-dir", originDir, "cat-file", "-e", "main:tracked.txt"]).status,
    ).not.toBe(0);
  });

  it("restores the previous staged state when the API commit fails", () => {
    const { root, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tool.sh"), "#!/usr/bin/env bash\necho staged\n");
    run(workDir, ["git", "add", "tool.sh"]);
    writeFileSync(join(workDir, "tracked.txt"), "api failure\n");

    const result = runResult(workDir, [committerPath, "fix: restore staged state", "tracked.txt"], {
      ...env,
      GH_TEST_GRAPHQL_FAIL: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("synthetic gh graphql failure");
    expect(result.stderr).toContain("restored previous staged state");
    expect(run(workDir, ["git", "diff", "--cached", "--name-only"])).toBe("tool.sh\n");
    expect(run(workDir, ["git", "status", "--short"])).toContain(" M tracked.txt");
  });

  it("leaves requested files staged when commit metadata cannot be parsed", () => {
    const { root, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tracked.txt"), "missing oid\n");
    const result = runResult(workDir, [committerPath, "fix: missing oid", "tracked.txt"], {
      ...env,
      GH_TEST_GRAPHQL_MISSING_OID: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed to parse signed API commit metadata");
    expect(result.stderr).toContain(
      "remote commit may exist at https://example.test/openclaw/openclaw/main",
    );
    expect(result.stderr).toContain("sync the branch manually before retrying");
    expect(run(workDir, ["git", "diff", "--cached", "--name-only"])).toBe("tracked.txt\n");
    expect(run(workDir, ["git", "status", "--short"])).toContain("M  tracked.txt");
  });

  it("splits multiline commit messages into headline and body", () => {
    const { root, originDir, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tracked.txt"), "multiline commit\n");
    const message = "fix: multiline headline\n\nbody line 1\nbody line 2";
    const output = run(workDir, [committerPath, message, "tracked.txt"], env);

    expect(output).toContain('Committed "fix: multiline headline');
    expect(run(workDir, ["git", "log", "-1", "--format=%s"])).toBe("fix: multiline headline\n");
    expect(run(workDir, ["git", "log", "-1", "--format=%B"])).toBe(
      "fix: multiline headline\n\nbody line 1\nbody line 2\n\n",
    );
    expect(run(root, ["git", "--git-dir", originDir, "show", "main:tracked.txt"])).toBe(
      "multiline commit\n",
    );
  });

  it("rejects branches that are ahead of origin before attempting the API commit", () => {
    const { root, workDir, env } = makeScriptRepo();
    tempDirs.push(root);

    writeFileSync(join(workDir, "tracked.txt"), "local only\n");
    run(workDir, ["git", "add", "tracked.txt"]);
    run(workDir, ["git", "commit", "-qm", "local unsigned"]);

    writeFileSync(join(workDir, "tracked.txt"), "needs signing\n");
    const result = runResult(workDir, [committerPath, "fix: must stay signed", "tracked.txt"], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("replay unpublished local commits with scripts/committer");
  });
});
