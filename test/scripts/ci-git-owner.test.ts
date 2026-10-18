import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeAll, expect, vi } from "vitest";
import { parse } from "yaml";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import { readCiCheckoutStep, renderGitTestClock } from "./ci-checkout.test-support.js";
import { runCiGitStep, type FetchResult } from "./ci-git-owner.test-support.js";
import { runDependencyFreePreflight } from "./ci-preflight-dependencies.test-support.js";

// Each case owns its checkout and process trees. Overlap their real timeout and
// drain waits, but keep subprocess pressure bounded on the four-core CI runner.
beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});

const it = createCommandTest();
const linuxIt = it.skipIf(process.platform !== "linux").concurrent;
const releasePolicyIt = it.skipIf(process.platform === "win32");
const base = "c".repeat(40);
const head = "a".repeat(40);
const policyImport =
  "from ci_git_owner import run_git, git_output, GitFailure, FetchTimeout\nimport os, subprocess\n";
const gitOwnerPath = join(process.cwd(), ".github/actions/git-owner/owner.py");
const releaseAncestryPolicyPath = join(
  process.cwd(),
  ".github/actions/git-owner/release-ancestry.py",
);
const releaseAncestryPolicy = readFileSync(releaseAncestryPolicyPath, "utf8");
const fastReleaseAncestryPolicy = releaseAncestryPolicy.replace(
  "max_fetch_seconds = 30",
  "max_fetch_seconds = 2",
);
const expiredReleaseAncestryPolicy = releaseAncestryPolicy.replace(
  "max_total_seconds = 120",
  "max_total_seconds = 0",
);

type AncestryFixture = {
  origin: string;
  root: string;
  source: string;
  target: string;
};
type GitReport = Awaited<ReturnType<typeof runCiGitStep>>;
const commandArgs = (report: GitReport, name: string) =>
  report.commands.filter(({ args }) => args[0] === name).map(({ args }) => args);
const fetchArgs = (...args: string[]) => ["fetch", "--no-tags", ...args];
const baseFetchArgs = (...args: string[]) => ["fetch", "--filter=blob:none", "--no-tags", ...args];
function expectNoPublication(report: GitReport) {
  expectReport(report, { githubOutput: "", githubSummary: "" });
}
const reportCountFields = ["fetches", "commands", "pushes", "readyAttempts"] as const;
function expectReport<K extends keyof GitReport>(
  report: GitReport,
  fields: Pick<GitReport, K>,
  lengths: Partial<Record<(typeof reportCountFields)[number], number>> = {},
) {
  for (const name in fields) {
    expect(report[name], report.output).toEqual(fields[name]);
  }
  for (const name of reportCountFields) {
    const length = lengths[name];
    if (length !== undefined) {
      expect(report[name], report.output).toHaveLength(length);
    }
  }
}
const authCleanupArgs = [
  "config",
  "--local",
  "--unset-all",
  "http.https://github.com/.extraheader",
];

function ancestryGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Detached Git maintenance can keep writing after the fixture starts cleanup.
    GIT_CONFIG_PARAMETERS:
      `${process.env.GIT_CONFIG_PARAMETERS ?? ""} 'maintenance.auto=false' 'gc.auto=0'`.trim(),
  };
}

function fixtureGit(cwd: string, args: string[], input?: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...ancestryGitEnv(),
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
    },
    input,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function fixtureCommit(origin: string, tree: string, parent: string | undefined, label: string) {
  return fixtureGit(
    process.cwd(),
    [`--git-dir=${origin}`, "commit-tree", tree, ...(parent ? ["-p", parent] : [])],
    `${label}\n`,
  );
}

function checkoutFixture(root: string, files: string[]) {
  const origin = join(root, "origin");
  const workspace = join(root, "checkout");
  mkdirSync(origin);
  mkdirSync(workspace);
  fixtureGit(origin, ["init", "--quiet"]);
  for (const file of files) {
    const destination = join(origin, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(file));
  }
  return { origin, workspace };
}
function snapshot(origin: string, label: string, parent?: string) {
  fixtureGit(origin, ["add", "."]);
  return fixtureCommit(join(origin, ".git"), fixtureGit(origin, ["write-tree"]), parent, label);
}
function checkoutEnvironment(root: string, repo: string, workflow: string) {
  const gitConfig = join(root, "gitconfig");
  writeFileSync(gitConfig, "");
  return {
    ...process.env,
    CHECKOUT_REPO: repo,
    CHECKOUT_TOKEN: "",
    WORKFLOW_SHA: workflow,
    GITHUB_WORKSPACE: join(root, "checkout"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(join(root, "origin")).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${repo}.git`,
  };
}

function createAncestryFixture(
  command: CommandFixture,
  sourceDistance: number,
  targetDistance: number,
  related = true,
): AncestryFixture {
  const root = command.createTempDir("openclaw-release-ancestry-");
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "--quiet", "--bare", origin]);
  const commits: string[] = [];
  const sourceRef = "refs/heads/release-source";
  const targetRef = "refs/heads/main";
  const commit = (ref: string, parent: number | undefined, label: string) => {
    const mark = commits.length + 1;
    const message = `${label}\n`;
    commits.push(`commit ${ref}
mark :${mark}
committer fixture <fixture@example.invalid> ${mark} +0000
data ${Buffer.byteLength(message)}
${message}${parent ? `from :${parent}\n` : ""}
`);
    return mark;
  };
  const sourceRoot = commit(sourceRef, undefined, "source root");
  const targetRoot = related ? sourceRoot : commit(targetRef, undefined, "target root");
  let source = sourceRoot;
  for (let index = 0; index < sourceDistance; index++) {
    source = commit(sourceRef, source, `source ${String(index)}`);
  }
  let target = targetRoot;
  for (let index = 0; index < targetDistance; index++) {
    target = commit(targetRef, target, `target ${String(index)}`);
  }
  fixtureGit(
    origin,
    ["fast-import", "--quiet"],
    `${commits.join("")}reset ${sourceRef}\nfrom :${source}\n\nreset ${targetRef}\nfrom :${target}\n\n`,
  );
  return {
    origin,
    root,
    source: fixtureGit(origin, ["rev-parse", sourceRef]),
    target: fixtureGit(origin, ["rev-parse", targetRef]),
  };
}

function createProvisionalMergeBaseFixture(
  command: CommandFixture,
): AncestryFixture & { base: string } {
  const root = command.createTempDir("openclaw-release-ancestry-provisional-");
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "--quiet", "--bare", origin]);
  const commits = Array.from({ length: 341 }, (_, index) => {
    const mark = index + 1;
    const parent = mark > 1 ? `from :${String(mark - 1)}\n` : "";
    return `commit refs/heads/main
mark :${String(mark)}
committer fixture <fixture@example.invalid> ${String(mark)} +0000
data 1
x
${parent}
`;
  });
  commits.push(`commit refs/heads/main
mark :342
committer fixture <fixture@example.invalid> 342 +0000
data 1
x
from :341
merge :1

`);
  for (let mark = 343; mark <= 562; mark += 1) {
    const parent = mark === 343 ? 121 : mark - 1;
    commits.push(`commit refs/heads/release-source
mark :${String(mark)}
committer fixture <fixture@example.invalid> ${String(mark)} +0000
data 1
x
from :${String(parent)}

`);
  }
  commits.push(`commit refs/heads/release-source
mark :563
committer fixture <fixture@example.invalid> 563 +0000
data 1
x
from :562
merge :1

`);
  fixtureGit(origin, ["fast-import", "--quiet"], commits.join(""));
  fixtureGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return {
    base: fixtureGit(origin, ["rev-parse", "refs/heads/main~221"]),
    origin,
    root,
    source: fixtureGit(origin, ["rev-parse", "refs/heads/release-source"]),
    target: fixtureGit(origin, ["rev-parse", "refs/heads/main"]),
  };
}

function cloneAncestrySource(fixture: AncestryFixture, name: string) {
  const checkout = join(fixture.root, name);
  fixtureGit(fixture.root, [
    "clone",
    "--quiet",
    "--depth=1",
    "--branch",
    "release-source",
    pathToFileURL(fixture.origin).href,
    checkout,
  ]);
  return checkout;
}

function writeGitProxy(
  fixture: AncestryFixture,
  name: string,
  body: string,
): { binDir: string; realGit: string } {
  const binDir = join(fixture.root, name);
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
${body}
`,
  );
  chmodSync(join(binDir, "git"), 0o755);
  return { binDir, realGit };
}

function runReleaseAncestry(
  checkout: string,
  mode: "ancestor" | "merge-base",
  env: Record<string, string> = {},
) {
  return spawnSync("python3", ["-I", "-S", gitOwnerPath, "--policy", releaseAncestryPolicyPath], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...ancestryGitEnv(),
      RELEASE_ANCESTRY_MODE: mode,
      RELEASE_ANCESTRY_TARGET_REF: "refs/heads/main",
      ...env,
    },
  });
}

function expectPolicySuccess(result: ReturnType<typeof runReleaseAncestry>, mode: string) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain(`Established release ${mode} relationship`);
}

releasePolicyIt.for([
  { sourceDistance: 8, targetDistance: 950, mode: "merge-base" },
  { sourceDistance: 64, targetDistance: 8, mode: "merge-base" },
  { sourceDistance: 0, targetDistance: 181, mode: "ancestor" },
] as const)(
  "hydrates $mode beyond shallow boundaries ($sourceDistance/$targetDistance)",
  ({ sourceDistance, targetDistance, mode }, { command }) => {
    const fixture = createAncestryFixture(command, sourceDistance, targetDistance);
    const checkout = cloneAncestrySource(fixture, "checkout");
    expectPolicySuccess(runReleaseAncestry(checkout, mode), mode);
    expect(fixtureGit(checkout, ["rev-parse", "refs/remotes/origin/main"])).toBe(fixture.target);
    if (mode === "ancestor") {
      fixtureGit(checkout, ["merge-base", "--is-ancestor", fixture.source, fixture.target]);
    } else {
      expect(fixtureGit(checkout, ["merge-base", fixture.source, fixture.target])).not.toBe("");
    }
  },
);

releasePolicyIt("deepens past a provisional shallow merge base", ({ command }) => {
  const fixture = createProvisionalMergeBaseFixture(command);
  const checkout = cloneAncestrySource(fixture, "checkout");
  expectPolicySuccess(runReleaseAncestry(checkout, "merge-base"), "merge-base");
  expect(fixtureGit(checkout, ["merge-base", fixture.source, "refs/remotes/origin/main"])).toBe(
    fixture.base,
  );
});

releasePolicyIt(
  "freezes the target SHA after the initial release ancestry fetch",
  ({ command }) => {
    const fixture = createAncestryFixture(command, 8, 220);
    const moved = fixtureCommit(
      fixture.origin,
      fixtureGit(fixture.root, [`--git-dir=${fixture.origin}`, "mktree"], ""),
      fixture.target,
      "moved target",
    );
    const marker = join(fixture.root, "target-moved");
    const proxy = writeGitProxy(
      fixture,
      "moving-git",
      `"$REAL_GIT" "$@"
status=$?
if [[ "$status" == 0 && " $* " == *" --depth=64 "* && ! -e "$MOVE_MARKER" ]]; then
  "$REAL_GIT" --git-dir="$ORIGIN" update-ref refs/heads/main "$MOVED_TARGET"
  : > "$MOVE_MARKER"
fi
exit "$status"`,
    );
    const checkout = cloneAncestrySource(fixture, "checkout");
    fixtureGit(checkout, [
      "config",
      "--add",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    expectPolicySuccess(
      runReleaseAncestry(checkout, "merge-base", {
        MOVE_MARKER: marker,
        MOVED_TARGET: moved,
        ORIGIN: fixture.origin,
        PATH: `${proxy.binDir}:${process.env.PATH ?? ""}`,
        REAL_GIT: proxy.realGit,
      }),
      "merge-base",
    );
    expect(fixtureGit(fixture.root, [`--git-dir=${fixture.origin}`, "rev-parse", "main"])).toBe(
      moved,
    );
    expect(fixtureGit(checkout, ["rev-parse", "refs/remotes/origin/main"])).toBe(fixture.target);
  },
);

releasePolicyIt.for(["target", "source", "combined"] as const)(
  "hydrates canonical ancestry branches when %s wants cannot deepen",
  (blocked, { command }) => {
    const fixture = createAncestryFixture(
      command,
      blocked === "target" ? 8 : 220,
      blocked === "target" ? 220 : 8,
    );
    const condition =
      blocked === "combined"
        ? '" $* " == *" --deepen="* && " $* " == *" +refs/heads/release-source:refs/remotes/origin/release-ancestry-source "* && " $* " == *" +refs/heads/main:refs/remotes/origin/release-ancestry-target-hydration "*'
        : `" $* " == *" --deepen=128 "* && " $* " == *" +${blocked === "target" ? fixture.target : fixture.source}:refs/remotes/origin/${blocked === "target" ? "main" : "release-ancestry-source"} "*`;
    const proxy = writeGitProxy(
      fixture,
      "branch-hydration-git",
      `if [[ " $* " == *" fetch "* && ${condition} ]]; then
  exit 0
fi
exec "$REAL_GIT" "$@"`,
    );
    const checkout = cloneAncestrySource(fixture, "checkout");
    expectPolicySuccess(
      runReleaseAncestry(checkout, "merge-base", {
        PATH: `${proxy.binDir}:${process.env.PATH ?? ""}`,
        REAL_GIT: proxy.realGit,
        ...(blocked === "target"
          ? {}
          : { RELEASE_ANCESTRY_SOURCE_REF: "refs/heads/release-source" }),
      }),
      "merge-base",
    );
    expect(fixtureGit(checkout, ["rev-parse", "refs/remotes/origin/main"])).toBe(fixture.target);
  },
);

releasePolicyIt(
  "continues hydration when changed shallow boundaries reduce visible history",
  ({ command }) => {
    const fixture = createAncestryFixture(command, 8, 1000);
    const marker = join(fixture.root, "count-observed");
    // Git can replace shallow cuts when it reaches merged history, making fewer
    // commits visible even though the frontier changed. Replay that observed
    // count transition while keeping fetches and the final ancestry proof real.
    const proxy = writeGitProxy(
      fixture,
      "non-monotonic-count-git",
      `if [[ " $* " == *" rev-list --count "* && ! -e "$COUNT_MARKER" ]]; then
  count=$("$REAL_GIT" "$@") || exit $?
  : > "$COUNT_MARKER"
  echo "$((count + 10000))"
  exit 0
fi
exec "$REAL_GIT" "$@"`,
    );
    const checkout = cloneAncestrySource(fixture, "checkout");
    expectPolicySuccess(
      runReleaseAncestry(checkout, "merge-base", {
        COUNT_MARKER: marker,
        PATH: `${proxy.binDir}:${process.env.PATH ?? ""}`,
        REAL_GIT: proxy.realGit,
      }),
      "merge-base",
    );
    expect(fixtureGit(checkout, ["rev-parse", "refs/remotes/origin/main"])).toBe(fixture.target);
  },
);

releasePolicyIt.for([false, true])(
  "rejects unprovable release history (stalled=%s)",
  (stalled, { command }) => {
    const fixture = createAncestryFixture(command, 8, stalled ? 220 : 12, stalled);
    const proxy = stalled
      ? writeGitProxy(
          fixture,
          "no-progress-git",
          `if [[ " $* " == *" fetch "* && " $* " == *" --deepen=128 "* ]]; then
  exit 0
fi
exec "$REAL_GIT" "$@"`,
        )
      : undefined;
    const checkout = cloneAncestrySource(fixture, "checkout");
    const result = runReleaseAncestry(
      checkout,
      "merge-base",
      proxy
        ? {
            PATH: `${proxy.binDir}:${process.env.PATH ?? ""}`,
            REAL_GIT: proxy.realGit,
          }
        : {},
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(stalled ? 125 : 1);
    expect(result.stdout).toContain(
      stalled ? "completed without ancestry progress" : "is invalid after complete history",
    );
    if (!stalled) {
      expect(fixtureGit(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    }
  },
);

releasePolicyIt.for([
  { label: "timeout retry", fetchResults: ["hang", 0], code: 0, policy: fastReleaseAncestryPolicy },
  { label: "Git retry", fetchResults: [23, 0], code: 0, policy: releaseAncestryPolicy },
  {
    label: "exhausted retries",
    fetchResults: [23, 23, 23],
    code: 23,
    policy: releaseAncestryPolicy,
  },
  { label: "expired budget", fetchResults: [], code: 124, policy: expiredReleaseAncestryPolicy },
] satisfies { label: string; fetchResults: FetchResult[]; code: number; policy: string }[])(
  "preserves bounded release ancestry outcomes: $label",
  { timeout: 55_000 },
  async ({ fetchResults, code, policy }, { signal }) => {
    const report = await runCiGitStep({
      signal,
      policy,
      env: {
        RELEASE_ANCESTRY_MODE: "merge-base",
        RELEASE_ANCESTRY_TARGET_REF: "refs/heads/main",
      },
      fetchResults,
      commandResults:
        code === 124
          ? undefined
          : {
              "rev-parse --verify HEAD^{commit}": { code: 0, output: `${head}\n` },
              ...(code === 0
                ? {
                    "rev-parse --verify refs/remotes/origin/main^{commit}": {
                      code: 0,
                      output: `${base}\n`,
                    },
                    "rev-parse --is-shallow-repository": { code: 0, output: "false\n" },
                    [`merge-base ${head} ${base}`]: { code: 0, output: `${base}\n` },
                  }
                : {}),
            },
    });
    expectReport(report, { code }, { fetches: fetchResults.length });
    if (code === 0) {
      expect(report.output).toContain("fetch failed on attempt 1; retrying");
    } else if (code === 124) {
      expect(report.commands).toEqual([]);
    }
  },
);

it("materializes an executable preflight manifest from the workflow revision", async ({
  command,
}) => {
  const root = command.createTempDir("ci-preflight-harness-");
  const { origin, workspace } = checkoutFixture(root, [
    ".github/actions/setup-node-env/action.yml",
    ".github/actions/git-owner/test-prerequisites.mjs",
    ".github/actions/git-owner/test-prerequisites.json",
    "scripts/ci-build-manifest.mjs",
    "scripts/lib/ci-ios-smoke-plan.mjs",
    "scripts/lib/release-context.mjs",
    "scripts/lib/release-version.mjs",
  ]);
  const revision = snapshot(origin, "workflow fixture");
  fixtureGit(origin, ["update-ref", "HEAD", revision]);
  const checkout = await command.run(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", gitOwnerPath],
    {
      cwd: workspace,
      env: {
        ...checkoutEnvironment(root, "fixture/preflight", revision),
        CHECKOUT_KIND: "preflight",
        CHECKOUT_REF: revision,
        CHECKOUT_FALLBACK_REF: revision,
        GITHUB_EVENT_NAME: "pull_request",
      },
    },
  );
  expect(checkout.status, `${checkout.stdout}\n${checkout.stderr}`).toBe(0);
  // The workflow's native Node manifest uses registerHooks to forbid runtime dependencies.
  const { result, manifest } = runDependencyFreePreflight(
    pathToFileURL(join(workspace, ".ci-harness/scripts/ci-build-manifest.mjs")),
    root,
    resolveTestNodeExecPath(),
  );
  expect(result.status, result.stderr).toBe(0);
  expect(manifest).toContain("run_windows=true\n");
  expect(fixtureGit(workspace, ["status", "--porcelain"])).toBe("");
});

linuxIt.for([
  { shape: "same", event: "pull_request" },
  { shape: "different", event: "pull_request" },
  { shape: "same", event: "schedule" },
  { shape: "different", event: "schedule" },
])(
  "executes trusted additional checks after a $shape-SHA $event checkout",
  async ({ shape, event }, { command }) => {
    const root = command.createTempDir("ci-additional-harness-");
    const script = "scripts/ci-additional-checks.sh";
    const trustedScript = readFileSync(script, "utf8");
    const { origin, workspace } = checkoutFixture(root, [
      ".github/actions/setup-node-env/action.yml",
      script,
      "scripts/ci-collect-checks.sh",
    ]);
    const workflow = snapshot(origin, "trusted workflow");
    let target = workflow;
    if (shape === "different") {
      writeFileSync(join(origin, script), "echo untrusted-candidate-script >&2\nexit 99\n");
      target = snapshot(origin, "different candidate", workflow);
    }
    fixtureGit(origin, ["update-ref", "HEAD", target]);
    const checkout = await command.run("python3", ["-I", "-S", gitOwnerPath], {
      cwd: workspace,
      env: {
        ...checkoutEnvironment(root, "fixture/additional", workflow),
        CHECKOUT_KIND: "linux-node",
        CHECKOUT_SHA: target,
        CHECKOUT_BASE_SHA: "",
        CHECKOUT_GIT_COMMITS_JSON: "[]",
        GITHUB_EVENT_NAME: event,
      },
    });
    expect(checkout.status, `${checkout.stdout}\n${checkout.stderr}`).toBe(0);
    expect(readFileSync(join(workspace, ".ci-harness", script), "utf8")).toBe(trustedScript);
    if (shape === "different") {
      expect(fixtureGit(join(workspace, ".ci-harness"), ["rev-parse", "HEAD"])).toBe(workflow);
      expect(readFileSync(join(workspace, script), "utf8")).toContain("untrusted-candidate-script");
    }
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$PROBE_COMMAND"\n');
    chmodSync(join(bin, "pnpm"), 0o755);
    const probe = join(root, "invoked-command");
    const run = await command.run("bash", [`.ci-harness/${script}`], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        ADDITIONAL_CHECK_GROUP: "runtime-topology-architecture",
        PROBE_COMMAND: probe,
      },
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(readFileSync(probe, "utf8")).toBe("check:architecture\n");
    expect(fixtureGit(workspace, ["status", "--porcelain"])).toBe("");
  },
);

// Ask Bash to decode the source independently of the generator and fixture codec.
it("keeps exactly one byte-identical generated CI owner", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const source = readFileSync(".github/actions/git-owner/owner.py", "utf8");
  const projections = [
    ...workflow.matchAll(/^ {10}run_owner '[\s\S]*?^ {10}# End generated CI Git owner\.$/gmu),
  ];
  expect(projections).toHaveLength(1);
  for (const [projection] of projections) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e"], {
      encoding: "utf8",
      input: "run_owner() { printf '%s' \"$1\"; }\n" + projection.replace(/^ {10}/gmu, ""),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(source);
  }
});

it("launches the Windows checkout owner below the native command-line limit", ({ command }) => {
  const root = command.createTempDir("ci-owner-windows-argv ");
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner temp");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  const python = join(bin, "python");
  writeFileSync(python, "#!/usr/bin/env bash\nprintf '%s\\0' \"$@\"\n");
  chmodSync(python, 0o755);
  const checkout = readCiCheckoutStep("checks-windows").run;
  const owner =
    renderGitTestClock(readFileSync(".github/actions/git-owner/owner.py", "utf8")) +
    `\n#${"x".repeat(32_768)}\n`;
  const source = checkout.replace(
    /^run_owner '[\s\S]*?'\n# End generated CI Git owner\.$/mu,
    () => `run_owner '${owner.replaceAll("'", "'\\''")}'\n# End generated CI Git owner.`,
  );
  expect(source).not.toBe(checkout);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e"], {
    // Git for Windows prepends its tools; restore the Python probe boundary inside Bash.
    input:
      (process.platform === "win32"
        ? 'export PATH="$(cygpath -u "$OWNER_PROBE_BIN"):$PATH"\n'
        : "") + source,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      OWNER_PROBE_BIN: bin,
      RUNNER_OS: "Windows",
      RUNNER_TEMP: runnerTemp.replaceAll("\\", "/"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const args = result.stdout.split("\0").slice(0, -1);
  expect(args).toEqual(["-I", "-S", `${runnerTemp.replaceAll("\\", "/")}/ci-git-owner.py`]);
  expect(args.join(" ").length).toBeLessThan(1_024);
  const materialized = readFileSync(join(runnerTemp, "ci-git-owner.py"), "utf8");
  expect(materialized).toBe(owner);
  // Fixed padding keeps the oversized-source regression meaningful if the owner shrinks.
  expect(materialized.length + (materialized.match(/"/gu)?.length ?? 0) + 2).toBeGreaterThan(
    32_767,
  );
});

it("binds read-only checkout authentication only to the workflow repository", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    permissions: Record<string, string>;
    jobs: Record<
      string,
      { permissions?: Record<string, string>; steps?: { env?: Record<string, string> }[] }
    >;
  };
  let ownedCheckouts = 0;
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.env?.CHECKOUT_REPO) {
        continue;
      }
      ownedCheckouts++;
      const sameRepository = step.env.CHECKOUT_REPO === "${{ github.repository }}";
      expect(step.env.CHECKOUT_TOKEN).toBe(sameRepository ? "${{ github.token }}" : undefined);
      if (sameRepository) {
        expect((job.permissions ?? workflow.permissions).contents).toBe("read");
      }
    }
  }
  expect(ownedCheckouts).toBeGreaterThan(0);
});

it.for([false, true])(
  "preserves linked Git metadata (reclaim locks=%s)",
  async (reclaimLocks, { signal }) => {
    const invocation = reclaimLocks
      ? 'run_git(os.getcwd(), "fetch", "origin", "fixture", reclaim_locks=True)'
      : 'print(git_output(os.getcwd(), "rev-parse", "HEAD"), end="")';
    const report = await runCiGitStep({
      signal,
      fetchResults: [],
      policy:
        policyImport +
        `from pathlib import Path
shared = Path.cwd().parent / "shared-git"
shared.mkdir()
lock = shared / "shallow.lock"
lock.write_text("not invocation-owned\\n")
metadata = Path(".git")
metadata.write_text("gitdir: ../shared-git\\n")
try:
    ${invocation}
finally:
    assert metadata.read_text() == "gitdir: ../shared-git\\n"
    assert lock.read_text() == "not invocation-owned\\n"
`,
    });
    expect(report.code, report.output).toBe(reclaimLocks ? 125 : 0);
    expect(report.commands.map(({ args }) => args)).toEqual(
      reclaimLocks ? [] : [["rev-parse", "HEAD"]],
    );
    if (!reclaimLocks) {
      expect(report.output).toBe(`${head}${EOL}`);
    }
  },
);

it("reclaims failed supplemental-fetch locks before the next attempt", async ({ signal }) => {
  const report = await runCiGitStep({
    signal,
    job: "checks-fast-core",
    step: "Prepare release-gate ratchet merge tree",
    fetchResults: ["hang", 0],
    prepare: true,
  });
  expectReport(report, { code: 0, readyAttempts: [1, 2] }, { fetches: 2 });
});

linuxIt(
  "bootstraps only action-owned bytes outside the candidate with isolated Python",
  async ({ signal }) => {
    const report = await runCiGitStep({
      signal,
      action: "git-owner",
      fetchResults: [],
      poisonPython: true,
    });
    expectReport(report, { code: 0, commands: [] });
    expect(report.githubEnv).toContain("CI_GIT_OWNER=");
  },
);

it.for([
  ["distant shallow base", 470, true, false, false],
  ["final shallow fallback", 8, true, true, false],
  ["complete checkout fallback", 1, false, true, false],
  ["unavailable base", 8, true, true, true],
] as const)(
  "recovers real base history: %s",
  async ([_label, depth, shallow, blockDeepen, unavailable], { command }) => {
    const root = command.createTempDir("openclaw-ensure-base-");
    const origin = join(root, "origin.git");
    const checkout = join(root, "checkout");
    const commandLog = join(root, "git-commands.log");
    fixtureGit(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    fixtureGit(origin, ["config", "uploadpack.allowFilter", "true"]);
    const commits = Array.from({ length: depth + 1 }, (_, index) => {
      const message = `fixture ${index}\n`;
      const parent = index > 0 ? `from :${index}\n` : "";
      return `commit refs/heads/main
mark :${index + 1}
committer fixture <fixture@example.invalid> ${1_700_000_000 + index} +0000
data ${Buffer.byteLength(message)}
${message}${parent}M 100644 inline fixture.txt
data ${Buffer.byteLength(message)}
${message}
`;
    });
    fixtureGit(origin, ["fast-import", "--quiet"], commits.join(""));
    let baseSha = fixtureGit(origin, ["rev-parse", `main~${depth}`]);
    fixtureGit(root, [
      "clone",
      "--quiet",
      "--filter=blob:none",
      ...(shallow ? ["--depth=2"] : []),
      pathToFileURL(origin).href,
      checkout,
    ]);
    if (!shallow) {
      const previous = fixtureGit(origin, ["rev-parse", "main"]);
      fixtureGit(
        origin,
        ["fast-import", "--quiet"],
        `commit refs/heads/main
committer fixture <fixture@example.invalid> 1700000002 +0000
data 14
remote update
from ${previous}
M 100644 inline fixture.txt
data 14
remote update

`,
      );
      baseSha = fixtureGit(origin, ["rev-parse", "main"]);
    }
    const actionPath = join(process.cwd(), ".github/actions/ensure-base-commit");
    const fixtureActionPath = join(root, "trusted-actions", "ensure-base-commit");
    const fixtureOwnerPath = join(root, "trusted-actions", "git-owner");
    mkdirSync(fixtureActionPath, { recursive: true });
    mkdirSync(fixtureOwnerPath);
    writeFileSync(
      join(fixtureOwnerPath, "owner.py"),
      readFileSync(join(actionPath, "../git-owner/owner.py")),
    );
    // Intercept the public policy boundary without a batch layer altering native Git arguments.
    writeFileSync(
      join(fixtureActionPath, "policy.py"),
      `import json, os, runpy
import ci_git_owner

real_run_git = ci_git_owner.run_git
def observed_run_git(directory, *arguments, **options):
    environment = {**os.environ, **(options.get("env") or {})}
    with open(os.environ["GIT_COMMAND_LOG"], "a", encoding="utf-8") as output:
        output.write(json.dumps({"args": arguments, "noLazyFetch": environment.get("GIT_NO_LAZY_FETCH") or "unset"}) + "\\n")
    if "fetch" in arguments:
        if arguments[-1] == os.environ["BASE_SHA"] or os.environ["DENY_ALL_FETCHES"] == "1":
            raise ci_git_owner.GitFailure(128)
        if os.environ["BLOCK_DEEPEN"] == "1" and any(arg.startswith("--deepen=") for arg in arguments):
            raise ci_git_owner.GitFailure(128)
    return real_run_git(directory, *arguments, **options)

ci_git_owner.run_git = observed_run_git
runpy.run_path(os.environ["BASE_REAL_POLICY_PATH"], run_name="__main__")
`,
    );
    const localProbe = () =>
      spawnSync("git", ["-C", checkout, "rev-parse", "--verify", `${baseSha}^{commit}`], {
        encoding: "utf8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      });
    expect(localProbe().status).toBe(128);
    const action = parse(readFileSync(join(actionPath, "action.yml"), "utf8")) as {
      runs: { steps: { run: string }[] };
    };
    const result = await command.run("bash", ["--noprofile", "--norc", "-eo", "pipefail"], {
      cwd: checkout,
      encoding: "utf8",
      input: expectDefined(action.runs.steps[0], "ensure-base-commit action step").run,
      env: {
        ...process.env,
        BASE_ACTION_PATH: fixtureActionPath.replaceAll("\\", "/"),
        BASE_REAL_POLICY_PATH: join(actionPath, "policy.py").replaceAll("\\", "/"),
        BASE_SHA: baseSha,
        FETCH_REF: "main",
        RUNNER_OS:
          process.platform === "win32"
            ? "Windows"
            : process.platform === "linux"
              ? "Linux"
              : "macOS",
        GIT_COMMAND_LOG: commandLog,
        GIT_NO_LAZY_FETCH: "",
        BLOCK_DEEPEN: blockDeepen ? "1" : "0",
        DENY_ALL_FETCHES: unavailable ? "1" : "0",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(unavailable ? 1 : 0);
    const commands = readFileSync(commandLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; noLazyFetch: string });
    const probes = commands.filter(({ args }) => args.includes("rev-parse"));
    expect(probes.length).toBeGreaterThan(1);
    expect(probes.every(({ noLazyFetch }) => noLazyFetch === "1")).toBe(true);
    const commitProbes = probes.filter(({ args }) => args.includes("--verify"));
    expect(commitProbes.length).toBeGreaterThan(1);
    expect(commitProbes.every(({ args }) => args.at(-1) === `${baseSha}^{commit}`)).toBe(true);
    const fetches = commands.filter(({ args }) => args.includes("fetch"));
    expect(fetches.every(({ args }) => args.includes("--filter=blob:none"))).toBe(true);
    expect(fetches.every(({ noLazyFetch }) => noLazyFetch === "unset")).toBe(true);
    expect(fetches.some(({ args }) => args.includes("--unshallow"))).toBe(shallow && blockDeepen);
    if (unavailable) {
      expect(result.stdout).toContain("::error title=ensure-base-commit missing base::");
      expect(localProbe().status).toBe(128);
      return;
    }
    expect(localProbe().status).toBe(0);
    expect(fixtureGit(checkout, ["diff", "--name-only", baseSha, "HEAD"])).toBe("fixture.txt");
    // Normal downstream reads must still hydrate historical blobs after local-only probes.
    expect(fixtureGit(checkout, ["show", `${baseSha}:fixture.txt`])).toBe(
      shallow ? "fixture 0" : "remote update",
    );
    if (blockDeepen) {
      expect(result.stdout).toContain("Resolved base commit after full ref fetch");
      expect(fixtureGit(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    } else {
      expect(fetches.some(({ args }) => args.includes("--deepen=1000"))).toBe(true);
    }
  },
);

linuxIt(
  "drains a timed-out exact fetch before deepening for the base",
  async ({ signal }) => {
    const report = await runCiGitStep({
      signal,
      action: "ensure-base-commit",
      baseAvailableAfter: 2,
      fetchResults: ["hang", 0],
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches.map(({ args }) => args)).toEqual([
      baseFetchArgs("--depth=1", "origin", base),
      baseFetchArgs("--deepen=25", "origin", "--", "fixture-base"),
    ]);
  },
  55_000,
);

linuxIt.for([
  { label: "empty", sha: "", code: 0, commands: 0 },
  { label: "all-zero", sha: "00000", code: 0, commands: 0 },
  { label: "invalid SHA", sha: "--help", code: 2, commands: 0 },
  { label: "short SHA rejected", sha: "a".repeat(6), code: 2, commands: 0 },
  { label: "long SHA rejected", sha: "a".repeat(41), code: 2, commands: 0 },
  { label: "short uppercase SHA accepted", sha: "ABCDEF1", code: 0, commands: 2 },
  { label: "invalid ref", sha: base, invalidRef: true, code: 2, commands: 1 },
  { label: "already available", sha: base, code: 0, commands: 2 },
])(
  "base policy preserves $label validation and skip behavior",
  async ({ sha, code, commands, invalidRef }, { signal }) => {
    const report = await runCiGitStep({
      signal,
      action: "ensure-base-commit",
      env: { BASE_SHA: sha },
      invalidRef,
      baseAvailableAfter: 0,
      fetchResults: [],
    });
    expectReport(report, { code, fetches: [] }, { commands });
  },
);

linuxIt.for([1, 2, 6, undefined])(
  "base policy preserves exact/deepen/plain-ref order (available after %s)",
  { timeout: 55_000 },
  async (baseAvailableAfter, { signal }) => {
    const report = await runCiGitStep({
      signal,
      action: "ensure-base-commit",
      baseAvailableAfter,
      fetchResults: [0, 23, 0, 23, 0, 0],
      commandResults: {
        "rev-parse --is-shallow-repository": { code: 0, output: "false\n" },
      },
      poisonPython: true,
    });
    expect(report.code, report.output).toBe(baseAvailableAfter ? 0 : 1);
    const expected = [
      baseFetchArgs("--depth=1", "origin", base),
      ...[25, 100, 300, 1000].map((depth) =>
        baseFetchArgs(`--deepen=${depth}`, "origin", "--", "fixture-base"),
      ),
      baseFetchArgs("origin", "--", "fixture-base"),
    ].slice(0, baseAvailableAfter ?? 6);
    expect(report.fetches.map(({ args }) => args)).toEqual(expected);
    expect(
      report.fetches.every(
        ({ configuration }) => configuration?.join(" ") === "protocol.version=2",
      ),
    ).toBe(true);
    expect(
      report.commands.filter(({ args }) => args[0] === "rev-parse" && args[1] === "--verify"),
    ).toHaveLength(expected.length + 1);
    if (!baseAvailableAfter) {
      expect(report.output).toContain("::error title=ensure-base-commit missing base::");
    }
  },
);

linuxIt.for([125, 143, "hang"] as const)(
  "base remains available after safely drained ordinary outcome %s",
  { timeout: 55_000 },
  async (failure, { signal }) => {
    const report = await runCiGitStep({
      signal,
      action: "ensure-base-commit",
      baseAvailableAfter: 1,
      fetchResults: [failure],
    });
    expectReport(report, { code: 0 }, { fetches: 1 });
    expect(report.output).toContain("exact fetch failed");
    expect(report.output).toContain("Resolved base commit after exact fetch");
  },
);

linuxIt.for([
  { label: "inspection failure", result: "cleanup-failure", code: 125 },
  { label: "cancellation", result: "hang", scenario: "cancel-SIGTERM", code: 143 },
  {
    label: "cancellation during timeout drain",
    result: "hang",
    cancelDuringCleanup: true,
    code: 143,
  },
] as const)(
  "base policy stops before availability/retry on $label",
  { timeout: 55_000 },
  async ({ result, code, ...entry }, { signal }) => {
    const report = await runCiGitStep({
      signal,
      action: "ensure-base-commit",
      baseAvailableAfter: 1,
      fetchResults: [result],
      realDrain: true,
      scenario: "scenario" in entry ? entry.scenario : undefined,
      cancelDuringCleanup: "cancelDuringCleanup" in entry,
    });
    expectReport(report, { code }, { fetches: 1 });
    expect(report.commands.filter(({ args }) => args[0] === "rev-parse")).toHaveLength(1);
    expect(report.output).not.toContain("Resolved base commit");
    expect(report.cancelledDuringCleanup).toBe("cancelDuringCleanup" in entry);
  },
);

linuxIt(
  "keeps the base action's 30-second fetch deadline and drains before recovery",
  async ({ signal }) => {
    const report = await runCiGitStep({
      signal,
      action: "ensure-base-commit",
      baseAvailableAfter: 1,
      fetchResults: ["hang"],
      realClock: true,
      readyFetchClockAdvanceSeconds: 30,
    });
    expect(report.code, report.output).toBe(0);
    expect(report.output).toContain("exact fetch failed");
    expect(report.readyAttempts).toEqual([1]);
    expect(report.output.match(/fixture fetch timeout: \d+/gu)).toEqual([
      "fixture fetch timeout: 30",
    ]);
    expect(report.fetchClockAdvancedSeconds).toBe(30);
  },
  55_000,
);

linuxIt(
  "fences later calls even if a trusted policy accidentally catches an ownership failure",
  async ({ signal }) => {
    const report = await runCiGitStep({
      signal,
      fetchResults: ["cleanup-failure"],
      policy:
        policyImport +
        `try:
    run_git(os.getcwd(), "fetch", "origin", "fixture")
except Exception:
    try:
        run_git(os.getcwd(), "rev-parse", "HEAD")
    except RuntimeError:
        print("closed owner rejected reuse")
    else:
        raise AssertionError("closed owner spawned Git")
`,
    });
    expectReport(report, { code: 125 }, { commands: 1 });
    expect(report.output).toContain("closed owner rejected reuse");
  },
);

linuxIt.for(
  [false, true].flatMap((inlinePolicy) =>
    ([125, "cleanup-failure"] as const).map((failure) => ({ inlinePolicy, failure })),
  ),
)(
  "preserves generic output and typed recovery (stdin=$inlinePolicy, outcome=$failure)",
  { timeout: 55_000 },
  async ({ inlinePolicy, failure }, { signal }) => {
    const output = " \tpath\0another path\r\n\n\n";
    const report = await runCiGitStep({
      signal,
      fetchResults: [failure],
      inlinePolicy,
      revisions: { HEAD: output.slice(0, -1) },
      policy:
        policyImport +
        `import sys
assert "RUNNER_OS" not in os.environ
assert "GITHUB_WORKSPACE" not in os.environ
try:
    run_git(os.getcwd(), "fetch", "origin", "fixture", env={"CI_OWNER_PROBE": "child-only"})
except GitFailure as error:
    assert error.code == 125
assert "CI_OWNER_PROBE" not in os.environ
sys.stdout.write(git_output(os.getcwd(), "rev-parse", "HEAD", env={"CI_OWNER_PROBE": "output-only"}))
`,
      poisonPython: true,
    });
    if (failure === "cleanup-failure") {
      expectReport(report, { code: 125 }, { commands: 1 });
      expect(report.output).toContain("Git ownership/setup failed");
      expect(report.output).not.toContain("path");
    } else {
      expectReport(report, { code: 0, output });
      expect(report.commands).toHaveLength(2);
      expect(report.commands.map(({ envProbe }) => envProbe)).toEqual([
        "child-only",
        "output-only",
      ]);
    }
  },
);

linuxIt.for([0, 23, "cleanup-failure"] as const)(
  "generic Git output drains its writers before consumption (%s)",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const output = `${head}\trefs/heads/main\n`;
    const report = await runCiGitStep({
      signal,
      policy:
        policyImport +
        'import sys\nsys.stdout.write(git_output(os.getcwd(), "ls-remote", "origin", "refs/heads/main"))\n',
      fetchResults: [],
      lsRemoteResults: [{ code, output }],
    });
    expect(report.code, report.output).toBe(code === "cleanup-failure" ? 125 : code);
    expect(report.commands.map(({ args }) => args)).toEqual([
      ["ls-remote", "origin", "refs/heads/main"],
    ]);
    expect(report.readyAttempts).toEqual([1]);
    if (code === 0) {
      expect(report.output).toBe(output);
    } else {
      expect(report.output).not.toContain(output);
    }
  },
);

const posixIt = it.skipIf(process.platform === "win32").concurrent;
const auditFiles = [".pre-commit-config.yaml", ".github/zizmor.yml"];
const branch = "refs/remotes/origin/main";
const auditObjects = Object.fromEntries(
  [base, branch].flatMap((ref) =>
    auditFiles.map((file) => [
      `${ref}:${file}`,
      {
        text: `# ${ref}\n${file === auditFiles[0] ? "config: .github/zizmor.yml" : "rules: {}"}\n`,
      },
    ]),
  ),
);
function requireAuditObject(ref: string, file: string) {
  const object = auditObjects[`${ref}:${file}`];
  if (!object) {
    throw new Error(`Missing audit fixture object: ${ref}:${file}`);
  }
  return object;
}
const sanity = (
  signal: AbortSignal,
  options: Omit<Parameters<typeof runCiGitStep>[0], "workflow" | "signal">,
) =>
  runCiGitStep({
    signal,
    ...options,
    workflow: "workflow-sanity",
    objects: { ...auditObjects, ...options.objects },
  });

type SanityFetchCase = [
  label: string,
  fetchResults: FetchResult[],
  refs: string[],
  warnings?: number,
  code?: number,
  baseAvailableAfter?: number,
];
const sanityFetchCases: SanityFetchCase[] = [
  ["already present", [], [], 0, 0, 0],
  ["exact success", [0], [base]],
  ...[125, 143].map<SanityFetchCase>((code) => [
    `ordinary ${code}`,
    [code, 0],
    [base, "refs/heads/main"],
  ]),
  ...[124, 137].flatMap<SanityFetchCase>((code) => [
    [`ordinary ${code} retry`, [code, 0], [base, base], 1],
    [
      `ordinary ${code} exhaustion`,
      Array(6).fill(code),
      [...Array(3).fill(base), ...Array(3).fill("refs/heads/main")],
      4,
      code,
    ],
  ]),
  [
    "FetchTimeout exhaustion then branch",
    ["hang", "hang", "hang", 0],
    [base, base, base, "refs/heads/main"],
    2,
  ],
  [
    "FetchTimeout both refs exhausted",
    Array(6).fill("hang"),
    [...Array(3).fill(base), ...Array(3).fill("refs/heads/main")],
    4,
    124,
  ],
];

posixIt.for(sanityFetchCases)(
  "workflow sanity preserves fetch policy: %s",
  { timeout: 55_000 },
  async ([_label, fetchResults, refs, warnings = 0, code = 0, baseAvailableAfter], { signal }) => {
    const report = await sanity(signal, { fetchResults, baseAvailableAfter });
    expect(report.code, report.output).toBe(code);
    expect(report.fetches.map(({ args }) => args)).toEqual(
      refs.map((ref) =>
        fetchArgs(
          "--depth=1",
          "origin",
          `+${ref}:${ref === base ? "refs/remotes/origin/security-base" : branch}`,
        ),
      ),
    );
    expect(
      report.fetches.every(
        ({ configuration, cwd }) => configuration?.length === 0 && cwd === report.workspace,
      ),
    ).toBe(true);
    expect(report.output.match(/timed out on attempt [12]; retrying/gu) ?? []).toHaveLength(
      warnings,
    );
    expect(commandArgs(report, "cat-file")).toEqual([
      ["cat-file", "-e", `${base}^{commit}`],
      ...(code === 0 ? auditFiles.map((file) => ["cat-file", "-e", `${base}:${file}`]) : []),
    ]);
    expect(report.githubEnv).toBe(
      code === 0 ? `PRE_COMMIT_CONFIG_PATH=${report.runnerTemp}/pre-commit-base.yaml\n` : "",
    );
    if (code === 0) {
      expect(report.trustedConfig).toBe(
        `# ${base}\nconfig: ${report.runnerTemp}/zizmor-base.yml\n`,
      );
      expect(report.trustedZizmor).toBe(`# ${base}\nrules: {}\n`);
    } else {
      expectReport(report, { trustedConfig: "", trustedZizmor: "" });
    }
  },
);

posixIt.for([
  { label: "30-second fetch deadline", fetchResults: ["hang", 0], warnings: 1 },
  { label: "five-second backoff", fetchResults: [137, 0], warnings: 1 },
] as const)(
  "workflow sanity retains $label",
  { timeout: 55_000 },
  async ({ fetchResults, warnings }, { signal }) => {
    const readyFetchClockAdvanceSeconds = fetchResults[0] === "hang" ? 30 : undefined;
    const report = await sanity(signal, {
      fetchResults: [...fetchResults],
      realClock: true,
      virtualBackoff: true,
      cooperativeTrees: true,
      readyFetchClockAdvanceSeconds,
    });
    expectReport(report, { code: 0 }, { fetches: 2 });
    expect(report.output.match(/; retrying/gu) ?? []).toHaveLength(warnings);
    expect(report.fetchClockAdvancedSeconds).toBe(readyFetchClockAdvanceSeconds);
    if (readyFetchClockAdvanceSeconds !== undefined) {
      expect(report.output.match(/fixture fetch timeout: \d+/gu)).toEqual([
        "fixture fetch timeout: 30",
        "fixture fetch timeout: 30",
      ]);
    }
    expect(report.output.match(/fixture backoff: \d+/gu)).toEqual(["fixture backoff: 5"]);
    const elapsed =
      (report.backoffClockAdvancedSeconds + (report.fetchClockAdvancedSeconds ?? 0)) * 1000;
    expect(elapsed).toBeGreaterThanOrEqual(fetchResults[0] === "hang" ? 35_000 : 5_000);
  },
);

posixIt.for([
  { label: "owner inspection failure", fetchResults: ["cleanup-failure"], code: 125 },
  { label: "fetch cancellation", fetchResults: ["hang"], scenario: "cancel-SIGTERM", code: 143 },
  {
    label: "timeout drain cancellation",
    fetchResults: ["hang"],
    cancelDuringCleanup: true,
    code: 143,
  },
  {
    label: "backoff cancellation",
    fetchResults: [124],
    cancelDuringBackoff: true,
    realClock: true,
    cooperativeTrees: true,
    code: 143,
  },
  { label: "missing owner", fetchResults: [], setupFailure: "owner", code: 2 },
  {
    label: "missing Python interpreter",
    fetchResults: [],
    setupFailure: "python",
    code: "launcher",
  },
  { label: "Git spawn failure", fetchResults: [], setupFailure: "git", code: 125 },
] satisfies (Partial<Parameters<typeof runCiGitStep>[0]> & {
  label: string;
  code: number | "launcher";
  fetchResults: FetchResult[];
})[])(
  "workflow sanity never recovers or publishes after $label",
  { timeout: 55_000 },
  async ({ label: _label, code, ...options }, { signal }) => {
    const report = await sanity(signal, options);
    if (code === "launcher") {
      // Bash versions differ for a found executable whose interpreter is missing.
      expect([126, 127], report.output).toContain(report.code);
    } else {
      expect(report.code, report.output).toBe(code);
    }
    expect(report.fetches).toHaveLength(options.fetchResults.length);
    expect(commandArgs(report, "show")).toEqual([]);
    expectReport(report, {
      githubEnv: "",
      trustedConfig: "",
      trustedZizmor: "",
      cancelledDuringCleanup: Boolean(options.cancelDuringCleanup),
    });
    expect(report.boundaries.some(({ name }) => name === "backoff-cancel")).toBe(
      Boolean(options.cancelDuringBackoff),
    );
  },
);

posixIt.for([0, 1])(
  "workflow sanity selects missing exact configs independently (%s)",
  { timeout: 55_000 },
  async (missing, { signal }) => {
    const missingFile = expectDefined(auditFiles[missing], "audit fixture file");
    const report = await sanity(signal, {
      fetchResults: [],
      baseAvailableAfter: 0,
      objects: {
        [`${base}:${missingFile}`]: {
          ...requireAuditObject(base, missingFile),
          probe: missing === 0 ? 125 : 143,
        },
      },
    });
    expectReport(report, { code: 0, fetches: [] });
    expect(commandArgs(report, "show")).toEqual(
      auditFiles.map((file, index) => ["show", `${missing === index ? branch : base}:${file}`]),
    );
    expect(report.output).toContain(
      `Base SHA ${base} does not expose ${missingFile}; using origin/main instead.`,
    );
    expect(report.githubEnv).toBe(
      `PRE_COMMIT_CONFIG_PATH=${report.runnerTemp}/pre-commit-base.yaml\n`,
    );
  },
);

posixIt.for(
  auditFiles.flatMap((file) => [
    { file, fallback: false },
    { file, fallback: true },
  ]),
)(
  "workflow sanity rejects partial $file show (fallback=$fallback)",
  { timeout: 55_000 },
  async ({ file, fallback }, { signal }) => {
    const report = await sanity(signal, {
      fetchResults: [],
      baseAvailableAfter: 0,
      objects: {
        [`${base}:${file}`]: { text: "partial\n", probe: fallback ? 1 : 0, code: 23 },
        [`${branch}:${file}`]: { text: "partial\n", code: 23 },
      },
    });
    expectReport(report, { code: fallback ? 1 : 23, fetches: [], githubEnv: "" });
    expect(file === auditFiles[0] ? report.trustedConfig : report.trustedZizmor).toBe("");
    const shows = commandArgs(report, "show").map((args) => args.at(-1));
    expect(shows.at(-1)).toBe(`${fallback ? branch : base}:${file}`);
    expect(shows).not.toContain(`${fallback ? base : branch}:${file}`);
    if (fallback) {
      expect(report.output).toContain(`Could not read ${file} from ${base} or origin/main.`);
    }
  },
);

posixIt("workflow sanity rejects a config without the Zizmor reference", async ({ signal }) => {
  const report = await sanity(signal, {
    fetchResults: [],
    baseAvailableAfter: 0,
    objects: { [`${base}:${auditFiles[0]}`]: { text: "repos: []\n" } },
    poisonPython: true,
  });
  expect(report.code, report.output).toBe(1);
  expect(report.output).toContain(
    "trusted pre-commit config does not reference .github/zizmor.yml",
  );
  expect(report.githubEnv).toBe("");
});

const maturityValidation = {
  file: ".github/workflows/maturity-scorecard.yml",
  job: "validate_selected_ref",
  step: "Validate selected ref",
};
const maturityEnvironment = {
  EXPECTED_SHA: head,
  INPUT_REF: "main",
  EVIDENCE_RUN_ID: "123",
  PUBLISH_PULL_REQUEST: "true",
};

function publisherRun(
  signal: AbortSignal,
  options: Partial<Parameters<typeof runCiGitStep>[0]> = {},
) {
  return runCiGitStep({
    signal,
    action: "publish-generated-pr",
    step: "Publish generated pull request",
    fetchResults: [],
    publisher: {},
    ...options,
  });
}
function maturityRun(
  signal: AbortSignal,
  options: Partial<Parameters<typeof runCiGitStep>[0]> = {},
) {
  return runCiGitStep({
    signal,
    workflow: maturityValidation,
    env: maturityEnvironment,
    fetchResults: [],
    mergeBase: { ancestor: true, revision: head },
    ...options,
  });
}

// Actual-body fault injection covers the former conditional-errexit hole and
// lifecycle/status collisions; the existing real-repository cases own tree semantics.
posixIt.for(
  ["fetch", "ls-remote", "push", "ls-tree"].flatMap((operation) =>
    (["cleanup-failure", "cancel"] as const).map((code) => ({ operation, code })),
  ),
)(
  "generated publisher $code at $operation is terminal before any continuation",
  { timeout: 55_000 },
  async ({ operation, code }, { signal }) => {
    const report = await publisherRun(signal, { gitFault: { match: `^${operation} `, code } });
    expectReport(report, { code: code === "cancel" ? 143 : 125 }, { readyAttempts: 1 });
    expect(report.commands.at(-1)?.args[0]).toBe(operation);
    expectReport(report, { githubSummary: "", authHeaderPresent: true, pushLog: "" });
    expect(report.output).not.toMatch(
      /refusing a doomed retry|moved concurrently|merged|Deferred|Generated pull request:/u,
    );
  },
);

posixIt.for([124, 125, 143])(
  "generated publisher ordinary push %s drains before semantic failure reporting",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await publisherRun(signal, {
      gitFault: { match: "^push ", code, output: "GH013 repository rule violations\n" },
    });
    expectReport(report, { code: code === 124 ? 0 : code }, { pushes: code === 124 ? 2 : 1 });
    expect(commandArgs(report, "ls-remote")).toHaveLength(code === 124 ? 3 : 2);
    if (code === 124) {
      expect(report.output).toContain("retrying once under the same lease");
      expect(report.githubSummary).toContain("Generated pull request:");
    } else {
      expect(report.output).toContain("refusing a doomed retry");
      expect(report.pushLog).toBe("GH013 repository rule violations\n");
    }
    expect(report.authHeaderPresent).toBe(false);
    if (code !== 124) {
      expect(report.githubSummary).toBe("");
    }
  },
);

posixIt.for(["fetch", "ls-remote"])(
  "generated publisher %s timeout has bounded recovery",
  { timeout: 55_000 },
  async (operation, { signal }) => {
    const report = await publisherRun(signal, {
      gitFault: { match: `^${operation} `, code: "hang" },
    });
    expectReport(report, { code: 124 }, { fetches: 1, pushes: 0 });
    expectReport(report, { githubSummary: "", authHeaderPresent: false });
  },
);

posixIt.for([
  ["overlap candidate diff", "^diff --name-only", 2, {}],
  ["overlap tree read", "^ls-tree ", 1, {}],
  ["invalidation diff", "^diff --quiet ", 1, {}],
  ["ancestor probe", "^merge-base ", 1, {}],
  ["merged-tree read", "^ls-tree ", 5, { mergeGeneratedPush: true }],
  ["neutralization fetch", "^fetch ", 1, { noGeneratedChange: true }],
  ["neutralization tree read", "^ls-tree ", 1, { noGeneratedChange: true, baseChangePath: "a" }],
] satisfies [
  string,
  string,
  number,
  NonNullable<Parameters<typeof publisherRun>[1]>["publisher"],
][])(
  "generated publisher ordinary failure inside %s never becomes success",
  { timeout: 55_000 },
  async ([_label, match, occurrence, publisher], { signal }) => {
    const report = await publisherRun(signal, {
      publisher: { baseChangePath: null, ...publisher },
      gitFault: { match, occurrence, code: 23 },
    });
    expectReport(report, { code: 23, githubSummary: "", authHeaderPresent: false });
    expect(report.output).not.toMatch(
      /Generated output was merged|Deferred stale|Neutralized stale/u,
    );
  },
);

posixIt.for([0, 2, 23, 125, 143, "hang", "cleanup-failure", "cancel"] as const)(
  "maturity branch lookup %s preserves 0/2/ordinary/fatal policy after drain",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await maturityRun(signal, {
      env: { ...maturityEnvironment, INPUT_REF: "release/2026.8.1" },
      gitFault: { match: "^ls-remote ", code },
    });
    const success = code === 0 || code === 2;
    expect(report.code, report.output).toBe(
      success
        ? 0
        : code === "hang"
          ? 124
          : code === "cancel"
            ? 143
            : code === "cleanup-failure"
              ? 125
              : code,
    );
    expect(report.fetches).toHaveLength(success ? 2 : 1);
    if (success) {
      expect(report.githubOutput).toContain(
        `publication_base=${code === 0 ? "release/2026.8.1" : "main"}\n`,
      );
    } else {
      expectNoPublication(report);
      expect(report.commands.at(-1)?.args[0]).toBe("ls-remote");
      if (typeof code === "number" || code === "hang") {
        expect(report.output).toContain(`(status ${code === "hang" ? 124 : code})`);
      } else {
        expect(report.output).not.toContain("Unable to determine");
      }
    }
  },
);

posixIt(
  "generated publisher retries one timed-out push under the unchanged lease",
  async ({ signal }) => {
    const report = await publisherRun(signal, {
      gitFault: { match: "^push ", occurrence: 1, code: "hang" },
    });
    expectReport(report, { code: 0 }, { pushes: 2 });
    expect(report.pushes[0]?.args).toEqual(report.pushes[1]?.args);
    expect(report.publication?.generatedA).toBe("desired-a");
    expectReport(report, { authHeaderPresent: false }, { fetches: 1 });
    expect(report.githubSummary).toBe(
      "Generated pull request: https://github.com/openclaw/openclaw/pull/1\n",
    );
    expect(report.output).toContain("retrying once under the same lease");
  },
  55_000,
);

posixIt.for(
  [
    { match: "^fetch ", occurrence: 1 },
    { match: "^fetch ", occurrence: 2 },
    { match: "^rev-parse refs/remotes", occurrence: 1 },
    { match: "^rev-parse refs/remotes", occurrence: 2 },
    { match: "^diff ", occurrence: 1 },
  ].flatMap((site) =>
    (["cleanup-failure", "cancel"] as const).map((code) => Object.assign({}, site, { code })),
  ),
)(
  "maturity $code at $match/$occurrence stops before fallback/output",
  { timeout: 55_000 },
  async ({ match, occurrence, code }, { signal }) => {
    const report = await maturityRun(signal, {
      env: { ...maturityEnvironment, EXPECTED_SHA: "" },
      gitFault: { match, occurrence, code },
    });
    expect(report.code, report.output).toBe(code === "cancel" ? 143 : 125);
    expect(report.commands.at(-1)?.args.join(" ")).toMatch(new RegExp(match));
    expectNoPublication(report);
  },
);

posixIt.for([
  { race: "delete", secondFailure: false, code: 0, pushes: 2, fetches: 2, pushCode: undefined },
  { race: "advance", secondFailure: false, code: 1, pushes: 1, fetches: 1, pushCode: undefined },
  { race: "recreate", secondFailure: false, code: 1, pushes: 2, fetches: 2, pushCode: undefined },
  { race: "delete", secondFailure: true, code: 1, pushes: 2, fetches: 2, pushCode: undefined },
  ...[125, 143].map((pushCode) => ({
    race: "delete" as const,
    secondFailure: false,
    code: 0,
    pushes: 2,
    fetches: 2,
    pushCode,
  })),
] as const)(
  "generated publisher exact deletion-race lease policy ($race, second failure=$secondFailure, push=$pushCode)",
  { timeout: 55_000 },
  async ({ race, secondFailure, code, pushes, fetches, pushCode }, { signal }) => {
    const report = await publisherRun(signal, {
      publisher: { existingPr: true, race, failGeneratedPush: secondFailure },
      gitFault:
        pushCode === undefined
          ? undefined
          : { match: "^push ", code: pushCode, output: "stale info\n" },
    });
    expect(report.code, report.output).toBe(code);
    expect(report.initialBranch).toMatch(/^[0-9a-f]{40}$/u);
    expect(report.pushes.map(({ args }) => args)).toEqual(
      [report.initialBranch, ...(pushes === 2 ? [""] : [])].map((lease) => [
        "push",
        `--force-with-lease=refs/heads/automation/locale:${lease}`,
        "origin",
        "HEAD:refs/heads/automation/locale",
      ]),
    );
    expectReport(report, { authHeaderPresent: false }, { fetches });
    expect(report.output).toContain("stale info");
    if (code === 0) {
      expect(report.publication?.generatedA).toBe("desired-a");
      expect(report.githubSummary).toContain("Generated pull request:");
    } else {
      expect(report.githubSummary).toBe("");
      expect(
        report.commands.filter(
          ({ tool, args }) => tool === "gh" && ["create", "edit", "merge"].includes(args[1] ?? ""),
        ),
      ).toEqual([]);
    }
  },
);

posixIt.for(
  [
    { match: "^fetch ", occurrence: 2 },
    { match: "^ls-tree ", occurrence: 5 },
  ].flatMap((site) =>
    ([23, "cleanup-failure", "cancel"] as const).map((code) => Object.assign({}, site, { code })),
  ),
)(
  "generated publisher verify_publication $code at $match is terminal",
  { timeout: 55_000 },
  async ({ match, occurrence, code }, { signal }) => {
    const report = await publisherRun(signal, {
      publisher: { reconciliation: "missing" },
      gitFault: { match, occurrence, code },
    });
    expect(report.code, report.output).toBe(
      code === "cancel" ? 143 : code === "cleanup-failure" ? 125 : code,
    );
    expectReport(report, { githubSummary: "", authHeaderPresent: code !== 23 });
    expect(report.commands.at(code === 23 ? -2 : -1)?.args.join(" ")).toMatch(new RegExp(match));
    expect(report.output).not.toContain("Generated output was merged");
  },
);

posixIt.for([undefined, 0, 5, 125, "cleanup-failure", "cancel"] as const)(
  "generated publisher auth cleanup keeps ordinary tolerance but fences fatal %s",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await publisherRun(signal, {
      gitFault: code === undefined ? undefined : { match: "^config --local --unset-all ", code },
    });
    expect(report.code, report.output).toBe(
      code === "cleanup-failure" ? 125 : code === "cancel" ? 143 : 0,
    );
    expect(report.commands.at(-1)?.args).toEqual(authCleanupArgs);
    if (code === undefined) {
      expect(report.pushes).toHaveLength(1);
      expect(report.githubSummary).toContain("Generated pull request:");
    }
    for (const text of [report.output, report.pushLog, JSON.stringify(report.commands)]) {
      expect(text).not.toContain("contents-token");
      expect(text).not.toContain(Buffer.from("x-access-token:contents-token").toString("base64"));
      expect(text).not.toContain("test-token");
    }
  },
);

posixIt(
  "generated publisher removes Git auth after an unexpected policy exception",
  async ({ signal }) => {
    const report = await publisherRun(signal, {
      publisher: { autoMerge: true, malformedAutoMergeRecord: true },
    });
    expectReport(report, { code: 125, authHeaderPresent: false });
    expect(report.commands.at(-1)?.args).toEqual(authCleanupArgs);
    expect(report.output).toContain("Git ownership/setup failed (IndexError)");
  },
  55_000,
);

posixIt.for(["main-ancestor", "release-tag", "release-branch-head", "floating-main"])(
  "maturity preserves exact trust order, output hash bytes and fetches: %s",
  { timeout: 55_000 },
  async (reason, { signal }) => {
    const release = "release/2026.8.1";
    const floating = reason === "floating-main";
    const tag = reason === "release-tag";
    const releaseBranch = reason === "release-branch-head";
    const revision = floating ? "d".repeat(40) : head;
    const publicationBase = releaseBranch ? release : "main";
    const report = await maturityRun(signal, {
      realClock: true,
      realDrain: false,
      env: {
        ...maturityEnvironment,
        EXPECTED_SHA: floating ? "" : head,
        PUBLISH_PULL_REQUEST: tag ? "false" : "true",
        INPUT_REF: tag ? "refs/tags/v2026.8.1" : releaseBranch ? release : "main",
      },
      revisions: { "refs/heads/main": revision, [`refs/heads/${release}`]: head },
      commandResults: {
        ...(tag || releaseBranch
          ? { [`merge-base --is-ancestor ${head} refs/remotes/origin/main`]: { code: 1 } }
          : {}),
        ...(tag ? { [`tag --points-at ${head}`]: { code: 0, output: "v2026.8.1\n" } } : {}),
      },
    });
    expect(report.code, report.output).toBe(0);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256")
      .update(`123\n${publicationBase}\n${revision}\n`)
      .digest("hex")
      .slice(0, 16);
    expect(report.githubOutput).toBe(
      `publication_base=${publicationBase}\npublication_head=${tag ? "" : `automation/maturity-scorecard-123-${digest}`}\nselected_revision=${revision}\ntrusted_reason=${floating ? "main-ancestor" : reason}\n`,
    );
    expect(report.fetches.map(({ args }) => args)).toEqual(
      ["main", ...(releaseBranch ? [release] : []), ...(!tag ? [publicationBase] : [])].map((ref) =>
        fetchArgs("origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`),
      ),
    );
    expect(report.commands.some(({ args }) => args[0] === "tag")).toBe(tag || releaseBranch);
    expect(report.commands.at(-1)?.args).toEqual(
      tag
        ? ["tag", "--points-at", head]
        : [
            "diff",
            "--quiet",
            revision,
            `refs/remotes/origin/${publicationBase}`,
            "--",
            ".",
            ":(exclude)qa/maturity-scores.yaml",
            ":(exclude)docs/maturity/scorecard.md",
            ":(exclude)docs/maturity/taxonomy.md",
          ],
    );
  },
);

posixIt.for(
  ["publisher", "maturity"].flatMap((surface) =>
    (["owner", "python", "git"] as const).map((setupFailure) => ({ surface, setupFailure })),
  ),
)(
  "$surface setup failure ($setupFailure) never reaches Git, GH, or outputs",
  { timeout: 55_000 },
  async ({ surface, setupFailure }, { signal }) => {
    const report = await (surface === "publisher" ? publisherRun : maturityRun)(signal, {
      setupFailure,
    });
    expect(report.code).not.toBe(0);
    expect(report.commands).toEqual([]);
    expectNoPublication(report);
  },
);

posixIt(
  "generated publisher reconciliation accepts a tree merged after PR mutation",
  async ({ signal }) => {
    const report = await publisherRun(signal, { publisher: { reconciliation: "merged" } });
    expectReport(report, { readyAttempts: [], code: 0 }, { fetches: 2, pushes: 1 });
    expect(report.githubSummary).toBe(
      "Generated output was merged while publication was being reconciled.\n",
    );
    expect(report.authHeaderPresent).toBe(false);
  },
  55_000,
);

posixIt.for<[string, NonNullable<Parameters<typeof maturityRun>[1]>, number, string, number?]>([
  ["invalid expected SHA", { env: { EXPECTED_SHA: "bad" } }, 0, "expected_sha must be a full"],
  ["mismatched expected SHA", { env: { EXPECTED_SHA: "f".repeat(40) } }, 0, "expected fffff"],
  ["invalid evidence id", { env: { EVIDENCE_RUN_ID: "1x" } }, 1, "must be a numeric"],
  [
    "publication ancestry",
    { gitFault: { match: "^merge-base ", occurrence: 2, code: 1 } },
    2,
    "not an ancestor of pull request base",
  ],
  [
    "changed publication inputs",
    { gitFault: { match: "^diff ", code: 1 } },
    2,
    "changed maturity inputs",
  ],
  ["failed publication diff", { gitFault: { match: "^diff ", code: 23 } }, 2, "", 23],
])(
  "maturity rejects %s without outputs",
  { timeout: 55_000 },
  async ([_label, options, fetches, diagnostic, code = 1], { signal }) => {
    const report = await maturityRun(signal, {
      ...options,
      env: { ...maturityEnvironment, ...options.env },
    });
    expectReport(report, { code }, { fetches });
    expectNoPublication(report);
    if (diagnostic) {
      expect(report.output).toContain(diagnostic);
    }
  },
);
