// PR wrapper tests cover maintainer helper command delegation.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ANCHOR_PREFIX,
  collectUnusedDependencyCaches,
  withDependencyCacheLock,
} from "../../scripts/pr-lib/cache-lifetime.mjs";
import {
  isCoreQuotaExhausted,
  isGraphqlQuotaExhausted,
} from "../../scripts/pr-lib/gh-api-preflight.mjs";
import { copyTreeCloseOnExec } from "../helpers/close-on-exec-copy.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  REVIEWED_HEAD,
  REVIEWED_PR,
  validReview,
  writeReviewArtifacts,
} from "./pr-review-artifact-fixture.js";
import {
  copyPrWrapperSources,
  createSettledPrCacheEntry,
  prCacheEntries,
  readPrCacheState,
  delegatingGitFixture,
  linkPrWrapperDependencies,
} from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const templateDirs = useAutoCleanupTempDirTracker(afterAll);
const fixtureTemplates = new Map<string, ReturnType<typeof createMismatchedWrapperTemplate>>();
const outcomeOid = "a".repeat(40);
const selectedHead = "b".repeat(40);
const otherHead = "c".repeat(40);

function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o755 });
}

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

const jsonLines = (path: string) =>
  readScript(path)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const matchingEntries = (root: string, prefix: string) =>
  readdirSync(root).filter((name) => name.startsWith(prefix));

const anchorSubstitutionNotice = (repo: string) =>
  `scripts/pr wrapper in this worktree differs from origin/main; running the canonical checkout's wrapper (matches the origin/main trust anchor): ${repo}`;
const itPosix = process.platform === "win32" ? it.skip : it;

describe.each([
  { resource: "graphql", classify: isGraphqlQuotaExhausted },
  { resource: "core", classify: isCoreQuotaExhausted },
])("$resource primary quota fallback", ({ resource, classify }) => {
  const message = "API rate limit already exceeded for user ID 123.";
  const errorBody = (type = "RATE_LIMITED", detail = message) =>
    JSON.stringify(
      resource === "graphql" ? { errors: [{ type, message: detail }] } : { message: detail },
    );
  const response = (body: string, headers = "", status = resource === "graphql" ? 200 : 403) =>
    `HTTP/2.0 ${status} Response\r\nX-RateLimit-Resource: ${resource}\r\nX-RateLimit-Remaining: 0\r\nAccess-Control-Expose-Headers: ETag, Retry-After, X-RateLimit-Remaining\r\n${headers}\r\n${body}`;

  if (resource === "graphql") {
    it("recognizes the original RATE_LIMITED response with and without headers", () => {
      const body = errorBody();
      for (const stdout of [body, response(body), Buffer.from(response(body))]) {
        expect(classify({ status: 1, stdout })).toBe(true);
      }
    });
  }
  it.each([
    { stderr: Buffer.from("gh: API rate limit exceeded for fixture-user (HTTP 403)\n") },
    ...(resource === "core"
      ? [{ stderr: Buffer.from("GraphQL: API rate limit exceeded for user ID 123.\n") }]
      : []),
  ])("recognizes native gh primary exhaustion: %j", (failure) => {
    expect(classify({ status: 1, ...failure })).toBe(true);
  });
  it.each<{ name: string; code?: string; stdout?: string; stderr?: string }>(
    resource === "core"
      ? [
          { name: "transport failure", code: "ETIMEDOUT", stderr: `gh: ${message}` },
          { name: "malformed response", stdout: "{", stderr: `gh: ${message}` },
          { name: "malformed framed response", stdout: response("{"), stderr: `gh: ${message}` },
          { name: "retry-after", stdout: response(errorBody(), "Retry-After: 60\r\n") },
        ]
      : [
          {
            name: "mixed rendered GraphQL errors",
            stderr: `GraphQL: ${message}, Resource not accessible by integration`,
          },
          {
            name: "mixed GraphQL errors",
            stdout: JSON.stringify({
              errors: [
                { type: "RATE_LIMITED", message },
                { type: "FORBIDDEN", message: "Access denied" },
              ],
            }),
          },
        ],
  )("does not authorize fallback for $name", ({ name: _name, ...failure }) => {
    expect(classify({ status: 1, ...failure })).toBe(false);
  });

  if (resource === "core") {
    it("does not infer core exhaustion from access rejection with exhausted headers", () => {
      const stdout = response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
      );
      expect(classify({ status: 1, stdout })).toBe(false);
    });
  }
});

function isolatedWrapperEnv(root: string) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    GIT_AUTHOR_NAME: "OpenClaw Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "OpenClaw Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(home, ".config"),
    GH_CONFIG_DIR: join(home, "gh"),
    GH_REPO: "fixture/repo",
  };
}

function createWrapperGit(fixtureEnv: ReturnType<typeof isolatedWrapperEnv>) {
  return (cwd: string, args: string[]) => {
    const result = runCommand(
      "git",
      args,
      {
        ...fixtureEnv,
        // Template copies must not race detached object-store maintenance.
        GIT_CONFIG_PARAMETERS: "'maintenance.auto=false' 'gc.auto=0'",
      },
      cwd,
    );
    expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
    return result;
  };
}

function baseBranchGhStub(baseRef: string) {
  const pull = {
    number: 123,
    html_url: "https://github.com/fixture/repo/pull/123",
    base: {
      ref: baseRef,
      repo: {
        id: 123,
        node_id: "fixture-repo",
        full_name: "fixture/repo",
        html_url: "https://github.com/fixture/repo",
      },
    },
  };
  return `#!/bin/sh
case "$*" in
  "api user --include") printf 'HTTP/2.0 200 OK\\n\\n{"login":"fixture"}\\n' ;;
  "browse") printf 'https://github.com/fixture/repo\\n' ;;
  "api --hostname github.com repos/fixture/repo/pulls/123 -H Cache-Control: max-age=0")
    printf '%s\\n' '${JSON.stringify(pull)}' ;;
  *) echo "Unexpected gh call: $*" >&2; exit 99 ;;
esac
`;
}

function unanchoredWrapperFixture(prefix: string) {
  const dir = tempDirs.make(prefix);
  const repo = join(dir, "repo");
  const linked = join(dir, "linked");
  copyPrWrapperSources(repo);
  const env = isolatedWrapperEnv(dir);
  mkdirSync(join(dir, "bin"));
  for (const [command, code] of [
    ["gh", 99],
    ["pnpm", 0],
    ["rg", 0],
  ] as const) {
    const executable = join(dir, "bin", command);
    writeExecutable(executable, `#!/bin/sh\nexit ${code}\n`);
  }
  const git = (cwd: string, args: string[]) => runCommand("git", args, env, cwd);
  expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
  expect(git(repo, ["add", "."]).status).toBe(0);
  expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
  const run = () => runCommand(join(linked, "scripts/pr"), ["ls"], env, linked);
  return { repo, linked, git, run };
}

function createMismatchedWrapperTemplate({
  realModules,
  dispatchBody,
  toolingOnly,
}: {
  realModules: boolean;
  dispatchBody: string;
  toolingOnly: boolean;
}) {
  const root = templateDirs.make("openclaw-pr-dev-wrapper-template-");
  const bin = join(root, "bin");
  const canonicalPath = join(root, "canonical");
  const originPath = join(root, "origin.git");
  mkdirSync(bin, { recursive: true });
  // This fixture exercises wrapper trust routing, not the host command inventory.
  for (const command of ["pnpm", "rg"]) {
    const commandPath = join(bin, command);
    writeExecutable(commandPath, "#!/bin/sh\nexit 0\n");
  }
  // Deterministic gh stub: main-only subcommands fail fast on the base-branch
  // gate instead of reaching the network, proving which wrapper actually ran.
  const ghStub = join(bin, "gh");
  writeExecutable(ghStub, baseBranchGhStub("not-main"));

  const fixtureEnv = isolatedWrapperEnv(root);
  const git = createWrapperGit(fixtureEnv);

  git(root, ["init", "--bare", "-b", "main", originPath]);
  git(root, ["init", "-b", "main", canonicalPath]);
  const canonical = realpathSync(canonicalPath);
  const origin = realpathSync(originPath);
  if (toolingOnly) {
    // Dependency sourcing needs the real wrapper and package policy, but no
    // application imports. The existing closure tests retain the full inventory.
    const components = [
      "package.json",
      "scripts/lib/plain-gh.sh",
      "scripts/lib/plain-gh.mjs",
      "scripts/lib/direct-run.mjs",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/managed-cleanup-handoff.mts",
      "scripts/windows-cmd-helpers.mjs",
      "scripts/lib/vitest-resource-ownership.mts",
      "scripts/lib/windows-taskkill.mjs",
    ];
    mkdirSync(join(canonical, "scripts/lib"), { recursive: true });
    for (const component of ["scripts/pr", "scripts/pr-lib", ...components]) {
      cpSync(component, join(canonical, component), { recursive: true });
    }
    writeFileSync(
      join(canonical, "scripts/pr-lib/wrapper-components.txt"),
      `${components.join("\n")}\n`,
    );
  } else {
    copyPrWrapperSources(canonical);
  }
  // Marker stub committed to main (the origin/main anchor), so tests can tell
  // an anchor-substituted canonical run apart from a local wrapper run.
  if (!realModules) {
    writeFileSync(
      join(canonical, "scripts", "pr-lib", "gates.sh"),
      `${readScript("scripts/pr-lib/gates.sh")}\nci_dispatch() { ${dispatchBody} }\n`,
    );
  }
  chmodSync(join(canonical, "scripts", "pr"), 0o755);

  git(canonical, ["config", "commit.gpgSign", "false"]);
  git(canonical, ["config", "core.hooksPath", "/dev/null"]);
  git(canonical, ["remote", "add", "origin", origin]);
  git(canonical, ["add", "."]);
  git(canonical, ["commit", "-m", "test: canonical wrapper"]);
  git(canonical, ["push", "-u", "origin", "main"]);
  // Pack once so private fixture copies do not repeat thousands of loose files.
  git(canonical, ["repack", "-ad"]);
  git(origin, ["repack", "-ad"]);
  return { canonical, origin, bin };
}

function makeMismatchedWrapperRepo({
  realModules = false,
  dispatchBody = 'echo "canonical wrapper executed";',
  toolingOnly = false,
} = {}) {
  const options = { realModules, dispatchBody, toolingOnly };
  const key = JSON.stringify(options);
  let template = fixtureTemplates.get(key);
  if (!template) {
    template = createMismatchedWrapperTemplate(options);
    fixtureTemplates.set(key, template);
  }
  const root = tempDirs.make("openclaw-pr-dev-wrapper-");
  const bin = join(root, "bin");
  const canonical = join(root, "canonical");
  const origin = join(root, "origin.git");
  const linkedPath = join(root, "linked");
  const fixtureEnv = isolatedWrapperEnv(root);
  const git = createWrapperGit(fixtureEnv);
  // Copy private object stores before creating worktrees, whose absolute
  // back-links must refer to this fixture. No refs or mutable files are shared.
  // PATH stubs and canonical scripts/pr are executed directly.
  copyTreeCloseOnExec(template.bin, bin);
  copyTreeCloseOnExec(template.canonical, canonical);
  cpSync(template.origin, origin, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
  git(canonical, ["remote", "set-url", "origin", origin]);
  git(canonical, ["worktree", "add", "-b", "feature", linkedPath, "main"]);

  const linked = realpathSync(linkedPath);
  git(linked, ["config", "commit.gpgSign", "false"]);
  expect(git(linked, ["rev-parse", "refs/remotes/origin/main"]).stdout.trim()).toBe(
    git(canonical, ["rev-parse", "main"]).stdout.trim(),
  );

  writeFileSync(
    join(linked, "scripts", "pr-lib", "gates.sh"),
    'ci_dispatch() { echo "local wrapper executed"; }\n',
  );
  git(linked, ["add", "scripts/pr-lib/gates.sh"]);
  git(linked, ["commit", "-m", "test: local wrapper"]);
  const localRevision = git(linked, ["rev-parse", "HEAD"]).stdout.trim();

  linkPrWrapperDependencies(canonical);

  return {
    bin,
    canonical,
    env: fixtureEnv,
    git,
    linked,
    localRevision,
    root,
    gitText(args: string[], cwd = canonical) {
      return git(cwd, args).stdout.trim();
    },
    write(path: string, contents: string, cwd = canonical) {
      writeFileSync(join(cwd, path), contents);
    },
    commit(paths: string[], push = false, cwd = canonical) {
      git(cwd, ["add", ...paths]);
      git(cwd, ["commit", "-m", "test: fixture change"]);
      if (push) {
        git(cwd, ["push", "origin", "main"]);
      }
    },
  };
}

function runWrapper(
  fixture: ReturnType<typeof makeMismatchedWrapperRepo>,
  args: string[],
  location: "canonical" | "linked" = "linked",
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
) {
  return spawnSync(join(fixture[location], "scripts/pr"), args, {
    cwd: fixture[location],
    encoding: "utf8",
    env: fixture.env,
    ...options,
  });
}

function resolveCommand(command: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  throw new Error(`command not found in test PATH: ${command}`);
}

function seedReadyReview(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
  const reviewRoot = join(fixture.canonical, ".worktrees", "pr-123");
  fixture.git(fixture.canonical, [
    "worktree",
    "add",
    "--detach",
    reviewRoot,
    fixture.localRevision,
  ]);
  const review = validReview(fixture.localRevision);
  review.pr.number = 123;
  review.recommendation = "READY FOR /prepare-pr";
  review.issueValidation.status = "valid";
  writeReviewArtifacts(reviewRoot, review, { prNumber: 123, headSha: fixture.localRevision });
}

describe("scripts/pr wrappers", () => {
  function workflowFixture() {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const reviewPath = join(fixture.canonical, "scripts/pr-lib/review.sh");
    writeFileSync(
      reviewPath,
      `${readScript(reviewPath)}\nreview_guard() {
  pr_git show-ref --verify --quiet refs/openclaw/pr-operation-locks/123 || return 1
  [ ! -e /dev/fd/8 ] && [ ! -e /dev/fd/9 ] || return 1
  printf 'active workflow wrapper %s\\n' "$script_parent_dir"
  printf 'admitted workflow %s\\n' "$PR_WORKFLOW_SOURCE_REVISION"
  return "\${PR_TEST_COMMAND_STATUS:-0}"
}\n`,
    );
    fixture.commit(["scripts/pr-lib/review.sh"], true);
    const source = fixture.gitText(["rev-parse", "HEAD"]);
    const run = (status = "0", env: NodeJS.ProcessEnv = fixture.env) =>
      runCommand(
        join(fixture.linked, "scripts/pr"),
        ["review-guard", "123"],
        { ...env, PR_TEST_COMMAND_STATUS: status },
        fixture.linked,
      );
    return { ...fixture, reviewPath, source, run };
  }

  itPosix(
    "preserves a PATH-delegating Git policy through admission, supervision and reentry",
    () => {
      const fixture = workflowFixture();
      writeFileSync(
        fixture.reviewPath,
        `${readScript(fixture.reviewPath)}
review_guard() {
  pr_git show-ref --verify --quiet refs/openclaw/pr-operation-locks/123 || return 1
  [ ! -e /dev/fd/8 ] && [ ! -e /dev/fd/9 ] || return 1
  export PR_TEST_GIT_PHASE=supervised-shell
  git --version >/dev/null || return
  export PR_TEST_GIT_PHASE=supervised-node
  node -e 'require("node:child_process").execFileSync("git", ["--version"], { stdio: "ignore" })' || return
  echo 'delegating policy completed'
}
`,
      );
      fixture.commit(["scripts/pr-lib/review.sh"], true);
      const guard = delegatingGitFixture(fixture.root, fixture.env);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = fixture.run("0", guard.env);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("delegating policy completed");
        expect(fixture.gitText(["for-each-ref", "refs/openclaw/pr-operation-locks/123"])).toBe("");
      }
      const calls = readScript(guard.calls);
      expect(calls).toContain("supervised-shell --version\n");
      expect(calls).toContain("supervised-node --version\n");
      expect(calls).toContain("cat-file blob");
      expect(calls).toContain("update-ref --no-deref -d refs/openclaw/pr-operation-locks/123");
      expect(calls).not.toContain("recursive selected Git");
    },
  );

  itPosix("keeps the admitted workflow after a failed command and main advances", () => {
    const fixture = workflowFixture();
    const { source, reviewPath } = fixture;
    const first = fixture.run("1");
    expect(first.status, first.stderr).toBe(1);
    expect(first.stdout).toContain(`admitted workflow ${source}`);
    const ref = "refs/openclaw/pr-workflow-bindings/123";
    const admitted = fixture.gitText(["rev-parse", ref]);
    writeFileSync(
      reviewPath,
      `${readScript(reviewPath)}\nreview_guard() { echo 'new workflow'; }\n`,
    );
    fixture.commit(["scripts/pr-lib/review.sh"], true);

    const resumed = fixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain(`admitted workflow ${source}`);
    expect(resumed.stdout).not.toContain("new workflow");
    expect(fixture.gitText(["rev-parse", ref])).toBe(admitted);
    expect(fixture.gitText(["rev-parse", `${admitted}^`])).toBe(source);
    expect(resumed.stderr).toContain(`retained PR #123 workflow ${source}`);

    const successor = fixture.gitText([
      "commit-tree",
      `${admitted}^{tree}`,
      "-p",
      source,
      "-m",
      "successor",
    ]);
    writeExecutable(
      join(fixture.bin, "node"),
      `#!/bin/sh
case "$*" in
  *'fstatSync(8)'*) ;;
  *) exec "${requireNodeTool("node")}" "$@" ;;
esac
"${requireNodeTool("node")}" "$@"
status=$?
case "$*" in
  *'fstatSync(8)'*) "${resolveCommand("git")}" -C "${fixture.canonical}" update-ref ${ref} ${successor} ${admitted} || exit ;;
esac
exit "$status"
`,
    );
    const raced = fixture.run();
    expect(raced.status, raced.stderr).toBe(1);
    expect(raced.stderr).toContain("Workflow selection changed across handoff");
    expect(raced.stdout).not.toContain("admitted workflow");
    expect(fixture.gitText(["rev-parse", ref])).toBe(successor);
  });

  itPosix("keeps the captured revision when main advances during archive materialization", () => {
    const fixture = workflowFixture();
    writeFileSync(
      fixture.reviewPath,
      `${readScript(fixture.reviewPath)}\nreview_guard() { echo 'new workflow'; }\n`,
    );
    fixture.commit(["scripts/pr-lib/review.sh"], true);
    const advanced = fixture.gitText(["rev-parse", "HEAD"]);
    fixture.git(fixture.canonical, ["update-ref", "refs/remotes/origin/main", fixture.source]);
    const selectedGit = join(fixture.root, "selected-git");
    writeExecutable(
      selectedGit,
      `#!/bin/sh
"${resolveCommand("git")}" "$@"
status=$?
case " $* " in
  *' archive '*) "${resolveCommand("git")}" -C "${fixture.canonical}" update-ref refs/remotes/origin/main ${advanced} ;;
esac
exit "$status"
`,
    );
    const result = fixture.run("0", { ...fixture.env, OPENCLAW_PR_GIT: selectedGit });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`admitted workflow ${fixture.source}`);
    expect(result.stdout).not.toContain("new workflow");
    expect(fixture.gitText(["rev-parse", "refs/remotes/origin/main"])).toBe(advanced);
    const record = JSON.parse(
      fixture.git(fixture.canonical, [
        "show",
        "refs/openclaw/pr-workflow-bindings/123:binding.json",
      ]).stdout,
    );
    expect(record.source).toBe(fixture.source);
    const activeWrapper = result.stdout.match(/^active workflow wrapper (.+)$/m)?.[1] ?? "";
    expect(activeWrapper).toContain("openclaw-pr-anchor-v3.");
    expect(existsSync(join(activeWrapper, ".."))).toBe(false);
  });

  itPosix("preserves the caller's gh route environment through startup", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    cpSync("scripts/lib/plain-gh.sh", join(fixture.canonical, "scripts/lib/plain-gh.sh"));
    fixture.write(
      "scripts/pr-lib/worktree.sh",
      `list_pr_worktrees() { /bin/sh -c 'printf "%s\\n" "\${OPENCLAW_GH_BIN-absent}"'; }\n`,
    );
    for (const override of [undefined, "", join(fixture.bin, "gh")]) {
      const result = runWrapper(fixture, ["ls"], "canonical", {
        env: { ...fixture.env, OPENCLAW_GH_BIN: override },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${override ?? "absent"}\n`);
    }
  });

  itPosix("fails loudly at preflight when ripgrep is unavailable", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    rmSync(join(fixture.bin, "rg"));
    for (const command of ["bash", "basename", "dirname", "git", "gh", "jq", "pnpm", "node"]) {
      rmSync(join(fixture.bin, command), { force: true });
      symlinkSync(resolveCommand(command), join(fixture.bin, command));
    }

    const result = spawnSync(join(fixture.canonical, "scripts", "pr"), ["ls"], {
      cwd: fixture.canonical,
      encoding: "utf8",
      env: {
        ...fixture.env,
        PATH: fixture.bin,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing required command(s): rg");
    expect(result.stderr).toContain("Install ripgrep and retry:");
  });

  itPosix("requires a separate operator confirmation for merge recovery", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const recovery = (...args: string[]) => [
      "123",
      outcomeOid,
      "--confirmed-operator-recovery",
      ...args,
    ];
    for (const args of [
      ["123", outcomeOid],
      ["123", "not-an-outcome", "--confirmed-operator-recovery"],
      ["123", outcomeOid, "--confirmed-no-running-tools"],
      recovery("--auto-merge"),
      recovery("--cancel-auto", "--cancel-auto"),
      recovery("--observed-head", selectedHead),
      recovery("--cancel-auto", "--observed-head"),
      recovery("--cancel-auto", "--observed-head", "HEAD"),
      recovery("--cancel-auto", "--observed-head", selectedHead, "--observed-head", otherHead),
      recovery("--cancel-auto", "--body-file", "message.md"),
      recovery("--cancel-auto", "--replacement-head", selectedHead),
      recovery("--replacement-head"),
      recovery("--replacement-head", "HEAD"),
      recovery("--replacement-head", selectedHead, "--replacement-head", otherHead),
      recovery("--replacement-head", selectedHead, "--confirmed-operator-recovery"),
      ["0123", outcomeOid, "--confirmed-operator-recovery", "--replacement-head", selectedHead],
      recovery("--merged-head"),
      recovery("--merged-head", "HEAD"),
      recovery("--merged-head", selectedHead, "--merged-head", otherHead),
      recovery("--merged-head", selectedHead, "--body-file", "message.md"),
    ]) {
      const result = runWrapper(fixture, ["merge-recover", ...args], "canonical");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stdout).toContain("Usage:");
      expect(result.stderr).not.toContain("only support PRs targeting main");
    }
  });

  itPosix("accepts scoped GC in either flag order and rejects ambiguous scope", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    fixture.write("scripts/pr-lib/worktree.sh", 'gc_pr_worktrees() { printf "<%s>\\n" "$@"; }\n');
    for (const [args, expected] of [
      [["--pr", "123"], "<false>\n<123>\n"],
      [[], "<false>\n<>\n"],
      [["--dry-run"], "<true>\n<>\n"],
      [["--pr", "123", "--dry-run"], "<true>\n<123>\n"],
      [["--dry-run", "--pr", "123"], "<true>\n<123>\n"],
    ] as const) {
      const result = runWrapper(fixture, ["gc", ...args], "canonical");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    }
    for (const args of [
      ["--pr"],
      ["--pr", "../123"],
      ["--pr", "123", "--pr", "456"],
      ["--dry-run", "--dry-run"],
      ["123"],
    ]) {
      const result = runWrapper(fixture, ["gc", ...args], "canonical");
      expect(result.status, result.stdout + result.stderr).toBe(2);
    }
  });

  const recoveryArgs = ["merge-recover", "123", outcomeOid, "--confirmed-operator-recovery"];
  const dispatchFields = {
    pr: "123",
    auto: "false",
    outcome: "",
    replacement: "",
    body: "",
    legacy: "",
    cancel: "false",
    refusal: "",
    admin: "",
    confirmed: "false",
    merged: "",
    observed: "",
  };
  function expectedDispatch(fields: Partial<typeof dispatchFields>) {
    return Object.values({ ...dispatchFields, ...fields })
      .map((value) => `<${value}>\n`)
      .join("");
  }
  function mergeDispatchFixture(main = true) {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    if (main) {
      fixture.write("gh", baseBranchGhStub("main"), fixture.bin);
    }
    const caller = join(fixture.canonical, "nested");
    mkdirSync(caller);
    fixture.write("scripts/pr-lib/merge.sh", `merge_run() { printf '<%s>\\n' "$@"; }\n`);
    fixture.commit(["scripts/pr-lib/merge.sh"], true);
    return { fixture, caller };
  }

  itPosix.each<{
    name: string;
    args: string[];
    fields: Partial<typeof dispatchFields>;
    main?: boolean;
    nested?: boolean;
  }>([
    {
      name: "body relative to caller",
      args: ["merge-run", "123", "--body-file", "operator body.md"],
      fields: { body: "operator body.md" },
      main: false,
      nested: true,
    },
    {
      name: "observed head for auto retirement",
      args: [...recoveryArgs, "--observed-head", selectedHead, "--cancel-auto"],
      fields: { outcome: outcomeOid, observed: selectedHead, cancel: "true" },
    },
    {
      name: "selected merged head",
      args: [...recoveryArgs, "--merged-head", selectedHead],
      fields: { outcome: outcomeOid, merged: selectedHead },
    },
    ...(
      [
        ["merge-run", ""],
        ["merge-recover", ""],
        ["merge-recover", selectedHead],
      ] as const
    ).map(([command, replacement]) => ({
      name: `admin evidence for ${command} (replacement=${replacement})`,
      args: [
        ...(command === "merge-recover" ? recoveryArgs : ["merge-run", "123"]),
        ...(replacement ? ["--replacement-head", replacement] : []),
        "--admin-evidence",
        "admin proof.json",
        "--confirmed-operator-admin",
      ],
      fields: {
        outcome: command === "merge-recover" ? outcomeOid : "",
        replacement,
        admin: "admin proof.json",
        confirmed: "true",
      },
      nested: true,
    })),
  ])("forwards $name before supervisor cwd changes", ({ args, fields, main, nested }) => {
    const { fixture, caller } = mergeDispatchFixture(main);
    const expected: Partial<typeof dispatchFields> = { ...fields };
    if (expected.body) {
      expected.body = join(caller, expected.body);
    }
    if (expected.admin) {
      expected.admin = join(caller, expected.admin);
    }
    const result = runWrapper(fixture, args, "canonical", nested ? { cwd: caller } : {});
    expect(result, result.stderr).toMatchObject({ status: 0, stdout: expectedDispatch(expected) });
  });

  itPosix(
    "requires an exact receipt and explicit confirmation for completion-only dispatch",
    () => {
      const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
      fixture.write(
        "scripts/pr-lib/merge.sh",
        `merge_complete() { printf '<%s>\\n' "$@"; }\nmerge_run() { exit 99; }\n`,
      );
      fixture.commit(["scripts/pr-lib/merge.sh"], true);
      const oid = outcomeOid;
      for (const args of [
        ["123", oid],
        ["123", "HEAD", "--confirmed-operator-completion"],
        ["0123", oid, "--confirmed-operator-completion"],
        ["123", oid, "--confirmed-operator-recovery"],
        ["123", oid, "--confirmed-operator-completion", "--auto-merge"],
      ]) {
        const result = runWrapper(fixture, ["merge-complete", ...args], "canonical");
        expect(result.status, result.stdout + result.stderr).toBe(2);
        expect(result.stdout).toContain("Usage:");
      }
      const result = runWrapper(
        fixture,
        ["merge-complete", "123", oid, "--confirmed-operator-completion"],
        "canonical",
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toBe(`<123>\n<${oid}>\n`);
    },
  );

  itPosix("rejects ambiguous body flags and keeps recovery confirmation mandatory", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    for (const args of [
      ["merge-run", "123", "--body-file"],
      ["merge-run", "123", "--observed-head", selectedHead],
      ["merge-run", "123", "--body-file", ""],
      ["merge-run", "123", "--body-file", "one", "--body-file", "two"],
      ["merge-run", "123", "--auto-merge", "--auto-merge"],
      ["merge-recover", "123", outcomeOid, "--body-file", "one"],
      ...[
        ["--admin-evidence", "proof.json"],
        ["--confirmed-operator-admin"],
        ["--admin-evidence", "proof.json", "--confirmed-operator-admin", "--cancel-auto"],
      ].map((flags) =>
        ["merge-recover", "123", outcomeOid, "--confirmed-operator-recovery"].concat(flags),
      ),
    ]) {
      const result = runWrapper(fixture, args, "canonical");
      expect(result.status, `${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(2);
      expect(result.stdout).toContain("Usage:");
    }
  });

  itPosix("pins pre-dispatch-refusal evidence relative to the original caller", () => {
    const flag = "pre-dispatch-refusal";
    const { fixture, caller } = mergeDispatchFixture();
    const args = [
      "merge-recover",
      "123",
      outcomeOid,
      "--confirmed-operator-recovery",
      `--${flag}`,
      "proof",
    ];
    const missing = runWrapper(fixture, args, "canonical", { cwd: caller });
    expect(missing.status, missing.stdout + missing.stderr).toBe(0);
    const result = runWrapper(fixture, [...args, "--replacement-head", selectedHead], "canonical", {
      cwd: caller,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(
      expectedDispatch({
        outcome: outcomeOid,
        replacement: selectedHead,
        refusal: join(caller, "proof"),
      }),
    );
  });

  it("runs a mismatched advisory wrapper locally with an explicit developer opt-in", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const cliResult = runWrapper(fixture, ["--dev-wrapper", "ci-dispatch", "123"], "linked");
    expect(cliResult.status, `${cliResult.stderr}\n${cliResult.stdout}`).toBe(0);
    expect(cliResult.stdout).toContain("local wrapper executed");
    expect(cliResult.stderr).toContain(
      `WARNING: running local scripts/pr revision ${fixture.localRevision} via dev-wrapper opt-in.`,
    );
    expect(cliResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
    expect(cliResult.stderr).toContain("landing subcommands remain refused");

    const envResult = runWrapper(fixture, ["ci-dispatch", "123"], "linked", {
      env: { ...fixture.env, OPENCLAW_PR_DEV_WRAPPER: "1" },
    });
    expect(envResult.status, `${envResult.stderr}\n${envResult.stdout}`).toBe(0);
    expect(envResult.stdout).toContain("local wrapper executed");
    expect(envResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
  });

  it.each([
    { command: "prepare-run", parked: false },
    ...["prepare-run", "prepare-baseline-refresh", "prepare-baseline-successor"].map((command) => ({
      command,
      parked: true,
    })),
  ])(
    "routes mismatched $command through the trusted wrapper (parked=$parked)",
    ({ command, parked }) => {
      const fixture = makeMismatchedWrapperRepo();
      seedReadyReview(fixture);
      if (parked) {
        parkCanonicalOffAnchor(fixture);
      }
      const result = runWrapper(fixture, [...(parked ? [] : ["--dev-wrapper"]), command, "123"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        parked
          ? "running wrapper code materialized from the refs/remotes/origin/main trust anchor"
          : anchorSubstitutionNotice(fixture.canonical),
      );
      expect(result.stderr).toContain(
        "scripts/pr prepare and merge commands only support PRs targeting main; PR #123 targets not-main.",
      );
      if (parked) {
        expect(result.stderr).not.toContain("Refusing to silently substitute");
      } else {
        expect(result.stderr).toContain(
          `subcommand '${command}' is classified landing; dev-wrapper opt-in is unavailable.`,
        );
        expect(result.stdout).not.toContain("local wrapper executed");
      }
    },
  );

  it("substitutes the canonical wrapper for a stale-base worktree once main moves the wrapper", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    // Stale worktree: created at the pushed main base, no local wrapper edits.
    const stale = join(fixture.root, "stale");
    const baseline = fixture.gitText(["rev-parse", "main"]);
    fixture.git(fixture.canonical, ["worktree", "add", "-b", "stale-feature", stale, baseline]);

    // main's wrapper then advances and the canonical checkout tracks it.
    fixture.write("scripts/pr-lib/gates.sh", 'ci_dispatch() { echo "canonical v2 executed"; }\n');
    fixture.commit(["scripts/pr-lib/gates.sh"], true);

    const result = runCommand(
      join(stale, "scripts", "pr"),
      ["ci-dispatch", "123"],
      fixture.env,
      stale,
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("canonical v2 executed");
    expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
    expect(result.stderr).not.toContain("Refusing to silently substitute");
  });

  // Parks the canonical checkout on a diverging branch so neither the linked
  // worktree nor canonical matches the fetched origin/main anchor — the shape
  // that previously refused and forced a rebase.
  function parkCanonicalOffAnchor(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    fixture.git(fixture.canonical, ["checkout", "-b", "parked"]);
    fixture.write(
      "scripts/pr-lib/gates.sh",
      'ci_dispatch() { echo "parked canonical executed"; }\n',
    );
    fixture.commit(["scripts/pr-lib/gates.sh"]);
  }

  itPosix.each([
    "scripts/pr-lib/cache-lifetime.mjs",
    "scripts/pr-lib/materialized-anchor.mjs",
    "scripts/windows-cmd-helpers.mjs",
  ])("never imports a committed rejected parent helper: %s", (helper) => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const marker = join(fixture.root, "rejected-helper-executed");
    fixture.write(
      helper,
      `import { writeFileSync as recordRejected } from "node:fs"; recordRejected(${JSON.stringify(marker)}, "bad");\n${readScript(join(fixture.linked, helper))}`,
      fixture.linked,
    );
    fixture.commit([helper], false, fixture.linked);
    expect(fixture.gitText(["rev-parse", "HEAD:scripts/pr"], fixture.linked)).toBe(
      fixture.gitText(["rev-parse", "refs/remotes/origin/main:scripts/pr"]),
    );
    parkCanonicalOffAnchor(fixture);
    const result = runWrapper(fixture, ["ls"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(existsSync(marker)).toBe(false);
  });

  itPosix("retains without caller cleanup when trusted main lacks the bootstrap closure", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const marker = join(fixture.root, "unqualified-cleanup-executed");
    const cleanup = "scripts/pr-lib/materialized-anchor.mjs";
    fixture.write(
      cleanup,
      `import { writeFileSync as recordRejected } from "node:fs"; recordRejected(${JSON.stringify(marker)}, "bad");\n${readScript(join(fixture.linked, cleanup))}`,
      fixture.linked,
    );
    fixture.commit([cleanup], false, fixture.linked);
    const missing = "scripts/pr-lib/cache-lifetime.mjs";
    rmSync(join(fixture.canonical, missing));
    fixture.commit(["-u", missing], true);
    parkCanonicalOffAnchor(fixture);
    const result = runWrapper(fixture, ["ls"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Bootstrap closure unavailable");
    expect(result.stderr).toContain("retaining");
    expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  itPosix("rejects selected archive paths overlapping the independent bootstrap root", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const reserved = ".pr-bootstrap/replacement.mjs";
    mkdirSync(dirname(join(fixture.canonical, reserved)), { recursive: true });
    fixture.write(reserved, 'throw new Error("must not extract");\n');
    const inventory = "scripts/pr-lib/wrapper-components.txt";
    fixture.write(inventory, `${readScript(join(fixture.canonical, inventory))}.pr-bootstrap\n`);
    fixture.commit([reserved, inventory], true);
    parkCanonicalOffAnchor(fixture);
    const result = runWrapper(fixture, ["ls"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Selected source overlaps the reserved bootstrap directory");
    expect(result.stderr).not.toContain("must not extract");
    expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toHaveLength(0);
  });

  itPosix("reauthenticates parent cleanup after a failed selected extraction", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    parkCanonicalOffAnchor(fixture);
    const marker = join(fixture.root, "replaced-bootstrap-executed");
    const appended = `\nimport { writeFileSync as recordReplacement } from "node:fs"; recordReplacement(${JSON.stringify(marker)}, "bad");\n`;
    const shellAppended = "'" + appended.replaceAll("'", "'\\''") + "'";
    writeExecutable(
      join(fixture.bin, "tar"),
      `#!/bin/sh\nif [ "$(basename "$2")" = anchor.tar ]; then\n  printf '%s' ${shellAppended} >> "$4/.pr-bootstrap/scripts/pr-lib/cache-lifetime.mjs"\n  exit 9\nfi\nexec '${resolveCommand("tar")}' "$@"\n`,
    );
    const result = runWrapper(fixture, ["ls"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Bootstrap changed during selected extraction");
    expect(result.stderr).toContain("cannot be authenticated");
    expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  itPosix("preserves selected shell and Node Git across a legacy extracted wrapper handoff", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    fixture.write(
      "scripts/pr",
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "# OPENCLAW_PR_ANCHOR_REPO_ROOT",
        "export PR_TEST_GIT_PHASE=shell",
        "git --version >/dev/null",
        "export PR_TEST_GIT_PHASE=node",
        'node -e \'require("node:child_process").execFileSync("git", ["--version"], { stdio: "ignore" })\'',
        "printf 'legacy wrapper completed\\n'",
        "",
      ].join("\n"),
    );
    fixture.commit(["scripts/pr"], true);
    parkCanonicalOffAnchor(fixture);

    const { selected, calls, env } = delegatingGitFixture(fixture.root, fixture.env);
    const run = (path: string) =>
      runWrapper(fixture, ["ls"], "linked", { env: { ...env, PATH: path } });
    const result = run(env.PATH);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe("legacy wrapper completed\n");
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(readScript(calls)).toContain("shell --version\n");
    expect(readScript(calls)).toContain("node --version\n");
    const adapters = matchingEntries(fixture.root, "openclaw-pr-git.");
    expect(adapters).toHaveLength(1);
    const adapter = join(fixture.root, adapters[0]!);
    expect(lstatSync(join(adapter, "git")).isFile()).toBe(true);
    expect(readScript(join(adapter, "git"))).toContain("exec '");
    expect(readScript(join(adapter, "git"))).not.toBe(readScript(selected));

    const reentry = runWrapper(fixture, ["ls"], "linked", {
      env: {
        ...env,
        OPENCLAW_PR_GIT: join(adapter, "git"),
        GIT_EXEC: join(adapter, "git"),
        PATH: `${adapter}${delimiter}${env.PATH}`,
      },
    });
    expect(reentry.status, reentry.stdout + reentry.stderr).toBe(0);
    expect(reentry.stdout).toBe("legacy wrapper completed\n");
    expect(readScript(calls)).not.toContain("recursive selected Git");
  });

  function materializeAnchor(
    fixture: ReturnType<typeof makeMismatchedWrapperRepo>,
    env: NodeJS.ProcessEnv = fixture.env,
  ) {
    const node = join(fixture.bin, "node");
    // Crash the creator at its supervisor exec, after extraction and dependency
    // verification. This retains a real crash leftover without an orphan child.
    writeExecutable(
      node,
      '#!/bin/sh\ncase "$1" in\n  */process-group-runner.mjs) kill -KILL "$$" ;;\nesac\nexec "$PR_TEST_REAL_NODE" "$@"\n',
    );
    let materialized;
    try {
      materialized = runWrapper(fixture, ["ci-dispatch", "123"], "linked", {
        env: { ...env, PR_TEST_REAL_NODE: requireNodeTool("node") },
      });
    } finally {
      rmSync(node);
    }
    expect(materialized.signal, materialized.stderr).toBe("SIGKILL");
    expect(materialized.stderr).toContain("running wrapper code materialized from");
    const anchors = matchingEntries(fixture.root, "openclaw-pr-anchor-v3.");
    expect(anchors).toHaveLength(1);
    const anchor = join(fixture.root, anchors[0]!);
    expect(statSync(anchor).mode & 0o777).toBe(0o700);
    return { anchor, result: materialized };
  }

  function advanceAnchorReviewDependency(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    const dependency = "scripts/lib/anchor-review-record.mjs";
    cpSync("scripts/lib/record-shared.mjs", join(fixture.canonical, dependency));
    const inventory = "scripts/pr-lib/wrapper-components.txt";
    writeFileSync(
      join(fixture.canonical, inventory),
      `${readScript(join(fixture.canonical, inventory))}${dependency}\n`,
    );
    const helper = join(fixture.canonical, "scripts/pr-lib/review-artifacts.mjs");
    writeFileSync(
      helper,
      readScript(helper).replace("../lib/record-shared.mjs", "../lib/anchor-review-record.mjs"),
    );
    fixture.commit([inventory, dependency, "scripts/pr-lib/review-artifacts.mjs"], true);
  }

  function archiveFaultFixture(
    fixture: ReturnType<typeof makeMismatchedWrapperRepo>,
    failure: string,
    phase: "bootstrap" | "selected",
  ) {
    const helper = join(fixture.root, "archive-fault.mjs");
    const readerLog = join(fixture.root, "selected-reader.log");
    const archives = join(fixture.root, "archives.log");
    writeFileSync(
      helper,
      String.raw`
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const [tool, ...args] = process.argv.slice(2);
const env = process.env;
const failure = env.OPENCLAW_TEST_FAILURE;
const phase = env.OPENCLAW_TEST_ARCHIVE_PHASE;
const extracted = env.OPENCLAW_TEST_SELECTED_EXTRACTED;
const backendEnv = { ...env, PATH: env.OPENCLAW_TEST_BACKEND_PATH };
let command;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-C" || args[i] === "-c") { i++; continue; }
  if (/^-(?:C|c)./.test(args[i]) || ["--no-pager", "--literal-pathspecs", "--no-replace-objects"].includes(args[i])) continue;
  command = args[i]; break;
}
const components = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
const componentPhase = components.includes("scripts/pr-lib") ? "selected"
  : components.includes("scripts/pr-lib/cache-lifetime.mjs") ? "bootstrap" : undefined;
let input;
let targeted = false;
let destination;
let extractedPhase;
if (tool === "git") {
  if (command === "archive") {
    appendFileSync(env.OPENCLAW_TEST_ARCHIVES, JSON.stringify({ phase: componentPhase, components }) + "\n");
    targeted = componentPhase === phase;
  } else if (command === "ls-tree") {
    // Before extraction these listings also check namespace disjointness and
    // source selection. Fault only the selected extraction's verification.
    targeted = componentPhase === phase && (phase === "bootstrap" || existsSync(extracted));
  } else if (command === "hash-object" && args.includes("--stdin-paths")) {
    input = readFileSync(0);
    const paths = input.toString("utf8").trimEnd().split("\n");
    const bootstrap = paths.every(path => path.includes("/.pr-bootstrap/"));
    const selected = paths.every(path => /\/openclaw-pr-anchor-v3\.[^/]+\//.test(path) && !path.includes("/.pr-bootstrap/"));
    targeted = phase === "bootstrap" ? bootstrap : selected;
  }
} else {
  // The wrapper uses -xf, not separate -x -f. Parse both native spellings.
  const fileIndex = args.findIndex(arg => /^-[^-]*f$/.test(arg));
  const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  extractedPhase = basename(file ?? "") === "source.tar" ? "bootstrap"
    : basename(file ?? "") === "anchor.tar" ? "selected" : undefined;
  destination = args[args.indexOf("-C") + 1];
  targeted = extractedPhase === phase;
  if (extractedPhase === "selected") appendFileSync(env.OPENCLAW_TEST_READER_LOG, "started\n");
}
const capture = tool === "git" && (command === "ls-tree" || command === "hash-object");
const result = spawnSync(tool === "git" ? env.OPENCLAW_TEST_GIT : env.OPENCLAW_TEST_TAR, args, {
  env: backendEnv, input, stdio: [input === undefined ? 0 : "pipe", capture ? "pipe" : 1, 2],
});
if (result.stderr) writeFileSync(2, result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) {
  if (result.stdout) writeFileSync(1, result.stdout);
  process.exit(result.status ?? 1);
}
let output = result.stdout;
if (extractedPhase === "selected") writeFileSync(extracted, "selected archive extracted\n");
if (targeted) {
  if ((tool === "git" && command === "archive" && failure === "producer failure") ||
      (tool === "tar" && failure === "reader failure") ||
      (tool === "git" && command === "ls-tree" && failure === "listing producer failure") ||
      (tool === "git" && command === "hash-object" && failure === "hash producer failure")) {
    if (output) writeFileSync(1, output);
    process.exit(42);
  }
  if (tool === "git" && command === "ls-tree" && failure === "unterminated listing") {
    output = output.subarray(0, -1);
  } else if (tool === "git" && ((command === "hash-object" && failure === "incomplete hash output") ||
      (command === "ls-tree" && failure === "omitted required inventory component"))) {
    const separator = output.includes(0) ? "\0" : "\n";
    const records = output.toString("utf8").split(separator).slice(0, -1);
    const retained = failure === "incomplete hash output" ? records.slice(0, -1)
      : records.filter(record => record.slice(record.indexOf("\t") + 1) !== "package.json");
    output = Buffer.from(retained.join(separator) + separator);
  } else if (tool === "tar") {
    const relative = phase === "bootstrap" ? "scripts/pr-lib/cache-lifetime.mjs"
      : failure === "parent symlink" ? "scripts/lib"
      : failure === "leaf symlink" ? "scripts/lib/plain-gh.mjs"
      : "scripts/lib/anchor-review-record.mjs";
    const path = join(destination, relative);
    if (failure === "missing") rmSync(path);
    else if (failure === "tampered") appendFileSync(path, "\n// tampered\n");
    else if (failure === "leaf symlink" || failure === "parent symlink") {
      renameSync(path, env.OPENCLAW_TEST_LINK_TARGET);
      symlinkSync(env.OPENCLAW_TEST_LINK_TARGET, path);
    }
  }
}
if (output) writeFileSync(1, output);
`,
    );
    for (const tool of ["git", "tar"]) {
      writeExecutable(
        join(fixture.bin, tool),
        `#!/bin/sh\nexec "$OPENCLAW_TEST_NODE" "$OPENCLAW_TEST_FAULT_HELPER" ${tool} "$@"\n`,
      );
    }
    return {
      readerLog,
      archives,
      env: {
        ...fixture.env,
        OPENCLAW_TEST_GIT: resolveCommand("git"),
        OPENCLAW_TEST_TAR: resolveCommand("tar"),
        OPENCLAW_TEST_NODE: requireNodeTool("node"),
        OPENCLAW_TEST_BACKEND_PATH: process.env.PATH,
        OPENCLAW_TEST_FAULT_HELPER: helper,
        OPENCLAW_TEST_FAILURE: failure,
        OPENCLAW_TEST_ARCHIVE_PHASE: phase,
        OPENCLAW_TEST_ARCHIVES: archives,
        OPENCLAW_TEST_READER_LOG: readerLog,
        OPENCLAW_TEST_SELECTED_EXTRACTED: join(fixture.root, "selected-extracted"),
        OPENCLAW_TEST_LINK_TARGET: join(fixture.root, "anchor-matching-link-target"),
      },
    };
  }

  function makeToolingRootFixture({ dispatchBody }: { dispatchBody?: string } = {}) {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true, dispatchBody });
    const tooling = join(fixture.root, "tooling");
    const origin = fixture.gitText(["remote", "get-url", "origin"]);
    fixture.git(fixture.root, ["clone", "--no-local", "--quiet", origin, tooling]);
    writeFileSync(join(tooling, ".git/info/exclude"), "node_modules/\n");
    linkPrWrapperDependencies(tooling);
    const stale = join(fixture.root, "stale-tsx");
    mkdirSync(stale);
    writeFileSync(join(stale, "package.json"), '{"name":"tsx","version":"0.0.0"}\n');
    rmSync(join(fixture.canonical, "node_modules/tsx"));
    symlinkSync(stale, join(fixture.canonical, "node_modules/tsx"), "dir");
    parkCanonicalOffAnchor(fixture);
    const run = (env: Record<string, string> = {}) =>
      runWrapper(fixture, ["unknown-command"], "linked", {
        env: { ...fixture.env, ...env },
        maxBuffer: 8 * 1024 * 1024,
      });
    return { ...fixture, tooling, stale, run };
  }

  const itRecovery = process.platform === "linux" ? it : it.skip;
  const mvHelp =
    process.platform === "linux" ? spawnSync("mv", ["--help"], { encoding: "utf8" }).stdout : "";
  const itExchange = mvHelp?.includes("--exchange") && mvHelp.includes("--no-copy") ? it : it.skip;
  function recoveryFixture({ legacy = false } = {}) {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const runtime = runCommand(
      requireNodeTool("node"),
      [
        "-p",
        "JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })",
      ],
      fixture.env,
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    parkCanonicalOffAnchor(fixture);
    let { anchor } = materializeAnchor(fixture);
    if (legacy) {
      const retained = anchor.replace("openclaw-pr-anchor-v3.", "openclaw-pr-anchor.");
      renameSync(anchor, retained);
      anchor = retained;
    }
    fixture.git(fixture.canonical, ["checkout", "main"]);
    const modules = join(anchor, "node_modules");
    const donor = join(fixture.root, "isolated-tooling");
    const origin = fixture.gitText(["remote", "get-url", "origin"]);
    fixture.git(fixture.root, ["clone", "--quiet", origin, donor]);
    writeFileSync(join(donor, ".git/info/exclude"), "node_modules/\n");
    const manifest = JSON.parse(readScript(join(donor, "package.json")));
    const donorModules = join(donor, "node_modules");
    const store = join(donorModules, ".pnpm");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(donorModules, ".modules.yaml"),
      JSON.stringify({
        packageManager: manifest.packageManager.split("+")[0],
        nodeLinker: "isolated",
        virtualStoreDir: ".pnpm",
      }),
    );
    writeFileSync(join(store, "lock.yaml"), "lockfileVersion: '9.0'\n");
    const packages: Record<string, string> = {};
    for (const entry of readdirSync(modules)) {
      const names = entry.startsWith("@")
        ? readdirSync(join(modules, entry)).map((name) => `${entry}/${name}`)
        : [entry];
      for (const name of names) {
        const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
        const target = join(store, `${name.replace("/", "+")}@${version}`, "node_modules", name);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "package.json"), JSON.stringify({ name, version }));
        mkdirSync(join(donorModules, name, ".."), { recursive: true });
        symlinkSync(target, join(donorModules, name));
        packages[name] = target;
      }
    }
    const identity = (path: string) => {
      const stat = lstatSync(path, { bigint: true });
      return Object.fromEntries(
        ["dev", "ino", "uid", "gid", "mode"].map((key) => [
          key,
          String(stat[key as keyof typeof stat]),
        ]),
      );
    };
    const projection = (directory: string) => {
      const entries: Record<string, Record<string, string>> = {};
      const visit = (name: string) => {
        const path = join(directory, name);
        entries[name] = identity(path);
        if (lstatSync(path).isSymbolicLink()) {
          entries[name].target = readlinkSync(path);
        } else {
          for (const child of readdirSync(path).toSorted()) {
            visit(name ? `${name}/${child}` : child);
          }
        }
      };
      visit("");
      return entries;
    };
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    // The original failure: a previously pinned directory has disappeared.
    rmSync(join(modules, "yaml"));
    symlinkSync(join(fixture.root, "removed-install/yaml"), join(modules, "yaml"));
    const helper = join(anchor, "scripts/pr-lib/materialize-dependencies.mjs");
    const frozenHelper = readFileSync(helper);
    const plan = {
      version: 1,
      pr: 123,
      revision: fixture.gitText(["rev-parse", "HEAD"], donor),
      runtime: JSON.parse(runtime.stdout),
      anchor: {
        path: anchor,
        identity: identity(anchor),
        parentIdentity: identity(fixture.root),
        projection: projection(modules),
      },
      donor: {
        path: donor,
        identity: identity(donor),
        parentIdentity: identity(fixture.root),
        modulesSha256: hash(join(donorModules, ".modules.yaml")),
        installLockSha256: hash(join(store, "lock.yaml")),
        packages,
      },
    };
    const planPath = join(fixture.root, "recovery.json");
    const run = () => {
      writeFileSync(planPath, JSON.stringify(plan));
      return runWrapper(
        fixture,
        [
          "tooling-recover",
          "123",
          planPath,
          "--plan-sha256",
          hash(planPath),
          "--confirmed-quiescent",
        ],
        "canonical",
      );
    };
    const validate = () =>
      runCommand(requireNodeTool("node"), [helper, donorModules, modules], fixture.env);
    return {
      ...fixture,
      anchor,
      modules,
      donor,
      plan,
      run,
      validate,
      projection,
      identity,
      helper,
      frozenHelper,
    };
  }

  itExchange.each([false, true])(
    "recovers a frozen dangling projection through the locked wrapper (exchange reports failure: %s)",
    (reportsFailure) => {
      const fixture = recoveryFixture();
      // Older parents can have pinned only part of the child's dependency set.
      rmSync(join(fixture.modules, "zod"));
      chmodSync(fixture.modules, 0o2775);
      chmodSync(join(fixture.modules, "@openclaw"), 0o1775);
      fixture.plan.anchor.projection = fixture.projection(fixture.modules);
      expect(fixture.validate().status).toBe(78);
      const original = fixture.projection(fixture.modules);
      const yamlPackage = fixture.plan.donor.packages.yaml;
      if (!yamlPackage) {
        throw new Error("Fixture yaml package missing");
      }
      const donorBytes = readFileSync(join(yamlPackage, "package.json"));
      const alias = readlinkSync(join(fixture.canonical, "node_modules/yaml"));
      writeFileSync(join(fixture.anchor, "retained-evidence"), "unchanged");
      const mv = resolveCommand("mv");
      fixture.write(
        "mv",
        `#!/bin/sh\n"${mv}" "$@"\n${reportsFailure ? "exit 7" : "exit $?"}\n`,
        fixture.bin,
      );
      chmodSync(join(fixture.bin, "mv"), 0o755);
      const result = fixture.run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      expect(receipt.state).toBe("complete");
      expect(fixture.projection(receipt.stage)).toEqual(original);
      expect(fixture.identity(fixture.modules)).toEqual(receipt.installed);
      expect(fixture.identity(fixture.modules).mode).toBe(original[""]?.mode);
      expect(fixture.identity(join(fixture.modules, "@openclaw")).mode).toBe(
        original["@openclaw"]?.mode,
      );
      for (const [name, target] of Object.entries(fixture.plan.donor.packages)) {
        expect(readlinkSync(join(fixture.modules, name))).toBe(target);
      }
      expect(fixture.validate().status).toBe(0);
      expect(readFileSync(fixture.helper)).toEqual(fixture.frozenHelper);
      expect(readFileSync(join(yamlPackage, "package.json"))).toEqual(donorBytes);
      expect(readlinkSync(join(fixture.canonical, "node_modules/yaml"))).toBe(alias);
      expect(readScript(join(fixture.anchor, "retained-evidence"))).toBe("unchanged");
      // An already exchanged plan cannot swap the original directory back.
      const repeat = fixture.run();
      expect(repeat.status).not.toBe(0);
      expect(repeat.stderr).toContain("Projection preimage differs");
    },
  );

  itExchange("recovers an explicitly qualified legacy anchor without adopting its lifetime", () => {
    const fixture = recoveryFixture({ legacy: true });
    const result = fixture.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(fixture.anchor)).toBe(true);
    expect(readFileSync(fixture.helper)).toEqual(fixture.frozenHelper);
    expect(fixture.validate().status).toBe(0);
  });

  itRecovery("refuses changed recovery inputs before replacing the retained projection", () => {
    const fixture = recoveryFixture();
    const original = fixture.projection(fixture.modules);
    const check = (message: string) => {
      const result = fixture.run();
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(fixture.projection(fixture.modules)).toEqual(original);
      expect(readFileSync(fixture.helper)).toEqual(fixture.frozenHelper);
    };
    fixture.plan.anchor.identity.ino += "1";
    check("directory identity differs");
    fixture.plan.anchor.identity = fixture.identity(fixture.anchor);
    const yamlEntry = fixture.plan.anchor.projection.yaml;
    const yamlPackage = fixture.plan.donor.packages.yaml;
    if (!yamlEntry || !yamlPackage) {
      throw new Error("Fixture yaml projection missing");
    }
    yamlEntry.target = "changed-preimage";
    check("Projection preimage differs");
    fixture.plan.anchor.projection = fixture.projection(fixture.modules);
    const packagePath = join(yamlPackage, "package.json");
    const packageBytes = readFileSync(packagePath);
    writeFileSync(packagePath, '{"name":"yaml","version":"0.0.0"}');
    check("prerequisite command failed");
    writeFileSync(packagePath, packageBytes);
    const packageModules = join(yamlPackage, "..");
    symlinkSync(fixture.canonical, join(packageModules, "borrowed-workspace"));
    check("escapes the isolated installation");
    rmSync(join(packageModules, "borrowed-workspace"));
    const nestedModules = join(yamlPackage, "node_modules");
    mkdirSync(nestedModules);
    symlinkSync(fixture.canonical, join(nestedModules, "borrowed-workspace"));
    check("escapes the isolated installation");
    rmSync(nestedModules, { recursive: true });
    fixture.plan.donor.packages.yaml = fixture.canonical;
    check("Qualified package path differs");
  });

  itRecovery.each(["unchanged", "unknown"])(
    "retains both projection directories after an %s exchange outcome",
    (state) => {
      const fixture = recoveryFixture();
      const original = fixture.projection(fixture.modules);
      // Real PATH process boundary, without a production-only interruption seam.
      const mv = resolveCommand("mv");
      fixture.write(
        "mv",
        state === "unchanged"
          ? "#!/bin/sh\nexit 7\n"
          : `#!/bin/sh\n"${mv}" "$6" "$6.displaced"\nexit 7\n`,
        fixture.bin,
      );
      chmodSync(join(fixture.bin, "mv"), 0o755);
      const result = fixture.run();
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      expect(receipt.state).toBe(state);
      expect(result.stderr).toContain("do not retry");
      expect(existsSync(receipt.stage)).toBe(true);
      expect(
        fixture.projection(
          state === "unchanged" ? fixture.modules : `${fixture.modules}.displaced`,
        ),
      ).toEqual(original);
    },
  );

  itPosix(
    "sources anchor dependencies from the environment tooling root without changing canonical",
    () => {
      const fixture = makeToolingRootFixture();
      const canonicalHead = fixture.git(fixture.canonical, ["rev-parse", "HEAD"]).stdout;
      fixture.git(fixture.canonical, [
        "config",
        "openclaw.pr.toolingRoot",
        join(fixture.root, "invalid-config-root"),
      ]);
      const { anchor, result } = materializeAnchor(fixture, {
        ...fixture.env,
        OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
      });
      expect(result.stderr).toContain(`scripts/pr tooling root: ${fixture.tooling}`);
      expect(result.stderr).toContain("running wrapper code materialized from");
      expect(realpathSync(join(anchor, "node_modules/tsx"))).toBe(
        realpathSync(join(fixture.tooling, "node_modules/tsx")),
      );
      expect(fixture.git(fixture.canonical, ["rev-parse", "HEAD"]).stdout).toBe(canonicalHead);
      expect(realpathSync(join(fixture.canonical, "node_modules/tsx"))).toBe(fixture.stale);
      expect(result.stderr).not.toContain("Refreshing scripts/pr tooling root");
    },
  );

  function makeFrozenDependencyFixture({
    oldHelper = false,
    dispatchBody,
  }: { oldHelper?: boolean; dispatchBody?: string } = {}) {
    const fixture = makeToolingRootFixture({ dispatchBody });
    fixture.git(fixture.canonical, ["checkout", "main"]);
    const helper = "scripts/pr-lib/materialize-dependencies.mjs";
    const materializerCalls = join(fixture.root, "materializer-calls");
    if (oldHelper) {
      // A selected pre-lifetime helper still owns its complete package/version
      // policy, but cannot guard private-cache donors on the current parent's behalf.
      const source = readScript(helper).replace(
        "    assertDependencyTarget(target, process.argv[3]);\n",
        "",
      );
      fixture.write(
        helper,
        `import * as fixtureFs from "node:fs";
import * as fixturePath from "node:path";
import { DatabaseSync as FixtureDatabase } from "node:sqlite";
import { withDependencyCacheLock as fixtureWithCacheLock } from "./cache-lifetime.mjs";
const fixtureEntry = fixturePath.dirname(process.argv[2]);
const fixtureLedger = fixturePath.join(fixturePath.dirname(fixtureEntry), "lifetime.sqlite");
let fixtureHolds = 0;
if (fixtureFs.existsSync(fixtureLedger)) {
  fixtureWithCacheLock(fixturePath.dirname(fixtureEntry), () => {
    const db = new FixtureDatabase(fixtureLedger, { readOnly: true });
    try { fixtureHolds = db.prepare("SELECT count(*) AS count FROM holds WHERE entry_key = ?").get(fixturePath.basename(fixtureEntry)).count; }
    finally { db.close(); }
  });
}
fixtureFs.appendFileSync(${JSON.stringify(materializerCalls)}, JSON.stringify({ source: process.argv[2], destination: process.argv[3], holds: fixtureHolds }) + "\\n");
${source}`,
      );
    }
    const markdownManifest = "packages/markdown-core/package.json";
    mkdirSync(join(fixture.canonical, "packages/markdown-core"), { recursive: true });
    fixture.write(markdownManifest, readScript(markdownManifest));
    const inventory = "scripts/pr-lib/wrapper-components.txt";
    fixture.write(
      inventory,
      `${readScript(join(fixture.canonical, inventory))}${markdownManifest}\n`,
    );
    fixture.commit([markdownManifest, inventory, ...(oldHelper ? [helper] : [])], true);
    fixture.git(fixture.canonical, ["fetch", "origin", "main"]);
    fixture.git(fixture.canonical, ["checkout", "parked"]);
    const calls = join(fixture.root, "frozen-install-calls");
    writeFileSync(join(fixture.stale, "package.json"), '{"name":"tsx","version":"99.0.0"}');
    const expected = realpathSync(join(fixture.tooling, "node_modules/tsx"));
    // The anchor needs the original package; the shared installation has moved on.
    rmSync(join(fixture.tooling, "node_modules/tsx"));
    symlinkSync(fixture.stale, join(fixture.tooling, "node_modules/tsx"), "dir");
    fixture.write(
      "pnpm",
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const root = args[1];
if (root === ${JSON.stringify(fixture.tooling)}) process.exit(0);
if (process.env.PR_TEST_INSTALL_GIT) {
  const result = require("node:child_process").spawnSync("git", ["--version"], { stdio: "inherit", env: { ...process.env, PR_TEST_GIT_PHASE: "install-child" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
fs.cpSync(fs.realpathSync(${JSON.stringify(join(fixture.tooling, "node_modules"))}), path.join(root, "node_modules"), { recursive: true });
fs.unlinkSync(path.join(root, "node_modules/tsx"));
fs.symlinkSync(${JSON.stringify(expected)}, path.join(root, "node_modules/tsx"), "dir");
const workspaceModules = path.join(root, "packages/markdown-core/node_modules");
fs.mkdirSync(workspaceModules, { recursive: true });
for (const name of Object.keys(${JSON.stringify(JSON.parse(readScript("packages/markdown-core/package.json")).dependencies)})) {
  if (name !== "micromark" && !name.startsWith("mdast-") && !name.startsWith("micromark-")) continue;
  const target = path.join(root, "node_modules/.workspace", name);
  fs.cpSync(fs.realpathSync(path.join(${JSON.stringify(fixture.tooling)}, "packages/markdown-core/node_modules", name)), target, { recursive: true });
  fs.symlinkSync(path.relative(workspaceModules, target), path.join(workspaceModules, name), "dir");
}
if (process.env.PR_TEST_INSTALL_GATE) {
  console.log("frozen install ready");
  const fd = fs.openSync(process.env.PR_TEST_INSTALL_GATE, "r");
  fs.readSync(fd, Buffer.alloc(1), 0, 1, null);
  fs.closeSync(fd);
}
`,
      fixture.bin,
    );
    return { ...fixture, calls, expected, materializerCalls };
  }

  function privateToolingDonor(fixture: ReturnType<typeof makeFrozenDependencyFixture>) {
    const cache = join(fixture.env.HOME!, ".cache/openclaw/pr-dependencies/v3");
    const donorEntry = join(cache, "a".repeat(64));
    withDependencyCacheLock(cache, () => {});
    mkdirSync(donorEntry, { mode: 0o700 });
    renameSync(join(fixture.tooling, "node_modules"), join(donorEntry, "node_modules"));
    rmSync(join(donorEntry, "node_modules/tsx"));
    symlinkSync(fixture.expected, join(donorEntry, "node_modules/tsx"), "dir");
    symlinkSync(join(donorEntry, "node_modules"), join(fixture.tooling, "node_modules"), "dir");
    return donorEntry;
  }

  itPosix(
    "keeps a live package reader after its bootstrap creator exits and newer installs collect",
    async ({ signal }) => {
      const fixture = makeFrozenDependencyFixture();
      const env = { ...fixture.env, OPENCLAW_PR_GIT: resolveCommand("git") };
      const node = requireNodeTool("node");
      const sourceOnly = "cache-pressure.txt";
      const prepare = (index: number) => {
        fixture.git(fixture.canonical, ["checkout", "main"]);
        fixture.write(sourceOnly, String(index));
        fixture.commit([sourceOnly], true);
        const revision = fixture.gitText(["rev-parse", "HEAD"]);
        expect(fixture.gitText(["rev-parse", "refs/remotes/origin/main"])).toBe(revision);
        const archive = join(fixture.root, `creator-${index}.tar`);
        fixture.git(fixture.canonical, [
          "archive",
          "--format=tar",
          `--output=${archive}`,
          revision,
        ]);
        return { archive, revision };
      };
      // This is the actual embedded producer and selected helper. The creator,
      // not Vitest, owns FD9; its package reader deliberately survives that PID.
      const creatorSource = `
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
const [root, archive, revision, retain, prefix] = process.argv.slice(1);
const anchor = realpathSync(mkdtempSync(join(root, prefix + process.pid + ".")));
const extract = spawnSync("tar", ["-xf", archive, "-C", anchor], { encoding: "utf8" });
if (extract.status !== 0) throw new Error(extract.stderr);
const fd = openSync(anchor, "r");
const stdio = ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", fd];
const owner = join(anchor, "scripts/pr-lib/materialize-dependencies.mjs");
const bootstrap = readFileSync(join(anchor, "scripts/pr"), "utf8").split("<<'EOF_TOOLING'\\n")[1].split("\\nEOF_TOOLING")[0];
const installed = spawnSync(process.execPath, ["--input-type=module", "-", owner, process.cwd(), join(anchor, "node_modules"), revision, join(anchor, "scripts/pr-lib/cache-lifetime.mjs")], { input: bootstrap, encoding: "utf8", stdio });
if (installed.status !== 0) throw new Error(installed.stderr);
const receiptPrefix = "Using frozen scripts/pr dependency installation: ";
const installation = installed.stderr.split(String.fromCharCode(10)).find(line => line.startsWith(receiptPrefix))?.slice(receiptPrefix.length);
if (!installation) throw new Error("Actual frozen installation receipt is missing");
if (retain === "yes") {
  const reader = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`
import { readFileSync, readSync } from "node:fs";
const path = process.argv[1];
console.log("cache-reader=" + JSON.stringify({ event: "ready", pid: process.pid, path }));
const command = Buffer.alloc(1);
while (readSync(0, command, 0, 1, null) > 0) {
  if (command.toString() === "q") break;
  if (command.toString() === "r") {
    console.log("cache-reader=" + JSON.stringify({ event: "read", value: readFileSync(path, "utf8") }));
  }
}
`)}, join(anchor, "node_modules/micromark/package.json")], { stdio: [3, 1, 2] });
  reader.unref();
} else {
  const retired = spawnSync(process.execPath, [join(anchor, "scripts/pr-lib/materialized-anchor.mjs"), "retire-created", anchor], { encoding: "utf8", stdio });
  if (retired.status !== 0) throw new Error(retired.stderr);
  console.log(JSON.stringify({ anchor, installation }));
}
closeSync(fd);
`;
      const first = prepare(0);
      const creator = spawn(
        node,
        [
          "--input-type=module",
          "-e",
          creatorSource,
          fixture.root,
          first.archive,
          first.revision,
          "yes",
          ANCHOR_PREFIX,
        ],
        {
          cwd: fixture.canonical,
          env,
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        },
      );
      const exited = once(creator, "exit");
      const closed = once(creator, "close");
      const control = creator.stdio[3];
      if (!control || !("write" in control) || !creator.stdout || !creator.stderr) {
        throw new Error("Creator fixture pipes were not created");
      }
      const ready = createDeferred<{ pid: number; path: string }>();
      const read = createDeferred<string>();
      let output = "",
        errors = "";
      creator.stderr.on("data", (data) => {
        errors += data;
      });
      creator.stdout.on("data", (data) => {
        output += data;
        let newline;
        while ((newline = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (!line.startsWith("cache-reader=")) {
            continue;
          }
          const value = JSON.parse(line.slice("cache-reader=".length));
          if (value.event === "ready") {
            ready.resolve(value);
          }
          if (value.event === "read") {
            read.resolve(value.value);
          }
        }
      });
      try {
        const reader = await withinTest(
          awaitGateBeforeSettlement(ready.promise, closed, "Package reader did not start"),
          signal,
        );
        expect((await withinTest(exited, signal))[0], errors).toBe(0);
        expect(() => process.kill(reader.pid, 0)).not.toThrow();
        const original = readScript(reader.path);
        const pressureEntries = new Set<string>();
        for (let index = 1; index <= 5; index++) {
          const next = prepare(index);
          const result = spawnSync(
            node,
            [
              "--input-type=module",
              "-e",
              creatorSource,
              fixture.root,
              next.archive,
              next.revision,
              "no",
              ANCHOR_PREFIX,
            ],
            {
              cwd: fixture.canonical,
              env,
              encoding: "utf8",
            },
          );
          expect(result.status, result.stderr).toBe(0);
          const retired = JSON.parse(result.stdout);
          expect(existsSync(retired.anchor)).toBe(false);
          expect(existsSync(retired.installation)).toBe(true);
          expect(readPrCacheState(retired.installation)).toEqual({
            registered: true,
            settled: true,
            anchors: [],
          });
          pressureEntries.add(retired.installation);
        }
        expect(pressureEntries.size).toBe(5);
        expect(jsonLines(fixture.calls)).toHaveLength(6);
        expect(() => process.kill(reader.pid, 0)).not.toThrow();
        control.write("r");
        expect(
          await withinTest(
            awaitGateBeforeSettlement(
              read.promise,
              closed,
              "Live package reader lost its projection",
            ),
            signal,
          ),
        ).toBe(original);
      } finally {
        control.end("q");
        await closed;
      }
    },
  );

  itPosix(
    "materializes and reuses an older anchor without changing the installed tooling root",
    () => {
      const fixture = makeFrozenDependencyFixture();
      const { calls } = fixture;
      const before = fixture.gitText(["rev-parse", "HEAD"], fixture.tooling);
      for (let run = 0; run < 2; run++) {
        const result = fixture.run(run === 0 ? { OPENCLAW_PR_TOOLING_ROOT: fixture.tooling } : {});
        expect(result.status, result.stdout + result.stderr).toBe(2);
        expect(result.stderr).toContain("running wrapper code materialized from");
      }
      expect(jsonLines(calls)).toHaveLength(1);
      const cache = join(fixture.env.HOME!, ".cache/openclaw/pr-dependencies/v3");
      const entry = prCacheEntries(cache)[0]!;
      expect(realpathSync(join(cache, entry, "node_modules/tsx"))).toBe(fixture.expected);
      expect(existsSync(join(cache, entry, "packages/markdown-core/package.json"))).toBe(true);
      expect(
        lstatSync(join(cache, entry, "node_modules/mdast-util-from-markdown"), {
          throwIfNoEntry: false,
        }),
      ).toBeUndefined();
      expect(jsonLines(calls)[0].slice(2)).toEqual([
        "install",
        "--frozen-lockfile",
        "--prefer-offline",
      ]);
      expect(fixture.gitText(["rev-parse", "HEAD"], fixture.tooling)).toBe(before);
      expect(realpathSync(join(fixture.tooling, "node_modules/tsx"))).toBe(fixture.stale);
    },
  );

  itPosix(
    "shares one frozen install across source revisions with independent anchor lifetimes",
    () => {
      const fixture = makeFrozenDependencyFixture();
      const guard = delegatingGitFixture(fixture.root, {
        ...fixture.env,
        PR_TEST_INSTALL_GIT: "1",
      });
      fixture.git(fixture.canonical, ["checkout", "main"]);
      const sourceOnly = "source-only.txt";
      const auditPath = "scripts/pr-lib/dependency-inputs.json";
      fixture.write(sourceOnly, "first source revision\n");
      fixture.commit([sourceOnly]);
      const rows = fixture.gitText(["ls-tree", "-r", "-z", "HEAD"]).split("\0").filter(Boolean);
      // This fixture audits every tracked input except its inert source-only file
      // and the audit record itself; no production audit is renewed by the test.
      const inputs = rows.filter((row) => {
        const name = row.slice(row.indexOf("\t") + 1);
        return name !== sourceOnly && name !== auditPath;
      });
      const node = requireNodeTool("node");
      const runtime = runCommand(
        node,
        [
          "-p",
          "JSON.stringify({ platform: process.platform, arch: process.arch, modules: process.versions.modules })",
        ],
        fixture.env,
      );
      expect(runtime.status, runtime.stderr).toBe(0);
      fixture.write(
        auditPath,
        JSON.stringify({
          files: inputs.map((row) => row.slice(row.indexOf("\t") + 1)),
          directories: [],
          presence: ["scripts"],
          runtime: JSON.parse(runtime.stdout),
          auditSha256: createHash("sha256").update(inputs.join("\0")).digest("hex"),
        }),
      );
      fixture.commit([auditPath], true);
      fixture.git(fixture.canonical, ["fetch", "origin", "main"]);

      const createdRun = (anchor: string, args: string[], input?: string) => {
        const fd = openSync(anchor, "r");
        try {
          return spawnSync(node, args, {
            cwd: fixture.canonical,
            env: guard.env,
            encoding: "utf8",
            input,
            stdio: [
              "pipe",
              "pipe",
              "pipe",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              fd,
            ],
          });
        } finally {
          closeSync(fd);
        }
      };
      const materialize = (revision: string) => {
        const anchor = realpathSync(
          mkdtempSync(join(fixture.root, `openclaw-pr-anchor-v3.${process.pid}.`)),
        );
        const archive = join(fixture.root, "shared-source.tar");
        fixture.git(fixture.canonical, [
          "archive",
          "--format=tar",
          `--output=${archive}`,
          revision,
        ]);
        const extraction = runCommand("tar", ["-xf", archive, "-C", anchor], fixture.env);
        expect(extraction.status, extraction.stderr).toBe(0);
        rmSync(archive);
        const owner = join(anchor, "scripts/pr-lib/materialize-dependencies.mjs");
        expect(readScript(owner)).toBe(
          fixture.git(fixture.canonical, [
            "show",
            `${revision}:scripts/pr-lib/materialize-dependencies.mjs`,
          ]).stdout,
        );
        const bootstrap = readScript(join(anchor, "scripts/pr"))
          .split("<<'EOF_TOOLING'\n")[1]!
          .split("\nEOF_TOOLING")[0]!;
        const result = createdRun(
          anchor,
          [
            "--input-type=module",
            "-",
            owner,
            fixture.canonical,
            join(anchor, "node_modules"),
            revision,
            join(anchor, "scripts/pr-lib/cache-lifetime.mjs"),
          ],
          bootstrap,
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stderr).toContain("Using frozen scripts/pr dependency installation:");
        return anchor;
      };
      const firstRevision = fixture.gitText(["rev-parse", "HEAD"]);
      const first = materialize(firstRevision);
      const cache = join(fixture.env.HOME!, ".cache/openclaw/pr-dependencies/v3");
      const entries = prCacheEntries(cache);
      expect(entries).toHaveLength(1);
      const installation = realpathSync(join(cache, entries[0]!));
      fixture.write(sourceOnly, "second source revision\n");
      fixture.commit([sourceOnly], true);
      fixture.git(fixture.canonical, ["fetch", "origin", "main"]);
      const secondRevision = fixture.gitText(["rev-parse", "HEAD"]);
      expect(secondRevision).not.toBe(firstRevision);
      expect(fixture.gitText(["rev-parse", `${secondRevision}^{tree}`])).not.toBe(
        fixture.gitText(["rev-parse", `${firstRevision}^{tree}`]),
      );
      for (const name of [auditPath, "package.json", "packages/markdown-core/package.json"]) {
        expect(fixture.gitText(["rev-parse", `${secondRevision}:${name}`])).toBe(
          fixture.gitText(["rev-parse", `${firstRevision}:${name}`]),
        );
      }
      const second = materialize(secondRevision);
      expect(prCacheEntries(cache)).toEqual(entries);
      expect(jsonLines(fixture.calls)).toHaveLength(1);
      expect(readScript(guard.calls)).toContain("install-child --version\n");
      const consumers = () => readPrCacheState(installation).anchors;
      expect(consumers()).toEqual([first, second].toSorted());
      const usableProjection = (anchor: string) => {
        const projected = join(anchor, "node_modules/micromark");
        expect(realpathSync(projected)).toBe(
          join(installation, "node_modules/.workspace/micromark"),
        );
        const manifest = JSON.parse(
          readScript(join(anchor, "packages/markdown-core/package.json")),
        );
        expect(JSON.parse(readScript(join(projected, "package.json"))).version).toBe(
          manifest.dependencies.micromark,
        );
        expect(consumers()).toContain(anchor);
      };
      usableProjection(first);
      usableProjection(second);
      const retire = (anchor: string) => {
        const result = createdRun(anchor, [
          join(anchor, "scripts/pr-lib/materialized-anchor.mjs"),
          "retire-created",
          anchor,
        ]);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(anchor)).toBe(false);
      };
      utimesSync(installation, new Date(0), new Date(0));
      retire(first);
      expect(consumers()).toEqual([second]);
      expect(readPrCacheState(installation).settled).toBe(false);
      // Pressure entries are already settled fixture installations. The shared
      // entry and both of its holds above came only from the real bootstrap.
      for (let index = 0; index < 5; index++) {
        createSettledPrCacheEntry(cache, String(index).repeat(64));
      }
      const sweep = () => {
        const retired = withDependencyCacheLock(cache, (lock) =>
          collectUnusedDependencyCaches(lock),
        );
        for (const entry of retired) {
          rmSync(entry, { recursive: true });
        }
      };
      sweep();
      usableProjection(second);
      expect(consumers()).toEqual([second]);
      retire(second);
      expect(consumers()).toEqual([]);
      expect(readPrCacheState(installation).settled).toBe(true);
      sweep();
      expect(existsSync(installation)).toBe(false);
      expect(jsonLines(fixture.calls)).toHaveLength(1);
    },
  );

  itPosix("guards an older selected helper before private-cache donor projection", () => {
    const fixture = makeFrozenDependencyFixture({ oldHelper: true });
    // The selected old materializer still owns package policy. A rejected
    // invoking helper must not become the parent's current lifetime authority.
    const rejected = "scripts/pr-lib/cache-lifetime.mjs";
    const marker = join(fixture.root, "rejected-parent-helper-ran");
    fixture.write(
      rejected,
      `import { writeFileSync as markRejectedParent } from "node:fs";\nmarkRejectedParent(${JSON.stringify(marker)}, "ran");\n${readScript(join(fixture.linked, rejected))}`,
      fixture.linked,
    );
    fixture.commit([rejected], false, fixture.linked);
    const donorEntry = privateToolingDonor(fixture);
    const oldOwner = join(fixture.root, "old-owner");
    mkdirSync(join(oldOwner, "packages/markdown-core"), { recursive: true });
    const oldSource = fixture.gitText([
      "show",
      "refs/remotes/origin/main:scripts/pr-lib/materialize-dependencies.mjs",
    ]);
    writeFileSync(join(oldOwner, "materialize-dependencies.mjs"), oldSource);
    cpSync("scripts/pr-lib/cache-lifetime.mjs", join(oldOwner, "cache-lifetime.mjs"));
    for (const manifest of ["package.json", "packages/markdown-core/package.json"]) {
      writeFileSync(
        join(oldOwner, manifest),
        fixture.gitText(["show", `refs/remotes/origin/main:${manifest}`]),
      );
    }
    // Reproduce the old helper's unprotected success in isolated fixture data.
    const counterfactual = runCommand(
      requireNodeTool("node"),
      [
        join(oldOwner, "materialize-dependencies.mjs"),
        join(fixture.tooling, "node_modules"),
        join(oldOwner, "node_modules"),
      ],
      fixture.env,
    );
    expect(counterfactual.status, counterfactual.stderr).toBe(0);
    expect(realpathSync(join(oldOwner, "node_modules/tsx"))).toBe(fixture.expected);
    const previousCalls = readFileSync(fixture.materializerCalls, "utf8").trim().split("\n").length;
    const result = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: fixture.tooling });
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(jsonLines(fixture.calls)).toHaveLength(1);
    const invocations = readFileSync(fixture.materializerCalls, "utf8")
      .trim()
      .split("\n")
      .slice(previousCalls)
      .map((line) => JSON.parse(line) as { source: string; destination: string; holds: number });
    expect(invocations.some((call) => call.source === join(fixture.tooling, "node_modules"))).toBe(
      false,
    );
    const projected = invocations.filter(
      (call) =>
        call.destination.endsWith("/node_modules") &&
        /\/[a-f0-9]{64}\/node_modules$/.test(call.source),
    );
    expect(projected.length).toBeGreaterThan(0);
    expect(projected.every((call) => call.holds > 0)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toEqual([]);
    expect(readPrCacheState(donorEntry).anchors).toEqual([]);
  });

  itPosix.each([false, true])(
    "reuses held private dependencies through supervised dispatch (older helper: %s)",
    (oldHelper) => {
      const fixture = makeFrozenDependencyFixture({
        oldHelper,
        dispatchBody: `
test -z "\${OPENCLAW_PR_ANCHOR_CREATOR_PID:-}\${OPENCLAW_PR_ANCHOR_FD:-}" || return
if { : <&9; } 2>/dev/null; then return 8; fi
test "\${OPENCLAW_PR_LOCK_SUPERVISOR_PID:-}" = "$PPID" || return
node --input-type=module - "$script_parent_dir/../node_modules" "$script_parent_dir/pr-lib/cache-lifetime.mjs" <<'EOF_HELD_PROJECTION'
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const { withDependencyCacheLock } = await import(pathToFileURL(process.argv[3]).href);
const modules = realpathSync(process.argv[2]);
const require = createRequire(join(modules, "projection-check.cjs"));
const yaml = require("yaml");
const packagePath = realpathSync(join(modules, "yaml"));
const entry = dirname(dirname(packagePath));
const anchor = dirname(modules);
const { DatabaseSync } = require("node:sqlite");
const matchingHolds = withDependencyCacheLock(dirname(entry), () => {
  const db = new DatabaseSync(join(dirname(entry), "lifetime.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT anchor_path FROM holds WHERE entry_key = ? AND anchor_path = ?").all(require("node:path").basename(entry), anchor); }
  finally { db.close(); }
});
console.log("supervised-projection=" + JSON.stringify({ anchor, entry, matchingHolds: matchingHolds.length, usable: yaml.parse("held: true").held }));
EOF_HELD_PROJECTION
`,
      });
      const donorEntry = privateToolingDonor(fixture);
      // A physical package is copied into the frozen installation, so dispatch
      // exercises a real held cache target rather than only external aliases.
      const yaml = join(donorEntry, "node_modules/yaml");
      const packagePath = realpathSync(yaml);
      rmSync(yaml);
      cpSync(packagePath, yaml, { recursive: true });
      const result = runWrapper(fixture, ["ci-dispatch", "123"], "linked", {
        env: { ...fixture.env, OPENCLAW_PR_TOOLING_ROOT: fixture.tooling },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const line = result.stdout
        .split("\n")
        .find((value) => value.startsWith("supervised-projection="));
      expect(line).toBeDefined();
      const receipt = JSON.parse(line!.slice("supervised-projection=".length));
      expect(receipt.usable).toBe(true);
      expect(receipt.matchingHolds).toBe(1);
      expect(receipt.entry).not.toBe(donorEntry);
      expect(jsonLines(fixture.calls)).toHaveLength(1);
      expect(existsSync(receipt.anchor)).toBe(false);
      expect(readPrCacheState(receipt.entry).anchors).toEqual([]);
      expect(readPrCacheState(receipt.entry).settled).toBe(true);
      expect(readPrCacheState(donorEntry).anchors).toEqual([]);
      expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toEqual([]);
      expect(
        fixture.gitText([
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/pr-operation-locks/123",
        ]),
      ).toBe("");
    },
  );

  itPosix(
    "normalizes symlinked temporary and cache roots through frozen fallback and retirement",
    () => {
      const fixture = makeFrozenDependencyFixture();
      const temporaryAlias = join(fixture.root, "temporary-alias");
      symlinkSync(fixture.root, temporaryAlias, "dir");
      const cacheOwner = join(fixture.root, "cache-owner");
      mkdirSync(cacheOwner, { mode: 0o700 });
      symlinkSync(cacheOwner, join(fixture.env.HOME!, ".cache"), "dir");
      for (let run = 0; run < 2; run++) {
        const result = fixture.run({
          OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
          TMPDIR: temporaryAlias,
        });
        expect(result.status, result.stdout + result.stderr).toBe(2);
        expect(result.stderr).toContain("running wrapper code materialized from");
        expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toEqual([]);
      }
      expect(jsonLines(fixture.calls)).toHaveLength(1);
      const cache = join(cacheOwner, "openclaw/pr-dependencies/v3");
      const entries = prCacheEntries(cache);
      expect(entries).toHaveLength(1);
      expect(readPrCacheState(join(cache, entries[0]!)).anchors).toEqual([]);
      expect(readPrCacheState(join(cache, entries[0]!)).settled).toBe(true);
    },
  );

  itPosix("publishes one complete dependency installation when creators overlap", async () => {
    const fixture = makeFrozenDependencyFixture({ oldHelper: true });
    const start = (name: string) => {
      const gate = join(fixture.root, `install-gate-${name}`);
      expect(runCommand("mkfifo", [gate], fixture.env).status).toBe(0);
      const child = spawn(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
        cwd: fixture.linked,
        env: {
          ...fixture.env,
          OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
          PR_TEST_INSTALL_GATE: gate,
        },
        stdio: "pipe",
      });
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const ready = new Promise<void>((accept, reject) => {
        child.stdout.on("data", (data) => {
          if (String(data).includes("frozen install ready")) {
            accept();
          }
        });
        child.on("exit", (code) => reject(new Error(`Installer exited ${code}: ${stderr}`)));
      });
      return { child, gate, ready, result: once(child, "exit"), errors: () => stderr };
    };
    const creators = [start("first"), start("second")];
    try {
      await Promise.all(creators.map((creator) => creator.ready));
      await Promise.all(creators.map((creator) => writeFile(creator.gate, "x")));
      for (const creator of creators) {
        const code = (await creator.result)[0];
        expect(code, creator.errors()).toBe(2);
        expect(creator.errors()).toContain("running wrapper code materialized from");
      }
      const cache = join(fixture.env.HOME!, ".cache/openclaw/pr-dependencies/v3");
      expect(prCacheEntries(cache)).toHaveLength(1);
      expect(readdirSync(cache).toSorted()).toEqual(
        ["lifetime.sqlite", ...prCacheEntries(cache)].toSorted(),
      );
      expect(jsonLines(fixture.calls)).toHaveLength(2);
      expect(realpathSync(join(cache, prCacheEntries(cache)[0]!, "node_modules/tsx"))).toBe(
        fixture.expected,
      );
      expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toEqual([]);
      expect(readPrCacheState(join(cache, prCacheEntries(cache)[0]!)).anchors).toEqual([]);
      expect(readPrCacheState(join(cache, prCacheEntries(cache)[0]!)).settled).toBe(true);
      // A later real consumer also reuses the published entry without an install,
      // holds its projection, then retires its own anchor canonically.
      const previousCalls = existsSync(fixture.materializerCalls)
        ? jsonLines(fixture.materializerCalls).length
        : 0;
      const consumer = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: fixture.tooling });
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(2);
      expect(consumer.stderr).toContain("running wrapper code materialized from");
      expect(jsonLines(fixture.calls)).toHaveLength(2);
      expect(prCacheEntries(cache)).toHaveLength(1);
      expect(readdirSync(cache).toSorted()).toEqual(
        ["lifetime.sqlite", ...prCacheEntries(cache)].toSorted(),
      );
      const projections = jsonLines(fixture.materializerCalls)
        .slice(previousCalls)
        .filter(
          (call: { source: string; destination: string }) =>
            call.destination.endsWith("/node_modules") &&
            /\/[a-f0-9]{64}\/node_modules$/.test(call.source),
        );
      expect(projections.length).toBeGreaterThan(0);
      for (const call of projections) {
        expect(call.holds).toBeGreaterThan(0);
        const anchor = join(call.destination, "..");
        expect(existsSync(anchor)).toBe(false);
        expect(readPrCacheState(join(cache, prCacheEntries(cache)[0]!)).anchors).not.toContain(
          anchor,
        );
      }
    } finally {
      for (const creator of creators) {
        if (creator.child.exitCode === null) {
          creator.child.kill();
        }
      }
    }
  });

  itPosix.each(["changed manifest", "extra hook"])(
    "refuses unverified frozen install source (%s) before package hooks",
    (fault) => {
      const fixture = makeFrozenDependencyFixture();
      writeExecutable(
        join(fixture.bin, "tar"),
        `#!/bin/sh
"$PR_TEST_REAL_TAR" "$@" || exit
case "$4" in
  */install-*) ${fault === "changed manifest" ? "printf 'changed manifest' > \"$4/package.json\"" : 'touch "$4/.pnpmfile.cjs"'} ;;
esac
`,
      );
      const result = fixture.run({
        OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
        PR_TEST_REAL_TAR: resolveCommand("tar"),
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(
        fault === "changed manifest"
          ? "Frozen install source differs: package.json"
          : "Unexpected frozen install source: .pnpmfile.cjs",
      );
      expect(existsSync(fixture.calls)).toBe(false);
    },
  );

  itPosix.each(["sparse", "unrelated", "subdirectory"])(
    "refuses an unsafe %s tooling root without installation",
    (condition) => {
      const fixture = makeToolingRootFixture();
      let root = fixture.tooling;
      rmSync(join(fixture.tooling, "node_modules/tsx"));
      symlinkSync(fixture.stale, join(fixture.tooling, "node_modules/tsx"), "dir");
      if (condition === "sparse") {
        fixture.git(root, ["config", "core.sparseCheckout", "true"]);
      }
      if (condition === "unrelated") {
        fixture.git(root, ["remote", "set-url", "origin", "https://github.com/other/repo.git"]);
      }
      if (condition === "subdirectory") {
        root = join(root, "scripts");
      }
      const installed = join(fixture.root, "installed");
      fixture.write("pnpm", `#!/bin/sh\ntouch '${installed}'\nexit 1\n`, fixture.bin);
      const result = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: root });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(root);
      expect(result.stderr).toContain("full Git work tree of this repository");
      expect(existsSync(installed)).toBe(false);
      expect(result.stderr).not.toContain("running wrapper code materialized from");
    },
  );

  itPosix("does not install dependencies when the materialization destination is invalid", () => {
    const fixture = makeToolingRootFixture();
    writeExecutable(
      join(fixture.bin, "node"),
      `#!/bin/sh
if [ "$1" = --input-type=module ] && [ "$2" = - ] && [ "\${5##*/}" = node_modules ]; then
  printf 'not a directory\\n' > "$5"
fi
exec "$OPENCLAW_TEST_NODE" "$@"
`,
    );
    const installed = join(fixture.root, "installed");
    fixture.write("pnpm", `#!/bin/sh\ntouch '${installed}'\nexit 1\n`, fixture.bin);
    const result = fixture.run({
      OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
      OPENCLAW_TEST_NODE: requireNodeTool("node"),
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Dependency materialization failed");
    expect(result.stderr).toMatch(
      /Dependency materialization failed in [^\r\n]+\/node_modules: PR dependency projection is not an owned physical directory/u,
    );
    expect(existsSync(installed)).toBe(false);
  });

  it("materializes the origin/main anchor wrapper when canonical is parked elsewhere", () => {
    const names = [
      "space name",
      ...(process.platform === "win32"
        ? []
        : ["tab\tname", 'quote"name', "backslash\\name", "control\u0001name", "newline\nname"]),
    ];
    const directory = "scripts/pr-lib/path-spelling";
    const fixture = makeMismatchedWrapperRepo({
      toolingOnly: true,
      dispatchBody: `node -e '
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { strictEqual } = require("node:assert");
for (const name of ${JSON.stringify(names)}) {
  strictEqual(readFileSync(join(process.argv[1], "pr-lib/path-spelling", name), "utf8"), "anchored path bytes\\n");
}
console.log("anchored paths verified");
' "$script_parent_dir" || return;
echo "canonical wrapper executed";`,
    });
    mkdirSync(join(fixture.canonical, directory));
    for (const name of names) {
      writeFileSync(join(fixture.canonical, directory, name), "anchored path bytes\n");
    }
    fixture.commit(["--", directory], true);
    parkCanonicalOffAnchor(fixture);
    const result = runWrapper(fixture, ["ci-dispatch", "123"]);
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    // The anchor (pushed main) marker proves materialized anchor code ran,
    // not the linked worktree's wrapper and not the parked canonical one.
    expect(result.stdout).toContain("canonical wrapper executed");
    expect(result.stdout).toContain("anchored paths verified");
    expect(result.stdout).not.toContain("local wrapper executed");
    expect(result.stdout).not.toContain("parked canonical executed");
    expect(result.stderr).toContain(
      "running wrapper code materialized from the refs/remotes/origin/main trust anchor",
    );
    expect(result.stderr).not.toContain("Refusing to silently substitute");
    const anchors = matchingEntries(fixture.root, "openclaw-pr-anchor-v3.");
    expect(anchors).toHaveLength(0);
  });

  itPosix.for([
    { outcome: "failure", args: ["ci-dispatch", "123"], exitCode: 17, interrupt: false },
    { outcome: "SIGTERM", args: ["ci-dispatch", "123"], exitCode: 143, interrupt: true },
    { outcome: "unsupervised usage", args: ["unknown-command"], exitCode: 2, interrupt: false },
  ])(
    "retires the materialized anchor after $outcome",
    async ({ args, exitCode, interrupt }, { signal }) => {
      const fixture = makeMismatchedWrapperRepo({
        toolingOnly: true,
        dispatchBody: `mark_pr_operation_side_effects_started || return;
node -e '
const { renameSync, writeFileSync } = require("node:fs");
if (process.env.PR_TEST_INTERRUPT === "1") process.stdin.resume();
writeFileSync(process.env.PR_TEST_STARTED + ".pending", "operation started\\n");
renameSync(process.env.PR_TEST_STARTED + ".pending", process.env.PR_TEST_STARTED);
console.log("operation started");
if (process.env.PR_TEST_INTERRUPT !== "1") process.exit(Number(process.env.PR_TEST_EXIT));
';`,
      });
      parkCanonicalOffAnchor(fixture);
      const started = join(fixture.root, "operation-started");
      const env = {
        ...fixture.env,
        PR_TEST_STARTED: started,
        PR_TEST_EXIT: String(exitCode),
        PR_TEST_INTERRUPT: interrupt ? "1" : "0",
      };
      let result;
      if (interrupt) {
        const ready = createDeferred();
        const child = spawn(join(fixture.linked, "scripts/pr"), args, {
          cwd: fixture.linked,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const completed = once(child, "close");
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (data) => {
          stdout += data;
          if (existsSync(started)) {
            ready.resolve();
          }
        });
        child.stderr.setEncoding("utf8").on("data", (data) => {
          stderr += data;
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(ready.promise, completed, "operation did not start"),
            signal,
          );
          expect(readScript(started)).toBe("operation started\n");
          expect(child.kill("SIGTERM")).toBe(true);
          const [status, childSignal] = await withinTest(completed, signal);
          expect(childSignal).toBeNull();
          result = { status, stdout, stderr };
        } finally {
          child.stdin.end();
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            await completed;
          }
        }
      } else {
        result = runWrapper(fixture, args, "linked", { env });
      }
      expect(result.status, result.stdout + result.stderr).toBe(exitCode);
      expect(result.stderr).toContain("running wrapper code materialized from");
      if (args[0] === "ci-dispatch") {
        expect(readScript(started)).toBe("operation started\n");
      }
      expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toEqual([]);
    },
  );

  itPosix("retires the materialized anchor when its wrapper exec fails", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    parkCanonicalOffAnchor(fixture);
    writeExecutable(
      join(fixture.bin, "tar"),
      '#!/bin/sh\n"$PR_TEST_REAL_TAR" "$@" || exit\nchmod -x "$4/scripts/pr"\n',
    );
    const result = runWrapper(fixture, ["unknown-command"], "linked", {
      env: { ...fixture.env, PR_TEST_REAL_TAR: resolveCommand("tar") },
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toEqual([]);
    expect(result.stderr).toContain("Unable to execute the materialized scripts/pr wrapper.");
  });

  itPosix("materializes the anchor when tar stops before the producer's trailing padding", () => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    parkCanonicalOffAnchor(fixture);
    const git = join(fixture.bin, "git");
    writeFileSync(
      git,
      `#!/bin/sh
"$OPENCLAW_TEST_GIT" "$@" || exit
if [ "$3" = archive ]; then
  # Valid zero padding exceeds a pipe buffer even when tar has read every entry.
  dd if=/dev/zero bs=65536 count=32 2>/dev/null
fi
`,
    );
    chmodSync(git, 0o755);
    const result = runWrapper(fixture, ["unknown-command"], "linked", {
      env: { ...fixture.env, OPENCLAW_TEST_GIT: resolveCommand("git") },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).not.toContain("Refusing to silently substitute");
  });

  itPosix.each([
    "producer failure",
    "reader failure",
    "listing producer failure",
    "hash producer failure",
    "incomplete hash output",
    "unterminated listing",
    "omitted required inventory component",
    "leaf symlink",
    "parent symlink",
    "tampered",
    "missing",
  ])("refuses anchor extraction on %s", (failure) => {
    const sourceFault = failure === "tampered" || failure === "missing";
    const fixture = makeMismatchedWrapperRepo(
      sourceFault ? { realModules: true } : { toolingOnly: true },
    );
    if (sourceFault) {
      advanceAnchorReviewDependency(fixture);
    }
    parkCanonicalOffAnchor(fixture);
    const fault = archiveFaultFixture(fixture, failure, "selected");
    const result = runWrapper(fixture, ["unknown-command"], "linked", { env: fault.env });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("Refusing to silently substitute");
    expect(result.stderr).not.toContain("running wrapper code materialized from");
    if (!sourceFault) {
      expect(
        result.stderr
          .split("\n")
          .find((line) => line.startsWith("differing wrapper components vs origin/main:")),
      ).toBe("differing wrapper components vs origin/main: scripts/pr-lib");
      expect(existsSync(fault.readerLog)).toBe(failure !== "producer failure");
    }
    expect(matchingEntries(fixture.root, "openclaw-pr-anchor-v3.")).toEqual([]);
  });

  itPosix.each([
    "producer failure",
    "reader failure",
    "hash producer failure",
    "tampered",
    "leaf symlink",
  ])("retains the owned anchor without executing helpers after bootstrap %s", (failure) => {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    parkCanonicalOffAnchor(fixture);
    const callerExecuted = join(fixture.root, "caller-helper-executed");
    writeFileSync(
      join(fixture.linked, "scripts/pr-lib/materialized-anchor.mjs"),
      `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(callerExecuted)}, "untrusted caller helper executed");
throw new Error("untrusted caller helper executed");
`,
    );
    fixture.commit(["scripts/pr-lib/materialized-anchor.mjs"], false, fixture.linked);
    const fault = archiveFaultFixture(fixture, failure, "bootstrap");
    const result = runWrapper(fixture, ["unknown-command"], "linked", { env: fault.env });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(
      failure === "producer failure" || failure === "reader failure"
        ? "Bootstrap closure unavailable; retaining"
        : "Bootstrap helper qualification failed; retaining",
    );
    expect(result.stderr).toContain(
      "Warning: retaining PR anchor before bootstrap helper qualification:",
    );
    expect(result.stderr).not.toContain("running wrapper code materialized from");
    expect(existsSync(callerExecuted)).toBe(false);
    expect(existsSync(fault.readerLog)).toBe(false);
    const archives = jsonLines(fault.archives);
    expect(archives).toEqual([
      {
        phase: "bootstrap",
        components: [
          "scripts/pr",
          "scripts/pr-lib/wrapper-components.txt",
          "scripts/pr-lib/cache-lifetime.mjs",
          "scripts/pr-lib/materialized-anchor.mjs",
          "scripts/pr-lib/git-invocation.mjs",
          "scripts/pr-lib/materialize-dependencies.mjs",
          "scripts/pr-lib/dependency-inputs.json",
          "scripts/windows-cmd-helpers.mjs",
        ],
      },
    ]);
    const anchors = matchingEntries(fixture.root, "openclaw-pr-anchor-v3.");
    expect(anchors).toHaveLength(1);
    const anchor = join(fixture.root, anchors[0]!);
    expect(lstatSync(anchor).isDirectory()).toBe(true);
    expect(statSync(anchor).uid).toBe(statSync(fixture.root).uid);
    expect(statSync(anchor).mode & 0o777).toBe(0o700);
    expect(existsSync(join(anchor, ".pr-bootstrap/scripts/pr-lib/cache-lifetime.mjs"))).toBe(
      failure !== "producer failure",
    );
  });

  itPosix("executes extracted helpers through a symlinked temporary root", () => {
    const fixture = makeMismatchedWrapperRepo({ realModules: true });
    // Exercise the wrapper's own helper path, not a physical path reconstructed by the test.
    fixture.write(
      "scripts/pr-lib/gates.sh",
      `ci_dispatch() { node "$(review_artifacts_helper_path)" template "$1" "${REVIEWED_HEAD}"; }\n`,
    );
    fixture.commit(["scripts/pr-lib/gates.sh"], true);
    parkCanonicalOffAnchor(fixture);
    const temporaryAlias = join(fixture.root, "temporary-alias");
    symlinkSync(fixture.root, temporaryAlias, "dir");
    const result = runWrapper(fixture, ["ci-dispatch", String(REVIEWED_PR)], "linked", {
      env: { ...fixture.env, TMPDIR: temporaryAlias },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(result.stdout, "the extracted helper must not silently skip its entrypoint").toContain(
      REVIEWED_HEAD,
    );
    expect(JSON.parse(result.stdout).pr).toEqual({ number: REVIEWED_PR, headSha: REVIEWED_HEAD });
  });

  itPosix(
    "executes review artifacts from the extracted anchor dependency closure with canonical dirty added dependency",
    () => {
      const fixture = makeMismatchedWrapperRepo({ realModules: true });
      advanceAnchorReviewDependency(fixture);
      fixture.write(
        "scripts/lib/anchor-review-record.mjs",
        "throw new Error('unreviewed dependency');\n",
      );
      const { anchor } = materializeAnchor(fixture);
      fixture.write("gh", "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n", fixture.bin);
      writeReviewArtifacts(fixture.linked, validReview());
      const result = runCommand(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            'script_parent_dir="$1/scripts"',
            'source "$script_parent_dir/pr-lib/review.sh"',
            'node "$(review_artifacts_helper_path)" template "$2" "$3"',
            'node "$(review_artifacts_helper_path)" validate .local/review.json .local/pr-meta.json',
          ].join("\n"),
          "anchor-review",
          anchor,
          String(REVIEWED_PR),
          REVIEWED_HEAD,
        ],
        fixture.env,
        fixture.linked,
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).pr).toEqual({
        number: REVIEWED_PR,
        headSha: REVIEWED_HEAD,
      });
    },
  );

  itPosix(
    "keeps extracted dependency pins and executes the planner's source-scanning child",
    () => {
      const fixture = makeMismatchedWrapperRepo({ realModules: true });
      parkCanonicalOffAnchor(fixture);
      const { anchor } = materializeAnchor(fixture);
      fixture.write("gh", "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n", fixture.bin);
      const nodeExecPath = requireNodeTool("node");
      const run = (args: string[]) => runCommand(nodeExecPath, args, fixture.env, anchor);
      // A later install may remove or redirect the canonical package aliases.
      // The materialized owner must keep its original installed dependency.
      const canonicalYaml = join(fixture.canonical, "node_modules/yaml");
      rmSync(canonicalYaml);
      const replacementYaml = join(fixture.root, "replacement-yaml");
      mkdirSync(replacementYaml);
      writeFileSync(join(replacementYaml, "package.json"), '{"main":"index.js"}');
      writeFileSync(
        join(replacementYaml, "index.js"),
        'throw new Error("replacement yaml executed");\n',
      );
      for (const state of ["removed", "redirected"]) {
        if (state === "redirected") {
          symlinkSync(replacementYaml, canonicalYaml, "dir");
        }
        const verified = run(["scripts/verify-pr-hosted-gates.mjs"]);
        expect.soft(verified.status, `${state}\n${verified.stderr}`).toBe(1);
        expect
          .soft(verified.stderr, state)
          .toContain("Usage: node scripts/verify-pr-hosted-gates.mjs");
      }

      // The trusted planner reads candidate sources without executing them. A
      // non-sibling importer exercises its real source-scanning child as well.
      mkdirSync(join(fixture.linked, "src"), { recursive: true });
      mkdirSync(join(fixture.linked, "test/probe"), { recursive: true });
      fixture.write("src/anchor-value.ts", "export const value = 1;\n", fixture.linked);
      fixture.write(
        "test/probe/anchor.test.ts",
        'import { value } from "../../src/anchor-value.js";\nvoid value;\n',
        fixture.linked,
      );
      fixture.commit(["src", "test/probe"], false, fixture.linked);
      const base = fixture.gitText(["rev-parse", "HEAD"], fixture.linked);
      fixture.write("src/anchor-value.ts", "export const value = 2;\n", fixture.linked);
      fixture.commit(["src/anchor-value.ts"], false, fixture.linked);
      const head = fixture.gitText(["rev-parse", "HEAD"], fixture.linked);
      const planned = runCommand(
        nodeExecPath,
        [join(anchor, "scripts/pr-lib/crabbox-gate-plan.mts"), "--base", base, "--head", head],
        fixture.env,
        fixture.linked,
      );
      expect(planned.status, planned.stderr).toBe(0);
      expect(JSON.parse(planned.stdout)).toMatchObject({
        baseSha: base,
        headSha: head,
        changedPaths: [{ path: "src/anchor-value.ts", status: "M" }],
        targets: ["test/probe/anchor.test.ts"],
      });
    },
  );

  it("loads hosted-gate verification from the anchor without caller-owned aliases", () => {
    const fixture = makeMismatchedWrapperRepo({
      dispatchBody: 'node "$script_parent_dir/verify-pr-hosted-gates.mjs" --anchor-proof;',
    });
    fixture.write(
      "caller-dependency.mts",
      'export const minimatch = null;\nthrow new Error("caller workspace dependency executed");\n',
      fixture.linked,
    );
    fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          paths: {
            minimatch: ["./caller-dependency.mts"],
            "@openclaw/normalization-core/record-coerce": [
              "./packages/normalization-core/src/record-coerce.ts",
            ],
          },
        },
      }),
      fixture.linked,
    );
    fixture.commit(["caller-dependency.mts", "tsconfig.json"], false, fixture.linked);
    const recordPath = "packages/normalization-core/src/record-coerce.ts";
    fixture.write(
      recordPath,
      `throw new Error("caller workspace normalization executed");\n${readScript(recordPath)}`,
      fixture.linked,
    );
    fixture.commit([recordPath], false, fixture.linked);
    parkCanonicalOffAnchor(fixture);
    const result = runWrapper(fixture, ["ci-dispatch", "123"], "linked", {
      env: { ...fixture.env, TMPDIR: fixture.root },
    });
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(result.stdout + result.stderr).toContain("Unknown option: --anchor-proof");
    expect(result.stdout + result.stderr).not.toContain("Cannot find module");
  });

  itPosix(
    "loads matching linked helper dependencies without an install or dev-wrapper opt-in",
    () => {
      const dependencies = ["tsx", "zod", "minimatch", "yaml"];
      const fixture = makeMismatchedWrapperRepo({
        dispatchBody: `node -e '
const { realpathSync } = require("node:fs");
const { join } = require("node:path");
console.log("anchor-dependencies=" + JSON.stringify(${JSON.stringify(dependencies)}.map((name) => realpathSync(join(process.argv[1], "..", "node_modules", name)))));
' "$script_parent_dir" || return;
node "$script_parent_dir/verify-pr-hosted-gates.mjs" --anchor-proof;`,
      });
      fixture.git(fixture.linked, ["reset", "--hard", "refs/remotes/origin/main"]);
      parkCanonicalOffAnchor(fixture);
      const linkedModules = join(fixture.linked, "node_modules");
      expect(existsSync(linkedModules)).toBe(false);
      const targets = dependencies.map((name) =>
        realpathSync(join(fixture.canonical, "node_modules", name)),
      );
      const ghCalled = join(fixture.root, "gh-called");
      fixture.write("gh", `#!/bin/sh\ntouch "${ghCalled}"\nexit 99\n`, fixture.bin);
      const result = runWrapper(fixture, ["ci-dispatch", "123"], "linked");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Unknown option: --anchor-proof");
      expect(existsSync(ghCalled)).toBe(false);
      expect(existsSync(linkedModules)).toBe(false);
      expect(result.stderr).not.toContain("dev-wrapper opt-in");
      const anchors = matchingEntries(fixture.root, "openclaw-pr-anchor-v3.");
      expect(anchors).toHaveLength(0);
      const dependencyProof = result.stdout
        .split("\n")
        .find((line) => line.startsWith("anchor-dependencies="));
      expect(dependencyProof).toBeDefined();
      expect(JSON.parse(dependencyProof!.slice("anchor-dependencies=".length))).toEqual(targets);
      expect(targets.every((target) => existsSync(target))).toBe(true);
      expect(result.stderr).toContain("matches origin/main but has no node_modules directory");
      expect(result.stderr).toContain("running wrapper code materialized from");
    },
  );

  it.each(["handoff", "inventory"])(
    "keeps the refusal when the anchor lacks its %s",
    (contract) => {
      const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
      fixture.git(fixture.canonical, ["checkout", "main"]);
      if (contract === "handoff") {
        const legacy = readScript(join(fixture.canonical, "scripts/pr")).replaceAll(
          "OPENCLAW_PR_ANCHOR_REPO_ROOT",
          "OPENCLAW_PR_LEGACY_UNSUPPORTED",
        );
        fixture.write("scripts/pr", legacy);
      } else {
        rmSync(join(fixture.canonical, "scripts/pr-lib/wrapper-components.txt"));
      }
      fixture.commit(["-u", "scripts/pr", "scripts/pr-lib"], true);
      fixture.git(fixture.linked, ["fetch", "origin", "main"]);
      parkCanonicalOffAnchor(fixture);
      const result = runWrapper(fixture, ["ci-dispatch", "123"], "linked");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Refusing to silently substitute");
      expect(result.stdout).not.toContain("canonical wrapper executed");
      expect(result.stdout).not.toContain("local wrapper executed");
    },
  );

  describe("alias wrapper trust delegation", () => {
    function makeAliasFixture() {
      const fixture = makeMismatchedWrapperRepo({ realModules: true, toolingOnly: true });
      fixture.git(fixture.linked, ["checkout", "--detach", "refs/remotes/origin/main"]);
      // Keep the Node recorder at the supervisor handoff, after dependency preparation.
      linkPrWrapperDependencies(fixture.linked);
      for (const alias of ["pr-prepare", "pr-review", "pr-merge"]) {
        cpSync(join("scripts", alias), join(fixture.linked, "scripts", alias));
      }
      fixture.git(fixture.canonical, ["checkout", "-b", "parked"]);
      fixture.write("scripts/pr", '#!/bin/sh\necho "stale canonical wrapper executed"\nexit 91\n');
      fixture.commit(["scripts/pr"]);
      const recorder = join(fixture.bin, "node");
      writeFileSync(
        recorder,
        '#!/bin/sh\nif [ "$1" = "$PR_TEST_SUPERVISOR" ]; then\n  printf \'%s\\0\' "$PWD" "$@"\n  exit 73\nfi\nexec "$PR_TEST_REAL_NODE" "$@"\n',
      );
      chmodSync(recorder, 0o755);
      const caller = join(fixture.root, "caller directory");
      mkdirSync(caller);
      return {
        ...fixture,
        caller,
        env: {
          ...fixture.env,
          PR_TEST_REAL_NODE: requireNodeTool("node"),
          PR_TEST_SUPERVISOR: join(fixture.linked, "scripts/pr-lib/process-group-runner.mjs"),
        },
      };
    }

    itPosix.each([
      ["pr-prepare", ["run", "123"], ["prepare-run", "123"]],
      [
        "pr-review",
        ["123", "argument with spaces", ""],
        ["review-init", "123", "argument with spaces", ""],
      ],
      ["pr-merge", ["run", "123"], ["merge-run", "123"]],
    ] as const)("%s delegates %j through the trusted sibling", (alias, args, mapped) => {
      const fixture = makeAliasFixture();
      const result = runCommand(
        join(fixture.linked, "scripts", alias),
        args,
        fixture.env,
        fixture.caller,
      );
      expect(result.status, result.stderr).toBe(73);
      expect(result.stderr).toBe("");
      expect(result.stdout.split("\0")).toEqual([
        fixture.caller,
        join(fixture.linked, "scripts/pr-lib/process-group-runner.mjs"),
        fixture.canonical,
        join(fixture.linked, "scripts/pr"),
        ...mapped,
        "",
      ]);
    });

    itPosix.each([
      ["pr-prepare", ["run", "123"]],
      ["pr-review", ["123"]],
      ["pr-merge", ["run", "123"]],
    ] as const)(
      "%s preserves refusal with a spoofed anchor and developer opt-in",
      (alias, args) => {
        const fixture = makeAliasFixture();
        fixture.git(fixture.linked, ["branch", "origin/main", "refs/remotes/origin/main"]);
        fixture.git(fixture.linked, ["update-ref", "-d", "refs/remotes/origin/main"]);
        const result = runCommand(
          join(fixture.linked, "scripts", alias),
          args,
          { ...fixture.env, OPENCLAW_PR_DEV_WRAPPER: "1" },
          fixture.caller,
        );
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Refusing to silently substitute");
        expect(result.stderr).toContain("classified landing; dev-wrapper opt-in is unavailable");
        expect(result.stdout).toBe("");
      },
    );
  });

  it("refuses to substitute a different canonical wrapper implementation", () => {
    const { repo, linked, git, run } = unanchoredWrapperFixture("openclaw-pr-wrapper-revision-");
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    for (const component of ["scripts/pr-lib/merge.sh", "scripts/lib/local-check-runtime.mts"]) {
      writeFileSync(join(linked, component), "# dirty linked\n");
      const dirtyResult = run();
      expect(dirtyResult.status, component).toBe(1);
      expect(dirtyResult.stderr, component).toContain(
        "scripts/pr wrapper files have uncommitted changes",
      );
      expect(git(linked, ["restore", component]).status).toBe(0);
    }

    // A dirty canonical checkout no longer blocks a linked worktree whose
    // committed wrapper matches the origin/main trust anchor; without that
    // anchor it must still refuse.
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# dirty canonical\n");
    const dirtyResult = run();
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(git(repo, ["restore", "scripts/pr-lib/merge.sh"]).status).toBe(0);

    writeFileSync(join(linked, "scripts", "lib", "local-check-runtime.mts"), "// linked\n");
    expect(git(linked, ["add", "scripts/lib/local-check-runtime.mts"]).status).toBe(0);
    expect(git(linked, ["commit", "-m", "test: linked wrapper"]).status).toBe(0);

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(result.stderr).toContain("scripts/lib/local-check-runtime.mts");
  });

  it("runs the local wrapper when it matches origin/main and the canonical checkout is parked elsewhere", () => {
    const { repo, linked, git, run } = unanchoredWrapperFixture("openclaw-pr-wrapper-anchor-");
    // The linked worktree keeps main's wrapper; origin/main anchors trust.
    expect(git(repo, ["update-ref", "refs/remotes/origin/main", "main"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    // Park the canonical checkout on a release-style branch with a different
    // wrapper revision, the exact contention that used to block landings.
    expect(git(repo, ["switch", "-c", "release/test-train"]).status).toBe(0);
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# release drift\n");
    expect(git(repo, ["add", "scripts/pr-lib/merge.sh"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: release drift"]).status).toBe(0);

    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain("Refusing to silently substitute");
    expect(result.stderr).not.toContain("scripts/pr implementation differs");
    expect(result.stderr).not.toContain("differing wrapper components vs origin/main");
    expect(result.stderr).not.toContain("uncommitted changes");

    // A local branch literally named "origin/main" must not spoof the trust
    // anchor: only the remote-tracking ref counts.
    expect(git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]).status).toBe(0);
    expect(git(repo, ["update-ref", "refs/heads/origin/main", "main"]).status).toBe(0);
    const spoofed = run();

    expect(spoofed.status).toBe(1);
    expect(spoofed.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
  });

  const writer = { login: "fixture-user" };
  type AuthCase = {
    name: string;
    status?: number;
    code: number;
    body?: unknown;
    headers?: Record<string, string>;
    diagnostic?: string;
    details?: string[];
  };
  function authFailure(name: string, body: unknown, overrides: Partial<AuthCase> = {}): AuthCase {
    return { name, body, status: 200, code: 0, diagnostic: "failed", ...overrides };
  }
  const preflightCases = [
    authFailure(
      "invalid quota metadata",
      { message: "API rate limit exceeded for synthetic-private-detail" },
      {
        code: 1,
        diagnostic: "rate limited",
        headers: {
          "X-RateLimit-Resource": "synthetic-private-detail",
          "X-RateLimit-Remaining": "no",
          "X-RateLimit-Limit": "5000synthetic-private-detail",
          "X-RateLimit-Reset": "999999999999999",
          "Retry-After": "synthetic-private-detail",
        },
        details: ["resource=unknown; remaining=unknown; limit=unknown; reset=unknown"],
      },
    ),
    authFailure(
      "rejected authentication",
      { message: "Bad credentials synthetic-private-detail" },
      { status: 401, code: 1, diagnostic: "authentication unavailable" },
    ),
    authFailure("empty writer", { login: "  " }),
    authFailure("wrong writer type", { login: 42 }),
    authFailure("partial writer with errors", { ...writer, errors: [{ type: "FORBIDDEN" }] }),
    authFailure("writer with failed process", writer, { code: 1 }),
    authFailure("missing HTTP framing", writer, { status: undefined }),
  ];
  it.each<AuthCase & { route: string; hostname: string }>([
    ...preflightCases.map((scenario) =>
      Object.assign({ route: "default", hostname: "" }, scenario),
    ),
    {
      name: "writer on the explicitly selected host",
      status: 200,
      code: 0,
      body: writer,
      route: "override",
      hostname: "github.fixture.invalid",
    },
  ])("GitHub API preflight: $name ($route)", ({ route, hostname, ...scenario }) => {
    const quotaIntercepted =
      scenario.code !== 0 &&
      ([403, 429].includes(scenario.status ?? 0) || scenario.diagnostic === "rate limited");
    const dir = tempDirs.make("openclaw-pr-auth-");
    // Both extensionless executables use CommonJS, even below a repo-local TMPDIR.
    writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
    const env = isolatedWrapperEnv(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const pathGh = join(bin, "gh");
    const gh = route === "default" ? pathGh : join(dir, "selected-gh");
    const calls = join(dir, "calls.jsonl");
    const headers =
      scenario.status === undefined
        ? ""
        : `HTTP/2.0 ${scenario.status} Synthetic\nContent-Type: application/json\r\n` +
          Object.entries(scenario.headers ?? {})
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("") +
          "X-Request-Id: synthetic-private-detail\r\n\r\n";
    const body = scenario.body === undefined ? "" : JSON.stringify(scenario.body);
    const fakeGh = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args.includes("--include")) process.stdout.write(${JSON.stringify(headers)});
process.stdout.write(${JSON.stringify(body)});
console.error("gh: synthetic-private-detail");
process.exit(${scenario.code});
`;
    writeExecutable(
      pathGh,
      route === "default" ? fakeGh : "#!/bin/sh\necho UNEXPECTED_ROUTE >&2\nexit 99\n",
    );
    if (route === "override") {
      writeExecutable(gh, fakeGh);
    }
    const result = runCommand(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/lib/plain-gh.sh",
          'source "$PWD/scripts/pr-lib/worktree.sh"',
          'repo_root() { printf "%s\\n" "$HOME"; }',
          "mark_pr_operation_side_effects_started() { echo UNEXPECTED_SIDE_EFFECT; return 99; }",
          scenario.diagnostic
            ? "enter_worktree 42 false || exit 1"
            : hostname
              ? `pr_gh_writer_login ${hostname}`
              : "ensure_gh_api_auth",
        ].join("\n"),
      ],
      {
        ...env,
        OPENCLAW_GH_BIN: route === "override" ? gh : "",
        GH_TOKEN: "synthetic-token",
      },
    );
    expect(result.status, result.stderr).toBe(scenario.diagnostic ? 1 : 0);
    expect(result.stdout).not.toContain("UNEXPECTED");
    expect(result.stdout + result.stderr).not.toMatch(/synthetic-private-detail|UNEXPECTED_ROUTE/);
    if (quotaIntercepted) {
      expect(result.stderr).toContain("GitHub API request failed (resource=core)");
      expect(result.stderr).toContain(`original response: HTTP ${scenario.status}`);
      expect(result.stderr).not.toContain("Supplemental quota probe");
      for (const detail of scenario.details ?? []) {
        expect(result.stderr).toContain(detail);
      }
    } else if (scenario.diagnostic) {
      expect(result.stderr).toContain(`GitHub API preflight ${scenario.diagnostic}`);
      for (const detail of scenario.details ?? []) {
        expect(result.stderr).toContain(detail);
      }
      if (scenario.diagnostic === "failed") {
        expect(result.stderr).not.toContain("preflight rate limited");
      }
      if (scenario.diagnostic === "authentication unavailable") {
        expect(result.stderr).toContain(
          "Configure or refresh the intended active credential manually",
        );
      } else {
        expect(result.stderr).not.toMatch(/login|refresh|invalid credentials/i);
      }
    } else {
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(hostname ? "fixture-user\n" : "");
    }
    expect(jsonLines(calls)).toEqual([
      ["api", ...(hostname ? ["--hostname", hostname] : []), "user", "--include"],
    ]);
  });

  it.each([
    { route: "override", host: "github.fixture.invalid", assigned: true, rateLimited: false },
    { route: "override", host: "github.fixture.invalid", assigned: false, rateLimited: false },
    { route: "default", host: "github.com", assigned: false, rateLimited: true },
  ])(
    "resolves and verifies review assignment through REST ($route, $host, assigned=$assigned, rateLimited=$rateLimited)",
    ({ route, host, assigned, rateLimited }) => {
      const dir = tempDirs.make("openclaw-pr-review-writer-");
      const bin = join(dir, "bin");
      const calls = join(dir, "calls.jsonl");
      mkdirSync(bin);
      writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
      const protectedGh = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OPENCLAW_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "browse") {
  console.log("https://${host}/fixture/repo");
} else if (args[0] === "api" && args[1] === "user") {
  if (args.includes("--include")) {
    if (${rateLimited}) {
      process.stdout.write('HTTP/2.0 403 Forbidden\\nX-RateLimit-Resource: core\\nX-RateLimit-Remaining: 0\\n\\n{"message":"API rate limit exceeded for synthetic-private-detail"}\\n');
      process.exit(1);
    }
    process.stdout.write('HTTP/2.0 200 OK\\n\\n{"login":"writer-maintainer"}\\n');
  } else {
    console.log(JSON.stringify({ login: "relay-reader" }));
  }
} else if (args[0] === "api" && args.includes("graphql") && ${rateLimited}) {
  process.stdout.write('HTTP/2.0 403 Forbidden\\nX-RateLimit-Resource: graphql\\nX-RateLimit-Remaining: 0\\n\\n');
  console.log(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for synthetic-private-detail" }] }));
  process.exit(1);
} else if (args[0] === "api" && args.includes("repos/fixture/repo/issues/42/assignees")) {
  if (args[args.indexOf("--hostname") + 1] !== "${host}" ||
      args[args.indexOf("--method") + 1] !== "POST" ||
      !args.includes("assignees[]=writer-maintainer")) process.exit(19);
  console.log(JSON.stringify({ assignees: [{ login: "${assigned ? "writer-maintainer" : "relay-reader"}" }], private: "synthetic-private-detail" }));
} else {
  process.exit(19);
}
`;
      const pathGh = join(bin, "gh");
      const overrideGh = join(dir, "selected-gh");
      writeFileSync(pathGh, route === "default" ? protectedGh : "#!/bin/sh\nexit 19\n");
      writeFileSync(overrideGh, protectedGh);
      chmodSync(pathGh, 0o755);
      chmodSync(overrideGh, 0o755);
      const result = runCommand(
        "bash",
        [
          "-c",
          [
            "source scripts/lib/plain-gh.sh",
            "source scripts/pr-lib/common.sh",
            "source scripts/pr-lib/review.sh",
            'enter_worktree() { cd "$OPENCLAW_TEST_ROOT"; mkdir -p .local; }',
            "sleep() { :; }",
            "review_claim 42",
          ].join("\n"),
        ],
        {
          HOME: dir,
          GH_REPO: `${host}/fixture/repo`,
          GH_HOST: host,
          GH_TOKEN: "synthetic-writer-token",
          OPENCLAW_GH_BIN: route === "override" ? overrideGh : "",
          OPENCLAW_TEST_CALLS: calls,
          OPENCLAW_TEST_ROOT: dir,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(assigned ? 0 : 1);
      const ghCalls = jsonLines(calls);
      expect(ghCalls[0]).toEqual(["api", "user", "--include"]);
      expect(ghCalls.filter((args: string[]) => args.includes("graphql"))).toHaveLength(
        rateLimited ? 1 : 0,
      );
      const assignmentCalls = ghCalls.filter((args: string[]) => args.includes("POST"));
      expect(assignmentCalls).toHaveLength(rateLimited ? 0 : assigned ? 1 : 3);
      expect(result.stdout + result.stderr).not.toContain("synthetic-private-detail");
      if (rateLimited) {
        expect(ghCalls).toHaveLength(2);
        expect(result.stderr).toContain("GitHub API request failed (resource=graphql)");
        expect(result.stdout).not.toContain("review claim succeeded");
      } else if (assigned) {
        expect(result.stdout).toContain("@writer-maintainer assigned to PR #42");
      } else {
        expect(result.stdout).toContain("Failed to assign @writer-maintainer to PR #42");
        expect(result.stdout).not.toContain("review claim succeeded");
      }
      if (!rateLimited) {
        expect(readScript(join(dir, ".local/review-claim-user-attempt-1.log"))).toBe(
          "writer-maintainer\n",
        );
      }
    },
  );
});
