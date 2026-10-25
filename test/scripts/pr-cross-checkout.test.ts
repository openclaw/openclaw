import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const outcomeRef = "refs/openclaw/pr-merge-outcomes/42";
const lockRef = "refs/openclaw/pr-operation-locks/42";
const describePosix = process.platform === "win32" ? describe.skip : describe;

function fixture() {
  const shared = createMainRefreshFixture(temps.make("pr-cross-checkout-"), {
    precreateWorktree: false,
    perWorktreeConfig: false,
  });
  const { root, canonical: owner, head, main: base, worktree } = shared;
  const caller = join(root, "caller");
  const bin = join(root, "cross-checkout-bin");
  mkdirSync(bin);
  // Recovery and metadata checks need these preflight commands but must never execute them.
  for (const command of ["rg", "pnpm"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\necho 'Unexpected fixture command: ${command}' >&2\nexit 99\n`,
      { mode: 0o755 },
    );
  }
  const env = {
    ...shared.env,
    PATH: `${bin}${delimiter}${shared.env.PATH}`,
    OPENCLAW_GH_BIN: join(bin, "gh"),
  };
  const git = (repo: string, args: string[], input?: string) =>
    execFileSync(shared.realGit, ["-C", repo, ...args], {
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(root, ["clone", "-q", owner, caller]);
  const tree = git(owner, ["rev-parse", `${head}^{tree}`]);
  const landed = git(owner, ["commit-tree", tree, "-p", base], "Landed\n");
  git(owner, ["update-ref", "refs/heads/main", landed]);
  git(owner, ["push", "-q", "origin", "main"]);
  git(owner, ["update-ref", "refs/remotes/origin/main", landed]);
  git(owner, ["worktree", "add", "-q", "--detach", worktree, head]);
  mkdirSync(join(worktree, ".local"));
  const capture = join(worktree, ".local/merge-output.log");
  writeFileSync(capture, "retained capture\n");
  const repo = { id: 123, nameWithOwner: "fixture/repo", url: "https://github.com/fixture/repo" };
  const repoAuthority = {
    id: repo.id,
    node_id: "fixture-repo",
    full_name: repo.nameWithOwner,
    html_url: repo.url,
  };
  const record = {
    version: 1,
    repo,
    pr: 42,
    prId: "fixture-pr",
    base: "main",
    head,
    main: base,
    method: "squash",
    route: "immediate",
    attempt: "11111111-2222-4333-8444-555555555555",
    phase: "intent",
    accepted: true,
    landed: null,
  };
  const recordBlob = git(owner, ["hash-object", "-w", "--stdin"], JSON.stringify(record));
  const recordTree = git(owner, ["mktree"], `100644 blob ${recordBlob}\toutcome.json\n`);
  const intent = git(owner, ["commit-tree", recordTree, "-p", head, "-p", base], "Intent\n");
  git(owner, ["update-ref", outcomeRef, intent]);
  const response = {
    data: {
      repository: {
        ...repo,
        id: repoAuthority.node_id,
        databaseId: repo.id,
        ref: { target: { oid: landed } },
        pullRequest: {
          ...shared.metadata,
          state: "MERGED",
          mergeCommit: { oid: landed },
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
        },
      },
    },
  };
  const pullResponse = (baseRef: string) =>
    JSON.stringify({
      number: 42,
      html_url: `${repo.url}/pull/42`,
      base: { ref: baseRef, repo: repoAuthority },
      head: { sha: "" },
    });
  const calls = join(root, "calls.log");
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\t%s\\n' "$(git rev-parse --show-toplevel)" "$*" >> '${calls}'
case "$1 $2" in
  "browse ") printf '%s\\n' '${repo.url}' ;;
  "api user") printf 'HTTP/2.0 200 OK\\n\\n{"login":"fixture"}\\n' ;;
  "api --hostname")
    case "$4" in
      repos/fixture/repo/pulls/42)
        if [ "$(git rev-parse --show-toplevel)" = '${owner}' ]; then
          printf '%s\\n' '${pullResponse("owner-release")}'
        else
          printf '%s\\n' '${pullResponse("caller-release")}'
        fi ;;
      repos/fixture/repo/pulls/42/files?per_page=100) printf '%s\\n' '[[]]' ;;
      *) echo "Unexpected GitHub operation: $*" >&2; exit 99 ;;
    esac ;;
  "api graphql")
    case " $* " in *" --include "*) printf 'HTTP/2.0 200 OK\\n\\n' ;; esac
    printf '%s\\n' '${JSON.stringify(response)}' ;;
  *) echo "Unexpected GitHub operation: $*" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const run = (cwd = caller, args = ["merge-run", "42"]) => {
    const result = spawnSync(join(owner, "scripts/pr"), args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const readCalls = () => readFileSync(calls, "utf8").trim().split("\n");
  const refs = (repoPath: string, prefix: string) =>
    git(repoPath, ["for-each-ref", "--format=%(refname)", prefix]);
  return {
    root,
    owner,
    caller,
    worktree,
    capture,
    head,
    landed,
    intent,
    record,
    git,
    run,
    expectOwnerCalls: () => {
      const observedCalls = readCalls();
      expect(new Set(observedCalls.map((call) => call.split("\t")[0]))).toEqual(new Set([owner]));
      expect(
        observedCalls.filter((call) =>
          /\bmutation\b|(?:--method|-X) (?:POST|PATCH|PUT|DELETE)\b/u.test(call),
        ),
      ).toEqual([]);
    },
    refs,
  };
}

describePosix("native PR wrapper repository ownership", () => {
  it.each(["conflicting caller outcome", "non-Git caller"])(
    "reconciles from a %s without redispatch or cleanup",
    (location) => {
      const f = fixture();
      if (location === "conflicting caller outcome") {
        f.git(f.caller, ["update-ref", outcomeRef, f.git(f.caller, ["rev-parse", "HEAD"])]);
      }
      const callerRefs = f.git(f.caller, ["show-ref"]);
      const result = f.run(location === "non-Git caller" ? f.root : f.caller);

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(`MERGED exact attempted head ${f.head} as ${f.landed}`);
      expect(result.output).toContain("completion pending");
      expect(JSON.parse(f.git(f.owner, ["show", `${outcomeRef}:outcome.json`]))).toEqual({
        ...f.record,
        phase: "merged",
        landed: f.landed,
      });
      f.git(f.owner, ["merge-base", "--is-ancestor", f.intent, outcomeRef]);
      expect(readFileSync(f.capture, "utf8")).toBe("retained capture\n");
      expect(f.git(f.caller, ["show-ref"])).toBe(callerRefs);
      expect(f.refs(f.owner, lockRef)).toBe("");
      f.expectOwnerCalls();
    },
  );

  it("reconciles from another clone after the disposable worktree is gone", () => {
    const f = fixture();
    f.git(f.owner, ["worktree", "remove", "--force", f.worktree]);
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("completion pending");
    expect(existsSync(f.worktree)).toBe(false);
    expect(f.refs(f.caller, "refs/openclaw")).toBe("");
  });

  it("rejects corrupt owner evidence even when the caller has a valid retained intent", () => {
    const f = fixture();
    f.git(f.caller, ["fetch", f.owner, `${outcomeRef}:${outcomeRef}`]);
    f.git(f.owner, ["update-ref", outcomeRef, f.head]);
    const result = f.run();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("corrupt or mismatched retained record");
    expect(f.git(f.owner, ["rev-parse", outcomeRef])).toBe(f.head);
    expect(f.git(f.caller, ["rev-parse", outcomeRef])).toBe(f.intent);
    expect(readFileSync(f.capture, "utf8")).toBe("retained capture\n");
    f.expectOwnerCalls();
  });

  it.each(["ci-dispatch", "review-init"])(
    "uses owner repository metadata for early %s validation",
    (command) => {
      const f = fixture();
      const result = f.run(f.caller, [command, "42"]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        command === "ci-dispatch"
          ? "missing remote headRefName/headRefOid metadata"
          : "did not include a head SHA",
      );
      f.expectOwnerCalls();
      expect(f.git(f.owner, ["rev-parse", outcomeRef])).toBe(f.intent);
      expect(f.refs(f.owner, lockRef)).toBe("");
      expect(f.refs(f.caller, "refs/openclaw")).toBe("");
    },
  );
});
