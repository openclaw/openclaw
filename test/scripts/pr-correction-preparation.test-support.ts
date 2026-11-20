import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";

const scripts = join(process.cwd(), "scripts");

export function createCapturedHashProbe(root: string, write = false) {
  const scratch = join(root, ".local/tmp");
  mkdirSync(scratch, { recursive: true });
  const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const probe = join(root, ".local/git-probe");
  const calls = join(root, ".local/hash-probe-calls");
  const batches = join(root, ".local/hash-probe-batches");
  const args = ["hash-object", "--no-filters", ...(write ? ["-w"] : []), "--stdin"];
  writeFileSync(
    probe,
    `#!/usr/bin/env python3
import os,sys,stat,fcntl,signal,subprocess
args=sys.argv[1:]
prefix=${JSON.stringify(args)}
if args[:len(prefix)] == prefix:
 extra=args[len(prefix):]
 fds=[0]
 if extra:
  assert extra[0] == '--'
  fds += list(range(3, 3+len(extra)-1))
  assert extra[1:] == ['/dev/fd/'+str(fd) for fd in fds[1:]]
 assert len(fds) <= 5, 'snapshot batch enters reserved descriptors'
 for fd in fds:
  s=os.fstat(fd)
  assert stat.S_ISREG(s.st_mode), 'snapshot must be a regular file'
  assert s.st_nlink == 0, 'snapshot pathname still linked'
  assert stat.S_IMODE(s.st_mode) == 0o600, 'snapshot is not private'
  assert fcntl.fcntl(fd,fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY, 'snapshot is writable'
  assert os.lseek(fd,0,os.SEEK_CUR) == 0, 'snapshot offset is not zero'
  with open(${JSON.stringify(calls)},'a') as record: record.write(str(s.st_size)+'\\n')
 assert not any(n.startswith('openclaw-pr-hash-') for n in os.listdir(os.environ['TMPDIR'])), 'snapshot directory retained at dispatch'
 with open(${JSON.stringify(batches)},'a') as record: record.write(str(len(fds))+'\\n')
 if os.environ.get('CHECK_HASH_LIFETIME'):
  for fd in [7,10]:
   assert os.fstat(fd).st_ino == os.stat(os.environ['HASH_HELD_'+str(fd)]).st_ino
  for fd in [8,9]:
   try: os.fstat(fd)
   except OSError: pass
   else: raise AssertionError('creator/review authority leaked to Git')
 if os.environ.get('MUTATE_ORIGINAL'): open('.local/correction-review.json','wb').write(b'changed after capture')
 if os.environ.get('FAIL_HASH'): sys.stderr.write('fixture Git hash failure\\n'); sys.exit(97)
 if os.environ.get('SIGNAL_HASH'):
  sys.stderr.write('fixture Git hash intentional SIGTERM\\n'); sys.stderr.flush()
  os.kill(os.getpid(),signal.SIGTERM)
 mode=os.environ.get('HASH_PROBE_OUTPUT')
 if mode:
  result=subprocess.run([${JSON.stringify(git)},*args],stdout=subprocess.PIPE,pass_fds=tuple(fds[1:]))
  if result.returncode: sys.exit(result.returncode)
  lines=result.stdout.splitlines()
  if mode == 'missing': lines=lines[:-1]
  elif mode == 'extra': lines += lines[:1]
  elif mode == 'reversed': lines=lines[::-1]
  elif mode == 'invalid': lines[0]=b'not-an-oid'
  sys.stdout.buffer.write(b'\\n'.join(lines)+b'\\n')
  sys.exit(0)
os.execv(${JSON.stringify(git)},[${JSON.stringify(git)},*args])
`,
  );
  chmodSync(probe, 0o700);
  return { scratch, calls, batches, env: { TMPDIR: scratch, OPENCLAW_PR_GIT: probe } };
}

export function reviewWithFinding(head: string, area: string, id = "I1") {
  const review = validReview(head);
  review.issueValidation.status = "valid";
  review.findings.push({ id, severity: "IMPORTANT", title: "Bug", area, fix: "Fix" });
  return review;
}

export function createCorrectionFixture(root: string, initialContent = "broken\n") {
  const write = (name: string, value: string) => writeFileSync(join(root, name), value);
  const json = (name: string, value: object) => write(name, JSON.stringify(value));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "topic");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", "/dev/null");
  write(".gitignore", ".local/\n");
  mkdirSync(join(root, "docs"));
  write("docs/fix.md", initialContent);
  git("add", ".");
  git("commit", "-qm", "incoming");
  const incoming = git("rev-parse", "HEAD");
  const review = reviewWithFinding(incoming, "docs/fix.md");
  writeReviewArtifacts(root, review, { headSha: incoming, files: ["docs/fix.md"] });
  const url = "https://github.com/fixture/repo";
  json(".local/pr-meta.json", {
    number: 42,
    headRefOid: incoming,
    headRefName: "topic",
    url: `${url}/pull/42`,
    baseRepository: { id: "fixture-repo", databaseId: 1, nameWithOwner: "fixture/repo", url },
    files: [{ path: "docs/fix.md" }],
  });
  write(".local/pr-meta.env", `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\n`);
  const run = (invocation: string, envOverrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.platform === "darwin" ? "/bin/bash" : "bash",
      [
        "-c",
        `set -euo pipefail
script_parent_dir="$1"
for lib in common review prepare-core gates; do source "$1/pr-lib/$lib.sh"; done
require_artifact() { [ -s "$1" ]; }
enter_worktree() { :; }
pr_gh() { gh "$@"; }
common_repo_root() { pwd; }
pr_worktree_state() { jq -n --arg path "$PWD" '{present:true,path:$path}'; }
read_pr_view_json() { cat .local/pr-meta.json; }
review_guard() { REVIEW_MODE=pr; source .local/pr-meta.env; [ "$(git rev-parse HEAD)" = "$PR_HEAD_SHA" ]; }
print_review_stdout_summary() { :; }
mark_pr_operation_side_effects_started() { touch .local/side-effects; }
checkout_pr_worktree_target() { git checkout -q --detach "$2"; }
pr_meta_json() { cat .local/pr-meta.json; }
resolve_pr_author_access_at_prepare() { echo external; }
fetch_pr_head() { PR_HEAD_OBSERVATION="$4"; git update-ref "$3" "$2"; }
${invocation}`,
        "correction-fixture",
        scripts,
      ],
      { cwd: root, env: { ...env, ...envOverrides }, encoding: "utf8" },
    );
  const commitFix = (content = "corrected\n") => {
    write("docs/fix.md", content);
    git("add", "docs/fix.md");
    git("commit", "-qm", "fix behavior");
  };
  const approve = () => {
    const path = join(root, ".local/correction-review.json");
    const correction = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(correction, validReview(git("rev-parse", "HEAD")));
    correction.recommendation = "READY FOR /prepare-pr";
    correction.issueValidation.status = "valid";
    correction.correction.resolvedFindings[0].resolution = "The corrected behavior is verified.";
    json(".local/correction-review.json", correction);
  };
  return { root, env, run, git, incoming, review, commitFix, approve };
}
