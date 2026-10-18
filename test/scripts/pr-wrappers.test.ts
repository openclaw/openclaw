// PR wrapper tests cover maintainer helper command delegation.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
import { copyTreeCloseOnExec } from "../helpers/close-on-exec-copy.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
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
const outcomeOid = "a".repeat(40);
const selectedHead = "b".repeat(40);
const otherHead = "c".repeat(40);

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
    it.each(["RATE_LIMITED"])(
      "recognizes the original %s response with and without headers",
      (type) => {
        const body = errorBody(type);
        for (const stdout of [body, response(body), Buffer.from(response(body))]) {
          expect(classify({ status: 1, stdout })).toBe(true);
        }
      },
    );
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
    it.each([
      {
        name: "access rejection with exhausted headers",
        stdout: response(JSON.stringify({ message: "Resource not accessible by integration" })),
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
    writeFileSync(executable, `#!/bin/sh\nexit ${code}\n`);
    chmodSync(executable, 0o755);
  }
  const git = (cwd: string, args: string[]) =>
    spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
  expect(git(repo, ["add", "."]).status).toBe(0);
  expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
  const run = () =>
    spawnSync(join(linked, "scripts/pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
      env,
    });
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
  itPosix("preserves the caller's gh route environment through startup", () => {
    const fixture = makeMismatchedWrapperRepo();
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

  itPosix("requires a separate operator confirmation for merge recovery", () => {
    const fixture = makeMismatchedWrapperRepo();
    const recovery = (...args: string[]) => [
      "123",
      outcomeOid,
      "--confirmed-operator-recovery",
      ...args,
    ];
    for (const args of [
      ["123", outcomeOid],
      ["123", "", "--confirmed-operator-recovery"],
      ["123", "not-an-outcome", "--confirmed-operator-recovery"],
      ["123", outcomeOid, "--confirmed-no-running-tools"],
      recovery("--auto-merge"),
      recovery("--cancel-auto", "--cancel-auto"),
      recovery("--observed-head", selectedHead),
      ...[
        [],
        [""],
        ["HEAD"],
        ["B".repeat(40)],
        [selectedHead, "--observed-head", otherHead],
        [selectedHead, "--merged-head", otherHead],
        [selectedHead, "--replacement-head", otherHead],
        [selectedHead, "--auto-merge"],
        [selectedHead, "--body-file", "message.md"],
        [selectedHead, "--legacy-refusal", "proof"],
        [selectedHead, "--pre-dispatch-refusal", "proof"],
        [selectedHead, "--admin-evidence", "proof", "--confirmed-operator-admin"],
      ].map((suffix) => recovery("--cancel-auto", "--observed-head").concat(suffix)),
      recovery("--cancel-auto", "--body-file", "message.md"),
      recovery("--cancel-auto", "--replacement-head", selectedHead),
      ...[
        [],
        [""],
        ["HEAD"],
        ["a".repeat(39)],
        ["A".repeat(40)],
        [selectedHead, "--replacement-head", otherHead],
        [selectedHead, "--confirmed-operator-recovery"],
      ].map((suffix) => recovery("--replacement-head").concat(suffix)),
      ["123", outcomeOid, "--replacement-head", selectedHead, "--confirmed-operator-recovery"],
      ["123", outcomeOid, "--replacement-head", selectedHead],
      ["0123", outcomeOid, "--confirmed-operator-recovery", "--replacement-head", selectedHead],
      ...[
        [],
        ["HEAD"],
        ["B".repeat(40)],
        [selectedHead, "--merged-head", otherHead],
        [selectedHead, "--cancel-auto"],
        [selectedHead, "--auto-merge"],
        [selectedHead, "--replacement-head", otherHead],
        [selectedHead, "--body-file", "message.md"],
        [selectedHead, "--admin-evidence", "proof.json", "--confirmed-operator-admin"],
      ].map((suffix) => recovery("--merged-head").concat(suffix)),
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
      ["--pr", "0123"],
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
    const fixture = makeMismatchedWrapperRepo();
    if (main) {
      fixture.write("gh", baseBranchGhStub("main"), fixture.bin);
    }
    const caller = join(fixture.canonical, "nested");
    mkdirSync(caller);
    fixture.write("scripts/pr-lib/merge.sh", `merge_run() { printf '<%s>\\n' "$@"; }\n`);
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
      const fixture = makeMismatchedWrapperRepo();
      fixture.write(
        "scripts/pr-lib/merge.sh",
        `merge_complete() { printf '<%s>\\n' "$@"; }\nmerge_run() { exit 99; }\n`,
      );
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
    const fixture = makeMismatchedWrapperRepo();
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
        [
          "--admin-evidence",
          "proof.json",
          "--confirmed-operator-admin",
          "--replacement-head",
          "HEAD",
        ],
        ["--admin-evidence", "proof.json", "--confirmed-operator-admin", "--cancel-auto"],
        [
          "--admin-evidence",
          "proof.json",
          "--confirmed-operator-admin",
          "--pre-dispatch-refusal",
          "proof",
        ],
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
    const fixture = makeMismatchedWrapperRepo();
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
    const fixture = makeMismatchedWrapperRepo();
    // Stale worktree: created at the pushed main base, no local wrapper edits.
    const stale = join(fixture.root, "stale");
    const baseline = fixture.git(fixture.canonical, ["rev-parse", "main"]).stdout.trim();
    fixture.git(fixture.canonical, ["worktree", "add", "-b", "stale-feature", stale, baseline]);

    // main's wrapper then advances and the canonical checkout tracks it.
    fixture.write("scripts/pr-lib/gates.sh", 'ci_dispatch() { echo "canonical v2 executed"; }\n');
    fixture.commit(["scripts/pr-lib/gates.sh"], true);

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
    fixture.write(
      "scripts/pr-lib/gates.sh",
      'ci_dispatch() { echo "parked canonical executed"; }\n',
    );
    fixture.commit(["scripts/pr-lib/gates.sh"]);
  }

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
    expect(realpathSync(join(adapter, "git"))).toBe(realpathSync(selected));

    const reentry = run(`${adapter}${delimiter}${env.PATH}`);
    expect(reentry.status, reentry.stdout + reentry.stderr).toBe(0);
    expect(reentry.stdout).toBe("legacy wrapper completed\n");
    expect(matchingEntries(fixture.root, "openclaw-pr-git.")).toEqual(adapters);
  });

  function materializeAnchor(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    const materialized = runWrapper(fixture, ["unknown-command"]);
    expect(materialized.status, materialized.stderr).toBe(2);
    expect(materialized.stderr).toContain("running wrapper code materialized from");
    const anchors = matchingEntries(fixture.root, "openclaw-pr-anchor.");
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
    fixture.commit([inventory, dependency, "scripts/pr-lib/review-artifacts.mjs"], true);
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
      runWrapper(fixture, ["unknown-command"], "linked", {
        env: { ...fixture.env, ...env },
        maxBuffer: 8 * 1024 * 1024,
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

  const itRecovery = process.platform === "linux" ? it : it.skip;
  const mvHelp =
    process.platform === "linux" ? spawnSync("mv", ["--help"], { encoding: "utf8" }).stdout : "";
  const itExchange = mvHelp?.includes("--exchange") && mvHelp.includes("--no-copy") ? it : it.skip;
  function recoveryFixture() {
    const fixture = makeMismatchedWrapperRepo({ toolingOnly: true });
    const runtime = spawnSync(
      requireNodeTool("node"),
      [
        "-p",
        "JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })",
      ],
      { env: fixture.env, encoding: "utf8" },
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    parkCanonicalOffAnchor(fixture);
    const anchor = materializeAnchor(fixture);
    fixture.git(fixture.canonical, ["checkout", "main"]);
    const modules = join(anchor, "node_modules");
    const donor = join(fixture.root, "isolated-tooling");
    const origin = fixture.git(fixture.canonical, ["remote", "get-url", "origin"]).stdout.trim();
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
      revision: fixture.git(donor, ["rev-parse", "HEAD"]).stdout.trim(),
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
      spawnSync(requireNodeTool("node"), [helper, donorModules, modules], {
        env: fixture.env,
        encoding: "utf8",
      });
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
      const result = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: fixture.tooling });
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

  itPosix.each([
    { repairs: true, largeOutput: false },
    { repairs: false, largeOutput: false },
    { repairs: true, largeOutput: true },
  ])(
    "refreshes a stale clean main tooling root once (install repairs=$repairs, merge output over 1 MiB=$largeOutput)",
    ({ repairs, largeOutput }) => {
      const fixture = makeToolingRootFixture();
      const advanced = advanceToolingMain(fixture);
      if (largeOutput) {
        // Stands in for a far-behind root's diffstat without checking out
        // thousands of files; Git sends hook stdout to its stderr.
        const hooks = join(fixture.root, "tooling-hooks");
        mkdirSync(hooks);
        fixture.git(fixture.tooling, ["config", "core.hooksPath", hooks]);
        writeFileSync(join(hooks, "post-merge"), "#!/bin/sh\nyes x | head -c 1200000\n", {
          mode: 0o755,
        });
      }
      const target = realpathSync(join(fixture.tooling, "node_modules/tsx"));
      rmSync(join(fixture.tooling, "node_modules/tsx"));
      symlinkSync(fixture.stale, join(fixture.tooling, "node_modules/tsx"), "dir");
      const calls = join(fixture.root, "install-calls");
      fixture.write(
        "pnpm",
        `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${repairs}) {
  fs.unlinkSync(${JSON.stringify(join(fixture.tooling, "node_modules/tsx"))});
  fs.symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(join(fixture.tooling, "node_modules/tsx"))}, "dir");
}
`,
        fixture.bin,
      );
      const result = fixture.run({ OPENCLAW_PR_TOOLING_ROOT: fixture.tooling });
      expect(result.status, result.stdout + result.stderr).toBe(repairs ? 2 : 1);
      // Merge output streams to the operator instead of filling a capture buffer.
      expect(result.stderr.length).toBeGreaterThan(largeOutput ? 1_200_000 : 0);
      expect(result.stderr).toContain("has version 0.0.0; the trust anchor requires");
      expect(result.stderr).toContain(`Refreshing scripts/pr tooling root ${fixture.tooling}`);
      expect(jsonLines(calls)).toEqual([["-C", fixture.tooling, "install", "--frozen-lockfile"]]);
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
      const manifestBefore = readScript(manifest);
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
      fixture.write("pnpm", `#!/bin/sh\ntouch '${installed}'\nexit 1\n`, fixture.bin);
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
      expect(readScript(manifest)).toBe(manifestBefore + (condition === "dirty" ? "\n" : ""));
      expect(realpathSync(join(fixture.tooling, "node_modules/tsx"))).toBe(fixture.stale);
    },
  );

  itPosix.each(["canonical", "sparse", "unrelated", "subdirectory"])(
    "refuses an unsafe %s tooling root without installation",
    (condition) => {
      const fixture = makeToolingRootFixture();
      let root = fixture.tooling;
      rmSync(join(fixture.tooling, "node_modules/tsx"));
      symlinkSync(fixture.stale, join(fixture.tooling, "node_modules/tsx"), "dir");
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
      fixture.write("pnpm", `#!/bin/sh\ntouch '${installed}'\nexit 1\n`, fixture.bin);
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
    fixture.write("pnpm", `#!/bin/sh\ntouch '${installed}'\nexit 1\n`, fixture.bin);
    const result = fixture.run({
      OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
      OPENCLAW_TEST_NODE: process.execPath,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("tooling root was not refreshed");
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
    const anchors = matchingEntries(fixture.root, "openclaw-pr-anchor.");
    expect(anchors).toHaveLength(0);
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
    const git = join(fixture.bin, "git");
    writeFileSync(
      git,
      `#!/bin/sh
git_command() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -c|-C) shift 2 ;;
      -c?*|-C?*|--no-pager|--literal-pathspecs|--no-replace-objects) shift ;;
      *) printf '%s\\n' "$1"; return ;;
    esac
  done
}
command=$(git_command "$@")
if [ "$command" = archive ]; then
  "$OPENCLAW_TEST_GIT" "$@" || exit
  if [ "$OPENCLAW_TEST_FAILURE" = 'producer failure' ]; then
    exit 42
  fi
  exit 0
fi
case "$command:$OPENCLAW_TEST_FAILURE" in
  'ls-tree:listing producer failure'|'hash-object:hash producer failure')
    "$OPENCLAW_TEST_GIT" "$@" || exit
    exit 42
    ;;
  'ls-tree:unterminated listing'|'ls-tree:omitted required inventory component'|'hash-object:incomplete hash output')
    "$OPENCLAW_TEST_GIT" "$@" > "$OPENCLAW_TEST_GIT_OUTPUT" || exit
    exec "$OPENCLAW_TEST_NODE" -e '
const { readFileSync, writeFileSync } = require("node:fs");
const output = readFileSync(process.env.OPENCLAW_TEST_GIT_OUTPUT);
let changed;
if (process.env.OPENCLAW_TEST_FAILURE === "unterminated listing") {
  changed = output.subarray(0, -1);
} else {
  const separator = output.includes(0) ? 0 : 10;
  const records = [];
  let start = 0;
  for (let end = 0; end < output.length; end++) {
    if (output[end] === separator) {
      records.push(output.subarray(start, end));
      start = end + 1;
    }
  }
  const retained = process.env.OPENCLAW_TEST_FAILURE === "incomplete hash output"
    ? records.slice(0, -1)
    : records.filter((record) => !record.subarray(record.indexOf(9) + 1).equals(Buffer.from("package.json")));
  changed = Buffer.concat(retained.flatMap((record) => [record, Buffer.from([separator])]));
}
writeFileSync(1, changed);
'
    ;;
esac
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
case "$OPENCLAW_TEST_FAILURE" in
  'leaf symlink') linked_path=scripts/lib/plain-gh.mjs ;;
  'parent symlink') linked_path=scripts/lib ;;
  'tampered'|'missing') linked_path=scripts/lib/anchor-review-record.mjs ;;
  *) exit 0 ;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    case "$OPENCLAW_TEST_FAILURE" in
      missing) rm "$2/$linked_path" ;;
      tampered) printf '\\n// tampered\\n' >> "$2/$linked_path" ;;
      *) mv "$2/$linked_path" "$OPENCLAW_TEST_LINK_TARGET" || exit
         ln -s "$OPENCLAW_TEST_LINK_TARGET" "$2/$linked_path" ;;
    esac
    exit
  fi
  shift
done
exit 99
`,
    );
    chmodSync(tar, 0o755);
    const readerLog = join(fixture.root, "reader.log");
    const result = runWrapper(fixture, ["unknown-command"], "linked", {
      env: {
        ...fixture.env,
        OPENCLAW_TEST_GIT: resolveCommand("git"),
        OPENCLAW_TEST_TAR: resolveCommand("tar"),
        OPENCLAW_TEST_FAILURE: failure,
        OPENCLAW_TEST_GIT_OUTPUT: join(fixture.root, "git-output"),
        OPENCLAW_TEST_LINK_TARGET: join(fixture.root, "anchor-matching-link-target"),
        OPENCLAW_TEST_NODE: process.execPath,
        OPENCLAW_TEST_READER_LOG: readerLog,
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("Refusing to silently substitute");
    expect(result.stderr).not.toContain("running wrapper code materialized from");
    if (!sourceFault) {
      expect(
        result.stderr
          .split("\n")
          .find((line) => line.startsWith("differing wrapper components vs origin/main:")),
      ).toBe("differing wrapper components vs origin/main: scripts/pr-lib");
      expect(existsSync(readerLog)).toBe(failure !== "producer failure");
    }
    expect(matchingEntries(fixture.root, "openclaw-pr-anchor.")).toEqual([]);
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
      const anchor = materializeAnchor(fixture);
      fixture.write("gh", "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n", fixture.bin);
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
      fixture.write("gh", "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n", fixture.bin);
      const nodeExecPath = requireNodeTool("node");
      const run = (args: string[]) =>
        spawnSync(nodeExecPath, args, {
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
        nodeExecPath,
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
        baseSha: outcomeOid,
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
      fixture.write("src/anchor-value.ts", "export const value = 1;\n", fixture.linked);
      fixture.write(
        "test/probe/anchor.test.ts",
        'import { value } from "../../src/anchor-value.js";\nvoid value;\n',
        fixture.linked,
      );
      fixture.commit(["src", "test/probe"], false, fixture.linked);
      const base = fixture.git(fixture.linked, ["rev-parse", "HEAD"]).stdout.trim();
      fixture.write("src/anchor-value.ts", "export const value = 2;\n", fixture.linked);
      fixture.commit(["src/anchor-value.ts"], false, fixture.linked);
      const head = fixture.git(fixture.linked, ["rev-parse", "HEAD"]).stdout.trim();
      const planned = spawnSync(
        nodeExecPath,
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
      const anchors = matchingEntries(fixture.root, "openclaw-pr-anchor.");
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
      writeFileSync(recorder, '#!/bin/sh\nprintf \'%s\\0\' "$PWD" "$@"\nexit 73\n');
      chmodSync(recorder, 0o755);
      const caller = join(fixture.root, "caller directory");
      mkdirSync(caller);
      return { ...fixture, caller };
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
    const { repo, linked, git, run } = unanchoredWrapperFixture("openclaw-pr-wrapper-revision-");
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    for (const component of [
      "scripts/pr-lib/wrapper-components.txt",
      "scripts/pr-lib/merge.sh",
      "scripts/watch-pr-ci.mts",
      "scripts/verify-pr-hosted-gates.mts",
      "scripts/lib/local-check-runtime.mts",
    ]) {
      writeFileSync(join(linked, component), "# dirty linked\n");
      const dirtyResult = run();
      expect(dirtyResult.status, component).toBe(1);
      expect(dirtyResult.stderr, component).toContain(
        "scripts/pr wrapper files have uncommitted changes",
      );
      expect(git(linked, ["restore", component]).status).toBe(0);
    }

    writeFileSync(join(linked, "scripts", "tsx.mjs"), "// dirty preloader\n");
    const dirtyPreloaderResult = run();
    expect(dirtyPreloaderResult.status).toBe(1);
    expect(dirtyPreloaderResult.stderr).toContain(
      "scripts/pr wrapper files have uncommitted changes",
    );
    expect(git(linked, ["restore", "scripts/tsx.mjs"]).status).toBe(0);

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
