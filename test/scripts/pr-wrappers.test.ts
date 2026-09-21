// PR wrapper tests cover maintainer helper command delegation.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  isCoreQuotaExhausted,
  isGraphqlQuotaExhausted,
} from "../../scripts/pr-lib/gh-api-preflight.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  REVIEWED_HEAD,
  REVIEWED_PR,
  validReview,
  writeReviewArtifacts,
} from "./pr-review-artifact-fixture.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const templateDirs = useAutoCleanupTempDirTracker(afterAll);
const fixtureTemplates = new Map<string, ReturnType<typeof createMismatchedWrapperTemplate>>();

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

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

  it.each(resource === "graphql" ? ["RATE_LIMIT", "RATE_LIMITED"] : ["REST primary limit"])(
    "recognizes the original %s response with and without headers",
    (type) => {
      const body = errorBody(type);
      for (const stdout of [body, response(body), Buffer.from(response(body))]) {
        expect(classify({ status: 1, stdout })).toBe(true);
      }
    },
  );
  it.each([
    { stdout: response(JSON.stringify({ message }), "", 403) },
    { stderr: `gh: ${message}\n` },
    { stderr: Buffer.from("gh: API rate limit exceeded for fixture-user (HTTP 403)\n") },
    { stderr: `GraphQL: ${message}\n` },
    { stderr: Buffer.from("GraphQL: API rate limit exceeded for user ID 123.\n") },
    { stderr: `GraphQL: ${message}, ${message}\n` },
  ])("recognizes native gh primary exhaustion: %j", (failure) => {
    expect(classify({ status: 1, ...failure })).toBe(true);
  });
  it.each([
    {
      name: "secondary throttle",
      stdout: errorBody("RATE_LIMITED", "You have exceeded a secondary rate limit."),
    },
    { name: "abuse detection", stderr: "gh: You have triggered an abuse detection mechanism." },
    { name: "retry-after", stdout: response(errorBody(), "Retry-After: 60\r\n") },
    { name: "malformed retry-after", stdout: response(errorBody(), "Retry-After: unknown\r\n") },
    {
      name: "remaining primary budget",
      stdout: response(errorBody()).replace("Remaining: 0", "Remaining: 50"),
    },
    {
      name: "other resource exhaustion",
      stdout: response(errorBody()).replace(
        `Resource: ${resource}`,
        `Resource: ${resource === "graphql" ? "core" : "graphql"}`,
      ),
    },
    ...[401, 407, 429, 500, 503].map((status) => ({
      name: `HTTP ${status}`,
      stdout: response(errorBody(), "", status),
    })),
    { name: "generic forbidden", stderr: "gh: Resource not accessible by integration (HTTP 403)" },
    { name: "plain 429", stderr: `gh: ${message} (HTTP 429)` },
    { name: "GraphQL secondary throttle", stderr: `GraphQL: ${message}, secondary rate limit` },
    { name: "GraphQL forbidden", stderr: "GraphQL: Resource not accessible by integration" },
    {
      name: "mixed rendered GraphQL errors",
      stderr: `GraphQL: ${message}, Resource not accessible by integration`,
    },
    { name: "multiline GraphQL errors", stderr: `GraphQL: ${message}\nAccess denied` },
    { name: "unrecognized CLI prefix", stderr: `proxy: ${message}` },
    {
      name: "plain proxy failure",
      stderr: 'Post "https://api.github.com/graphql": Proxy Authentication Required',
    },
    { name: "transport failure", code: "ETIMEDOUT", stderr: `gh: ${message}` },
    { name: "interrupted response", signal: "SIGTERM", stdout: errorBody() },
    { name: "killed response", killed: true, stdout: errorBody() },
    { name: "successful final unit", status: 0, stdout: response(errorBody()) },
    { name: "malformed response", stdout: "{", stderr: `gh: ${message}` },
    { name: "malformed framed response", stdout: response("{"), stderr: `gh: ${message}` },
    {
      name: "ambiguous typed error",
      stdout: JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }),
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
    {
      name: "data named after quota",
      stdout: JSON.stringify({ data: { message, type: "RATE_LIMITED" } }),
    },
    {
      name: "supplemental quota",
      message: "Supplemental quota probe: graphql 0/5000",
      stdout: JSON.stringify({ resources: { graphql: { remaining: 0 } } }),
    },
  ])("does not authorize fallback for $name", ({ name: _name, ...failure }) => {
    expect(classify({ status: 1, ...failure })).toBe(false);
  });

  if (resource === "core") {
    it("recognizes authoritative exhausted core headers without an error message", () => {
      expect(classify({ status: 1, stdout: response("{}") })).toBe(true);
    });

    it.each([
      { name: "successful HTTP response", stdout: response(errorBody(), "", 200) },
      {
        name: "search resource",
        stdout: response(errorBody()).replace("Resource: core", "Resource: search"),
      },
      { name: "unknown process result", status: null, stdout: errorBody() },
      {
        name: "access rejection with exhausted headers",
        stdout: response(JSON.stringify({ message: "Resource not accessible by integration" })),
      },
      {
        name: "GraphQL error without headers",
        stdout: JSON.stringify({ errors: [{ type: "RATE_LIMITED", message }] }),
      },
      {
        name: "multiline primary-looking body",
        stdout: JSON.stringify({ message: `${message}\nAccess denied` }),
      },
      { name: "primary-looking prefix", stderr: "gh: API rate limit exceededness" },
      {
        name: "unframed depleted balance",
        stdout: JSON.stringify({ remaining: 0, resource: "core" }),
      },
    ])("does not infer core exhaustion from $name", ({ name: _name, ...failure }) => {
      expect(classify({ status: 1, ...failure })).toBe(false);
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
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...fixtureEnv,
        // Template copies must not race detached object-store maintenance.
        GIT_CONFIG_PARAMETERS: "'maintenance.auto=false' 'gc.auto=0'",
      },
      stdio: "pipe",
    });
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
  "browse") printf 'https://github.com/fixture/repo\\n' ;;
  "api --hostname github.com repos/fixture/repo/pulls/123 -H Cache-Control: max-age=0")
    printf '%s\\n' '${JSON.stringify(pull)}' ;;
  *) echo "Unexpected gh call: $*" >&2; exit 99 ;;
esac
`;
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
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    chmodSync(commandPath, 0o755);
  }
  // Deterministic gh stub: main-only subcommands fail fast on the base-branch
  // gate instead of reaching the network, proving which wrapper actually ran.
  const ghStub = join(bin, "gh");
  writeFileSync(ghStub, baseBranchGhStub("not-main"));
  chmodSync(ghStub, 0o755);

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
      `ci_dispatch() { ${dispatchBody} }\n`,
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
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  cpSync(template.bin, bin, copyOptions);
  cpSync(template.canonical, canonical, copyOptions);
  cpSync(template.origin, origin, copyOptions);
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
  };
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

function parseSubcommandClassifications(script: string): Map<string, string> {
  const start = script.indexOf("# PR_SUBCOMMAND_CLASSIFICATIONS_BEGIN");
  const end = script.indexOf("# PR_SUBCOMMAND_CLASSIFICATIONS_END");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const table = script.slice(start, end);
  const classifications = new Map<string, string>();
  const armPattern = /^\s+([^\n)]+)\)\s*\n\s+printf '(landing|advisory)\\n'/gm;
  for (const match of table.matchAll(armPattern)) {
    const commandGroup = match[1];
    const classification = match[2];
    if (commandGroup === undefined || classification === undefined) {
      throw new Error("classification regexp returned incomplete captures");
    }
    for (const command of commandGroup.split("|").map((value) => value.trim())) {
      classifications.set(command, classification);
    }
  }
  return classifications;
}

function parseDispatchedSubcommands(script: string): string[] {
  const start = script.lastIndexOf('  case "$cmd" in');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf("\n  esac", start);
  expect(end).toBeGreaterThan(start);
  const commands: string[] = [];
  const armPattern = /^\s{4}([^\n)]+)\)/gm;
  for (const match of script.slice(start, end).matchAll(armPattern)) {
    const commandGroup = match[1];
    if (commandGroup === undefined) {
      throw new Error("dispatch regexp returned an incomplete capture");
    }
    commands.push(...commandGroup.split("|").map((value) => value.trim()));
  }
  return commands.filter((command) => command !== "*");
}

describe("scripts/pr wrappers", () => {
  it("refreshes wrapper dependencies idempotently", () => {
    const destination = tempDirs.make("openclaw-pr-wrapper-dependencies-");

    linkPrWrapperDependencies(destination);
    linkPrWrapperDependencies(destination);

    for (const dependency of ["tsx", "zod", "minimatch", "yaml"]) {
      expect(realpathSync(join(destination, "node_modules", dependency))).toBe(
        realpathSync(join("node_modules", dependency)),
      );
    }
  });

  it("loads the tooling include policy from the wrapper source inventory", () => {
    const root = tempDirs.make("openclaw-wrapper-include-policy-");
    copyPrWrapperSources(root);
    const loaded = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('./test/vitest/vitest.include-patterns.ts')"],
      { cwd: root, encoding: "utf8", env: isolatedWrapperEnv(root) },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
  });

  it("keeps the main PR helper usage and command table aligned", () => {
    const script = readScript("scripts/pr");

    expect(script).toContain("export NO_COLOR=1");
    expect(script).toContain("unset COLORTERM");
    expect(script).toContain('source "$script_parent_dir/lib/plain-gh.sh"');
    expect(script).toContain("for cmd in gh jq rg pnpm node");
    expect(script).not.toContain("gh() {");
    expect(script).toContain("scripts/pr review-init <PR>");
    expect(script).toContain("scripts/pr prepare-run <PR>");
    expect(script).toContain("scripts/pr ci-dispatch <PR>");
    expect(script).toContain("scripts/pr merge-run <PR> [--auto-merge]");
    expect(script).toContain("OPENCLAW_PR_AUTO_MERGE=1 is equivalent");
    expect(script).toContain("Required commands: git, gh, jq, rg (ripgrep), pnpm, node.");
    expect(script).toContain('review_init "$pr"');
    expect(script).toContain('prepare_run "$pr"');
    expect(script).toContain('ci_dispatch "$pr"');
    expect(script).toContain('merge_run "$merge_pr" "$auto_merge"');
    expect(script).toContain('require_main_target_pr "${1-}"');
    expect(script).toContain("only support PRs targeting main");
  });

  it("packages the dependency-free ClawSweeper review gate with the native wrapper", () => {
    const fixture = makeMismatchedWrapperRepo();
    const helper = join(fixture.canonical, "scripts/pr-lib/clawsweeper-review-gate.mjs");
    expect(readScript(helper)).not.toMatch(/from ["'](?!node:)/);
    expect(existsSync(join(fixture.linked, "scripts/pr-lib/clawsweeper-review-gate.mjs"))).toBe(
      true,
    );
  });

  itPosix("preserves the caller's gh route environment through startup", () => {
    const fixture = makeMismatchedWrapperRepo();
    cpSync("scripts/lib/plain-gh.sh", join(fixture.canonical, "scripts/lib/plain-gh.sh"));
    writeFileSync(
      join(fixture.canonical, "scripts/pr-lib/worktree.sh"),
      `list_pr_worktrees() { /bin/sh -c 'printf "%s\\n" "\${OPENCLAW_GH_BIN-absent}"'; }\n`,
    );
    for (const override of [undefined, "", join(fixture.bin, "gh")]) {
      const result = spawnSync(join(fixture.canonical, "scripts/pr"), ["ls"], {
        cwd: fixture.canonical,
        encoding: "utf8",
        env: { ...fixture.env, OPENCLAW_GH_BIN: override },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${override ?? "absent"}\n`);
    }
  });

  itPosix("uses the selected Git for wrapper routing when PATH Git is broken", () => {
    const fixture = makeMismatchedWrapperRepo();
    const selected = join(fixture.root, "selected-git");
    const calls = join(fixture.root, "selected-git-calls");
    writeFileSync(
      selected,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PR_TEST_GIT_CALLS"\nexec "$PR_TEST_REAL_GIT" "$@"\n',
    );
    chmodSync(selected, 0o755);
    writeFileSync(join(fixture.bin, "git"), '#!/bin/sh\necho "unexpected PATH Git" >&2\nexit 99\n');
    chmodSync(join(fixture.bin, "git"), 0o755);
    const result = spawnSync(join(fixture.canonical, "scripts/pr"), ["ls"], {
      cwd: fixture.canonical,
      encoding: "utf8",
      env: {
        ...fixture.env,
        OPENCLAW_PR_GIT: selected,
        PR_TEST_GIT_CALLS: calls,
        PR_TEST_REAL_GIT: resolveCommand("git"),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("--version\n");
    expect(readFileSync(calls, "utf8")).toContain("--git-common-dir");
    expect(result.stderr).not.toContain("unexpected PATH Git");
  });

  it("routes cached reads and writer-sensitive operations through their owning gh seams", () => {
    const script = readScript("scripts/pr");
    const common = readScript("scripts/pr-lib/common.sh");
    const worktree = readScript("scripts/pr-lib/worktree.sh");
    const review = readScript("scripts/pr-lib/review.sh");
    const push = readScript("scripts/pr-lib/push.sh");
    const merge = readScript("scripts/pr-lib/merge.sh");
    const mergeOutcome = readScript("scripts/pr-lib/merge-outcome.sh");

    expect(script).toContain('pr_observe "$pr" || exit 1');
    expect(script).toContain('base_json="$PR_OBSERVATION"');
    expect(common).toContain('pr_gh pr view "$pr" --json "$fields"');
    expect(worktree).toContain(
      'metadata=$(read_pr_view_json "$pr" "number,title,state,isDraft,author,baseRefName,baseRefOid,baseRepository,',
    );
    expect(review).toContain('pr_gh_plain assign-reviewer "$pr" "$reviewer"');
    expect(push).toContain('pr_gh_plain api graphql --input "$payload_file"');
    expect(push).not.toContain("pr_gh_plain api graphql --input -");
    expect(merge).toContain('pr_gh_plain pr merge "$pr"');
    expect(mergeOutcome).toContain('pr_gh_plain api --hostname "$MERGE_REPO_HOST" --method POST');
    expect(mergeOutcome).toContain("--jq '.html_url // empty'");
    expect(merge).toContain(
      'pr_git push --force-with-lease="refs/heads/$MERGE_HEAD_REF:$PREP_HEAD_SHA"',
    );
  });

  itPosix("fails loudly at preflight when ripgrep is unavailable", () => {
    const fixture = makeMismatchedWrapperRepo();
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

  it("classifies every dispatched subcommand", () => {
    const script = readScript("scripts/pr");
    const classifications = parseSubcommandClassifications(script);
    const dispatched = parseDispatchedSubcommands(script);

    expect([...classifications.keys()].toSorted()).toEqual(
      [...dispatched, "lock-recover"].toSorted(),
    );
    expect(classifications.get("ls")).toBe("advisory");
    expect(classifications.get("ci-dispatch")).toBe("advisory");
    for (const command of dispatched.filter((value) => !["ls", "ci-dispatch"].includes(value))) {
      expect(classifications.get(command), command).toBe("landing");
    }
  });

  itPosix("requires a separate operator confirmation for merge recovery", () => {
    const fixture = makeMismatchedWrapperRepo();
    for (const args of [
      ["123", "a".repeat(40)],
      ["123", "", "--confirmed-operator-recovery"],
      ["123", "not-an-outcome", "--confirmed-operator-recovery"],
      ["123", "a".repeat(40), "--confirmed-no-running-tools"],
      ["123", "a".repeat(40), "--confirmed-operator-recovery", "--auto-merge"],
      ["123", "a".repeat(40), "--confirmed-operator-recovery", "--cancel-auto", "--cancel-auto"],
      [
        "123",
        "a".repeat(40),
        "--confirmed-operator-recovery",
        "--cancel-auto",
        "--body-file",
        "message.md",
      ],
      [
        "123",
        "a".repeat(40),
        "--confirmed-operator-recovery",
        "--cancel-auto",
        "--replacement-head",
        "b".repeat(40),
      ],
      ...[
        [],
        [""],
        ["HEAD"],
        ["a".repeat(39)],
        ["A".repeat(40)],
        ["b".repeat(40), "--replacement-head", "c".repeat(40)],
        ["b".repeat(40), "--confirmed-operator-recovery"],
      ].map((suffix) =>
        ["123", "a".repeat(40), "--confirmed-operator-recovery", "--replacement-head"].concat(
          suffix,
        ),
      ),
      [
        "123",
        "a".repeat(40),
        "--replacement-head",
        "b".repeat(40),
        "--confirmed-operator-recovery",
      ],
      ["123", "a".repeat(40), "--replacement-head", "b".repeat(40)],
      [
        "0123",
        "a".repeat(40),
        "--confirmed-operator-recovery",
        "--replacement-head",
        "b".repeat(40),
      ],
    ]) {
      const result = spawnSync(
        join(fixture.canonical, "scripts", "pr"),
        ["merge-recover", ...args],
        { cwd: fixture.canonical, encoding: "utf8", env: fixture.env },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stdout).toContain("Usage:");
      expect(result.stderr).not.toContain("only support PRs targeting main");
    }
  });

  itPosix("resolves an explicit merge body from the caller before supervisor cwd changes", () => {
    const fixture = makeMismatchedWrapperRepo();
    const caller = join(fixture.canonical, "nested");
    mkdirSync(caller);
    writeFileSync(
      join(fixture.canonical, "scripts/pr-lib/merge.sh"),
      `merge_run() { printf '<%s>\\n' "$@"; }\n`,
    );
    const result = spawnSync(
      join(fixture.canonical, "scripts/pr"),
      ["merge-run", "123", "--body-file", "operator body.md"],
      { cwd: caller, encoding: "utf8", env: fixture.env },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `<123>\n<false>\n<>\n<>\n<${join(caller, "operator body.md")}>\n<>\n<false>\n`,
    );
  });

  itPosix(
    "requires an exact receipt and explicit confirmation for completion-only dispatch",
    () => {
      const fixture = makeMismatchedWrapperRepo();
      writeFileSync(
        join(fixture.canonical, "scripts/pr-lib/merge.sh"),
        `merge_complete() { printf '<%s>\\n' "$@"; }\nmerge_run() { exit 99; }\n`,
      );
      const oid = "a".repeat(40);
      for (const args of [
        ["123", oid],
        ["123", "HEAD", "--confirmed-operator-completion"],
        ["0123", oid, "--confirmed-operator-completion"],
        ["123", oid, "--confirmed-operator-recovery"],
        ["123", oid, "--confirmed-operator-completion", "--auto-merge"],
      ]) {
        const result = spawnSync(
          join(fixture.canonical, "scripts/pr"),
          ["merge-complete", ...args],
          {
            cwd: fixture.canonical,
            encoding: "utf8",
            env: fixture.env,
          },
        );
        expect(result.status, result.stdout + result.stderr).toBe(2);
        expect(result.stdout).toContain("Usage:");
      }
      const result = spawnSync(
        join(fixture.canonical, "scripts/pr"),
        ["merge-complete", "123", oid, "--confirmed-operator-completion"],
        { cwd: fixture.canonical, encoding: "utf8", env: fixture.env },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toBe(`<123>\n<${oid}>\n`);
    },
  );

  itPosix("rejects ambiguous body flags and keeps recovery confirmation mandatory", () => {
    const fixture = makeMismatchedWrapperRepo();
    for (const args of [
      ["merge-run", "123", "--body-file"],
      ["merge-run", "123", "--body-file", ""],
      ["merge-run", "123", "--body-file", "one", "--body-file", "two"],
      ["merge-run", "123", "--auto-merge", "--auto-merge"],
      ["merge-recover", "123", "a".repeat(40), "--body-file", "one"],
      ["merge-recover", "123", "a".repeat(40), "--confirmed-operator-recovery", "--auto-merge"],
    ]) {
      const result = spawnSync(join(fixture.canonical, "scripts/pr"), args, {
        cwd: fixture.canonical,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stdout).toContain("Usage:");
    }
  });

  itPosix("dispatches explicit replacement arguments through the same merge owner", () => {
    const fixture = makeMismatchedWrapperRepo();
    writeFileSync(join(fixture.bin, "gh"), baseBranchGhStub("main"));
    writeFileSync(
      join(fixture.canonical, "scripts/pr-lib/merge.sh"),
      `merge_run() { printf '<%s>\\n' "$@"; }\n`,
    );
    for (const replacement of [[], ["--replacement-head", "b".repeat(40)], ["--cancel-auto"]]) {
      for (const body of [[], ["--body-file", "message.md"]]) {
        const cancel = replacement[0] === "--cancel-auto";
        if (cancel && body.length) {
          continue;
        }
        const result = spawnSync(
          join(fixture.canonical, "scripts/pr"),
          [
            "merge-recover",
            "123",
            "a".repeat(40),
            "--confirmed-operator-recovery",
            ...body,
            ...replacement,
          ],
          { cwd: fixture.canonical, encoding: "utf8", env: fixture.env },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toBe(
          `<123>\n<false>\n<${"a".repeat(40)}>\n<${replacement[1] ?? ""}>\n<${body.length ? join(fixture.canonical, "message.md") : ""}>\n<>\n<${cancel}>\n`,
        );
      }
    }
  });

  itPosix("pins legacy refusal evidence and requires an explicit current recovery head", () => {
    const fixture = makeMismatchedWrapperRepo();
    const caller = join(fixture.canonical, "nested");
    mkdirSync(caller);
    writeFileSync(join(fixture.bin, "gh"), baseBranchGhStub("main"));
    writeFileSync(
      join(fixture.canonical, "scripts/pr-lib/merge.sh"),
      `merge_run() { printf '<%s>\\n' "$@"; }\n`,
    );
    const args = [
      "merge-recover",
      "123",
      "a".repeat(40),
      "--confirmed-operator-recovery",
      "--legacy-refusal",
      "proof",
    ];
    const missing = spawnSync(join(fixture.canonical, "scripts/pr"), args, {
      cwd: caller,
      encoding: "utf8",
      env: fixture.env,
    });
    expect(missing.status, missing.stdout + missing.stderr).toBe(2);
    const result = spawnSync(
      join(fixture.canonical, "scripts/pr"),
      [...args, "--replacement-head", "b".repeat(40)],
      { cwd: caller, encoding: "utf8", env: fixture.env },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `<123>\n<false>\n<${"a".repeat(40)}>\n<${"b".repeat(40)}>\n<>\n<${join(caller, "proof")}>\n<false>\n`,
    );
  });

  it("runs a mismatched advisory wrapper locally with an explicit developer opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    const cliResult = spawnSync(
      join(fixture.linked, "scripts", "pr"),
      ["--dev-wrapper", "ci-dispatch", "123"],
      {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      },
    );
    expect(cliResult.status, `${cliResult.stderr}\n${cliResult.stdout}`).toBe(0);
    expect(cliResult.stdout).toContain("local wrapper executed");
    expect(cliResult.stderr).toContain(
      `WARNING: running local scripts/pr revision ${fixture.localRevision} via dev-wrapper opt-in.`,
    );
    expect(cliResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
    expect(cliResult.stderr).toContain("landing subcommands remain refused");

    const envResult = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
      cwd: fixture.linked,
      encoding: "utf8",
      env: { ...fixture.env, OPENCLAW_PR_DEV_WRAPPER: "1" },
    });
    expect(envResult.status, `${envResult.stderr}\n${envResult.stdout}`).toBe(0);
    expect(envResult.stdout).toContain("local wrapper executed");
    expect(envResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
  });

  it("substitutes the anchor-matching canonical wrapper for a mismatched worktree without opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
      cwd: fixture.linked,
      encoding: "utf8",
      env: fixture.env,
    });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("canonical wrapper executed");
    expect(result.stdout).not.toContain("local wrapper executed");
    expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
    expect(result.stderr).not.toContain("Refusing to silently substitute");
  });

  it.each(["prepare-run", "merge-recover"])(
    "routes mismatched %s to the canonical wrapper despite opt-in",
    (command) => {
      const fixture = makeMismatchedWrapperRepo();
      if (command === "prepare-run") {
        seedReadyReview(fixture);
      }
      const result = spawnSync(
        join(fixture.linked, "scripts", "pr"),
        [
          "--dev-wrapper",
          command,
          "123",
          ...(command === "merge-recover" ? ["a".repeat(40), "--confirmed-operator-recovery"] : []),
        ],
        { cwd: fixture.linked, encoding: "utf8", env: fixture.env },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `subcommand '${command}' is classified landing; dev-wrapper opt-in is unavailable.`,
      );
      expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
      // The stubbed gh reports a non-main base: reaching this gate proves the
      // canonical wrapper ran instead of the mismatched local one.
      expect(result.stderr).toContain(
        "scripts/pr prepare and merge commands only support PRs targeting main; PR #123 targets not-main.",
      );
      expect(result.stdout).not.toContain("local wrapper executed");
    },
  );

  it("substitutes the canonical wrapper for a stale-base worktree once main moves the wrapper", () => {
    const fixture = makeMismatchedWrapperRepo();
    // Stale worktree: created at the pushed main base, no local wrapper edits.
    const stale = join(fixture.root, "stale");
    const baseline = fixture.git(fixture.canonical, ["rev-parse", "main"]).stdout.trim();
    fixture.git(fixture.canonical, ["worktree", "add", "-b", "stale-feature", stale, baseline]);

    // main's wrapper then advances and the canonical checkout tracks it.
    writeFileSync(
      join(fixture.canonical, "scripts", "pr-lib", "gates.sh"),
      'ci_dispatch() { echo "canonical v2 executed"; }\n',
    );
    fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
    fixture.git(fixture.canonical, ["commit", "-m", "test: wrapper v2"]);
    fixture.git(fixture.canonical, ["push", "origin", "main"]);

    const result = spawnSync(join(stale, "scripts", "pr"), ["ci-dispatch", "123"], {
      cwd: stale,
      encoding: "utf8",
      env: fixture.env,
    });
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
    writeFileSync(
      join(fixture.canonical, "scripts", "pr-lib", "gates.sh"),
      'ci_dispatch() { echo "parked canonical executed"; }\n',
    );
    fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
    fixture.git(fixture.canonical, ["commit", "-m", "test: parked canonical wrapper"]);
  }

  itPosix.each(["canonical", "extracted"])(
    "preserves selected shell and Node Git across a legacy %s wrapper handoff",
    (route) => {
      const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
      writeFileSync(
        join(fixture.canonical, "scripts/pr"),
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
      fixture.git(fixture.canonical, ["add", "scripts/pr"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: legacy Git handoff"]);
      fixture.git(fixture.canonical, ["push", "origin", "main"]);
      if (route === "extracted") {
        parkCanonicalOffAnchor(fixture);
      }

      const selected = join(fixture.root, "custom-git");
      const calls = join(fixture.root, "git-handoff-calls");
      writeFileSync(
        selected,
        '#!/bin/sh\nprintf "%s %s\\n" "${PR_TEST_GIT_PHASE:-bootstrap}" "$*" >> "$PR_TEST_GIT_CALLS"\nexec "$PR_TEST_REAL_GIT" "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(fixture.bin, "git"),
        '#!/bin/sh\necho "unexpected PATH Git" >&2\nexit 99\n',
        { mode: 0o755 },
      );
      const env = {
        ...fixture.env,
        OPENCLAW_PR_GIT: selected,
        PR_TEST_GIT_CALLS: calls,
        PR_TEST_REAL_GIT: resolveCommand("git"),
      };
      const run = (path: string) =>
        spawnSync(join(fixture.linked, "scripts/pr"), ["ls"], {
          cwd: fixture.linked,
          encoding: "utf8",
          env: { ...env, PATH: path },
        });
      const result = run(env.PATH);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toBe("legacy wrapper completed\n");
      expect(result.stderr).toContain(
        route === "canonical"
          ? "running the canonical checkout's wrapper"
          : "running wrapper code materialized from",
      );
      expect(readFileSync(calls, "utf8")).toContain("shell --version\n");
      expect(readFileSync(calls, "utf8")).toContain("node --version\n");
      const adapters = readdirSync(fixture.root).filter((name) =>
        name.startsWith("openclaw-pr-git."),
      );
      expect(adapters).toHaveLength(1);
      const adapter = join(fixture.root, adapters[0]!);
      expect(realpathSync(join(adapter, "git"))).toBe(realpathSync(selected));

      const reentry = run(`${adapter}${delimiter}${env.PATH}`);
      expect(reentry.status, reentry.stdout + reentry.stderr).toBe(0);
      expect(reentry.stdout).toBe("legacy wrapper completed\n");
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith("openclaw-pr-git.")),
      ).toEqual(adapters);
    },
  );

  function materializeAnchor(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    const materialized = spawnSync(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
      cwd: fixture.linked,
      encoding: "utf8",
      env: fixture.env,
    });
    expect(materialized.status, materialized.stderr).toBe(2);
    expect(materialized.stderr).toContain("running wrapper code materialized from");
    const anchors = readdirSync(fixture.root).filter((name) =>
      name.startsWith("openclaw-pr-anchor."),
    );
    expect(anchors).toHaveLength(1);
    const anchor = join(fixture.root, anchors[0]!);
    expect(statSync(anchor).mode & 0o777).toBe(0o700);
    return anchor;
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
    fixture.git(fixture.canonical, [
      "add",
      inventory,
      dependency,
      "scripts/pr-lib/review-artifacts.mjs",
    ]);
    fixture.git(fixture.canonical, ["commit", "-m", "test: anchor-only review dependency"]);
    fixture.git(fixture.canonical, ["push", "origin", "main"]);
  }

  function makeToolingRootFixture() {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const tooling = join(fixture.root, "tooling");
    const origin = fixture.git(fixture.canonical, ["remote", "get-url", "origin"]).stdout.trim();
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
      spawnSync(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, ...env },
      });
    return { ...fixture, tooling, stale, run };
  }

  function advanceToolingMain(fixture: ReturnType<typeof makeToolingRootFixture>) {
    const previousHead = fixture.git(fixture.tooling, ["rev-parse", "HEAD"]).stdout.trim();
    const tree = fixture.git(fixture.tooling, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    const advanced = fixture
      .git(fixture.canonical, [
        "commit-tree",
        tree,
        "-p",
        previousHead,
        "-m",
        "test: advance tooling main",
      ])
      .stdout.trim();
    fixture.git(fixture.canonical, ["push", "origin", `${advanced}:refs/heads/main`]);
    return advanced;
  }

  itPosix.each(["environment", "config"])(
    "sources anchor dependencies from the %s tooling root without changing canonical",
    (setting) => {
      const fixture = makeToolingRootFixture();
      const canonicalHead = fixture.git(fixture.canonical, ["rev-parse", "HEAD"]).stdout;
      fixture.git(fixture.canonical, [
        "config",
        "openclaw.pr.toolingRoot",
        setting === "config" ? fixture.tooling : join(fixture.root, "invalid-config-root"),
      ]);
      const result = fixture.run(
        setting === "environment" ? { OPENCLAW_PR_TOOLING_ROOT: fixture.tooling } : {},
      );
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stderr).toContain(`scripts/pr tooling root: ${fixture.tooling}`);
      expect(result.stderr).toContain("running wrapper code materialized from");
      const anchor = readdirSync(fixture.root).find((name) =>
        name.startsWith("openclaw-pr-anchor."),
      );
      expect(anchor).toBeDefined();
      expect(realpathSync(join(fixture.root, anchor!, "node_modules/tsx"))).toBe(
        realpathSync(join(fixture.tooling, "node_modules/tsx")),
      );
      expect(fixture.git(fixture.canonical, ["rev-parse", "HEAD"]).stdout).toBe(canonicalHead);
      expect(realpathSync(join(fixture.canonical, "node_modules/tsx"))).toBe(fixture.stale);
      expect(result.stderr).not.toContain("Refreshing scripts/pr tooling root");
    },
  );

  itPosix.each([true, false])(
    "refreshes a stale clean main tooling root once (install repairs=%s)",
    (repairs) => {
      const fixture = makeToolingRootFixture();
      const advanced = advanceToolingMain(fixture);
      const target = realpathSync(join(fixture.tooling, "node_modules/tsx"));
      rmSync(join(fixture.tooling, "node_modules/tsx"));
      symlinkSync(fixture.stale, join(fixture.tooling, "node_modules/tsx"), "dir");
      const calls = join(fixture.root, "install-calls");
      writeFileSync(
        join(fixture.bin, "pnpm"),
        `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${repairs}) {
  fs.unlinkSync(${JSON.stringify(join(fixture.tooling, "node_modules/tsx"))});
  fs.symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(join(fixture.tooling, "node_modules/tsx"))}, "dir");
}
`,
      );
      const result = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: fixture.tooling });
      expect(result.status, result.stdout + result.stderr).toBe(repairs ? 2 : 1);
      expect(result.stderr).toContain("has version 0.0.0; the trust anchor requires");
      expect(result.stderr).toContain(`Refreshing scripts/pr tooling root ${fixture.tooling}`);
      expect(
        readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([["-C", fixture.tooling, "install", "--frozen-lockfile"]]);
      expect(result.stderr).toContain(
        repairs ? "Refreshed and verified" : "no further refresh was attempted",
      );
      expect(fixture.git(fixture.tooling, ["rev-parse", "HEAD"]).stdout.trim()).toBe(advanced);
      expect(realpathSync(join(fixture.canonical, "node_modules/tsx"))).toBe(fixture.stale);
    },
  );

  itPosix.each(["dirty", "branch"])(
    "preserves a post-merge hook's %s tooling checkout without installing",
    (condition) => {
      const fixture = makeToolingRootFixture();
      const advanced = advanceToolingMain(fixture);
      const manifest = join(fixture.tooling, "package.json");
      const manifestBefore = readFileSync(manifest, "utf8");
      rmSync(join(fixture.tooling, "node_modules/tsx"));
      symlinkSync(fixture.stale, join(fixture.tooling, "node_modules/tsx"), "dir");
      const hooks = join(fixture.root, "tooling-hooks");
      mkdirSync(hooks);
      fixture.git(fixture.tooling, ["config", "core.hooksPath", hooks]);
      writeFileSync(
        join(hooks, "post-merge"),
        `#!/bin/sh\nset -e\n${condition === "dirty" ? "printf '\\n' >> package.json" : '"$OPENCLAW_PR_GIT" switch -c operator-work'}\n`,
        { mode: 0o755 },
      );
      const installed = join(fixture.root, "installed");
      writeFileSync(join(fixture.bin, "pnpm"), `#!/bin/sh\ntouch '${installed}'\nexit 1\n`);
      const result = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: fixture.tooling });
      const branch = condition === "dirty" ? "main" : "operator-work";

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`Cannot refresh scripts/pr tooling root ${fixture.tooling}`);
      expect(result.stderr).toContain(
        `branch=${branch}, ${condition === "dirty" ? "dirty" : "clean"}`,
      );
      expect(result.stderr).toContain(
        "Restore its frozen dependencies manually or set OPENCLAW_PR_TOOLING_ROOT",
      );
      expect(existsSync(installed)).toBe(false);
      expect(fixture.git(fixture.tooling, ["branch", "--show-current"]).stdout.trim()).toBe(branch);
      expect(fixture.git(fixture.tooling, ["rev-parse", "HEAD"]).stdout.trim()).toBe(advanced);
      expect(readFileSync(manifest, "utf8")).toBe(
        manifestBefore + (condition === "dirty" ? "\n" : ""),
      );
      expect(realpathSync(join(fixture.tooling, "node_modules/tsx"))).toBe(fixture.stale);
    },
  );

  itPosix.each(["dirty", "branch", "canonical", "sparse", "unrelated", "subdirectory"])(
    "refuses an unsafe %s tooling root without installation",
    (condition) => {
      const fixture = makeToolingRootFixture();
      let root = fixture.tooling;
      rmSync(join(fixture.tooling, "node_modules/tsx"));
      symlinkSync(fixture.stale, join(fixture.tooling, "node_modules/tsx"), "dir");
      if (condition === "dirty") {
        writeFileSync(join(root, "untracked"), "keep me\n");
      }
      if (condition === "branch") {
        fixture.git(root, ["checkout", "-b", "operator-work"]);
      }
      if (condition === "canonical") {
        root = fixture.canonical;
      }
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
      writeFileSync(join(fixture.bin, "pnpm"), `#!/bin/sh\ntouch '${installed}'\nexit 1\n`);
      const result = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: root });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(root);
      expect(result.stderr).toContain(
        ["sparse", "unrelated", "subdirectory"].includes(condition)
          ? "full Git work tree of this repository"
          : "Restore its frozen dependencies manually or set OPENCLAW_PR_TOOLING_ROOT",
      );
      expect(existsSync(installed)).toBe(false);
      expect(result.stderr).not.toContain("running wrapper code materialized from");
    },
  );

  itPosix("does not refresh a tooling root when the materialization destination is invalid", () => {
    const fixture = makeToolingRootFixture();
    writeFileSync(
      join(fixture.bin, "node"),
      `#!/bin/sh
if [ "$1" = --input-type=module ] && [ "$2" = - ] && [ "\${5##*/}" = node_modules ]; then
  printf 'not a directory\\n' > "$5"
fi
exec "$OPENCLAW_TEST_NODE" "$@"
`,
      { mode: 0o755 },
    );
    const installed = join(fixture.root, "installed");
    writeFileSync(join(fixture.bin, "pnpm"), `#!/bin/sh\ntouch '${installed}'\nexit 1\n`);
    const result = fixture.run({
      OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
      OPENCLAW_TEST_NODE: process.execPath,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("tooling root was not refreshed");
    expect(existsSync(installed)).toBe(false);
  });

  it("materializes the origin/main anchor wrapper when canonical is parked elsewhere", () => {
    const fixture = makeMismatchedWrapperRepo();
    parkCanonicalOffAnchor(fixture);
    const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
      cwd: fixture.linked,
      encoding: "utf8",
      env: fixture.env,
    });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    // The anchor (pushed main) marker proves materialized anchor code ran,
    // not the linked worktree's wrapper and not the parked canonical one.
    expect(result.stdout).toContain("canonical wrapper executed");
    expect(result.stdout).not.toContain("local wrapper executed");
    expect(result.stdout).not.toContain("parked canonical executed");
    expect(result.stderr).toContain(
      "running wrapper code materialized from the refs/remotes/origin/main trust anchor",
    );
    expect(result.stderr).not.toContain("Refusing to silently substitute");
  });

  itPosix("materializes the anchor when tar stops before the producer's trailing padding", () => {
    const fixture = makeMismatchedWrapperRepo();
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
    const result = spawnSync(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
      cwd: fixture.linked,
      encoding: "utf8",
      env: { ...fixture.env, OPENCLAW_TEST_GIT: resolveCommand("git") },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).not.toContain("Refusing to silently substitute");
  });

  itPosix.each(["producer failure", "truncated archive", "reader failure"])(
    "refuses anchor extraction on %s",
    (failure) => {
      const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
      parkCanonicalOffAnchor(fixture);
      const git = join(fixture.bin, "git");
      writeFileSync(
        git,
        `#!/bin/sh
if [ "$3" = archive ]; then
  if [ "$OPENCLAW_TEST_FAILURE" = 'truncated archive' ]; then
    "$OPENCLAW_TEST_GIT" "$@" > "$OPENCLAW_TEST_ARCHIVE" || exit
    dd if="$OPENCLAW_TEST_ARCHIVE" bs=512 count=3 2>/dev/null
    exit
  fi
  "$OPENCLAW_TEST_GIT" "$@" || exit
  if [ "$OPENCLAW_TEST_FAILURE" = 'producer failure' ]; then
    exit 42
  fi
  exit 0
fi
exec "$OPENCLAW_TEST_GIT" "$@"
`,
      );
      chmodSync(git, 0o755);
      const tar = join(fixture.bin, "tar");
      writeFileSync(
        tar,
        `#!/bin/sh
printf 'started\\n' >> "$OPENCLAW_TEST_READER_LOG"
"$OPENCLAW_TEST_TAR" "$@" || exit
if [ "$OPENCLAW_TEST_FAILURE" = 'reader failure' ]; then
  exit 42
fi
`,
      );
      chmodSync(tar, 0o755);
      const readerLog = join(fixture.root, "reader.log");
      const result = spawnSync(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: {
          ...fixture.env,
          OPENCLAW_TEST_GIT: resolveCommand("git"),
          OPENCLAW_TEST_TAR: resolveCommand("tar"),
          OPENCLAW_TEST_FAILURE: failure,
          OPENCLAW_TEST_ARCHIVE: join(fixture.root, "complete.tar"),
          OPENCLAW_TEST_READER_LOG: readerLog,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Refusing to silently substitute");
      expect(result.stderr).not.toContain("running wrapper code materialized from");
      expect(existsSync(readerLog)).toBe(failure !== "producer failure");
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith("openclaw-pr-anchor.")),
      ).toEqual([]);
    },
  );

  itPosix("executes extracted helpers through a symlinked temporary root", () => {
    const fixture = makeMismatchedWrapperRepo({ realModules: true });
    // Exercise the wrapper's own helper path, not a physical path reconstructed by the test.
    writeFileSync(
      join(fixture.canonical, "scripts/pr-lib/gates.sh"),
      `ci_dispatch() { node "$(review_artifacts_helper_path)" template "$1" "${REVIEWED_HEAD}"; }\n`,
    );
    fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
    fixture.git(fixture.canonical, ["commit", "-m", "test: real anchor helper dispatch"]);
    fixture.git(fixture.canonical, ["push", "origin", "main"]);
    parkCanonicalOffAnchor(fixture);
    const temporaryAlias = join(fixture.root, "temporary-alias");
    symlinkSync(fixture.root, temporaryAlias, "dir");
    const result = spawnSync(
      join(fixture.linked, "scripts/pr"),
      ["ci-dispatch", String(REVIEWED_PR)],
      {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: temporaryAlias },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(result.stdout, "the extracted helper must not silently skip its entrypoint").toContain(
      REVIEWED_HEAD,
    );
    expect(JSON.parse(result.stdout).pr).toEqual({ number: REVIEWED_PR, headSha: REVIEWED_HEAD });
  });

  itPosix.each(["parked", "dirty added dependency"])(
    "executes review artifacts from the extracted anchor dependency closure with canonical %s",
    (canonicalState) => {
      const fixture = makeMismatchedWrapperRepo({ realModules: true });
      advanceAnchorReviewDependency(fixture);
      if (canonicalState === "parked") {
        parkCanonicalOffAnchor(fixture);
      } else {
        writeFileSync(
          join(fixture.canonical, "scripts/lib/anchor-review-record.mjs"),
          "throw new Error('unreviewed dependency');\n",
        );
      }
      const anchor = materializeAnchor(fixture);
      writeFileSync(join(fixture.bin, "gh"), "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n");
      writeReviewArtifacts(fixture.linked, validReview());
      const result = spawnSync(
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
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: fixture.env,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).pr).toEqual({
        number: REVIEWED_PR,
        headSha: REVIEWED_HEAD,
      });
    },
  );

  itPosix(
    "executes tooling and publisher code from the extracted anchor dependency closure",
    () => {
      const fixture = makeMismatchedWrapperRepo({ realModules: true });
      parkCanonicalOffAnchor(fixture);
      const anchor = materializeAnchor(fixture);
      writeFileSync(join(fixture.bin, "gh"), "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n");
      const run = (args: string[]) =>
        spawnSync(process.execPath, args, {
          cwd: anchor,
          encoding: "utf8",
          env: fixture.env,
        });
      // These .mjs files launch children at import time. Execute the real shims
      // with invalid arguments so their .mts owners reject before any GitHub IO.
      for (const [entry, exitCode, message] of [
        ["watch-pr-ci.mjs", 2, "Usage: node scripts/watch-pr-ci.mjs"],
        ["verify-pr-hosted-gates.mjs", 1, "Usage: node scripts/verify-pr-hosted-gates.mjs"],
        ["pr-lib/ci-dispatch.mjs", 2, "Usage: ci-dispatch.mjs"],
      ] as const) {
        const result = run([join(anchor, "scripts", entry)]);
        expect.soft(result.status, `${entry}\n${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect.soft(result.stderr, entry).toContain(message);
      }
      // Import the actual adapter closure before it rejects missing arguments.
      // Real provisioning and allocation-lease renewal have separate flows.
      const provision = spawnSync(
        process.execPath,
        [
          "--import",
          join(anchor, "scripts/tsx.mjs"),
          join(anchor, "scripts/pr-lib/worktree-provision.mts"),
        ],
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: { ...fixture.env, TSX_TSCONFIG_PATH: join(anchor, "tsconfig.json") },
        },
      );
      expect.soft(provision.status, provision.stderr).toBe(1);
      expect.soft(provision.stderr).toContain("Usage: worktree-provision.mts");
      expect.soft(provision.stderr).toContain("[pr-worktree-provision] FAILED (exit 1)");
      expect
        .soft(fixture.git(fixture.canonical, ["for-each-ref", "refs/openclaw"]).stdout)
        .toBe("");
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

      const attribution = run([
        "scripts/check-changelog-attributions.mjs",
        "--is-forbidden-handle",
        "fixture[bot]",
      ]);
      expect.soft(attribution.status, attribution.stderr).toBe(0);
      const bypass = run([
        "--input-type=module",
        "-e",
        "await import('./scripts/pr-lib/crabbox-merge-bypass.mjs')",
      ]);
      expect.soft(bypass.status, bypass.stderr).toBe(0);

      const plan = {
        version: 1,
        baseSha: "a".repeat(40),
        headSha: REVIEWED_HEAD,
        changedPaths: [{ path: "docs/example.md", status: "M" }],
        targets: [],
      };
      const planFile = join(fixture.root, "plan.json");
      writeFileSync(planFile, JSON.stringify(plan));
      const publisher = run([
        "scripts/pr-crabbox-gate-publisher.mjs",
        "--print-command",
        planFile,
        "c".repeat(64),
      ]);
      expect.soft(publisher.status, publisher.stderr).toBe(0);
      expect.soft(publisher.stdout).toContain(`OPENCLAW_CRABBOX_GATE_HEAD=${REVIEWED_HEAD}`);
      expect.soft(publisher.stdout).toContain("OPENCLAW_CRABBOX_GATE_TARGET_COUNT=0");
      expect.soft(publisher.stdout).toContain("pnpm build");
      expect.soft(publisher.stdout).toContain("pnpm check");

      // The trusted planner reads candidate sources without executing them. A
      // non-sibling importer exercises its real source-scanning child as well.
      mkdirSync(join(fixture.linked, "src"), { recursive: true });
      mkdirSync(join(fixture.linked, "test/probe"), { recursive: true });
      writeFileSync(join(fixture.linked, "src/anchor-value.ts"), "export const value = 1;\n");
      writeFileSync(
        join(fixture.linked, "test/probe/anchor.test.ts"),
        'import { value } from "../../src/anchor-value.js";\nvoid value;\n',
      );
      fixture.git(fixture.linked, ["add", "src", "test/probe"]);
      fixture.git(fixture.linked, ["commit", "-m", "test: candidate import graph"]);
      const base = fixture.git(fixture.linked, ["rev-parse", "HEAD"]).stdout.trim();
      writeFileSync(join(fixture.linked, "src/anchor-value.ts"), "export const value = 2;\n");
      fixture.git(fixture.linked, ["add", "src/anchor-value.ts"]);
      fixture.git(fixture.linked, ["commit", "-m", "test: candidate change"]);
      const head = fixture.git(fixture.linked, ["rev-parse", "HEAD"]).stdout.trim();
      const planned = spawnSync(
        process.execPath,
        [join(anchor, "scripts/pr-lib/crabbox-gate-plan.mts"), "--base", base, "--head", head],
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: fixture.env,
        },
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

  itPosix.each(
    [
      "scripts/lib/anchor-review-record.mjs",
      "src/agents/worktrees/checkout.ts",
      "src/state/openclaw-state-schema.sql",
      "tsconfig.json",
    ].flatMap((resource) => ["tampered", "missing"].map((fault) => ({ resource, fault }))),
  )(
    "refuses an extracted anchor with a $fault source/resource $resource",
    ({ resource, fault }) => {
      const fixture = makeMismatchedWrapperRepo({ realModules: true });
      advanceAnchorReviewDependency(fixture);
      parkCanonicalOffAnchor(fixture);
      const tar = join(fixture.bin, "tar");
      writeFileSync(
        tar,
        `#!/bin/sh
"$OPENCLAW_TEST_TAR" "$@" || exit
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    if [ "$OPENCLAW_TEST_FAULT" = missing ]; then
      rm "$2/$OPENCLAW_TEST_FAULT_PATH"
    else
      printf '\\n// tampered\\n' >> "$2/$OPENCLAW_TEST_FAULT_PATH"
    fi
    exit
  fi
  shift
done
exit 99
`,
      );
      chmodSync(tar, 0o755);
      const result = spawnSync(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: {
          ...fixture.env,
          OPENCLAW_TEST_TAR: resolveCommand("tar"),
          OPENCLAW_TEST_FAULT: fault,
          OPENCLAW_TEST_FAULT_PATH: resource,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Refusing to silently substitute");
      expect(result.stderr).not.toContain("running wrapper code materialized from");
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith("openclaw-pr-anchor.")),
      ).toEqual([]);
    },
  );

  it("routes a mismatched landing subcommand through the materialized anchor", () => {
    const fixture = makeMismatchedWrapperRepo();
    seedReadyReview(fixture);
    parkCanonicalOffAnchor(fixture);
    const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["prepare-run", "123"], {
      cwd: fixture.linked,
      encoding: "utf8",
      env: fixture.env,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "running wrapper code materialized from the refs/remotes/origin/main trust anchor",
    );
    // The stubbed gh reports a non-main base: reaching this gate proves the
    // materialized anchor wrapper ran the landing subcommand.
    expect(result.stderr).toContain(
      "scripts/pr prepare and merge commands only support PRs targeting main; PR #123 targets not-main.",
    );
    expect(result.stderr).not.toContain("Refusing to silently substitute");
  });

  it("initializes stamped review artifacts through the materialized anchor", () => {
    const fixture = makeMismatchedWrapperRepo();
    writeFileSync(
      join(fixture.bin, "gh"),
      `#!/bin/sh
if [ "$*" = "api user --include" ]; then
  printf 'HTTP/2.0 200 OK\\n\\n{"login":"fixture-user"}\\n'
  exit 0
fi
echo "Unexpected gh call: $*" >&2
exit 99
`,
    );
    const reviewRoot = join(fixture.canonical, ".worktrees", "pr-123");
    fixture.git(fixture.canonical, [
      "worktree",
      "add",
      "--detach",
      reviewRoot,
      fixture.localRevision,
    ]);
    mkdirSync(join(reviewRoot, ".local"));
    writeFileSync(join(reviewRoot, ".local", "pr-meta.env"), "PR_NUMBER=123\n");
    writeFileSync(
      join(reviewRoot, ".local", "pr-meta.json"),
      JSON.stringify({ number: 123, headRefOid: fixture.localRevision, files: [] }),
    );
    parkCanonicalOffAnchor(fixture);
    const result = spawnSync(
      join(fixture.linked, "scripts", "pr"),
      ["review-artifacts-init", "123"],
      {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: fixture.root },
      },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stderr).toContain("running wrapper code materialized from");
    expect(JSON.parse(readScript(join(reviewRoot, ".local", "review.json"))).pr).toEqual({
      number: 123,
      headSha: fixture.localRevision,
    });
    expect(existsSync(join(reviewRoot, ".local", "review.md"))).toBe(false);
  });

  it.each([
    {
      script: "verify-pr-hosted-gates.mjs",
      args: "--anchor-proof",
      status: 1,
      output: "Unknown option: --anchor-proof",
      dependency: "minimatch",
      binding: "minimatch",
    },
    {
      script: "watch-pr-ci.mjs",
      args: "--help",
      status: 2,
      output: "Usage:",
      dependency: "zod",
      binding: "z",
    },
    {
      script: "check-changelog-attributions.mjs",
      args: "--is-forbidden-handle codex",
      status: 0,
      output: "",
      dependency: undefined,
      binding: undefined,
    },
  ])(
    "loads $script from the materialized anchor without caller-owned aliases",
    ({ script, args, status, output, dependency, binding }) => {
      const fixture = makeMismatchedWrapperRepo({
        dispatchBody: `node "$script_parent_dir/${script}" ${args};`,
      });
      if (dependency) {
        writeFileSync(
          join(fixture.linked, "caller-dependency.mts"),
          `export const ${binding} = null;\nthrow new Error("caller workspace dependency executed");\n`,
        );
        writeFileSync(
          join(fixture.linked, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              paths: {
                [dependency]: ["./caller-dependency.mts"],
                "@openclaw/normalization-core/record-coerce": [
                  "./packages/normalization-core/src/record-coerce.ts",
                ],
              },
            },
          }),
        );
        fixture.git(fixture.linked, ["add", "caller-dependency.mts", "tsconfig.json"]);
        fixture.git(fixture.linked, ["commit", "-m", "test: caller-owned dependency aliases"]);
      }
      if (script === "verify-pr-hosted-gates.mjs") {
        const recordPath = "packages/normalization-core/src/record-coerce.ts";
        writeFileSync(
          join(fixture.linked, recordPath),
          `throw new Error("caller workspace normalization executed");\n${readScript(recordPath)}`,
        );
        fixture.git(fixture.linked, ["add", recordPath]);
        fixture.git(fixture.linked, ["commit", "-m", "test: caller-owned normalization"]);
      }
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: fixture.root },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(status);
      expect(result.stderr).toContain("running wrapper code materialized from");
      if (output) {
        expect(`${result.stdout}${result.stderr}`).toContain(output);
      }
      expect(`${result.stdout}${result.stderr}`).not.toContain("Cannot find module");
    },
  );

  itPosix.each([
    { installed: false, devWrapper: false },
    { installed: false, devWrapper: true },
    { installed: true, devWrapper: false },
  ])(
    "loads matching linked helper dependencies (installed=$installed, dev-wrapper=$devWrapper)",
    ({ installed, devWrapper }) => {
      const fixture = makeMismatchedWrapperRepo({
        dispatchBody: 'node "$script_parent_dir/verify-pr-hosted-gates.mjs" --anchor-proof;',
      });
      fixture.git(fixture.linked, ["reset", "--hard", "refs/remotes/origin/main"]);
      parkCanonicalOffAnchor(fixture);
      const linkedModules = join(fixture.linked, "node_modules");
      expect(existsSync(linkedModules)).toBe(false);
      const dependencies = ["tsx", "zod", "minimatch", "yaml"];
      const targets = dependencies.map((name) =>
        realpathSync(join(fixture.canonical, "node_modules", name)),
      );
      if (installed) {
        mkdirSync(linkedModules);
        dependencies.forEach((name, index) =>
          symlinkSync(targets[index]!, join(linkedModules, name), "dir"),
        );
      }
      const ghCalled = join(fixture.root, "gh-called");
      writeFileSync(join(fixture.bin, "gh"), `#!/bin/sh\ntouch "${ghCalled}"\nexit 99\n`);
      const result = spawnSync(
        join(fixture.linked, "scripts/pr"),
        [...(devWrapper ? ["--dev-wrapper"] : []), "ci-dispatch", "123"],
        { cwd: fixture.linked, encoding: "utf8", env: fixture.env },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Unknown option: --anchor-proof");
      expect(existsSync(ghCalled)).toBe(false);
      expect(existsSync(linkedModules)).toBe(installed);
      expect(result.stderr).not.toContain("dev-wrapper opt-in");
      const anchors = readdirSync(fixture.root).filter((name) =>
        name.startsWith("openclaw-pr-anchor."),
      );
      expect(anchors).toHaveLength(installed ? 0 : 1);
      if (!installed) {
        expect(result.stderr).toContain("matches origin/main but has no node_modules directory");
        expect(result.stderr).toContain("running wrapper code materialized from");
        expect(
          dependencies.map((name) =>
            realpathSync(join(fixture.root, anchors[0]!, "node_modules", name)),
          ),
        ).toEqual(targets);
      }
    },
  );

  itPosix.each([
    { args: ["gc", "--dry-run"], status: 0, message: "No merged/closed PR worktrees eligible" },
    {
      args: ["lock-recover", "123", "a".repeat(40), "invalid-confirmation"],
      status: 2,
      message: "Recovery requires --confirmed-no-running-tools",
    },
    { args: ["unknown-command"], status: 2, message: "Usage:" },
  ])("keeps matching linked $args dependency-free", ({ args, status, message }) => {
    const fixture = makeMismatchedWrapperRepo();
    fixture.git(fixture.linked, ["reset", "--hard", "refs/remotes/origin/main"]);
    parkCanonicalOffAnchor(fixture);
    rmSync(join(fixture.canonical, "node_modules"), { recursive: true });
    const result = spawnSync(join(fixture.linked, "scripts/pr"), args, {
      cwd: fixture.linked,
      encoding: "utf8",
      env: fixture.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(existsSync(join(fixture.linked, "node_modules"))).toBe(false);
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith("openclaw-pr-anchor.")),
    ).toEqual([]);
    expect(fixture.git(fixture.canonical, ["for-each-ref", "refs/openclaw"]).stdout).toBe("");
  });

  it.each(
    ["tsx", "zod", "minimatch", "yaml", "@openclaw/fs-safe", "jiti", "kysely"].flatMap(
      (dependency) => [false, true].map((matching) => ({ dependency, matching })),
    ),
  )(
    "refuses missing $dependency before handoff (matching=$matching) without installing",
    ({ dependency, matching }) => {
      const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
      if (matching) {
        fixture.git(fixture.linked, ["reset", "--hard", "refs/remotes/origin/main"]);
      }
      const installedDependency = join(fixture.canonical, "node_modules", dependency);
      rmSync(installedDependency);
      writeFileSync(
        join(fixture.bin, "pnpm"),
        `#!/bin/sh\ntouch "${join(fixture.root, "installed")}"\nexit 1\n`,
      );
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: fixture.root },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Cannot resolve installed scripts/pr dependency '${dependency}'`,
      );
      expect(result.stderr).toContain(
        "Restore frozen dependencies in a clean trusted-main checkout",
      );
      expect(result.stderr).not.toContain("running wrapper code materialized from");
      expect(existsSync(join(fixture.root, "installed"))).toBe(false);
      expect(existsSync(installedDependency)).toBe(false);
      expect(fixture.git(fixture.canonical, ["for-each-ref", "refs/openclaw"]).stdout).toBe("");
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith("openclaw-pr-anchor.")),
      ).toEqual([]);
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
        writeFileSync(join(fixture.canonical, "scripts/pr"), legacy);
      } else {
        rmSync(join(fixture.canonical, "scripts/pr-lib/wrapper-components.txt"));
      }
      fixture.git(fixture.canonical, ["add", "-u", "scripts/pr", "scripts/pr-lib"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: legacy anchor wrapper"]);
      fixture.git(fixture.canonical, ["push", "origin", "main"]);
      fixture.git(fixture.linked, ["fetch", "origin", "main"]);
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
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
      writeFileSync(
        join(fixture.canonical, "scripts/pr"),
        '#!/bin/sh\necho "stale canonical wrapper executed"\nexit 91\n',
      );
      fixture.git(fixture.canonical, ["add", "scripts/pr"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: stale canonical wrapper"]);
      const recorder = join(fixture.bin, "node");
      writeFileSync(recorder, '#!/bin/sh\nprintf \'%s\\0\' "$PWD" "$@"\nexit 73\n');
      chmodSync(recorder, 0o755);
      const caller = join(fixture.root, "caller directory");
      mkdirSync(caller);
      return { ...fixture, caller };
    }

    itPosix.each([
      ...["init", "validate-commit", "gates", "push", "run"].map(
        (mode) => ["pr-prepare", [mode, "123"], [`prepare-${mode}`, "123"]] as const,
      ),
      [
        "pr-review",
        ["123", "argument with spaces", ""],
        ["review-init", "123", "argument with spaces", ""],
      ],
      ["pr-merge", ["123"], ["merge-verify", "123"]],
      ["pr-merge", ["verify", "123"], ["merge-verify", "123"]],
      ["pr-merge", ["run", "123"], ["merge-run", "123"]],
    ] as const)("%s delegates %j through the trusted sibling", (alias, args, mapped) => {
      const fixture = makeAliasFixture();
      const result = spawnSync(join(fixture.linked, "scripts", alias), args, {
        cwd: fixture.caller,
        encoding: "utf8",
        env: fixture.env,
      });
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
        const result = spawnSync(join(fixture.linked, "scripts", alias), args, {
          cwd: fixture.caller,
          encoding: "utf8",
          env: { ...fixture.env, OPENCLAW_PR_DEV_WRAPPER: "1" },
        });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Refusing to silently substitute");
        expect(result.stderr).toContain("classified landing; dev-wrapper opt-in is unavailable");
        expect(result.stdout).toBe("");
      },
    );
  });

  it("refuses to substitute a different canonical wrapper implementation", () => {
    const dir = tempDirs.make("openclaw-pr-wrapper-revision-");
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    copyPrWrapperSources(repo);
    const env = isolatedWrapperEnv(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/gh"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(dir, "bin/gh"), 0o755);
    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["add", "."]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    for (const component of [
      "scripts/pr-lib/wrapper-components.txt",
      "scripts/pr-lib/merge.sh",
      "scripts/watch-pr-ci.mts",
      "scripts/verify-pr-hosted-gates.mts",
      "scripts/lib/local-check-runtime.mts",
    ]) {
      writeFileSync(join(linked, component), "# dirty linked\n");
      const dirtyResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
        cwd: linked,
        encoding: "utf8",
        env,
      });
      expect(dirtyResult.status, component).toBe(1);
      expect(dirtyResult.stderr, component).toContain(
        "scripts/pr wrapper files have uncommitted changes",
      );
      expect(git(linked, ["restore", component]).status).toBe(0);
    }

    writeFileSync(join(linked, "scripts", "tsx.mjs"), "// dirty preloader\n");
    const dirtyPreloaderResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
      env,
    });
    expect(dirtyPreloaderResult.status).toBe(1);
    expect(dirtyPreloaderResult.stderr).toContain(
      "scripts/pr wrapper files have uncommitted changes",
    );
    expect(git(linked, ["restore", "scripts/tsx.mjs"]).status).toBe(0);

    // A dirty canonical checkout no longer blocks a linked worktree whose
    // committed wrapper matches the origin/main trust anchor; without that
    // anchor it must still refuse.
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# dirty canonical\n");
    const dirtyResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
      env,
    });
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(git(repo, ["restore", "scripts/pr-lib/merge.sh"]).status).toBe(0);

    writeFileSync(join(linked, "scripts", "lib", "local-check-runtime.mts"), "// linked\n");
    expect(git(linked, ["add", "scripts/lib/local-check-runtime.mts"]).status).toBe(0);
    expect(git(linked, ["commit", "-m", "test: linked wrapper"]).status).toBe(0);

    const result = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(result.stderr).toContain("scripts/lib/local-check-runtime.mts");
  });

  it("runs the local wrapper when it matches origin/main and the canonical checkout is parked elsewhere", () => {
    const dir = tempDirs.make("openclaw-pr-wrapper-anchor-");
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    copyPrWrapperSources(repo);
    const env = isolatedWrapperEnv(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/gh"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(dir, "bin/gh"), 0o755);
    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["add", "."]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
    // The linked worktree keeps main's wrapper; origin/main anchors trust.
    expect(git(repo, ["update-ref", "refs/remotes/origin/main", "main"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    // Park the canonical checkout on a release-style branch with a different
    // wrapper revision, the exact contention that used to block landings.
    expect(git(repo, ["switch", "-c", "release/test-train"]).status).toBe(0);
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# release drift\n");
    expect(git(repo, ["add", "scripts/pr-lib/merge.sh"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: release drift"]).status).toBe(0);

    const result = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
      env,
    });

    expect(result.stderr).not.toContain("Refusing to silently substitute");
    expect(result.stderr).not.toContain("scripts/pr implementation differs");
    expect(result.stderr).not.toContain("differing wrapper components vs origin/main");
    expect(result.stderr).not.toContain("uncommitted changes");

    // A local branch literally named "origin/main" must not spoof the trust
    // anchor: only the remote-tracking ref counts.
    expect(git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]).status).toBe(0);
    expect(git(repo, ["update-ref", "refs/heads/origin/main", "main"]).status).toBe(0);
    const spoofed = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
      env,
    });

    expect(spoofed.status).toBe(1);
    expect(spoofed.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
  });

  const writer = { login: "fixture-user" };
  const quota = {
    "X-RateLimit-Resource": "core",
    "X-RateLimit-Limit": "5000",
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": "1893456000",
  };
  const rateError = { message: "API rate limit exceeded for synthetic-private-detail" };
  const preflightCases: {
    name: string;
    status?: number;
    code: number;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    graphqlQuotaExhausted?: boolean;
    diagnostic?: string;
    details?: string[];
    absent?: string[];
  }[] = [
    {
      name: "both primary quotas exhausted",
      status: 403,
      code: 1,
      body: { message: "API rate limit exceeded for synthetic-private-detail" },
      headers: quota,
      graphqlQuotaExhausted: true,
      diagnostic: "rate limited",
      details: [
        "resource=graphql; remaining=0; limit=5000",
        "reset=2030-01-01T00:00:00Z",
        "Wait until 2030-01-01T00:00:00Z (UTC), then retry manually.",
      ],
    },
    {
      name: "HTTP 429 throttle",
      status: 429,
      code: 1,
      body: {},
      diagnostic: "rate limited",
      details: ["reset=unknown", "reset time is unknown", "Wait"],
    },
    ...[200, 403].map((status) => ({
      name: `secondary HTTP ${status} throttle`,
      status,
      code: 1,
      body: { message: "You have exceeded a secondary rate limit. synthetic-private-detail" },
      headers: { ...quota, "Retry-After": "60", "X-RateLimit-Remaining": "50" },
      diagnostic: "rate limited",
      details: [
        "remaining=50",
        "reset=2030-01-01T00:00:00Z",
        "retry-after=60s",
        "Wait at least 60 seconds",
      ],
      absent: ["until 2030-01-01T00:00:00Z"],
    })),
    {
      name: "secondary throttle without retry header",
      status: 403,
      code: 1,
      body: { message: "You have exceeded a secondary rate limit." },
      diagnostic: "rate limited",
      details: ["reset=unknown", "Wait"],
    },
    {
      name: "invalid quota metadata",
      status: 200,
      code: 1,
      body: rateError,
      headers: {
        "X-RateLimit-Resource": "synthetic-private-detail",
        "X-RateLimit-Remaining": "no",
        "X-RateLimit-Limit": "5000synthetic-private-detail",
        "X-RateLimit-Reset": "999999999999999",
        "Retry-After": "synthetic-private-detail",
      },
      diagnostic: "rate limited",
      details: ["resource=unknown; remaining=unknown; limit=unknown; reset=unknown"],
    },
    {
      name: "rejected authentication",
      status: 401,
      code: 1,
      body: { message: "Bad credentials synthetic-private-detail" },
      diagnostic: "authentication unavailable",
    },
    { name: "missing authentication", code: 4, diagnostic: "authentication unavailable" },
    ...[403, 500, 503].map((status) => ({
      name: `HTTP ${status} failure`,
      status,
      code: 1,
      body: { message: "synthetic-private-detail" },
      diagnostic: "failed",
    })),
    { name: "transport failure", code: 1, diagnostic: "failed" },
    {
      name: "unknown API error",
      status: 200,
      code: 1,
      body: { errors: [{ type: "SYNTHETIC_UNKNOWN", message: "synthetic-private-detail" }] },
      headers: quota,
      diagnostic: "failed",
      details: [
        "Observed exhausted primary quota",
        "remaining=0",
        "failure cause remains unverified",
      ],
    },
    {
      name: "malformed body",
      status: 200,
      code: 1,
      rawBody: "{synthetic-private-detail",
      headers: quota,
      diagnostic: "failed",
      details: [
        "Observed exhausted primary quota",
        "remaining=0",
        "failure cause remains unverified",
      ],
    },
    {
      name: "successful process without writer",
      status: 200,
      code: 0,
      body: {},
      headers: quota,
      diagnostic: "failed",
      details: [
        "Observed exhausted primary quota",
        "remaining=0",
        "failure cause remains unverified",
      ],
    },
    {
      name: "empty writer",
      status: 200,
      code: 0,
      body: { login: "  " },
      diagnostic: "failed",
    },
    {
      name: "wrong writer type",
      status: 200,
      code: 0,
      body: { login: 42 },
      diagnostic: "failed",
    },
    {
      name: "partial writer with errors",
      status: 200,
      code: 0,
      body: { ...writer, errors: [{ type: "FORBIDDEN" }] },
      diagnostic: "failed",
    },
    {
      name: "writer with failed process",
      status: 200,
      code: 1,
      body: writer,
      diagnostic: "failed",
    },
    {
      name: "GraphQL viewer shape is not writer evidence",
      status: 200,
      code: 0,
      body: { data: { viewer: writer } },
      diagnostic: "failed",
    },
    { name: "missing HTTP framing", code: 0, body: writer, diagnostic: "failed" },
    { name: "valid writer", status: 200, code: 0, body: writer },
    { name: "successful last quota request", status: 200, code: 0, body: writer, headers: quota },
  ];

  const esmPreflightCase: (typeof preflightCases)[number] = {
    name: "valid writer below an ESM package",
    status: 200,
    code: 0,
    body: writer,
  };
  it.each([
    ...preflightCases.map((scenario) => ({
      ...scenario,
      route: "default",
      esmParent: false,
      hostname: "",
    })),
    { ...preflightCases[0]!, route: "override", esmParent: false, hostname: "" },
    { ...esmPreflightCase, route: "default", esmParent: true, hostname: "" },
    { ...esmPreflightCase, route: "override", esmParent: true, hostname: "" },
    {
      ...esmPreflightCase,
      name: "writer on the explicitly selected host",
      route: "override",
      esmParent: false,
      hostname: "github.fixture.invalid",
    },
  ])("GitHub API preflight: $name ($route)", ({ route, esmParent, hostname, ...scenario }) => {
    const quotaIntercepted =
      scenario.code !== 0 &&
      ([403, 429].includes(scenario.status ?? 0) || scenario.diagnostic === "rate limited");
    const root = tempDirs.make("openclaw-pr-auth-");
    const dir = esmParent ? join(root, "fixture") : root;
    if (esmParent) {
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(dir);
    }
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
    const body =
      scenario.rawBody ?? (scenario.body === undefined ? "" : JSON.stringify(scenario.body));
    const fakeGh = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args[1] === "rate_limit") {
  console.log(JSON.stringify({ resources: {
    graphql: { remaining: 5000, limit: 5000, reset: 1893459600 },
    core: { remaining: 4999, limit: 5000, reset: 1893459600 },
  } }));
  process.exit(0);
}
if (args.includes("graphql") && ${Boolean(scenario.graphqlQuotaExhausted)}) {
  process.stdout.write(${JSON.stringify(headers.replace("X-RateLimit-Resource: core", "X-RateLimit-Resource: graphql"))});
  console.log(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for synthetic-private-detail" }] }));
  process.exit(1);
}
if (args.includes("--include")) process.stdout.write(${JSON.stringify(headers)});
process.stdout.write(${JSON.stringify(body)});
console.error("gh: synthetic-private-detail");
process.exit(${scenario.code});
`;
    writeFileSync(
      pathGh,
      route === "default" ? fakeGh : "#!/bin/sh\necho UNEXPECTED_ROUTE >&2\nexit 99\n",
      { mode: 0o755 },
    );
    if (route === "override") {
      writeFileSync(gh, fakeGh, { mode: 0o755 });
    }
    const result = spawnSync(
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
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...env,
          OPENCLAW_GH_BIN: route === "override" ? gh : "",
          GH_TOKEN: "synthetic-token",
        },
      },
    );
    expect(result.status, result.stderr).toBe(scenario.diagnostic ? 1 : 0);
    expect(result.stdout).not.toContain("UNEXPECTED");
    expect(result.stdout + result.stderr).not.toMatch(/synthetic-private-detail|UNEXPECTED_ROUTE/);
    if (quotaIntercepted) {
      expect(result.stderr).toContain(
        `GitHub API request failed (resource=${scenario.graphqlQuotaExhausted ? "graphql" : "core"})`,
      );
      expect(result.stderr).toContain(`original response: HTTP ${scenario.status}`);
      expect(result.stderr).not.toContain("Supplemental quota probe");
      for (const detail of scenario.details ?? []) {
        expect(result.stderr).toContain(detail);
      }
      for (const detail of scenario.absent ?? []) {
        expect(result.stderr).not.toContain(detail);
      }
    } else if (scenario.diagnostic) {
      expect(result.stderr).toContain(`GitHub API preflight ${scenario.diagnostic}`);
      for (const detail of scenario.details ?? []) {
        expect(result.stderr).toContain(detail);
      }
      for (const detail of scenario.absent ?? []) {
        expect(result.stderr).not.toContain(detail);
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
    expect(
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      ["api", ...(hostname ? ["--hostname", hostname] : []), "user", "--include"],
      ...(scenario.graphqlQuotaExhausted
        ? [
            [
              "api",
              ...(hostname ? ["--hostname", hostname] : []),
              "graphql",
              "--include",
              "-f",
              "query=query{viewer{login}}",
            ],
          ]
        : []),
    ]);
  });

  it.each([
    { route: "default", host: "github.com", assigned: true, rateLimited: false },
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
      const result = spawnSync(
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
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            HOME: dir,
            GH_REPO: `${host}/fixture/repo`,
            GH_HOST: host,
            GH_TOKEN: "synthetic-writer-token",
            OPENCLAW_GH_BIN: route === "override" ? overrideGh : "",
            OPENCLAW_TEST_CALLS: calls,
            OPENCLAW_TEST_ROOT: dir,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(assigned ? 0 : 1);
      const ghCalls = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
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
        expect(readFileSync(join(dir, ".local/review-claim-user-attempt-1.log"), "utf8")).toBe(
          "writer-maintainer\n",
        );
      }
    },
  );
});
