import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { minimatch } from "minimatch";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { isAlias, parse, parseDocument, visit } from "yaml";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  SOURCE_CHANNEL_TEST_POLICY,
  createUiRealGatewayTestShards,
  createUiTestShardGroups,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { resolveRunVitestSpawnEnv } from "../../scripts/lib/vitest-process-env.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createPrebuiltUiE2eVitestConfig } from "../vitest/vitest.ui-e2e-prebuilt.config.ts";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import {
  exportPreflightHarness,
  runDependencyFreePreflight,
} from "./ci-preflight-dependencies.test-support.js";
import {
  assertControlUiE2eOwnership,
  frozenRealGatewayFiles,
} from "./ci-ui-e2e-ownership.test-support.js";
import {
  CACHE_SAVE_V5,
  CACHE_V5,
  CHECKOUT_V6,
  DOWNLOAD_ARTIFACT_V8,
  MATURITY_SCORECARD_WORKFLOW,
  SETUP_GO_V6,
  UPLOAD_ARTIFACT_V7,
  evaluateWorkflowCondition,
  evaluateWorkflow as evaluateWorkflowExpression,
  evaluateWorkflowRunner,
  expectIncludes,
  expectExcludes,
  quoteShell,
  readAndroidToolchainAction,
  readBuildArtifactsTestboxWorkflow,
  readCiWorkflow,
  readMaturityScorecardWorkflow,
  readReleaseChecksWorkflow,
  readTrackedText,
  readWorkflow,
  readWorkflowOutputs,
  requiredWorkflowStep,
  runGit,
  runWorkflowShellScript,
  testNodeExecPath,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";
import { runGeneratedPublisherScenario } from "./generated-publisher.test-support.js";

const manifestSource = readFileSync(
  new URL("../../scripts/ci-build-manifest.mjs", import.meta.url),
  "utf8",
);

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

const SETUP_GRADLE_V6 = "gradle/actions/setup-gradle@3f5f9adaf7d9fecd50b5935e54106014257a94e6";
const CREATE_GITHUB_APP_TOKEN_V3_2 =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const CREATE_GITHUB_APP_TOKEN_V3_3 =
  "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510";
const OPENGREP_PR_DIFF_WORKFLOW = ".github/workflows/opengrep-precise.yml";
const OPENGREP_FULL_WORKFLOW = ".github/workflows/opengrep-precise-full.yml";
const CONTROL_UI_LOCALE_REFRESH_WORKFLOW = ".github/workflows/control-ui-locale-refresh.yml";
const NATIVE_APP_LOCALE_REFRESH_WORKFLOW = ".github/workflows/native-app-locale-refresh.yml";
const CREATE_GENERATED_PR_TOKENS_ACTION = ".github/actions/create-generated-pr-tokens/action.yml";
const PUBLISH_GENERATED_PR_ACTION = ".github/actions/publish-generated-pr/action.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const rootPackageManager = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    packageManager: string;
  }
).packageManager;

function runCiReleaseRefValidation(options: {
  kind?: "context" | "historical" | "candidate";
  ref: string;
  targetSha: string;
  resolvedSha?: string;
  comparisonStatus?: string;
  apiError?: "ref" | "comparison";
}) {
  const root = tempDirs.make("openclaw-ci-target-context-");
  const outputPath = path.join(root, "github-output");
  const binPath = path.join(root, "bin");
  const resolvedSha = options.resolvedSha ?? "b".repeat(40);
  const kind = options.kind ?? "context";
  const ref = `refs/${kind === "historical" ? "tags" : "heads"}/${options.ref}`;
  mkdirSync(binPath);
  writeFileSync(
    path.join(root, "ci-git-owner.py"),
    readFileSync(".github/actions/git-owner/owner.py"),
  );
  writeFileSync(outputPath, "", "utf8");
  writeFileSync(
    path.join(binPath, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-C" ]]; then shift 2; fi
if [[ "$*" == "remote get-url origin" ]]; then
  printf '%s\\n' 'https://github.com/openclaw/openclaw.git'
else
  echo 'fatal: could not read Username for https://github.com: terminal prompts disabled' >&2
  exit 128
fi
`,
    "utf8",
  );
  writeFileSync(
    path.join(binPath, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${GH_TOKEN:-}" == "test-token" ]] || exit 4
[[ "$1" == "api" ]] || exit 64
shift
if [[ "$1" == "--method" && "$2" == "GET" ]]; then shift 2; fi
[[ "$#" == 3 && "$2" == "--jq" ]] || exit 64
case "$1" in
  "$MOCK_REF_ENDPOINT") kind=ref; value="$MOCK_REF_SHA"; query=.sha ;;
  "$MOCK_COMPARE_ENDPOINT") kind=comparison; value="$MOCK_COMPARE_STATUS"; query=.status ;;
  *) echo "Unexpected GitHub API endpoint: $1" >&2; exit 64 ;;
esac
[[ "$3" == "$query" ]] || exit 64
# Valid-looking partial output must not authorize a failed request.
printf '%s\\n' "$value"
if [[ "$MOCK_API_ERROR" == "$kind" ]]; then
  echo 'gh: Service Unavailable (HTTP 503)' >&2
  exit 1
fi
`,
    "utf8",
  );
  chmodSync(path.join(binPath, "git"), 0o755);
  chmodSync(path.join(binPath, "gh"), 0o755);
  const stepName = {
    context: "Validate target context",
    historical: "Validate historical release target",
    candidate: "Validate release candidate target",
  }[kind];
  const step = requiredWorkflowStep(readCiWorkflow().jobs.preflight.steps, stepName);
  const run = spawnSync(
    "bash",
    ["-c", expectDefined(step.run, "target context validation script")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_TOKEN: step.env?.GH_TOKEN === "${{ github.token }}" ? "test-token" : "",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_OUTPUT: outputPath,
        MOCK_REF_ENDPOINT: `repos/openclaw/openclaw/commits/${encodeURIComponent(ref)}`,
        MOCK_REF_SHA: resolvedSha,
        MOCK_COMPARE_ENDPOINT: `repos/openclaw/openclaw/compare/${options.targetSha}...${resolvedSha}`,
        MOCK_COMPARE_STATUS: options.comparisonStatus ?? "ahead",
        MOCK_API_ERROR: options.apiError ?? "",
        RUNNER_TEMP: root,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        TARGET_CONTEXT_REF: options.ref,
        TARGET_REF: options.targetSha,
        EXPECTED_SHA: options.targetSha,
        HISTORICAL_TARGET_TAG: options.ref,
        RELEASE_CANDIDATE_REF: options.ref,
      },
    },
  );
  return {
    output: `${run.stdout}${run.stderr}`,
    outputs: readWorkflowOutputs(outputPath),
    status: run.status,
  };
}

function readAndroidReleaseWorkflow() {
  return readWorkflow(".github/workflows/android-release.yml");
}

function readWorkflowSanityWorkflow() {
  return readWorkflow(".github/workflows/workflow-sanity.yml");
}

function readRealBehaviorProofWorkflow() {
  return readWorkflow(".github/workflows/real-behavior-proof.yml");
}

function readAndroidCompileSdk(relativePath: string): number {
  const match = readTrackedText(relativePath).match(/^\s*compileSdk\s*=\s*(\d+)\s*$/mu);
  if (!match) {
    throw new Error(`Missing compileSdk in ${relativePath}`);
  }
  return Number(match[1]);
}

function findYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return findYamlFiles(entryPath);
    }
    return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [entryPath] : [];
  });
}

function findUnpinnedExternalActions(): string[] {
  const violations: string[] = [];
  for (const workflowPath of [
    ...findYamlFiles(".github/workflows"),
    ...findYamlFiles(".github/actions"),
  ]) {
    for (const [index, line] of readFileSync(workflowPath, "utf8").split("\n").entries()) {
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^#\s]+)/u)?.[1];
      if (!uses || uses.startsWith("./") || uses.startsWith("docker://")) {
        continue;
      }
      const at = uses.lastIndexOf("@");
      if (at < 1 || !/^[a-f0-9]{40}$/u.test(uses.slice(at + 1))) {
        violations.push(`${workflowPath}:${index + 1}: ${uses}`);
      }
    }
  }
  return violations;
}

function runReleaseFallbackHistoryFixture(options: {
  route: "branch" | "tag" | "orphan" | "non-release-tag";
  many?: boolean;
  failure?: "fetch-branches" | "fetch-tags" | "branch-producer" | "tag-producer";
}) {
  const ownedDirs = createTempDirTracker();
  const root = ownedDirs.make("openclaw-release-fallback-");
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const hooks = path.join(root, "hooks");
  const records = path.join(root, "git-results.jsonl");
  const fixtureEnv: NodeJS.ProcessEnv = {
    PATH: [path.dirname(testNodeExecPath), "/usr/local/bin", "/usr/bin", "/bin"].join(
      path.delimiter,
    ),
    HOME: home,
    XDG_CONFIG_HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: hooks,
    GIT_CONFIG_KEY_2: "gc.auto",
    GIT_CONFIG_VALUE_2: "0",
    GIT_CONFIG_KEY_3: "maintenance.auto",
    GIT_CONFIG_VALUE_3: "false",
    GIT_CONFIG_KEY_4: "commit.gpgsign",
    GIT_CONFIG_VALUE_4: "false",
    GIT_CONFIG_KEY_5: "protocol.file.allow",
    GIT_CONFIG_VALUE_5: "always",
    GIT_AUTHOR_NAME: "Release Fixture",
    GIT_AUTHOR_EMAIL: "release-fixture@example.com",
    GIT_COMMITTER_NAME: "Release Fixture",
    GIT_COMMITTER_EMAIL: "release-fixture@example.com",
    GITHUB_TOKEN: "synthetic-fixture-token",
  };
  try {
    for (const dir of [checkout, bin, home, hooks]) {
      mkdirSync(dir);
    }
    const realGit = execFileSync("bash", ["--noprofile", "--norc", "-c", "command -v git"], {
      env: fixtureEnv,
      encoding: "utf8",
    }).trim();
    const git = (cwd: string, args: string[], input?: string) =>
      execFileSync(realGit, args, {
        cwd,
        env: fixtureEnv,
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20_000,
      }).trim();
    git(root, ["init", "--bare", "-q", origin]);
    const tree = git(origin, ["mktree"], "");
    const selected = git(origin, ["commit-tree", tree, "-m", "selected"]);
    const unrelated = git(origin, ["commit-tree", tree, "-m", "unrelated"]);
    const count = options.many ? 4096 : 1;
    const refs = Array.from({ length: count }, (_, index) => {
      const suffix = options.many
        ? `${String(index).padStart(4, "0")}-${"a".repeat(192)}/${"b".repeat(192)}`
        : "small";
      return options.route === "branch"
        ? `refs/heads/fixture/${suffix}`
        : `refs/tags/${options.route === "non-release-tag" ? "fixture" : "vfixture"}/${suffix}`;
    });
    git(
      origin,
      ["update-ref", "--stdin"],
      [
        `create refs/heads/setup-target ${selected}`,
        `create refs/heads/unrelated ${unrelated}`,
        ...(options.route === "orphan" ? [] : refs.map((ref) => `create ${ref} ${selected}`)),
        "",
      ].join("\n"),
    );
    git(origin, ["pack-refs", "--all"]);
    git(checkout, ["init", "-q"]);
    git(checkout, ["remote", "add", "origin", pathToFileURL(origin).href]);
    git(checkout, ["fetch", "--no-tags", "origin", "refs/heads/setup-target"]);
    git(checkout, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
    git(origin, ["update-ref", "-d", "refs/heads/setup-target"]);
    git(checkout, ["update-ref", "-d", "refs/remotes/origin/setup-target"]);
    expect(
      git(checkout, [
        "for-each-ref",
        "--format=%(objectname)",
        "--contains",
        selected,
        "refs/remotes",
      ]),
    ).toBe("");
    expect(git(checkout, ["tag", "--points-at", selected])).toBe("");
    if (options.route === "tag") {
      git(checkout, [
        "config",
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic Zml4dHVyZQ==",
      ]);
    }
    const enumerationBytes = Buffer.byteLength(
      refs
        .map((ref) => ref.replace(/^refs\/heads\//u, "origin/").replace(/^refs\/tags\//u, ""))
        .join("\n") + "\n",
    );
    if (options.many && existsSync("/proc/sys/fs/pipe-max-size")) {
      expect(enumerationBytes).toBeGreaterThan(
        Number(readFileSync("/proc/sys/fs/pipe-max-size", "utf8").trim()),
      );
    }

    // Enumeration inherits the real pipeline. Only verbose fetch stderr uses a regular file.
    const launcher = path.join(root, "git-launcher.mjs");
    writeFileSync(
      launcher,
      [
        'import { spawnSync } from "node:child_process";',
        'import { createHash } from "node:crypto";',
        'import { appendFileSync, closeSync, openSync, readFileSync, statSync } from "node:fs";',
        'import { constants } from "node:os";',
        `const git = ${JSON.stringify(realGit)};`,
        `const records = ${JSON.stringify(records)};`,
        `const failure = ${JSON.stringify(options.failure ?? null)};`,
        "let args = process.argv.slice(2);",
        'const op = args.includes("fetch") ? (args.includes("--no-tags") ? "fetch-branches" : "fetch-tags")',
        '  : args[0] === "tag" ? "tag-producer" : args[0] === "for-each-ref" ? "branch-producer" : args[0];',
        'if (op.startsWith("fetch-") && op === failure) {',
        `  args = args.map(arg => arg === "origin" ? ${JSON.stringify(pathToFileURL(path.join(root, "missing.git")).href)} : arg);`,
        "}",
        `const fetchPath = ${JSON.stringify(path.join(root, "fetch-"))} + op + ".stderr";`,
        'const fd = op.startsWith("fetch-") ? openSync(fetchPath, "w", 0o600) : null;',
        'const result = spawnSync(git, args, { stdio: ["inherit", "inherit", fd ?? "inherit"], timeout: 20_000 });',
        "if (fd !== null) closeSync(fd);",
        "const exitCode = result.signal ? 128 + constants.signals[result.signal] : result.status ?? 1;",
        "const entry = { op, status: result.status, signal: result.signal, exitCode, error: result.error?.code };",
        "if (fd !== null) {",
        "  const size = statSync(fetchPath).size;",
        '  if (size > 8 * 1024 * 1024) throw new Error("fixture fetch capture exceeded 8 MiB");',
        "  const bytes = readFileSync(fetchPath);",
        '  entry.stderr = { bytes: size, sha256: createHash("sha256").update(bytes).digest("hex") };',
        "  process.stderr.write(bytes.subarray(Math.max(0, bytes.length - 1024)));",
        "}",
        'appendFileSync(records, JSON.stringify(entry) + "\\n");',
        "if (op === failure && fd === null && result.status === 0) {",
        '  const failed = spawnSync(git, ["rev-parse", "--verify", "refs/heads/fixture-missing"], { stdio: ["ignore", "ignore", "inherit"] });',
        '  appendFileSync(records, JSON.stringify({ op: "post-output-failure", status: failed.status, signal: failed.signal }) + "\\n");',
        "  process.exit(failed.status ?? 1);",
        "}",
        "process.exit(exitCode);",
        "",
      ].join("\n"),
    );
    writeExecutable(path.join(bin, "git"), [
      "#!/bin/bash",
      `exec ${quoteShell(testNodeExecPath)} ${quoteShell(launcher)} "$@"`,
    ]);
    const allocatedBytes = () =>
      Number(
        execFileSync("du", ["-sk", root], { env: fixtureEnv, encoding: "utf8" })
          .trim()
          .split(/\s/u)[0],
      ) * 1024;
    expect(allocatedBytes()).toBeLessThan(256 * 1024 * 1024);
    const step = requiredWorkflowStep(
      readReleaseChecksWorkflow().jobs.resolve_target.steps,
      "Validate selected ref belongs to this repository",
    );
    const result = runWorkflowShellScript(expectDefined(step.run, "fallback validation body"), {
      cwd: checkout,
      env: {
        ...fixtureEnv,
        PATH: `${bin}${path.delimiter}${fixtureEnv.PATH}`,
        RELEASE_REF: selected,
      },
    });
    const events = readFileSync(records, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            op: string;
            status: number | null;
            signal: string | null;
            error?: string;
          },
      );
    const containingBranches = git(checkout, [
      "for-each-ref",
      "--format=%(objectname)",
      "--contains",
      selected,
      "refs/remotes",
    ])
      .split(/\s/u)
      .filter(Boolean).length;
    if (!options.failure?.startsWith("fetch-")) {
      expect(containingBranches).toBe(options.route === "branch" ? count : 0);
    }
    expect(allocatedBytes()).toBeLessThan(256 * 1024 * 1024);
    expect(result.error).toBeUndefined();
    expect(events.every((event) => event.error === undefined)).toBe(true);
    return { result, events };
  } finally {
    ownedDirs.cleanup();
    expect(existsSync(root)).toBe(false);
  }
}
describe("release fast lane label", () => {
  it("declines fork heads before any reduced check can reach the aggregate gate", () => {
    const workflow = readCiWorkflow();
    const manifestStep = requiredWorkflowStep(workflow.jobs.preflight.steps, "Build CI manifest");
    // The manifest fixture "declines fork heads on the canonical base" in
    // ci-workflow-planning.test.ts proves the outputs; this pins the inputs it relies on.
    expect(manifestStep.env.OPENCLAW_CI_REPOSITORY).toBe("${{ github.repository }}");
    expect(manifestStep.env.OPENCLAW_CI_HEAD_REPOSITORY).toBe(
      "${{ github.event.pull_request.head.repo.full_name }}",
    );
    // Reduced selection only ever reaches the gate through preflight outputs.
    const gate = workflow.jobs["ci-gate"];
    expect(gate.needs[0]).toBe("preflight");
    const rows: string[] = gate.steps
      .find((candidate: WorkflowStep) => candidate.name === "Verify selected CI lanes")
      .env.JOB_RESULTS.trim()
      .split("\n");
    for (const row of rows) {
      const selected = row.slice(row.lastIndexOf("|") + 1);
      expect(selected === "true" || selected.includes("needs.preflight.outputs."), row).toBe(true);
      expect(selected).not.toContain("release_fast_lane");
    }
  });
});

describe("ci workflow guards", () => {
  const ci = readCiWorkflow();
  function ciValue(
    job: string,
    property: "runs-on" | "timeout-minutes",
    context: Partial<Parameters<typeof evaluateWorkflowExpression>[1]>,
  ) {
    const value = ci.jobs[job][property];
    return typeof value === "number" ? value : evaluateWorkflowExpression(value, context);
  }

  it("keeps Android PR capture on the release script without store authority", () => {
    const job = readCiWorkflow().jobs["android-screenshots"];
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(evaluateWorkflowRunner(job["runs-on"])).toBe("ubuntu-24.04");
    const toolchain = job.steps.find(
      (step: WorkflowStep) => step.uses === "./.ci-harness/.github/actions/setup-android-toolchain",
    );
    expect(toolchain.with["install-screenshot-emulators"]).toBe("true");
    const capture = job.steps.find((step: WorkflowStep) => step.run === "pnpm android:screenshots");
    expect(capture).toBeDefined();
    expect(capture.env.SIPS).toBe(
      "${{ runner.temp }}/openclaw-android-tools/android-sips-linux.sh",
    );
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.steps.filter((step: WorkflowStep) => step["continue-on-error"])).toEqual([]);
    const evidence = job.steps.find((step: WorkflowStep) => step.uses === UPLOAD_ARTIFACT_V7);
    expect(evidence.if).toBe("always()");
    expect(evidence.with.path).toContain("phoneScreenshots/*.jpg");
    expect(evidence.with.path).toContain("wearScreenshots/*.jpg");
  });

  it("separates release QA lanes without weakening their resource locks", () => {
    const workflow = readWorkflow(".github/workflows/qa-live-transports-convex.yml");
    const releaseWorkflow = readReleaseChecksWorkflow();

    expect(workflow.on.workflow_call.inputs.lock_scope).toEqual({
      description: "Concurrency scope for a trusted single-lane reusable call",
      required: false,
      default: "all",
      type: "string",
    });
    expect(workflow.concurrency).toEqual({
      group:
        "qa-lab-${{ inputs.lock_scope || 'all' }}-${{ github.event_name != 'schedule' && inputs.ref || github.sha }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    for (const [job, group] of [
      [
        "run_live_matrix",
        "qa-live-matrix-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      ],
      ["run_live_buzz", "qa-live-buzz-shared"],
    ] as const) {
      expect(workflow.jobs[job].concurrency).toEqual({
        group,
        "cancel-in-progress": false,
        queue: "max",
      });
    }
    expect(releaseWorkflow.jobs.qa_live_release_checks.with.lock_scope).toBe("matrix");
    expect(releaseWorkflow.jobs.qa_live_buzz_release_checks.with.lock_scope).toBe("buzz");
  });

  it.each([7])("preserves module heredocs and cleans artifacts after exit %i", (exitCode) => {
    const parentTempDir = tmpdir();
    const run = runWorkflowShellScript(
      `node --input-type=module <<'NODE'
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
NODE_prefix: for (const value of ["heredoc-body-preserved"]) {
  console.log(value);
  break NODE_prefix;
}
console.log(mkdtempSync(join(tmpdir(), 'openclaw-workflow-child-')));
console.log(JSON.stringify(process.execArgv));
process.exitCode = ${exitCode};
NODE
`,
      {},
    );

    expect(run.status, run.stderr).toBe(exitCode);
    const [body, temporaryDirectory, execArgv] = run.stdout.trim().split("\n");
    const childDirectory = expectDefined(temporaryDirectory, "child temporary directory");
    try {
      expect(body).toBe("heredoc-body-preserved");
      expect(JSON.parse(expectDefined(execArgv, "module arguments"))).toEqual([
        "--input-type=module",
      ]);
      expect(tmpdir()).toBe(parentTempDir);
      expect(existsSync(childDirectory)).toBe(false);
    } finally {
      rmSync(childDirectory, { force: true, recursive: true });
    }
  });

  it.each([
    { name: "plain Node", setup: "", nodeOptions: "", extension: "mjs" },
    { name: "tsx", setup: "", nodeOptions: "--import tsx ", extension: "ts" },
    {
      name: "manifest loader",
      setup: "manifest_node_args=()\nmanifest_node_args+=(--import tsx)\n",
      nodeOptions: '"${manifest_node_args[@]}" ',
      extension: "ts",
    },
  ])("keeps $name heredocs outside cwd and resolves imports after cd", (fixture) => {
    const root = tempDirs.make("openclaw-workflow-resolution-");
    const child = path.join(root, "module's directory");
    mkdirSync(child);
    writeFileSync(path.join(child, "package.json"), '{"type":"module"}');
    writeFileSync(
      path.join(child, `value.${fixture.extension}`),
      fixture.extension === "ts"
        ? 'export const value: string = "resolved";'
        : 'export const value = "resolved";',
    );
    const run = runWorkflowShellScript(
      `${fixture.setup}node --input-type=module <<'BEFORE_CD'
import { readdirSync } from 'node:fs';
console.log(JSON.stringify(readdirSync(process.cwd())));
BEFORE_CD
cd ${quoteShell(child)}
node ${fixture.nodeOptions}--input-type=module <<'AFTER_CD'
import { readdirSync } from 'node:fs';
import { value } from './value.${fixture.extension}';
console.log(value);
console.log(JSON.stringify(readdirSync(process.cwd()).sort()));
AFTER_CD
`,
      { cwd: root },
    );

    const [rootFiles, value, childFiles] = run.stdout.trim().split("\n");
    // Observe the namespace while both rewritten bodies exist, not only after cleanup.
    expect(JSON.parse(expectDefined(rootFiles, "cwd namespace"))).toEqual([path.basename(child)]);
    expect(run.status, run.stderr).toBe(0);
    expect(value).toBe("resolved");
    expect(JSON.parse(expectDefined(childFiles, "child namespace"))).toEqual([
      "package.json",
      `value.${fixture.extension}`,
    ]);
  });

  it("keeps ClawSweeper dispatch events aligned with receiver workflows", () => {
    const workflowPath = ".github/workflows/clawsweeper-dispatch.yml";
    const source = readFileSync(workflowPath, "utf8");
    const workflow = readWorkflow(workflowPath);
    const steps = workflow.jobs.dispatch.steps as WorkflowStep[];
    const receiverDispatchSteps = steps.filter((step) =>
      step.run?.includes("repos/openclaw/clawsweeper/dispatches"),
    );
    const eventTypes = receiverDispatchSteps.map((step) => {
      const matches = [...(step.run ?? "").matchAll(/\bevent_type\s*:\s*"([^"]+)"/gu)];
      expect(matches, step.name).toHaveLength(1);
      return expectDefined(matches[0]?.[1], step.name ?? "ClawSweeper dispatch event");
    });

    // This allowlist mirrors the target repository receiver contract; changes require coordinated receiver updates.
    expect(eventTypes.toSorted()).toEqual([
      "clawsweeper_comment",
      "clawsweeper_item",
      "github_activity",
    ]);
    expect(source).not.toContain("clawsweeper_commit_review");
    expect(source).not.toContain("CLAWSWEEPER_COMMIT_REVIEW_CREATE_CHECKS");
    expect(workflow.on.push.branches).toEqual(["main"]);

    const activityRun = expectDefined(
      requiredWorkflowStep(steps, "Dispatch GitHub activity to ClawSweeper").run,
      "ClawSweeper GitHub activity dispatch",
    );
    expect(activityRun).toMatch(
      /push: \(if \$event_name == "push" then \{\s+before: \.before,\s+after: \.after,\s+ref: \.ref,\s+compare: \.compare,\s+head_commit: \.head_commit\.id\s+\} else null end\)/u,
    );

    const exactReviewStep = requiredWorkflowStep(steps, "Dispatch exact ClawSweeper review");
    expect(exactReviewStep.env?.TARGET_BRANCH).toBe(
      "${{ github.event.repository.default_branch }}",
    );
    expect(exactReviewStep.run).toContain('--arg target_branch "$TARGET_BRANCH"');
    expect(exactReviewStep.run).toContain("target_branch:$target_branch");
    expect(exactReviewStep.run).toContain('ingress_route:"target_dispatcher"');
    expect(exactReviewStep.run).toContain("ingress_fingerprint:$ingress_fingerprint");
  });

  it.each([
    // name, body, override, permission, issue, admitted, reacts
    ["multiline", "context\r\n \t/merge now \r\n", "", "write", false, true, true],
    ["non-maintainer", "/merge", "", "read", false, true, false],
  ] as const)(
    "preserves reaction admission and actions for %s",
    async (_name, body, commands, permission, issue, admitted, reacts) => {
      const job = readWorkflow(".github/workflows/maintainer-command-reactions.yml").jobs.react;
      const event = {
        comment: { id: 456, body, user: { login: "comment-author" } },
        issue: { number: 123, ...(issue ? {} : { pull_request: {} }) },
      };
      const context = {
        repository: "openclaw/openclaw",
        runAttempt: 1,
        eventName: "issue_comment" as const,
        actor: "event-actor",
        githubEvent: event,
        maintainerCommands: commands,
      };
      const reactions: string[] = [];
      const permissionUsers: string[] = [];
      const step = job.steps.find((candidate: WorkflowStep) => candidate.with?.script);
      await runInNewContext(`(async () => { ${step.with.script} })()`, {
        context: { payload: event, repo: { owner: "openclaw", repo: "openclaw" } },
        process: {
          env: {
            MAINTAINER_COMMAND_REACTIONS: evaluateWorkflowExpression(
              job.env.MAINTAINER_COMMAND_REACTIONS,
              context,
            ),
          },
        },
        core: { info() {}, warning() {} },
        github: {
          rest: {
            repos: {
              async getCollaboratorPermissionLevel({ username }: { username: string }) {
                permissionUsers.push(username);
                return { data: { permission } };
              },
            },
            reactions: {
              async createForIssueComment({ content }: { content: string }) {
                reactions.push(content);
              },
            },
          },
        },
      });
      expect(reactions).toEqual(reacts ? ["eyes"] : []);
      expect(permissionUsers.every((login) => login === "comment-author")).toBe(true);
      expect(Boolean(evaluateWorkflowExpression(job.if, context))).toBe(admitted);
    },
  );

  it("routes stale bug issues through ClawSweeper instead of Barnacle closure", () => {
    const staleWorkflow = readWorkflow(".github/workflows/stale.yml");
    const staleSteps = staleWorkflow.jobs.stale.steps as WorkflowStep[];
    const stepNamed = (name: string) =>
      expectDefined(
        staleSteps.find((step) => step.name === name),
        name,
      );

    for (const name of [
      "Mark stale unassigned issues (primary)",
      "Mark stale assigned issues (primary)",
      "Mark stale unassigned issues (fallback)",
      "Mark stale assigned issues (fallback)",
    ]) {
      const exemptLabels = String(stepNamed(name).with?.["exempt-issue-labels"])
        .split(",")
        .map((label) => label.trim());
      expect(exemptLabels, name).toContain("bug");
      expect(String(stepNamed(name).with?.["days-before-pr-stale"]), name).toBe("-1");
      expect(String(stepNamed(name).with?.["days-before-pr-close"]), name).toBe("-1");
      expect(String(stepNamed(name).with?.["remove-pr-stale-when-updated"]), name).toBe("false");
    }

    const bugJob = staleWorkflow.jobs["stale-bug-verification"];
    expect(bugJob.permissions).toEqual({ issues: "write" });
    expect(evaluateWorkflowRunner(bugJob["runs-on"])).toBe("ubuntu-24.04");
    const bugScript = String(
      requiredWorkflowStep(bugJob.steps, "Mark inactive bugs for ClawSweeper verification").with
        ?.script,
    );
    expectIncludes(bugScript, [
      "const maxMarks = 25;",
      'labels: "bug"',
      "github.rest.issues.addLabels",
      "github.rest.issues.removeLabel",
      "Inactivity alone will not close a bug report.",
      "requires separate backfill approval",
      "slice(staleEventIndex + 1)",
      "updatedAtMs > lastAutomationAtMs",
      'item.state !== "open"',
    ]);
    expectExcludes(bugScript, ["15_000", "github.rest.issues.update"]);

    const backfillScript = String(
      (staleWorkflow.jobs["backfill-stale-closures"].steps as WorkflowStep[]).find(
        (step) => step.name === "Backfill stale closures",
      )?.with?.script,
    );
    expect(backfillScript).toMatch(/issueExemptLabels[\s\S]*"bug"/);

    const dispatchWorkflow = readWorkflow(".github/workflows/clawsweeper-dispatch.yml");
    const dispatchCondition = String(dispatchWorkflow.jobs.dispatch.if);
    expectIncludes(dispatchCondition, [
      "github.event.label.name == 'stale'",
      "contains(github.event.issue.labels.*.name, 'bug')",
      "github.actor_id == '257215752'",
      "github.actor_id == '264559031'",
    ]);

    const auditJob = staleWorkflow.jobs["audit-bug-closure-reasons"];
    expect(auditJob.permissions).toEqual({ issues: "read" });
    const auditScript = String((auditJob.steps as WorkflowStep[])[0]?.with?.script);
    expectIncludes(auditScript, [
      'item.state_reason !== "not_planned"',
      "github.rest.issues.listEventsForTimeline",
      "github.paginate.iterator(",
      "new Set([257215752, 264559031])",
      "escapeSummaryCell(violation.title)",
      '.replaceAll("<", "&lt;")',
      "core.setFailed(",
    ]);
    expectExcludes(auditScript, ["github.rest.issues.update", "github.rest.issues.createComment"]);
  });

  it("restricts hosted release gates to the exact pull request head", () => {
    const workflow = readCiWorkflow();
    const steps = workflow.jobs.preflight.steps;
    const validation = requiredWorkflowStep(steps, "Validate release-gate dispatch");
    expect(validation.if).toBe("github.event_name == 'workflow_dispatch' && inputs.release_gate");
    expectIncludes(validation.run, [
      "release_gate requires target_ref to be a full commit SHA",
      "release_gate requires pull_request_number",
      "release_gate must run from the branch at target_ref",
      "release_gate cannot be combined with historical_target_tag",
    ]);
    const diffBase = steps.find((step: WorkflowStep) => step.name === "Resolve exact diff base");
    expect(diffBase.env).toMatchObject({
      PULL_REQUEST_NUMBER: "${{ inputs.pull_request_number }}",
      RELEASE_GATE: "${{ inputs.release_gate }}",
    });
    expectIncludes(diffBase.run, [
      "refs/pull/${PULL_REQUEST_NUMBER}/merge",
      'release_gate_head="$(git rev-parse "${merge_ref}^2")"',
      "release_gate pull request head ${release_gate_head} does not match target ${target_head}",
      'base_sha="$(git rev-parse "${merge_ref}^1")"',
      'head_sha="$(git rev-parse "$merge_ref")"',
      'echo "head_sha=$head_sha" >> "$GITHUB_OUTPUT"',
    ]);
  });

  it("serializes the shared Swift package suite on hosted macOS retries", () => {
    const macosSwift = readCiWorkflow().jobs["macos-swift"];

    expect(macosSwift.env.OPENCLAWKIT_TEST_EXECUTION).toContain("github.run_attempt > 1");
    const openClawKitTests = requiredWorkflowStep(macosSwift.steps, "OpenClawKit tests");
    expectIncludes(openClawKitTests?.run, [
      'if [[ "$OPENCLAWKIT_TEST_EXECUTION" == "parallel" ]]',
      "--parallel",
      "--no-parallel",
    ]);
  });

  it("keeps every path-filtered hosted gate runnable on landing-relevant events", () => {
    const workflows = [
      [".github/workflows/ci-check-testbox.yml", "check"],
      [".github/workflows/ci-check-arm-testbox.yml", "check-arm"],
      [".github/workflows/ci-build-artifacts-testbox.yml", "build-artifacts"],
    ] as const;

    for (const [workflowPath, jobName] of workflows) {
      const workflow = readWorkflow(workflowPath);
      expect(workflow.on.pull_request.types).toEqual([
        "opened",
        "reopened",
        "synchronize",
        "ready_for_review",
      ]);
      expect(workflow.on.pull_request.paths).toContain(workflowPath);
      expect(workflow.on.pull_request.paths).not.toContain(".github/workflows/**");
      for (const [eventName, draft, result, cancelled, admitted] of [
        ["pull_request", false, "skipped", false, true],
        ["pull_request", true, "skipped", false, false],
        ["pull_request", false, "skipped", true, false],
        ["workflow_dispatch", false, "success", false, true],
        ["workflow_dispatch", false, "failure", false, false],
        ["workflow_dispatch", false, "success", true, false],
      ] as const) {
        expect(
          evaluateWorkflowExpression(workflow.jobs[jobName].if, {
            eventName,
            draft,
            cancelled,
            additionalNeeds: { admission: { outputs: {}, result } },
          }),
          `${workflowPath}: ${eventName}, admission=${result}, cancelled=${cancelled}`,
        ).toBe(admitted);
      }
    }
  });

  it("pins every external GitHub Action reference to a full commit SHA", () => {
    expect(findUnpinnedExternalActions()).toEqual([]);
  });

  it("schedules approved Docker refreshes from independently resolved channels", () => {
    const workflow = readWorkflow(".github/workflows/docker-image-refresh.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/docker-release.yml");
    const plan = workflow.jobs.plan;
    const publish = workflow.jobs.publish;
    const planSteps = plan.steps as WorkflowStep[];
    const mainGuard = requiredWorkflowStep(planSteps, "Require a main-branch run");
    const resolve = requiredWorkflowStep(planSteps, "Resolve refresh plan");

    expect(workflow.on.schedule).toEqual([{ cron: "17 3 * * 1" }]);
    expect(workflow.on.workflow_dispatch.inputs.channel).toEqual({
      description: "Release channel to rebuild",
      required: false,
      default: "both",
      type: "choice",
      options: ["stable", "extended-stable", "both"],
    });
    expect(workflow.on.workflow_dispatch.inputs.dry_run).toEqual({
      description: "Resolve and summarize without publishing",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(plan.permissions).toEqual({ contents: "read" });
    expect(mainGuard.run).toContain('[[ "${WORKFLOW_REF}" != "refs/heads/main" ]]');
    expectIncludes(resolve.run, [
      "docker-release-policy.mjs --current",
      'git rev-parse "refs/tags/${stable_tag}^{commit}"',
      'git rev-parse "refs/tags/${extended_stable_tag}^{commit}"',
      'suffix="-r$(date -u +%Y%m%d)"',
      'echo "matrix=${matrix}"',
      '} >> "${GITHUB_OUTPUT}"',
    ]);
    expect(plan.environment).toBeUndefined();
    expect(publish.environment).toBeUndefined();

    expect(publish.needs).toBe("plan");
    expect(publish.if).toBe("needs.plan.outputs.dry_run != 'true'");
    expect(publish.strategy).toEqual({
      "fail-fast": false,
      matrix: { include: "${{ fromJSON(needs.plan.outputs.matrix) }}" },
    });
    expect(publish.uses).toBe("./.github/workflows/docker-release.yml");
    expect(publish.with).toEqual({
      tag: "${{ matrix.tag }}",
      release_sha: "${{ matrix.release_sha }}",
      image_tag_suffix: "${{ needs.plan.outputs.image_tag_suffix }}",
    });
    expect(publish.secrets).toEqual({
      DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    });
    expect(publish.permissions).toEqual({
      actions: "read",
      attestations: "read",
      contents: "read",
      packages: "write",
    });
    expect(releaseWorkflow.jobs.approve.environment).toBe("docker-release");
    expect(releaseWorkflow.jobs.publish.environment).toBeUndefined();
    expect(releaseWorkflow.jobs.publish.needs).toContain("approve");
  });

  it("scopes generated publication credentials to the repository and separates branch and PR authority", () => {
    const action = readWorkflow(CREATE_GENERATED_PR_TOKENS_ACTION);
    const contents = action.runs.steps.find((step: WorkflowStep) => step.id === "contents-token");
    const pullRequest = action.runs.steps.find(
      (step: WorkflowStep) => step.id === "pull-request-token",
    );
    expect(contents.uses).toBe(CREATE_GITHUB_APP_TOKEN_V3_2);
    expect(pullRequest.uses).toBe(CREATE_GITHUB_APP_TOKEN_V3_2);
    expect(contents.with).toEqual({
      "client-id": "${{ inputs.contents-client-id }}",
      "private-key": "${{ inputs.contents-private-key }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
      "permission-contents": "write",
    });
    expect(pullRequest.with).toEqual({
      "client-id": "${{ inputs.pull-request-client-id }}",
      "private-key": "${{ inputs.pull-request-private-key }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
      "permission-contents": "${{ inputs.pull-request-contents-permission }}",
      "permission-pull-requests": "write",
    });
    expect(action.outputs["contents-token"].value).toBe(
      "${{ steps.contents-token.outputs.token }}",
    );
    expect(action.outputs["pull-request-token"].value).toBe(
      "${{ steps.pull-request-token.outputs.token }}",
    );
    const publisher = readWorkflow(PUBLISH_GENERATED_PR_ACTION);
    const tokens = publisher.runs.steps.find((step: WorkflowStep) => step.id === "tokens");
    expect(tokens.uses).toBe("./.github/actions/create-generated-pr-tokens");
    expect(tokens.with).toEqual({
      "contents-client-id": "${{ inputs.contents-client-id }}",
      "contents-private-key": "${{ inputs.contents-private-key }}",
      "pull-request-client-id": "${{ inputs.pull-request-client-id }}",
      "pull-request-contents-permission": "${{ inputs.auto-merge == 'true' && 'write' || '' }}",
      "pull-request-private-key": "${{ inputs.pull-request-private-key }}",
    });
    const publish = publisher.runs.steps.find(
      (step: WorkflowStep) => step.name === "Publish generated pull request",
    );
    expect(publish.env.CONTENTS_TOKEN).toBe("${{ steps.tokens.outputs.contents-token }}");
    expect(publish.env.GH_TOKEN).toBe("${{ steps.tokens.outputs.pull-request-token }}");
    expectExcludes(publish.run, [
      "gh auth setup-git",
      "gh pr close",
      'GH_TOKEN="${CONTENTS_TOKEN}"',
      'HEAD:"${BASE_BRANCH}"',
    ]);
  });

  type PublicationCase = {
    name: string;
    change?: "a" | "b";
    options?: Parameters<typeof runGeneratedPublisherScenario>[1];
    invalidationOwner?: readonly [workflow: string, job: string];
    expected?: Partial<ReturnType<typeof runGeneratedPublisherScenario>>;
    contains?: ReadonlyArray<readonly ["mergeCalls" | "summary" | "publishOutput", string]>;
    excludes?: ReadonlyArray<readonly ["mergeCalls" | "summary" | "publishOutput", string]>;
    head?: { reference: "initialBranch" | "mainHead"; equals: boolean };
    disablesAutoMerge?: boolean;
  };
  const inheritedAutoMerge = {
    autoMerge: true,
    existingAutoMergeMethod: "SQUASH",
    existingPr: true,
  } as const;
  const staleInputs = "Deferred stale generated output because generator inputs changed on main.";
  const staleOutput =
    "Deferred stale generated output because owned generated paths changed on main.";
  const convergingHead = "Generated pull request head has not converged yet; rechecking";
  const preservedHead = { reference: "initialBranch", equals: true } as const;
  const stalePullRequest = { generatedA: "stale-pr-a", mergeCalls: "" };

  it.skipIf(process.platform === "win32").each<PublicationCase>([
    {
      name: "enables auto-merge for the exact generated pull request head",
      options: { autoMerge: true },
      expected: { branchExists: true },
      contains: [
        ["mergeCalls", "pr merge https://github.com/openclaw/openclaw/pull/1"],
        ["mergeCalls", "--auto --squash --match-head-commit"],
        ["summary", "Enabled squash auto-merge for exact generated head"],
      ],
    },
    {
      name: "waits for the published pull request head before enabling auto-merge",
      options: { autoMerge: true, stalePrViewHeadOnce: true },
      contains: [
        ["mergeCalls", "--auto --squash --match-head-commit"],
        ["publishOutput", convergingHead],
      ],
    },
    {
      name: "preserves inherited auto-merge while replacing a generated pull request head",
      options: inheritedAutoMerge,
      expected: { generatedA: "desired-a", mergeCalls: "" },
      contains: [["summary", "Squash auto-merge already enabled for generated pull request"]],
    },
    {
      name: "accepts inherited auto-merge completing immediately after publication",
      options: { ...inheritedAutoMerge, mergeGeneratedPush: true },
      expected: { branchExists: false, mainGeneratedA: "desired-a", mergeCalls: "" },
      contains: [["summary", "Generated output was merged before pull request reconciliation"]],
    },
    {
      name: "waits for the existing pull request head before replacing it",
      options: { ...inheritedAutoMerge, stalePrHeadOnce: true },
      expected: { generatedA: "desired-a" },
      contains: [["publishOutput", convergingHead]],
    },
    {
      name: "refuses to replace an auto-merge-enabled head when publication opts out",
      options: { ...inheritedAutoMerge, autoMerge: false, expectFailure: true },
      expected: stalePullRequest,
      contains: [["publishOutput", "auto-merge enabled while publication opted out"]],
    },
    {
      name: "does not mutate inherited auto-merge when generated publication fails",
      options: { ...inheritedAutoMerge, expectFailure: true, failGeneratedPush: true },
      expected: stalePullRequest,
      excludes: [["summary", "auto-merge"]],
    },
    {
      name: "rejects an incompatible inherited auto-merge method without mutating it",
      options: { ...inheritedAutoMerge, existingAutoMergeMethod: "MERGE", expectFailure: true },
      expected: stalePullRequest,
      contains: [
        ["publishOutput", "Generated pull request already uses incompatible MERGE auto-merge"],
      ],
    },
    {
      name: "defers a newer owned snapshot even when the desired diff is disjoint",
      change: "b",
      expected: { branchExists: false },
      contains: [["summary", staleOutput]],
    },
    {
      name: "defers stale generator inputs and preserves an existing pull request and disarms auto-merge",
      options: { ...inheritedAutoMerge, updateSource: true },
      expected: { generatedA: "stale-pr-a" },
      head: { reference: "mainHead", equals: false },
      contains: [
        ["summary", staleInputs],
        ["mergeCalls", "--disable-auto"],
        ["summary", "Preserved stale generated pull request"],
      ],
    },
    {
      name: "defers timing refits when their codec changes on main",
      invalidationOwner: [".github/workflows/ci-test-timings-refit.yml", "refit"],
      options: { updateSource: "scripts/lib/ci-node-test-groups-codec.mts" },
      expected: { branchExists: false, mainGeneratedA: "old-a", mergeCalls: "" },
      contains: [["summary", staleInputs]],
    },
    ...(
      [
        [
          "native publication when shared translation config changes",
          NATIVE_APP_LOCALE_REFRESH_WORKFLOW,
          "scripts/lib/control-ui-i18n-config.json",
        ],
        [
          "plugin locale publication when authored input changes",
          CONTROL_UI_LOCALE_REFRESH_WORKFLOW,
          "extensions/example/src/i18n/locales/translated.json",
        ],
      ] as const
    ).map(([name, owner, updateSource]): PublicationCase => ({
      name: `defers ${name}`,
      invalidationOwner: [owner, "finalize"],
      options: { ...inheritedAutoMerge, updateSource },
      expected: { generatedA: "stale-pr-a" },
      head: preservedHead,
      contains: [
        ["mergeCalls", "--disable-auto"],
        ["summary", staleInputs],
      ],
    })),
    {
      name: "publishes after unrelated source changes when input invalidation is disabled",
      options: { invalidationPaths: "", overlapPolicy: "fail", updateSource: true },
      expected: { branchExists: true, generatedA: "desired-a" },
      excludes: [["publishOutput", "Refusing stale generated output"]],
    },
    {
      name: "preserves an existing pull request when a no-change run becomes stale",
      change: "b",
      options: { existingPr: true, noGeneratedChange: true },
      expected: { generatedA: "stale-pr-a", generatedB: "old-b" },
      head: preservedHead,
      contains: [
        ["summary", staleOutput],
        ["summary", "Preserved stale generated pull request"],
      ],
    },
    ...[false, true].map((inherited): PublicationCase => ({
      name: `disarms stale output when inputs advance during PR publication (inherited=${inherited})`,
      options: {
        autoMerge: true,
        existingPr: inherited,
        existingAutoMergeMethod: inherited ? "SQUASH" : undefined,
        updateSourceBeforeAutoMerge: true,
      },
      expected: { generatedA: "desired-a" },
      head: { reference: "mainHead", equals: false },
      contains: [["summary", "Deferred stale generated output"]],
      excludes: [["mergeCalls", "--auto --squash"]],
      disablesAutoMerge: inherited,
    })),
    {
      name: "leaves a current no-change run's existing pull request and auto-merge unchanged",
      options: { ...inheritedAutoMerge, noGeneratedChange: true },
      expected: { generatedA: "stale-pr-a", mergeCalls: "", summary: "" },
      head: preservedHead,
    },
    {
      name: "does not overwrite a successor that moves while stale auto-merge is disabled",
      options: { ...inheritedAutoMerge, updateSource: true, disarmRace: true, expectFailure: true },
      expected: { generatedA: "old-a" },
      head: { reference: "initialBranch", equals: false },
      contains: [["mergeCalls", "--disable-auto"]],
      excludes: [
        ["mergeCalls", "--auto --squash"],
        ["summary", "Preserved stale"],
      ],
    },
  ])("$name", (scenario) => {
    const options = { ...scenario.options };
    if (scenario.invalidationOwner) {
      const [file, job] = scenario.invalidationOwner;
      const publisher = expectDefined(
        readWorkflow(file).jobs[job].steps.find(
          (step: WorkflowStep) => step.uses === "./.github/actions/publish-generated-pr",
        ),
        "generated publisher",
      );
      options.invalidationPaths = publisher.with["invalidation-paths"];
    }
    const result = runGeneratedPublisherScenario(scenario.change ?? null, options);
    if (scenario.expected) {
      expect(result).toMatchObject(scenario.expected);
    }
    for (const [field, value] of scenario.contains ?? []) {
      expect(result[field]).toContain(value);
    }
    for (const [field, value] of scenario.excludes ?? []) {
      expect(result[field]).not.toContain(value);
    }
    if (scenario.head) {
      expect(result.branchHead === result[scenario.head.reference]).toBe(scenario.head.equals);
    }
    if (scenario.disablesAutoMerge !== undefined) {
      expect(result.mergeCalls.includes("--disable-auto")).toBe(scenario.disablesAutoMerge);
    }
  });

  it.skipIf(process.platform === "win32").each(["src/config/schema.help.runtime.ts"])(
    "keeps native publication independent of Control UI schema changes: %s",
    (sourcePath) => {
      const nativeWorkflow = readWorkflow(NATIVE_APP_LOCALE_REFRESH_WORKFLOW);
      const controlUiWorkflow = readWorkflow(CONTROL_UI_LOCALE_REFRESH_WORKFLOW);
      const results = [nativeWorkflow, controlUiWorkflow].map((workflow) => {
        const publisher = expectDefined(
          workflow.jobs.finalize.steps.find(
            (step: WorkflowStep) => step.uses === "./.github/actions/publish-generated-pr",
          ),
          "locale publisher",
        );
        return runGeneratedPublisherScenario(null, {
          autoMerge: true,
          invalidationPaths: publisher.with["invalidation-paths"],
          updateSource: sourcePath,
        });
      });
      const native = expectDefined(results[0], "native publication result");
      const controlUi = expectDefined(results[1], "Control UI publication result");
      expect(native.branchExists).toBe(true);
      expect(native.generatedA).toBe("desired-a");
      expect(native.mergeCalls).toContain("--auto --squash");
      expect(controlUi.branchExists).toBe(false);
      expect(controlUi.mergeCalls).toBe("");
      expect(controlUi.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails stale generated publication when no successor run is guaranteed",
    () => {
      const overlap = runGeneratedPublisherScenario("a", {
        expectFailure: true,
        overlapPolicy: "fail",
      });
      expect(overlap.branchExists).toBe(false);
      expect(overlap.publishOutput).toContain(
        "::error::Refusing stale generated output because owned generated paths changed on main.",
      );

      const stalePr = runGeneratedPublisherScenario(null, {
        existingPr: true,
        expectFailure: true,
        noGeneratedChange: true,
        overlapPolicy: "fail",
        updateSource: true,
      });
      expect(stalePr.branchHead).toBe(stalePr.initialBranch);
      expect(stalePr.summary).toContain("Preserved stale generated pull request");
      expect(stalePr.publishOutput).toContain(
        "::error::Refusing stale generated output because generator inputs changed on main.",
      );

      const publishRun = readWorkflow(PUBLISH_GENERATED_PR_ACTION).runs.steps.find(
        (step: { name?: string }) => step.name === "Publish generated pull request",
      ).run;
      const invalidPolicy = spawnSync("bash", ["-c", publishRun], {
        encoding: "utf8",
        env: {
          ...process.env,
          AUTO_MERGE: "false",
          CONTENTS_TOKEN: "contents-token",
          GH_TOKEN: "pull-request-token",
          OVERLAP_POLICY: "continue",
        },
      });
      expect(invalidPolicy.status).not.toBe(0);
      expect(`${invalidPolicy.stdout}${invalidPolicy.stderr}`).toContain(
        "Generated PR publication overlap policy must be 'defer' or 'fail'.",
      );
    },
  );

  it("fails OpenGrep SARIF artifact uploads when reports are missing", () => {
    for (const [workflowPath, artifactName] of [
      [OPENGREP_PR_DIFF_WORKFLOW, "opengrep-pr-diff-sarif"],
      [OPENGREP_FULL_WORKFLOW, "opengrep-full-sarif"],
    ] as const) {
      const workflow = readWorkflow(workflowPath);
      const uploadStep = workflow.jobs.scan.steps.find(
        (step: WorkflowStep) => step.name === "Upload SARIF as workflow artifact",
      );

      expect(uploadStep.if, workflowPath).toBe("always()");
      expect(uploadStep.uses, workflowPath).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with, workflowPath).toMatchObject({
        name: artifactName,
        path: ".opengrep-out/precise.sarif",
        "if-no-files-found": "error",
      });
    }
  });

  it("verifies the pinned OpenGrep release binary before installing it", () => {
    for (const workflowPath of [OPENGREP_PR_DIFF_WORKFLOW, OPENGREP_FULL_WORKFLOW]) {
      const workflow = readWorkflow(workflowPath);
      const installStep = requiredWorkflowStep(workflow.jobs.scan.steps, "Install opengrep");
      const run = expectDefined(installStep.run, `Install opengrep script in ${workflowPath}`);

      expect(installStep.env, workflowPath).toMatchObject({
        OPENGREP_VERSION: "v1.30.2",
        OPENGREP_LINUX_X64_SHA256:
          "a66aa3278457f02b287b985a45b6762aebcaba5000f2689245fd1ed86d1456c7",
      });
      expectIncludes(
        run,
        [
          'binary="$(mktemp "${RUNNER_TEMP}/opengrep.XXXXXX")"',
          "trap 'rm -f \"$binary\"' EXIT",
          "curl -fsSL --retry 4 --retry-all-errors --retry-delay 2",
          "--connect-timeout 10 --max-time 300",
          '-o "$binary"',
          "https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/opengrep_manylinux_x86",
          'printf \'%s  %s\\n\' "$OPENGREP_LINUX_X64_SHA256" "$binary" | sha256sum --check',
          'install -m 0755 "$binary" "$install_dir/opengrep"',
        ],
        workflowPath,
      );
      expect(run.indexOf('-o "$binary"'), workflowPath).toBeLessThan(
        run.indexOf("sha256sum --check"),
      );
      expect(run.indexOf("sha256sum --check"), workflowPath).toBeLessThan(
        run.indexOf('install -m 0755 "$binary"'),
      );
      expect(run, workflowPath).not.toMatch(/\|\s*bash/u);
    }
  });

  it("runs real behavior proof from the trusted workflow revision", () => {
    const workflow = readRealBehaviorProofWorkflow();
    const checkout = workflow.jobs["real-behavior-proof"].steps.find(
      (step: WorkflowStep) => step.uses === CHECKOUT_V6,
    );

    expect(checkout.with.ref).toBe("${{ github.workflow_sha }}");
  });

  it("keeps docs-change detection fail-safe and fixture-aware", () => {
    const action = readFileSync(".github/actions/detect-docs-changes/action.yml", "utf8");

    expectIncludes(action, [
      "base-sha:",
      "docs_only:",
      "docs_changed:",
      "BASE_SHA: ${{ inputs.base-sha }}",
    ]);

    const run = parse(action).runs.steps[0].run as string;
    for (const [source, destination, docsChanged, docsOnly] of [
      ["src/old.ts", "docs/new.md", "true", "false"],
      ["docs/old.md", "src/new.ts", "true", "false"],
      ["docs/old.md", "docs/new.md", "true", "true"],
      ["docs/old.md", "docs/.generated/config-baseline.counts.json", "true", "true"],
      ["docs/old.md", "docs/plugins/plugin-inventory.md", "true", "true"],
      ["src/old.ts", "src/new.ts", "false", "false"],
      ["test/fixtures/old.md", "docs/new.md", "true", "false"],
      ["docs/removed.md", null, "true", "true"],
      ["VISION.md", "AGENTS.md", "true", "true"],
      ["docs/old.md", "VISION.md", "true", "true"],
      ["src/old.ts", "VISION.md", "true", "false"],
    ] as const) {
      const root = tempDirs.make("openclaw-docs-diff-");
      const origin = path.join(root, "origin");
      const checkout = path.join(root, "checkout");
      mkdirSync(path.dirname(path.join(origin, source)), { recursive: true });
      const content = Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join("");
      writeFileSync(path.join(origin, source), content);
      runGit(origin, ["init", "-q", "-b", "main"]);
      for (const [name, value] of [
        ["user.name", "CI Fixture"],
        ["user.email", "ci-fixture@example.invalid"],
        ["commit.gpgsign", "false"],
        ["uploadpack.allowFilter", "true"],
      ] as const) {
        runGit(origin, ["config", name, value]);
      }
      runGit(origin, ["add", "."]);
      runGit(origin, ["commit", "-qm", "base"]);
      const base = runGit(origin, ["rev-parse", "HEAD"]);
      const sourceBlob = runGit(origin, ["rev-parse", `HEAD:${source}`]);
      rmSync(path.join(origin, source));
      if (destination) {
        mkdirSync(path.dirname(path.join(origin, destination)), { recursive: true });
        writeFileSync(path.join(origin, destination), `${content}edited after rename\n`);
      }
      runGit(origin, ["add", "-A"]);
      runGit(origin, ["commit", "-qm", "change"]);
      runGit(root, [
        "clone",
        "-q",
        "--no-local",
        "--filter=blob:none",
        "--depth=2",
        origin,
        checkout,
      ]);
      runGit(checkout, ["config", "diff.renames", "true"]);
      const localObjects = () =>
        runGit(checkout, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
      expect(localObjects()).toContain(base);
      expect(localObjects()).not.toContain(sourceBlob);
      const output = path.join(root, "output");
      const trace = path.join(root, "trace");
      const result = runWorkflowShellScript(run, {
        cwd: checkout,
        env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: output, GIT_TRACE2_EVENT: trace },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readWorkflowOutputs(output), `${source} -> ${destination}`).toEqual({
        docs_changed: docsChanged,
        docs_only: docsOnly,
        root_prose_only: source === "VISION.md" && destination === "AGENTS.md" ? "true" : "false",
      });
      expect(readFileSync(trace, "utf8")).not.toContain('"fetch"');
      expect(localObjects()).not.toContain(sourceBlob);
    }
  });

  it("keeps empty and unavailable root prose detection conservative", () => {
    const root = tempDirs.make("openclaw-root-prose-empty-");
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "CI Fixture"]);
    runGit(root, ["config", "user.email", "ci-fixture@example.invalid"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(root, "VISION.md"), "vision\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "base"]);
    const run = readWorkflow(".github/actions/detect-docs-changes/action.yml").runs.steps[0].run;
    for (const base of ["HEAD", "missing-base"]) {
      const output = path.join(root, base + ".out");
      const result = runWorkflowShellScript(run, {
        cwd: root,
        env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: output },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readWorkflowOutputs(output)).toEqual({
        docs_only: "false",
        docs_changed: "false",
        root_prose_only: "false",
      });
    }
  });

  it("runs generated docs checks in the docs-only job", () => {
    const job = readCiWorkflow().jobs["check-docs"];
    const configDocsCheck = requiredWorkflowStep(job.steps, "Check config docs baseline");
    const pluginInventoryCheck = requiredWorkflowStep(job.steps, "Check plugin inventory");

    expect(job.if).toBe("needs.preflight.outputs.run_check_docs == 'true'");
    expect(configDocsCheck?.run).toBe("pnpm config:docs:check");
    expect(pluginInventoryCheck?.run).toBe("pnpm plugins:inventory:check");
    const contentSteps = [
      "Check config docs baseline",
      "Check plugin inventory",
      "Checkout ClawHub docs source",
      "Record external documentation dependency",
      "Check docs",
    ];
    for (const name of contentSteps) {
      const step = job.steps.find((candidate: WorkflowStep) => candidate.name === name);
      for (const enabled of ["true", "false"]) {
        expect(
          evaluateWorkflowCondition(step.if, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            preflightOutputs: { run_docs_content: enabled },
            steps: {
              node_setup: { outcome: "success", outputs: {} },
              clawhub_docs: { outcome: "success", outputs: {} },
            },
          }),
          name,
        ).toBe(enabled === "true");
      }
    }
    const format = job.steps.find((step: WorkflowStep) => step.name === "Check formatting");
    expect(format.if).not.toContain("run_docs_content");
    expect(
      evaluateWorkflowCondition(format.if, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        preflightOutputs: { run_docs_content: "false", run_format_check: "true" },
        steps: { node_setup: { outcome: "success", outputs: {} } },
      }),
    ).toBe(true);
    const preflight = readCiWorkflow().jobs.preflight;
    expect(preflight.outputs.run_docs_content).toBe(
      "${{ steps.manifest.outputs.run_docs_content }}",
    );
    expect(
      preflight.steps.find((step: WorkflowStep) => step.id === "manifest").env
        .OPENCLAW_CI_DOCS_ROOT_PROSE_ONLY,
    ).toBe("${{ steps.docs_scope.outputs.root_prose_only }}");
  });

  it("bounds matrix fan-out for runner-registration pressure", () => {
    const workflow = readCiWorkflow();

    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name == 'pull_request'",
    );
    expect(workflow.jobs["checks-fast-core"].strategy["max-parallel"]).toBe(12);
    const nodeParallel =
      workflow.jobs["checks-node-core-test-nondist-shard"].strategy["max-parallel"];
    const canonicalNodePr = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      headRepository: "openclaw/openclaw",
      runAttempt: 1,
      runnerProfile: "hybrid" as const,
    };
    for (const runnerBackend of ["", "blacksmith", "hybrid"] as const) {
      for (const authorAssociation of ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]) {
        expect(
          evaluateWorkflowExpression(nodeParallel, {
            ...canonicalNodePr,
            runnerBackend,
            runnerProfile: runnerBackend === "hybrid" ? "hybrid" : "blacksmith",
            authorAssociation,
          }),
          `${runnerBackend || "default"}/${authorAssociation}`,
        ).toBe(130);
      }
    }
    const restrictedNodeContexts: Array<Partial<Parameters<typeof evaluateWorkflowExpression>[1]>> =
      [
        { eventName: "push" },
        { eventName: "schedule" },
        { eventName: "workflow_dispatch" },
        {
          eventName: "workflow_dispatch",
          ciShape: "main",
          preflightOutputs: { ci_qualification: "true", qualification_runner_backend: "hybrid" },
        },
        {
          eventName: "workflow_dispatch",
          ciShape: "default",
          preflightOutputs: { ci_qualification: "true", qualification_runner_backend: "hybrid" },
        },
        { runnerBackend: "github" },
        { runnerBackend: "runson" },
        { preflightOutputs: { node_runner_backend: "runson" } },
        { runnerProfile: "github" },
        { runAttempt: 2 },
        { frozenTarget: true },
        { headRepository: "contributor/openclaw", runAttempt: 2, runnerProfile: "github" },
        { repository: "contributor/openclaw" },
      ];
    for (const context of restrictedNodeContexts) {
      expect(
        evaluateWorkflowExpression(nodeParallel, {
          ...canonicalNodePr,
          runnerBackend: "hybrid",
          authorAssociation: "CONTRIBUTOR",
          ...context,
        }),
        JSON.stringify(context),
      ).toBe(96);
    }
    // Fork first attempts keep hosted check stripes but plan Node shards with the
    // configured backend, so they get the same Node parallelism.
    expect(
      evaluateWorkflowExpression(nodeParallel, {
        ...canonicalNodePr,
        runnerBackend: "hybrid",
        headRepository: "contributor/openclaw",
        runnerProfile: "github",
        preflightOutputs: { node_runner_backend: "hybrid" },
      }),
      "fork first attempt",
    ).toBe(130);
    // Author association no longer limits capacity.
    for (const authorAssociation of [
      "FIRST_TIME_CONTRIBUTOR",
      "FIRST_TIMER",
      "NONE",
      "MANNEQUIN",
    ]) {
      expect(
        evaluateWorkflowExpression(nodeParallel, {
          ...canonicalNodePr,
          runnerBackend: "hybrid",
          authorAssociation,
        }),
        authorAssociation,
      ).toBe(130);
    }
    expect(workflow.jobs["checks-fast-plugin-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-additional-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-windows"].strategy["max-parallel"]).toBe(5);
    expect(workflow.jobs["checks-ui-e2e-real-gateway"].strategy["max-parallel"]).toBe(2);
    for (const [context, expected] of [
      [{ eventName: "push" }, 4],
      [{ eventName: "pull_request", runnerBackend: "blacksmith" }, 4],
      [{ eventName: "pull_request", runnerBackend: "hybrid" }, 4],
      [{ eventName: "pull_request", authorAssociation: "NONE" }, 4],
      [{ eventName: "push", runnerBackend: "github" }, 2],
      [{ eventName: "push", runnerBackend: "blacksmith", runAttempt: 2 }, 2],
      [{ eventName: "workflow_dispatch", runnerBackend: "blacksmith" }, 2],
      [{ eventName: "pull_request", headRepository: "contributor/openclaw" }, 4],
      [{ eventName: "schedule", runnerBackend: "blacksmith" }, 2],
      [
        {
          eventName: "workflow_dispatch",
          runnerBackend: "hybrid",
          preflightOutputs: { ci_qualification: "true", qualification_runner_backend: "hybrid" },
        },
        2,
      ],
      [{ eventName: "push", repository: "contributor/openclaw" }, 2],
    ] as const) {
      expect(
        evaluateWorkflowExpression(workflow.jobs.android.strategy["max-parallel"], { ...context }),
        JSON.stringify(context),
      ).toBe(expected);
    }
    for (const runnerBackend of ["", "blacksmith", "hybrid", "runson", "github"] as const) {
      for (const runAttempt of [1, 2]) {
        const context = {
          eventName: "pull_request" as const,
          repository: "openclaw/openclaw",
          headRepository: "contributor/openclaw",
          authorAssociation: "FIRST_TIME_CONTRIBUTOR",
          runnerBackend,
          runAttempt,
        };
        const runner = evaluateWorkflowExpression(workflow.jobs.android["runs-on"], context);
        const parallel = evaluateWorkflowExpression(
          workflow.jobs.android.strategy["max-parallel"],
          context,
        );
        const hosted = runnerBackend === "github" || runAttempt > 1;
        expect(runner, JSON.stringify(context)).toBe(
          hosted ? "ubuntu-24.04" : "blacksmith-8vcpu-ubuntu-2404",
        );
        expect(parallel, JSON.stringify(context)).toBe(hosted ? 2 : 4);
      }
    }
  });

  it("runs the Docker seed tier with the published updater and a checked main/PR smoke package", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const jobs = readCiWorkflow().jobs;
    const job = jobs["docker-seed-e2e"];
    expect(source).toContain("docker-seed-e2e-contract-v1");
    expect(manifestSource).toContain('typeof dockerSeedPlan.resolveDockerSeedLanes === "function"');
    expect(jobs.preflight.outputs).toMatchObject({
      docker_seed_lanes: "${{ steps.manifest.outputs.docker_seed_lanes }}",
      run_docker_seed_e2e: "${{ steps.manifest.outputs.run_docker_seed_e2e }}",
    });
    expect(job.if).toBe("needs.preflight.outputs.run_docker_seed_e2e == 'true'");
    expect(job.needs).toEqual(["preflight"]);
    expect(job["timeout-minutes"]).toBe(115);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.strategy).toBeUndefined();
    expect(job.steps[0]).toEqual(jobs["build-artifacts"].steps[0]);
    expect(job.steps[1].uses).toBe("./.ci-harness/.github/actions/setup-node-env");
    expect(job.steps[1].with).toMatchObject({
      "build-all-cache-scope": "full",
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
    });
    const run = requiredWorkflowStep(job.steps, "Run Docker seed tier");
    const parallelism = run.env?.OPENCLAW_DOCKER_ALL_PARALLELISM;
    expect(run).toMatchObject({
      run: "pnpm test:docker:all",
      env: {
        OPENCLAW_DOCKER_ALL_LANES: "${{ needs.preflight.outputs.docker_seed_lanes }}",
        OPENCLAW_DOCKER_ALL_LIVE_MODE: "skip",
        OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG: "1",
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
        OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM: parallelism,
      },
    });
    expect(parallelism).toContain("&& 3 || 1");
    expect(run.env).not.toHaveProperty("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC");
    expect(run.env).not.toHaveProperty("OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS");
    const prepare = job.steps.find((step: WorkflowStep) =>
      step.run?.includes("scripts/package-openclaw-for-docker.mjs"),
    ) as WorkflowStep;
    for (const eventName of ["push", "pull_request"] as const) {
      expect(evaluateWorkflowExpression("${{ " + prepare.if + " }}", { eventName })).toBe(true);
    }
    for (const releaseGate of [false, true]) {
      for (const qualification of [false, true]) {
        expect(
          evaluateWorkflowExpression("${{ " + prepare.if + " }}", {
            eventName: "workflow_dispatch",
            releaseGate,
            preflightOutputs: { ci_qualification: String(qualification) },
          }),
        ).toBe(releaseGate && !qualification);
      }
    }
    const releaseChild = {
      eventName: "workflow_dispatch",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      dispatchId: "full-release-validation-1-1-ci",
    } as const;
    expect(evaluateWorkflowExpression("${{ " + prepare.if + " }}", releaseChild)).toBe(true);
    expect(evaluateWorkflowExpression(job["runs-on"], releaseChild)).toBe(
      "blacksmith-16vcpu-ubuntu-2404",
    );
    expect(evaluateWorkflowExpression(parallelism!, releaseChild)).toBe(1);
    for (const recovery of [
      { ...releaseChild, runnerBackend: "github" as const },
      { ...releaseChild, runAttempt: 2 },
      { ...releaseChild, runnerBackend: "hybrid" as const, runAttempt: 2 },
      { ...releaseChild, runnerBackend: "runson" as const, runAttempt: 2 },
    ]) {
      expect(evaluateWorkflowExpression(job["runs-on"], recovery)).toBe("ubuntu-24.04");
      expect(evaluateWorkflowExpression(parallelism!, recovery)).toBe(1);
    }
    expect(
      evaluateWorkflowExpression(job["runs-on"], {
        ...releaseChild,
        releaseRunnerGroup: "release-runners",
      }),
    ).toEqual({ group: "release-runners", labels: "ubuntu-24.04" });
    const manualDispatch = { ...releaseChild, dispatchId: "" };
    expect(evaluateWorkflowExpression(job["runs-on"], manualDispatch)).toBe("ubuntu-24.04");
    expect(evaluateWorkflowExpression(parallelism!, manualDispatch)).toBe(1);
    expect(prepare.run).toContain("pnpm build:ci-artifacts");
    expect(prepare.run).toContain("node scripts/package-openclaw-for-docker.mjs --skip-build");
    expect(prepare.run).not.toContain("--skip-check");
    expect(prepare.run).toContain("OPENCLAW_CURRENT_PACKAGE_TGZ=");
    expect(job.steps.indexOf(prepare)).toBeLessThan(job.steps.indexOf(run));
    const baseline = requiredWorkflowStep(
      job.steps,
      "Resolve published Docker seed upgrade baseline",
    );
    expect(baseline.if).toBe(
      "contains(format(' {0} ', needs.preflight.outputs.docker_seed_lanes), ' published-upgrade-survivor ')",
    );
    expect(baseline.env).toEqual({
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref || github.base_ref || github.ref_name }}",
      QUALIFICATION_BASELINES_JSON: "${{ inputs.qualification_baselines_json }}",
      FROZEN_TARGET: "${{ needs.preflight.outputs.frozen_target }}",
    });
    expect(job.steps.indexOf(baseline)).toBeLessThan(job.steps.indexOf(run));
    const survivorProof = requiredWorkflowStep(
      job.steps,
      "Upload sanitized upgrade survivor proof",
    );
    expect(survivorProof).toMatchObject({
      if: `always() && ${baseline.if}`,
      uses: UPLOAD_ARTIFACT_V7,
      with: { "include-hidden-files": true, "if-no-files-found": "warn" },
    });
    const proofPaths = String(survivorProof.with?.path).trim().split(/\s+/u);
    const uploaded = (file: string) => proofPaths.some((pattern) => minimatch(file, pattern));
    for (const file of [
      ".artifacts/docker-tests/20260920T000000Z/summary.json",
      ".artifacts/docker-tests/20260920T000000Z/failures.json",
      ".artifacts/docker-tests/upgrade-survivor-baseline.123/failure.json",
      ".artifacts/docker-tests/upgrade-survivor-baseline.123/summary.json",
    ]) {
      expect(uploaded(file), file).toBe(true);
    }
    for (const file of [
      ".artifacts/upgrade-survivor/baseline/legacy-operator-baseline-turn.err",
      ".artifacts/upgrade-survivor/baseline/diagnostics/raw.json",
      ".artifacts/docker-tests/run/published-upgrade-survivor.log",
      ".artifacts/docker-tests/20260920T000000Z/baseline-cache/package/summary.json",
      ".artifacts/docker-tests/20260920T000000Z/baseline-cache/package/failures.json",
      ".artifacts/docker-tests/upgrade-survivor-baseline.123/private/summary.json",
    ]) {
      expect(uploaded(file), file).toBe(false);
    }
  });

  it.each<{
    candidate: string;
    shape: string;
    captured?: string;
    expected?: string;
    context?: string;
    frozen?: boolean;
    catalog?: unknown;
    catalogText?: string;
    scenario?: string;
    error?: string;
  }>([
    { candidate: "2026.9.3", shape: "current", expected: "openclaw@2026.9.2" },
    {
      candidate: "2026.9.3",
      shape: "frozen-captured-three-key",
      frozen: true,
      captured: "openclaw@2026.9.1",
      catalog: {
        oldestSupportedBaseline: "2026.6.1",
        scenarios: ["base", "legacy-operator-state"],
        assertionOnlyScenarios: [],
      },
      expected: "openclaw@2026.9.1",
    },
    {
      candidate: "2026.9.3",
      shape: "assertion-only-is-not-executable",
      frozen: true,
      catalog: { scenarios: ["base"], assertionOnlyScenarios: ["legacy-operator-state"] },
      expected: "openclaw@2026.9.2",
      scenario: "base",
    },
    {
      candidate: "2026.6.35",
      shape: "extended-stable",
      context: "extended-stable/2026.6.33",
      expected: "openclaw@2026.6.34",
    },
    { candidate: "2026.6.34", shape: "no-predecessor", expected: undefined },
    {
      candidate: "2026.9.3",
      shape: "frozen-current",
      frozen: true,
      catalog: { scenarios: ["base", "legacy-operator-state"], assertionOnlyScenarios: [] },
      expected: "openclaw@2026.9.2",
    },
    {
      candidate: "2026.9.3",
      shape: "historical-declared",
      frozen: true,
      catalog: { scenarios: ["base"], assertionOnlyScenarios: [] },
      expected: "openclaw@2026.9.2",
      scenario: "base",
    },
    {
      candidate: "2026.9.3",
      shape: "historical-pre-catalog",
      frozen: true,
      expected: "openclaw@2026.9.2",
      scenario: "base",
    },
    {
      candidate: "2026.9.3",
      shape: "malformed-catalog",
      frozen: true,
      catalogText: "{",
      error: "Invalid upgrade-survivor scenario catalog",
    },
    {
      candidate: "2026.9.3",
      shape: "invalid-catalog",
      frozen: true,
      catalog: { scenarios: "base", assertionOnlyScenarios: [] },
      error: "Invalid upgrade-survivor scenario catalog",
    },
    {
      candidate: "2026.9.3",
      shape: "unsupported-catalog",
      frozen: true,
      catalog: { scenarios: ["other"], assertionOnlyScenarios: [] },
      error: "No supported Docker seed upgrade scenario",
    },
  ])("hands Docker seed published inputs for $candidate ($shape)", (fixture) => {
    const job = readCiWorkflow().jobs["docker-seed-e2e"];
    const baseline = requiredWorkflowStep(
      job.steps,
      "Resolve published Docker seed upgrade baseline",
    );
    const run = requiredWorkflowStep(job.steps, "Run Docker seed tier");
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-upgrade-baseline-"));
    try {
      const bin = path.join(root, "bin");
      const tooling = path.join(root, ".ci-harness", "scripts", "lib");
      mkdirSync(bin);
      mkdirSync(tooling, { recursive: true });
      for (const name of [
        "release-upgrade-baseline.mjs",
        "release-version.mjs",
        "canonical-json.mjs",
        "upgrade-survivor-policy.mjs",
        "upgrade-survivor-scenarios.json",
      ]) {
        copyFileSync(path.resolve("scripts", "lib", name), path.join(tooling, name));
      }
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ version: fixture.candidate }),
      );
      if (fixture.catalogText !== undefined || fixture.catalog !== undefined) {
        const catalog = path.join(root, "scripts/lib/upgrade-survivor-scenarios.json");
        mkdirSync(path.dirname(catalog), { recursive: true });
        writeFileSync(catalog, fixture.catalogText ?? JSON.stringify(fixture.catalog));
      }
      writeFileSync(
        path.join(root, ".ci-harness", "package.json"),
        JSON.stringify({ version: "2026.10.1" }),
      );
      symlinkSync(process.execPath, path.join(bin, "node"));
      writeFileSync(
        path.join(bin, "npm"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.QUALIFICATION_BASELINES_JSON) throw new Error("frozen qualification must not re-resolve npm baselines");
if (JSON.stringify(args) !== JSON.stringify(["view", "openclaw", "versions", "--json", "--silent", "--prefer-online"])) process.exit(2);
console.log(JSON.stringify(["2026.6.34", "2026.6.35", "2026.9.1", "2026.9.2", "2026.9.3", "2026.9.4-beta.1"]));
`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(bin, "pnpm"),
        `#!${process.execPath}
if (process.argv.slice(2).join(" ") !== "test:docker:all") process.exit(2);
require("node:fs").writeFileSync("scheduler-baseline", process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC ?? "missing");
require("node:fs").writeFileSync("scheduler-scenario", process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS ?? "missing");
require("node:fs").writeFileSync("scheduler-restart", process.env.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE ?? "missing");
`,
        { mode: 0o755 },
      );
      writeFileSync(path.join(root, "github-env"), "");
      const inheritedBaseline = run.env?.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC;
      const inheritedScenario = run.env?.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS;
      const inheritedRestartMode = run.env?.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE;
      if (typeof inheritedRestartMode !== "string") {
        throw new Error("Docker seed restart mode must be a string");
      }
      const result = runWorkflowShellScript(
        `set -euo pipefail\n${baseline?.run ?? ""}\nset -a\nsource "$GITHUB_ENV"\nset +a\n${run.run}`,
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            GITHUB_ENV: path.join(root, "github-env"),
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:
              typeof inheritedBaseline === "string" ? inheritedBaseline : "",
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS:
              typeof inheritedScenario === "string"
                ? String(
                    evaluateWorkflowExpression(inheritedScenario, {
                      eventName: "workflow_dispatch",
                      preflightOutputs: { frozen_target: String(fixture.frozen ?? false) },
                    }),
                  )
                : "",
            OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: inheritedRestartMode,
            FROZEN_TARGET: String(fixture.frozen ?? false),
            TARGET_CONTEXT_REF: fixture.context ?? "main",
            QUALIFICATION_BASELINES_JSON: fixture.captured
              ? JSON.stringify({
                  upgradeBaseline: fixture.captured,
                  upgradeSurvivorBaselines: [fixture.captured],
                })
              : "",
          },
        },
      );
      const receipt = path.join(root, "scheduler-baseline");
      if (fixture.expected) {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(receipt, "utf8")).toBe(fixture.expected);
        expect(readFileSync(path.join(root, "scheduler-scenario"), "utf8")).toBe(
          fixture.scenario ?? "legacy-operator-state",
        );
        expect(readFileSync(path.join(root, "scheduler-restart"), "utf8")).toBe("auto-auth");
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          fixture.error ?? "no published stable OpenClaw baseline predates candidate",
        );
        expect(existsSync(receipt)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs the Android SDK platform used by Gradle", () => {
    const workflow = readCiWorkflow();
    const releaseWorkflow = readAndroidReleaseWorkflow();
    const action = readAndroidToolchainAction();
    const appCompileSdk = readAndroidCompileSdk("apps/android/app/build.gradle.kts");
    const benchmarkCompileSdk = readAndroidCompileSdk("apps/android/benchmark/build.gradle.kts");
    const packageId = `platforms;android-${appCompileSdk}.0`;

    expect(appCompileSdk).toBe(benchmarkCompileSdk);
    expect(
      workflow.jobs.android.steps.filter(
        (step: WorkflowStep) =>
          step.uses === "./.ci-harness/.github/actions/setup-android-toolchain",
      ),
    ).toHaveLength(1);
    expect(
      releaseWorkflow.jobs.publish_signed_android_apk.steps.filter(
        (step: WorkflowStep) => step.uses === "./.github/actions/setup-android-toolchain",
      ),
    ).toHaveLength(1);

    const sdkRestoreStep = requiredWorkflowStep(action.runs.steps, "Restore Android SDK cache");
    const sdkSaveStep = requiredWorkflowStep(action.runs.steps, "Save Android SDK cache");
    const gradleCacheStep = requiredWorkflowStep(action.runs.steps, "Setup Gradle cache");
    const javaStep = requiredWorkflowStep(action.runs.steps, "Setup Java");
    const installStep = requiredWorkflowStep(action.runs.steps, "Install Android SDK packages");

    expect(javaStep.uses).toBe("actions/setup-java@de7274f081f381c8f8158605e0321c36c376e2e6");
    expect(javaStep.with).toMatchObject({
      distribution: "temurin",
      "java-version": 17,
    });
    expect(javaStep.with?.["set-default"]).not.toBe(false);
    const gradleJavaStep = requiredWorkflowStep(action.runs.steps, "Setup Gradle Java");
    expect(gradleJavaStep).toMatchObject({
      id: "gradle-java",
      uses: javaStep.uses,
      with: {
        distribution: "temurin",
        "java-version": "21.0.12+101.0.LTS",
        "set-default": false,
      },
    });
    expect(action.outputs["gradle-java-home"].value).toBe("${{ steps.gradle-java.outputs.path }}");
    expect(action.outputs["gradle-java-version"].value).toBe(
      "${{ steps.gradle-java.outputs.version }}",
    );
    expect(action.inputs["cache-mode"].default).toBe("off");
    expect(sdkRestoreStep.if).toBe("inputs.cache-mode != 'off'");
    expect(sdkRestoreStep.uses).toBe(CACHE_V5);
    expect(sdkRestoreStep.with?.key).toContain(`platform-${appCompileSdk}.0-`);
    expectIncludes(sdkSaveStep.if, [
      "inputs.cache-mode == 'read-write'",
      "steps.android-sdk-cache.outputs.cache-hit != 'true'",
    ]);
    expect(sdkSaveStep.uses).toBe(CACHE_SAVE_V5);
    expect(sdkSaveStep.with?.key).toBe("${{ steps.android-sdk-cache.outputs.cache-primary-key }}");
    expect(gradleCacheStep).toMatchObject({
      if: "inputs.cache-mode != 'off'",
      uses: SETUP_GRADLE_V6,
      with: {
        "add-job-summary": "never",
        "cache-provider": "basic",
        "cache-read-only": "${{ inputs.cache-mode != 'read-write' }}",
      },
    });
    expect(installStep.run).toContain(`"${packageId}"`);
    expect(installStep.run).toContain(
      'yes | sdkmanager --sdk_root="${ANDROID_SDK_ROOT}" --licenses >/dev/null || [[ "${PIPESTATUS[1]}" -eq 0 ]]',
    );
    const setupStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) =>
        step.run?.includes("commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"),
      ),
      "Android SDK setup step",
    );

    expect(sdkRestoreStep.with?.key).toBe(
      "${{ runner.os }}-android-sdk-v2-cmdline-15859902-platform-37.0-build-tools-37.0.0-${{ inputs.install-screenshot-emulators == 'true' && 'screenshot-emulators' || 'base' }}",
    );
    expect(String(sdkRestoreStep.with?.["restore-keys"]).trim().split("\n")).toEqual([
      "${{ inputs.install-screenshot-emulators == 'true' && format('{0}-android-sdk-v2-cmdline-15859902-platform-37.0-build-tools-37.0.0-base', runner.os) || '' }}",
    ]);
    expectIncludes(setupStep.run, [
      'CMDLINE_TOOLS_VERSION="15859902"',
      'CMDLINE_TOOLS_SHA256="4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583"',
      "curl -fsSL --connect-timeout 10 --max-time 300",
      "sha256sum --check -",
    ]);
  });

  it("binds release targets to current authenticated ref evidence", () => {
    const workflow = readCiWorkflow();
    const input = workflow.on.workflow_dispatch.inputs.target_context_ref;
    const step = requiredWorkflowStep(workflow.jobs.preflight.steps, "Validate target context");
    const targetSha = "a".repeat(40);

    expect(input).toEqual({
      description:
        "Canonical release branch context authorizing compatibility fallbacks for an exact-SHA target",
      required: false,
      default: "",
      type: "string",
    });
    expect(step.if).toBe("inputs.target_context_ref != ''");

    for (const contextRef of [
      "release/2026.8.1",
      "release/2026.8.1-1",
      "extended-stable/2026.8.33",
    ]) {
      for (const comparisonStatus of ["ahead", "identical"]) {
        const result = runCiReleaseRefValidation({
          ref: contextRef,
          targetSha,
          resolvedSha: comparisonStatus === "identical" ? targetSha : "b".repeat(40),
          comparisonStatus,
        });
        expect(result.status, `${contextRef}: ${result.output}`).toBe(0);
        expect(result.outputs.eligible).toBe("true");
      }
    }

    for (const contextRef of [
      "v2026.8.1",
      "main",
      "release-ci/2026.8.1-beta.2-frozen",
      "release/2026.8",
      "refs/heads/release/2026.8.1",
    ]) {
      const result = runCiReleaseRefValidation({ ref: contextRef, targetSha });
      expect(result.status, contextRef).toBe(1);
      expect(result.output).toContain(
        "target_context_ref must be a canonical OpenClaw release branch.",
      );
    }

    for (const targetRef of ["main", "a".repeat(39)]) {
      const result = runCiReleaseRefValidation({ ref: "release/2026.8.1", targetSha: targetRef });
      expect(result.status, targetRef).toBe(1);
      expect(result.output).toContain(
        "target_context_ref requires target_ref to be a full commit SHA.",
      );
    }

    for (const comparisonStatus of ["behind", "diverged"]) {
      const result = runCiReleaseRefValidation({
        ref: "release/2026.8.1",
        targetSha,
        comparisonStatus,
      });
      expect(result.status, comparisonStatus).toBe(1);
      expect(result.output).toContain(
        "target_ref must be the declared release branch head or one of its ancestors.",
      );
    }

    for (const identity of [
      { kind: "historical", ref: "v2026.8.1" },
      { kind: "candidate", ref: "release/2026.8.1" },
    ] as const) {
      const accepted = runCiReleaseRefValidation({
        ...identity,
        targetSha,
        resolvedSha: targetSha,
      });
      expect(accepted.status, accepted.output).toBe(0);
      expect(accepted.outputs.eligible).toBe("true");

      const mismatched = runCiReleaseRefValidation({ ...identity, targetSha });
      expect(mismatched.status).not.toBe(0);
      expect(mismatched.output).toContain(`does not resolve to ${targetSha}`);
      expect(mismatched.outputs).not.toHaveProperty("eligible");
    }
    for (const identity of [
      { kind: "context", ref: "release/2026.8.1", apiError: "ref" },
      { kind: "context", ref: "release/2026.8.1", apiError: "comparison" },
    ] as const) {
      const result = runCiReleaseRefValidation({
        ...identity,
        targetSha,
        resolvedSha: targetSha,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("HTTP 503");
      expect(result.outputs).not.toHaveProperty("eligible");
    }
    for (const identity of [
      { kind: "historical", ref: "refs/heads/v2026.8.1" },
      { kind: "candidate", ref: "refs/tags/release/2026.8.1" },
    ] as const) {
      const result = runCiReleaseRefValidation({ ...identity, targetSha });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("must be a canonical OpenClaw release");
      expect(result.outputs).not.toHaveProperty("eligible");
    }
  });

  // Native Windows Node cannot execute this fixture's POSIX gh child shim.
  it.skipIf(process.platform === "win32")("protects correction credentials", () => {
    const root = tempDirs.make("openclaw-ci-correction-order-");
    const trusted = path.join(root, ".ci-harness/scripts/lib");
    const eventsPath = path.join(root, "events");
    const outputPath = path.join(root, "output");
    const bin = path.join(root, "bin");
    mkdirSync(trusted, { recursive: true });
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(bin);
    writeFileSync(eventsPath, "");
    writeFileSync(outputPath, "");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
    for (const name of ["release-context.mjs", "release-version.mjs"]) {
      writeFileSync(path.join(trusted, name), readFileSync(`scripts/lib/${name}`));
    }
    writeFileSync(
      path.join(trusted, "release-context-original.mjs"),
      readFileSync("scripts/lib/release-context.mjs"),
    );
    const poisonedHelper = `
      import { appendFileSync } from 'node:fs';
      if (process.env.GH_TOKEN) appendFileSync(${JSON.stringify(eventsPath)}, 'token-exposed\\n');
      export { resolveReleaseContextIdentity } from './release-context-original.mjs';
    `;
    writeFileSync(
      path.join(root, "scripts/ci-changed-scope.mjs"),
      `import { appendFileSync, writeFileSync } from 'node:fs';
       appendFileSync(${JSON.stringify(eventsPath)}, 'candidate\\n');
       writeFileSync(${JSON.stringify(path.join(trusted, "release-context.mjs"))}, ${JSON.stringify(poisonedHelper)});`,
    );
    writeExecutable(path.join(bin, "gh"), [
      "#!/bin/sh",
      '[ "$GH_TOKEN" = test-token ] || exit 4',
      `[ "$*" = 'api repos/openclaw/openclaw/commits/refs%2Ftags%2Fv2026.9.1 --jq .sha' ] || exit 64`,
      `printf 'lookup\\n' >> ${quoteShell(eventsPath)}`,
      `printf '%s\\n' '${"a".repeat(40)}'`,
    ]);
    const context = {
      eventName: "workflow_dispatch" as const,
      releaseGate: true,
      releaseScope: "npm-stable",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      targetContextRef: "release/2026.9.1-1",
      workflowToken: "test-token",
      steps: {
        diff_base: { outputs: { sha: "b".repeat(40), head_sha: "a".repeat(40) } },
        target_context_target: { outputs: { eligible: "true" } },
      },
    };
    const steps = readCiWorkflow().jobs.preflight.steps.filter((step: WorkflowStep) =>
      ["Resolve release correction base", "Detect changed scopes"].includes(step.name ?? ""),
    );
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      const evaluate = (expression: string) => evaluateWorkflowExpression(expression, context);
      expect(evaluate(`\${{ ${step.if} }}`), step.name).toBe(true);
      const run = runWorkflowShellScript(
        step.run.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
          String(evaluate(expression)),
        ),
        {
          cwd: root,
          env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            GITHUB_REPOSITORY: context.repository,
            GITHUB_OUTPUT: outputPath,
            ...Object.fromEntries(
              Object.entries(step.env ?? {}).map(([name, value]) => [
                name,
                String(evaluate(String(value))),
              ]),
            ),
          },
        },
      );
      expect(run.status, `${step.name}: ${run.stdout}${run.stderr}`).toBe(0);
    }
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual(["lookup", "candidate"]);
    expect(readWorkflowOutputs(outputPath).sha).toBe("a".repeat(40));
  });

  it("loads Android CI setup from the workflow revision for frozen targets", () => {
    const steps = readCiWorkflow().jobs.android.steps as WorkflowStep[];
    const checkoutIndex = steps.findIndex((step) => step.name === "Checkout");
    const actionCheckoutIndex = steps.findIndex(
      (step) => step.name === "Checkout CI Android toolchain action",
    );
    const setupIndex = steps.findIndex((step) => step.name === "Setup Android toolchain");
    const actionCheckout = expectDefined(steps[actionCheckoutIndex], "Android action checkout");

    expect(actionCheckout.uses).toBe(CHECKOUT_V6);
    expect(actionCheckout.with).toMatchObject({
      path: ".ci-harness",
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
      "sparse-checkout": ".github/actions\nscripts/ci-collect-checks.sh\n",
    });
    expect(checkoutIndex).toBeLessThan(actionCheckoutIndex);
    expect(actionCheckoutIndex).toBeLessThan(setupIndex);
  });

  it("keeps tiny hybrid controls hosted without moving security or fork first attempts", () => {
    const context = {
      eventName: "pull_request",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerBackend: "hybrid",
    } as const;
    for (const jobName of ["preflight", "security-fast", "ci-gate"]) {
      const runner = (overrides: Partial<Parameters<typeof evaluateWorkflowExpression>[1]>) =>
        ciValue(jobName, "runs-on", { ...context, ...overrides });
      for (const eventName of ["pull_request", "push"] as const) {
        expect(runner({ eventName }), jobName).toBe(
          jobName === "security-fast" ? "blacksmith-4vcpu-ubuntu-2404" : "ubuntu-24.04",
        );
      }
      expect(
        runner({
          authorAssociation: "NONE",
          headRepository: "contributor/openclaw",
        }),
        `${jobName}: untrusted fork first attempt`,
      ).toBe("blacksmith-4vcpu-ubuntu-2404");
      for (const override of [
        { runAttempt: 0 },
        { runAttempt: 2 },
        { runAttempt: 2, headRepository: "contributor/openclaw" },
        { runnerBackend: "github" },
        { eventName: "workflow_dispatch" },
        { repository: "contributor/openclaw" },
      ] as const) {
        expect(runner(override), jobName).toBe("ubuntu-24.04");
      }
      for (const runnerBackend of ["", "blacksmith"] as const) {
        for (const eventName of ["pull_request", "push"] as const) {
          expect(runner({ eventName, runnerBackend }), jobName).toBe(
            jobName === "preflight" ? "blacksmith-4vcpu-ubuntu-2404" : "ubuntu-24.04",
          );
        }
      }
    }
    for (const [jobName, task, expected] of [
      ["preflight", undefined, "ubuntu-24.04"],
      ["security-fast", undefined, "ubuntu-24.04"],
      ["checks-ui", undefined, "blacksmith-8vcpu-ubuntu-2404"],
      ["checks-ui-e2e", "browser-extension", "ubuntu-24.04"],
      ["checks-ui-e2e", "control-ui", "blacksmith-16vcpu-ubuntu-2404"],
      ["checks-ui-e2e-real-gateway", undefined, "blacksmith-16vcpu-ubuntu-2404"],
    ] as const) {
      expect(
        ciValue(jobName, "runs-on", {
          ...context,
          matrix: { task },
          preflightOutputs: { hybrid_hosted_offload: "true" },
        }),
        `${jobName}: ${task ?? "default"}`,
      ).toBe(expected);
    }
    for (const frozenTarget of ["true", ""]) {
      expect(
        ciValue("checks-ui-e2e-real-gateway", "runs-on", {
          ...context,
          preflightOutputs: { frozen_target: frozenTarget },
        }),
      ).toBe("blacksmith-32vcpu-ubuntu-2404");
    }
    for (const authorAssociation of ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]) {
      for (const headRepository of ["openclaw/openclaw", "contributor/openclaw"]) {
        for (const runnerBackend of ["hybrid", "runson"] as const) {
          expect(
            ciValue("preflight", "runs-on", {
              ...context,
              authorAssociation,
              headRepository,
              runnerBackend,
            }),
            `${runnerBackend}: ${authorAssociation}: ${headRepository}`,
          ).toBe(
            runnerBackend === "hybrid" && headRepository === "openclaw/openclaw"
              ? "ubuntu-24.04"
              : "blacksmith-4vcpu-ubuntu-2404",
          );
        }
      }
    }
  });

  it.each([
    {
      file: "full-release-validation.yml",
      runner: "blacksmith-4vcpu-ubuntu-2404",
      job: "release_checks_independent",
    },
    {
      file: "openclaw-npm-preflight.yml",
      runner: "blacksmith-32vcpu-ubuntu-2404",
      job: "check_openclaw_npm",
    },
  ])("honors the global hosted runner override for $file/$job", ({ file, runner, job }) => {
    const workflow = readWorkflow(`.github/workflows/${file}`);
    const runsOn = workflow.jobs[job]["runs-on"];
    const supportsHostedInput =
      file === "openclaw-npm-preflight.yml" || file === "openclaw-live-and-e2e-checks-reusable.yml";

    for (const runnerBackend of ["github", "", "blacksmith", "hybrid"] as const) {
      for (const useGithubHostedRunners of [false, true]) {
        const expectedRunner =
          runnerBackend === "github" || (supportsHostedInput && useGithubHostedRunners)
            ? "ubuntu-24.04"
            : runner;
        const actualRunner =
          typeof runsOn === "string" && runsOn.startsWith("${{")
            ? evaluateWorkflowExpression(runsOn, {
                eventName: "workflow_dispatch",
                runnerBackend,
                useGithubHostedRunners,
              })
            : runsOn;

        expect(
          actualRunner,
          `${runnerBackend || "unset"}, use_github_hosted_runners=${useGithubHostedRunners}`,
        ).toBe(expectedRunner);
      }
    }
  });

  it.each(["release/2026.9.1"])(
    "honors trusted dispatch runner selection for check shards with context %j",
    (targetContextRef) => {
      const runsOn = readCiWorkflow().jobs["check-shard"]["runs-on"];
      const lintMatrix = {
        runner: "blacksmith-32vcpu-ubuntu-2404",
        task: "lint",
      };
      const evaluateDispatch = (
        runnerBackend: "blacksmith" | "github" | "hybrid",
        overrides: Partial<Parameters<typeof evaluateWorkflowExpression>[1]> = {},
      ) =>
        evaluateWorkflowExpression(runsOn, {
          eventName: "workflow_dispatch",
          matrix: lintMatrix,
          runnerBackend,
          ...overrides,
        });

      expect(evaluateDispatch("blacksmith")).toBe("blacksmith-32vcpu-ubuntu-2404");
      for (const backend of ["blacksmith", "github", "hybrid"] as const) {
        expect(
          evaluateDispatch(backend, backend === "blacksmith" ? { releaseGate: true } : {}),
        ).toBe("ubuntu-24.04");
      }

      const frozenFrv = {
        dispatchId: "full-release-validation-33128772779-ci",
        frozenTarget: true,
        targetContextRef,
      };
      expect(evaluateDispatch("hybrid", frozenFrv)).toBe("blacksmith-32vcpu-ubuntu-2404");
      expect(evaluateDispatch("github", frozenFrv)).toBe("ubuntu-24.04");
      for (const overrides of [
        { frozenTarget: false },
        { dispatchId: "manual-ci-proof" },
        { releaseGate: true },
        { matrix: { runner: "blacksmith-16vcpu-ubuntu-2404", task: "test-types" } },
        { repository: "fork/openclaw" },
      ]) {
        expect(evaluateDispatch("hybrid", { ...frozenFrv, ...overrides })).toBe("ubuntu-24.04");
      }
      expect(
        evaluateWorkflowExpression(runsOn, {
          authorAssociation: "NONE",
          headRepository: "openclaw/openclaw",
          matrix: lintMatrix,
          runnerBackend: "blacksmith",
        }),
      ).toBe("blacksmith-32vcpu-ubuntu-2404");
    },
  );

  it.each([
    ["current shard 1", {}, 30],
    ["current shard 2", { matrix: { shard: 2 } }, 30],
    ["frozen shard 1", { frozenTarget: true }, 30],
    ["frozen shard 2", { frozenTarget: true, matrix: { shard: 2 } }, 30],
    ["unclassified shard 1", { preflightOutputs: { frozen_target: "" } }, 30],
    ["unclassified shard 2", { preflightOutputs: { frozen_target: "" }, matrix: { shard: 2 } }, 30],
    ["hosted override", { runnerBackend: "github" }, 40],
    ["hybrid retry", { runnerBackend: "hybrid", runAttempt: 2 }, 40],
    ["manual fallback", { eventName: "workflow_dispatch" }, 40],
    ["PR retry", { eventName: "pull_request", runAttempt: 2 }, 40],
    ["noncanonical fallback", { repository: "example/openclaw" }, 40],
  ] as const)("bounds real-Gateway job time for %s", (_label, overrides, minutes) => {
    expect(
      ciValue("checks-ui-e2e-real-gateway", "timeout-minutes", {
        eventName: "schedule",
        runnerBackend: "blacksmith",
        frozenTarget: false,
        matrix: { shard: 1 },
        ...overrides,
      }),
    ).toBe(minutes);
  });

  it("gives breaker-routed hosted jobs their hosted timeout budgets", () => {
    const context = {
      eventName: "pull_request",
      headRepository: "openclaw/openclaw",
      matrix: { task: "build-play" },
      repository: "openclaw/openclaw",
      runAttempt: 1,
    } as const;
    for (const [jobName, hostedTimeout, blacksmithTimeout] of [
      ["android", 35, 20],
      ["build-artifacts", 35, 20],
      ["checks-ui", 35, 20],
      ["checks-ui-e2e-real-gateway", 40, 30],
    ] as const) {
      for (const [overrides, expected] of [
        [{ runnerBackend: "github" }, hostedTimeout],
        [{ runnerBackend: "blacksmith" }, blacksmithTimeout],
        [{ runnerBackend: "hybrid", runAttempt: 2 }, hostedTimeout],
      ] as const) {
        expect(
          ciValue(jobName, "timeout-minutes", { ...context, ...overrides }),
          `${jobName}: ${JSON.stringify(overrides)}`,
        ).toBe(expected);
      }
    }
    for (const [group, expected] of [
      ["extension-package-boundary", 40],
      ["runtime-topology-architecture", 20],
      ["plugin-sdk-api-diff", 30],
      ["boundaries", 20],
      [undefined, 20],
    ] as const) {
      expect(
        ciValue("check-additional-shard", "timeout-minutes", { runAttempt: 2, matrix: { group } }),
        group ?? "default additional check",
      ).toBe(expected);
    }
  });

  it.each(["hybrid", "runson"] as const)(
    "keeps %s UI shards on Blacksmith with their existing timeout",
    (runnerBackend) => {
      for (const offload of [false, true]) {
        const context = {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          matrix: { task: "build-play" },
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerBackend,
          preflightOutputs: { hybrid_hosted_offload: String(offload) },
        } as const;
        expect(ciValue("checks-ui", "runs-on", context)).toBe("blacksmith-8vcpu-ubuntu-2404");
        for (const [jobName, timeout] of [
          ["build-artifacts", 20],
          ["android", 20],
          ["checks-ui-e2e-real-gateway", 30],
          ["checks-ui", 20],
        ] as const) {
          expect(
            ciValue(jobName, "timeout-minutes", context),
            `${jobName}: hosted offload ${offload}`,
          ).toBe(timeout);
        }
      }
    },
  );

  it("resolves the pull request base and changed files from the shallow security checkout", () => {
    const securitySteps = readCiWorkflow().jobs["security-fast"].steps as WorkflowStep[];
    const checkoutIndex = securitySteps.findIndex((step) => step.name === "Checkout");
    const checkout = expectDefined(securitySteps[checkoutIndex], "security checkout");
    const root = tempDirs.make("openclaw-security-checkout-");
    const depth = checkout.with?.["fetch-depth"];
    expect(Number.isInteger(Number(depth)) && Number(depth) > 0).toBe(true);
    expect(checkout.with?.["persist-credentials"]).toBe(false);

    const source = path.join(root, "source");
    const selected = path.join(root, "selected");
    mkdirSync(source);
    mkdirSync(selected);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          cwd,
          "-c",
          "user.name=CI Fixture",
          "-c",
          "user.email=ci@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            GIT_ALLOW_PROTOCOL: "file",
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      ).trim();
    git(source, "init", "--initial-branch=main");
    writeFileSync(path.join(source, "base.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "base");
    git(source, "checkout", "-b", "pull-request");
    for (let index = 0; index < 3; index++) {
      writeFileSync(path.join(source, "change.txt"), `change ${index}\n`);
      git(source, "add", ".");
      git(source, "commit", "-m", `change ${index}`);
    }
    git(source, "checkout", "main");
    writeFileSync(path.join(source, "base.txt"), "advanced base\n");
    git(source, "commit", "-am", "advance main");
    const base = git(source, "rev-parse", "HEAD");
    git(source, "merge", "--no-ff", "pull-request", "-m", "synthetic merge");
    const merge = git(source, "rev-parse", "HEAD");
    git(selected, "init");
    git(
      selected,
      "fetch",
      "--no-tags",
      `--depth=${String(depth)}`,
      pathToFileURL(source).href,
      merge,
    );
    git(selected, "checkout", "--detach", "FETCH_HEAD");

    const resolveBase = expectDefined(
      securitySteps.find((step) => step.id === "diff_base"),
      "security diff base",
    );
    const output = path.join(root, "base-output");
    const result = spawnSync("bash", ["-e", "-c", expectDefined(resolveBase.run, "base script")], {
      cwd: selected,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        EVENT_BASE_SHA: "stale-event-base",
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8").trim()).toBe(`sha=${base}`);
    expect(git(selected, "diff", "--name-only", base, "HEAD")).toBe("change.txt");
  });

  it("keeps action manifests within the runner's anchor-free YAML grammar", () => {
    const files = globSync([".github/actions/**/action.yml", ".github/actions/**/action.yaml"]);
    expect(files.length).toBeGreaterThan(0);
    const unsupported: string[] = [];
    for (const file of files) {
      const document = parseDocument(readFileSync(file, "utf8"));
      expect(document.errors, file).toEqual([]);
      visit(document, {
        Node(_key, node) {
          if (isAlias(node) || node.anchor) {
            unsupported.push(file);
          }
        },
      });
    }
    expect(unsupported).toEqual([]);
  });

  it("keeps setup cache access explicit and isolates every cache write", () => {
    const setupActionPaths = [
      ".github/actions/setup-node-env/action.yml",
      ".github/actions/setup-pnpm-store-cache/action.yml",
    ];
    const legacyInputs = [
      "save-actions-cache",
      "save-dependency-cache",
      "save-node-compile-cache",
      "save-vitest-fs-cache",
      "use-actions-cache",
    ];
    for (const actionPath of setupActionPaths) {
      const action = readWorkflow(actionPath);
      const steps = action.runs.steps as WorkflowStep[];
      expect(action.inputs["cache-mode"].default, actionPath).toBe("off");
      for (const legacyInput of legacyInputs) {
        expect(action.inputs, `${actionPath}: ${legacyInput}`).not.toHaveProperty(legacyInput);
      }
      expect(
        steps.filter(
          (step) =>
            step.uses?.startsWith("actions/cache@") || step.uses?.startsWith("actions/cache/save@"),
        ),
        actionPath,
      ).toEqual([]);
      expect(
        steps.filter((step) => step.uses?.startsWith("actions/cache/restore@")).length,
        actionPath,
      ).toBeGreaterThan(0);
      const validation = expectDefined(
        steps.find((step) => step.run?.includes("off|restore|read-write")),
        `${actionPath} cache-mode validation`,
      );
      expect(validation.run).toContain("Invalid cache-mode input");
    }

    const callers: Array<{ file: string; mode: unknown; step: WorkflowStep }> = [];
    const directCaches: Array<{
      file: string;
      step: WorkflowStep;
      jobId?: string;
      jobCondition?: string;
    }> = [];
    const rubySetups: Array<{ file: string; step: WorkflowStep }> = [];
    for (const file of [
      ...findYamlFiles(".github/workflows"),
      ...findYamlFiles(".github/actions"),
    ]) {
      const parsed = readWorkflow(file);
      const stepLists = [
        ...Object.entries(parsed?.jobs ?? {}).map(([jobId, job]) => {
          const owner = job as { steps?: WorkflowStep[]; if?: string };
          return { jobId, jobCondition: owner.if, steps: owner.steps ?? [] };
        }),
        {
          jobId: undefined,
          jobCondition: undefined,
          steps: (parsed?.runs?.steps ?? []) as WorkflowStep[],
        },
      ];
      for (const { jobId, jobCondition, steps } of stepLists) {
        for (const step of steps) {
          if (step.uses?.startsWith("actions/cache")) {
            directCaches.push({ file, step, jobId, jobCondition });
          }
          if (step.uses?.startsWith("ruby/setup-ruby@")) {
            rubySetups.push({ file, step });
          }
          if (
            step.uses === "./.github/actions/setup-node-env" ||
            step.uses?.endsWith("/.github/actions/setup-node-env") ||
            step.uses === "./.github/actions/setup-pnpm-store-cache" ||
            step.uses?.endsWith("/.github/actions/setup-pnpm-store-cache")
          ) {
            callers.push({ file, mode: step.with?.["cache-mode"], step });
          }
        }
      }
    }
    expect(rubySetups.length).toBeGreaterThan(0);
    for (const { file, step } of rubySetups) {
      const bundlerCache = step.with?.["bundler-cache"] ?? false;
      expect([false, true, "false", "true"], `${file}: ${step.name}`).toContain(bundlerCache);
      if (bundlerCache === true || bundlerCache === "true") {
        expect(String(step.if), `${file}: ${step.name}`).toContain("cache_write_allowed == 'true'");
      }
    }
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      const staticMode = ["off", "restore", "read-write"].includes(String(caller.mode));
      const conditionalMode =
        typeof caller.mode === "string" &&
        caller.mode.startsWith("${{") &&
        (caller.mode.includes("needs.preflight.outputs.cache_mode") ||
          caller.mode.includes("steps.candidate_trust.outputs.cache_mode") ||
          (caller.mode.includes("'restore'") &&
            (caller.mode.includes("'off'") || caller.mode.includes("'read-write'"))));
      expect(staticMode || conditionalMode, `${caller.file}: ${caller.step.name}`).toBe(true);
      for (const legacyInput of legacyInputs) {
        expect(caller.step.with, `${caller.file}: ${legacyInput}`).not.toHaveProperty(legacyInput);
      }
    }
    const writeAuthorizedCallers = callers.filter(
      (caller) =>
        caller.mode === "read-write" ||
        (typeof caller.mode === "string" && caller.mode.includes("'read-write'")),
    );
    expect(writeAuthorizedCallers).toHaveLength(5);
    expect(writeAuthorizedCallers.map(({ file, mode, step }) => [file, mode, step.name])).toEqual(
      expect.arrayContaining([
        [
          ".github/workflows/ci-build-artifacts-testbox.yml",
          expect.stringContaining("'read-write'"),
          "Setup Node environment",
        ],
        [".github/workflows/openclaw-npm-preflight.yml", "read-write", "Setup Node environment"],
        [".github/workflows/vitest-cache-warm.yml", "read-write", "Setup Node environment"],
        [
          ".github/workflows/vitest-cache-warm.yml",
          "read-write",
          "Setup release build runtime and cache",
        ],
      ]),
    );

    const nodeCachePathPattern =
      /(?:^|\n)\s*(?:\.artifacts\/build-all-cache|dist\/|dist-runtime\/|packages\/\*\/dist\/|extensions\/\*\/dist\/|~\/\.cache\/ms-playwright|~\/\.local\/share\/pnpm|~\/\.cache\/pnpm|node_modules)(?:\n|$)/u;
    for (const { file, step, jobId, jobCondition } of directCaches) {
      if (step.uses?.startsWith("actions/cache/save@")) {
        if (step.with?.path === ".cache/barnacle-pr-scan.json") {
          expect(file).toBe(".github/workflows/stale.yml");
          expect(jobId).toBe("stale-pull-requests");
          expect(step.with).toEqual({
            path: ".cache/barnacle-pr-scan.json",
            key: "barnacle-pr-scan-v1-${{ github.run_id }}-${{ github.run_attempt }}",
          });
          expect(step.if).toBe(
            "${{ !cancelled() && steps.evaluate.outputs.checkpoint-written == 'true' && (github.event_name != 'workflow_dispatch' || inputs.dry_run == false) && inputs.pr_numbers == '' }}",
          );
          const workflow = readWorkflow(file);
          expect(workflow.jobs["stale-pull-requests"].concurrency).toEqual({
            group: "barnacle-stale-pr-lifecycle",
            "cancel-in-progress": false,
          });
          continue;
        }
        if (step.with?.path === "full-release-execution-plan") {
          expect(file).toBe(".github/workflows/full-release-validation.yml");
          expect(jobId).toBe("release_execution_plan");
          expect(step.with).toEqual({
            path: "full-release-execution-plan",
            key: "full-release-execution-plan-v2-${{ github.run_id }}",
          });
          expect(step.if).toBe(
            "${{ always() && github.run_attempt == 1 && steps.plan_witness.outcome == 'success' }}",
          );
          continue;
        }
        if (step.with?.path === ".cache/openclaw-cross-os-npm-cache/_cacache") {
          expect([
            ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
            ".github/workflows/release-npm-cache-warm.yml",
          ]).toContain(file);
          const authority = `${jobCondition ?? ""} ${step.if ?? ""}`;
          expect(authority).toContain("github.repository == 'openclaw/openclaw'");
          expect(authority).toContain("github.event_name == 'workflow_dispatch'");
          continue;
        }
        if (step.with?.path === ".artifacts/ci-sdk-declarations/sdk.json.gz") {
          expect(file).toBe(".github/actions/sdk-declarations/action.yml");
          const action = readWorkflow(file);
          const pack = action.runs.steps.find(
            (candidate: WorkflowStep) => candidate.id === "main-pack",
          );
          expect(step.if).toBe(pack.if);
          expectIncludes(step.if, [
            "success()",
            "inputs.mode == 'save-main'",
            "steps.identity.outputs.enabled == 'true'",
            "github.repository == 'openclaw/openclaw'",
            "github.ref == 'refs/heads/main'",
            "inputs.candidate-trust == 'main'",
            "inputs.cache-write-allowed == 'true'",
            "inputs.cache-mode != 'off'",
            "inputs.frozen-target != 'true'",
            "inputs.compatibility-target != 'true'",
            "inputs.release-gate != 'true'",
          ]);
          continue;
        }
        const condition = String(step.if);
        expect(
          condition.includes(".outputs.cache-mode == 'read-write'") ||
            condition.includes("inputs.cache-mode == 'read-write'") ||
            condition.includes("needs.preflight.outputs.cache_write_allowed == 'true'"),
          `${file}: ${step.name}`,
        ).toBe(true);
      }
      if (step.uses?.startsWith("actions/cache@")) {
        expect(nodeCachePathPattern.test(String(step.with?.path)), `${file}: ${step.name}`).toBe(
          false,
        );
      }
    }
  });

  it("uses the workflow Node 24 pin for hosted default requests", () => {
    const action = readWorkflow(".github/actions/setup-node-env/action.yml");
    const setup: WorkflowStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.id === "setup-node"),
      "Node setup",
    );
    const expression = String(
      expectDefined(setup.env?.REQUESTED_NODE_VERSION, "requested Node version"),
    )
      .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
      .replaceAll("inputs.node-version", 'inputs["node-version"]');
    for (const [environment, requested, pin, expected] of [
      ["github-hosted", "24.x", "24.21.0", "24.21.0"],
      ["github-hosted", "24.x", undefined, "24.x"],
      ["github-hosted", "24.x", "", "24.x"],
      ["github-hosted", "24.x", "26.1.0", "24.x"],
      ["github-hosted", "24.16.0", "24.21.0", "24.16.0"],
      ["github-hosted", "26.x", "24.21.0", "26.x"],
      ["self-hosted", "24.x", "24.21.0", "24.x"],
      ["", "24.x", "24.21.0", "24.x"],
    ] as const) {
      expect(
        runInNewContext(expression, {
          runner: { environment },
          inputs: { "node-version": requested },
          env: pin === undefined ? {} : { NODE_VERSION: pin },
          startsWith: (value: unknown, prefix: string) =>
            typeof value === "string" && value.startsWith(prefix),
        }),
        `${environment}/${requested}/${pin ?? "unset"}`,
      ).toBe(expected);
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves authenticated toolchain archives during dependency store repair",
    () => {
      const root = tempDirs.make("openclaw-install-recipe-");
      const workspace = path.join(root, "workspace");
      const bin = path.join(root, "bin");
      const store = path.join(root, "store");
      const log = path.join(root, "calls.jsonl");
      const githubEnv = path.join(root, "github.env");
      const payload = path.join(root, "payload");
      for (const directory of [
        bin,
        store,
        ...["", "ui", "packages", "extensions", "examples"].map((entry) =>
          path.join(workspace, entry),
        ),
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      mkdirSync(path.join(workspace, "node_modules"));
      writeFileSync(path.join(workspace, "node_modules", "before"), "");
      writeFileSync(path.join(store, "before"), "");
      mkdirSync(path.join(store, "toolchain"));
      writeFileSync(path.join(store, "toolchain", "pnpm.tgz"), "authenticated archive");
      symlinkSync(testNodeExecPath, path.join(bin, "node"));
      const pnpm = path.join(bin, "pnpm");
      writeFileSync(
        pnpm,
        "#!" +
          testNodeExecPath +
          "\n" +
          String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-v") { console.log("fixture"); process.exit(0); }
const log = process.env.RECIPE_LOG;
const count = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), importMethod: process.env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD }) + "\n");
process.exit(JSON.parse(process.env.RECIPE_EXITS)[count] ?? 99);
`,
      );
      chmodSync(pnpm, 0o755);
      const action = readWorkflow(".github/actions/setup-node-env/action.yml");
      const step: WorkflowStep = requiredWorkflowStep(action.runs.steps, "Install dependencies");
      const run = expectDefined(step.run, "Install dependencies script");
      const config = {
        PNPM_CONFIG_CACHE_DIR: path.join(root, "metadata"),
        PNPM_CONFIG_CHILD_CONCURRENCY: "3",
        PNPM_CONFIG_NETWORK_CONCURRENCY: "4",
        PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "copy",
        PNPM_CONFIG_STORE_DIR: store,
        PNPM_CONFIG_VIRTUAL_STORE_DIR: path.join(root, "virtual"),
      };
      const result = spawnSync(
        "bash",
        ["-c", run.trimEnd() + ' && printf reached > "$RECIPE_PAYLOAD"'],
        {
          cwd: workspace,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            NODE_BIN: bin,
            GITHUB_ACTION_PATH: path.resolve(".github/actions/setup-node-env"),
            GITHUB_WORKSPACE: workspace,
            GITHUB_ENV: githubEnv,
            RUNNER_OS: "Linux",
            CI: "true",
            DEPENDENCY_CACHE: "true",
            DEPENDENCY_CACHE_HIT: "true",
            FROZEN_LOCKFILE: "true",
            RECIPE_LOG: log,
            RECIPE_PAYLOAD: payload,
            RECIPE_EXITS: JSON.stringify([23, 23, 0]),
            ...config,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(payload)).toBe(true);
      const calls: Array<{ args: string[]; cwd: string; importMethod: string }> = readFileSync(
        log,
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const expectedArgs = [
        "install",
        "--config.ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
        "--frozen-lockfile",
        "--config.cache-dir=" + config.PNPM_CONFIG_CACHE_DIR,
        "--config.child-concurrency=3",
        "--config.network-concurrency=4",
        "--config.package-import-method=hardlink",
        "--config.store-dir=" + store,
        "--config.virtual-store-dir=" + config.PNPM_CONFIG_VIRTUAL_STORE_DIR,
      ];
      expect(calls).toEqual(
        ["--offline", "--offline", "--prefer-offline"].map((mode) => ({
          args: [...expectedArgs, mode],
          cwd: workspace,
          importMethod: "hardlink",
        })),
      );
      expect(existsSync(path.join(workspace, "node_modules", "before"))).toBe(false);
      expect(existsSync(path.join(store, "before"))).toBe(false);
      expect(readFileSync(path.join(store, "toolchain", "pnpm.tgz"), "utf8")).toBe(
        "authenticated archive",
      );
      expect(readFileSync(githubEnv, "utf8")).toBe(
        "OPENCLAW_BUILD_ALL_NO_PNPM=1\npnpm_config_verify_deps_before_run=false\n",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves pnpm hard links and validates cached importers and supply-chain policy offline",
    async ({ onTestFinished, signal }) => {
      const fixtureDirs = createTempDirTracker();
      // oxlint-disable-next-line prefer-const -- Failure cleanup can run before the registry is started.
      let stopRegistry: (() => Promise<void>) | undefined;
      // Timeout does not join the test body. Keep close and deletion in one hook,
      // outside afterEach, so a failed join cannot release the registry's files.
      onTestFinished(async () => {
        await stopRegistry?.();
        fixtureDirs.cleanup();
      });
      const root = fixtureDirs.make("openclaw-dependency-cache-");
      const source = path.join(root, "source");
      const registry = path.join(root, "registry");
      const workspace = path.join(root, "workspace");
      const consumer = path.join(workspace, "packages", "consumer");
      const store = path.join(workspace, ".cache", "openclaw-pnpm-store");
      let userHome = path.join(root, "producer-home");
      mkdirSync(userHome, { recursive: true });
      mkdirSync(source, { recursive: true });
      mkdirSync(registry, { recursive: true });
      mkdirSync(consumer, { recursive: true });
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({
          files: ["index.js"],
          name: "cache-proof-dep",
          packageManager: rootPackageManager,
          scripts: { "pnpm-path": "node -p process.env.npm_execpath" },
          version: "1.0.0",
        }),
      );
      writeFileSync(path.join(source, "index.js"), 'module.exports = "cache-proof-v1";\n');
      // Both projects own the pinned environment before any command runs; otherwise
      // pnpm resolves its own metadata from the public registry during bootstrap.
      const { environment } = pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8"));
      if (environment !== null) {
        for (const directory of [source, workspace]) {
          writeFileSync(path.join(directory, "pnpm-lock.yaml"), `---\n${environment}\n---\n`);
        }
      }
      // Capture the pinned CLI before switching to the fixture-only registry/store.
      const nodeExecPath = resolveTestNodeExecPath();
      const bootstrap = resolvePnpmRunner({ nodeExecPath });
      const npmExecPath = execFileSync(
        bootstrap.command,
        [...bootstrap.args, "--silent", "run", "pnpm-path"],
        { cwd: source, encoding: "utf8", env: { ...process.env, CI: "true" } },
      ).trim();
      const pnpm = resolvePnpmRunner({ nodeExecPath, npmExecPath });
      const action = readWorkflow(".github/actions/setup-node-env/action.yml");
      const configureCache = expectDefined(
        action.runs.steps.find(
          (step: WorkflowStep) => step.name === "Configure dependency cache store",
        )?.run,
        "Configure dependency cache store script",
      );
      const envFile = path.join(root, "dependency-cache.env");
      execFileSync("bash", ["-c", configureCache], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_ENV: envFile },
      });
      const dependencyEnvironment = Object.fromEntries(
        readFileSync(envFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      const runPnpm = (args: string[], cwd: string) =>
        spawnSync(pnpm.command, [...pnpm.args, ...args], {
          cwd,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: userHome,
            XDG_CACHE_HOME: path.join(userHome, ".cache"),
            CI: "true",
            PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "hardlink",
            ...dependencyEnvironment,
          },
        });
      const version = runPnpm(["--version"], source);
      expect(version.status, version.stderr).toBe(0);
      expect(`pnpm@${version.stdout.trim()}`).toBe(rootPackageManager.split("+")[0]);
      const packed = runPnpm(["pack", "--pack-destination", registry], source);
      expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);
      const tarball = path.join(registry, "cache-proof-dep-1.0.0.tgz");
      const registryScript = String.raw`
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const tarballPath = process.argv[1];
const tarball = readFileSync(tarballPath);
const server = createServer((request, response) => {
  if (request.url === "/cache-proof-dep") {
    const port = server.address().port;
    const metadata = {
      name: "cache-proof-dep",
      "dist-tags": { latest: "1.0.0" },
      time: {
        "1.0.0": new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        modified: new Date().toISOString(),
      },
      versions: {
        "1.0.0": {
          name: "cache-proof-dep",
          version: "1.0.0",
          dist: {
            tarball: "http://127.0.0.1:" + port + "/cache-proof-dep-1.0.0.tgz",
            shasum: createHash("sha1").update(tarball).digest("hex"),
            integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64"),
          },
        },
      },
    };
    const abbreviated = request.headers.accept?.includes("application/vnd.npm.install-v1+json");
    if (abbreviated) {
      delete metadata.time;
    }
    response.setHeader("content-type", abbreviated ? "application/vnd.npm.install-v1+json" : "application/json");
    response.end(JSON.stringify(metadata));
    return;
  }
  if (request.url === "/cache-proof-dep-1.0.0.tgz") {
    response.setHeader("content-type", "application/octet-stream");
    response.end(tarball);
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  process.send(server.address().port);
});
`;
      const registryServer = spawn(process.execPath, ["-e", registryScript, tarball], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let registryDidClose = false;
      // Retain actual close from launch, including failed spawn; readiness must not own this join.
      const registryClosed = new Promise<void>((resolve) => {
        registryServer.once("close", () => {
          registryDidClose = true;
          resolve();
        });
      });
      const failures: unknown[] = [];
      registryServer.on("error", (error) => failures.push(error));
      stopRegistry = async () => {
        if (!registryDidClose) {
          registryServer.kill("SIGTERM");
        }
        await registryClosed;
      };
      try {
        const ready = new Promise<number>((resolve, reject) => {
          registryServer.once("message", (message) => {
            if (typeof message !== "number") {
              reject(new Error("fixture registry sent an invalid port"));
              return;
            }
            resolve(message);
          });
          registryServer.once("error", reject);
        });
        const port = await withinTest(
          awaitGateBeforeSettlement(ready, registryClosed, "fixture registry closed before ready"),
          signal,
        );
        signal.throwIfAborted();
        const registryUrl = `http://127.0.0.1:${port}`;
        writeFileSync(
          path.join(workspace, "package.json"),
          JSON.stringify({
            dependencies: { "cache-proof-dep": "1.0.0" },
            name: "cache-proof-root",
            packageManager: rootPackageManager,
            private: true,
          }),
        );
        const workspaceConfig =
          "packages:\n  - packages/*\nminimumReleaseAge: 10080\nminimumReleaseAgeStrict: true\n";
        writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), workspaceConfig);
        const writeConsumerManifest = (dependencyVersion: string) =>
          writeFileSync(
            path.join(consumer, "package.json"),
            JSON.stringify({
              dependencies: { "cache-proof-dep": dependencyVersion },
              name: "cache-proof-consumer",
              private: true,
            }),
          );
        writeConsumerManifest("1.0.0");
        // The fixture registry serves only its test package, not the preserved project pnpm pin.
        const installArgs = [
          "install",
          "--ignore-scripts",
          "--config.engine-strict=false",
          "--pm-on-fail=ignore",
        ];
        const onlineArgs = [...installArgs, `--registry=${registryUrl}`];
        const seeded = runPnpm([...onlineArgs, "--lockfile-only"], workspace);
        expect(seeded.status, `${seeded.stdout}${seeded.stderr}`).toBe(0);
        // CI publishes a frozen install, without the lockfile generator's caches.
        rmSync(userHome, { force: true, recursive: true });
        rmSync(store, { force: true, recursive: true });
        mkdirSync(userHome, { recursive: true });
        const installed = runPnpm([...onlineArgs, "--frozen-lockfile"], workspace);
        expect(installed.status, `${installed.stdout}${installed.stderr}`).toBe(0);

        const findSameFile = (directory: string, referencePath: string): string | undefined => {
          const reference = statSync(referencePath);
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              const nested = findSameFile(entryPath, referencePath);
              if (nested) {
                return nested;
              }
            } else if (entry.isFile()) {
              const candidate = statSync(entryPath);
              if (candidate.dev === reference.dev && candidate.ino === reference.ino) {
                return entryPath;
              }
            }
          }
          return undefined;
        };
        const rootPackageFile = path.join(workspace, "node_modules", "cache-proof-dep", "index.js");
        expect(findSameFile(store, rootPackageFile)).toBeDefined();

        const archive = path.join(root, "dependency-cache.tar");
        execFileSync(
          "tar",
          [
            "-cf",
            archive,
            "-C",
            workspace,
            "node_modules",
            "packages/consumer/node_modules",
            ".cache/openclaw-pnpm-store",
          ],
          { stdio: "pipe" },
        );

        rmSync(path.join(workspace, "node_modules"), { force: true, recursive: true });
        rmSync(path.join(consumer, "node_modules"), { force: true, recursive: true });
        rmSync(store, { force: true, recursive: true });
        rmSync(userHome, { force: true, recursive: true });
        userHome = path.join(root, "consumer-home");
        mkdirSync(userHome, { recursive: true });
        execFileSync("tar", ["-xf", archive, "-C", workspace], { stdio: "pipe" });

        const restoredPackageFile = path.join(
          workspace,
          "node_modules",
          "cache-proof-dep",
          "index.js",
        );
        expect(findSameFile(store, restoredPackageFile)).toBeDefined();
        expect(
          readFileSync(path.join(consumer, "node_modules", "cache-proof-dep", "index.js"), "utf8"),
        ).toBe('module.exports = "cache-proof-v1";\n');

        await stopRegistry();
        const registryAtStop = {
          closed: registryDidClose,
          exitCode: registryServer.exitCode,
          signalCode: registryServer.signalCode,
        };
        signal.throwIfAborted();
        expect(
          registryAtStop.closed,
          "registry closed before source deletion/offline install",
        ).toBe(true);
        // This direct child owns the listener; its released port may already have a new owner.
        expect(registryAtStop.exitCode !== null || registryAtStop.signalCode !== null).toBe(true);
        rmSync(registry, { force: true, recursive: true });
        const cachedIdentity = statSync(restoredPackageFile);
        const cachedLockfile = readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8");
        const offlineArgs = [...onlineArgs, "--offline", "--frozen-lockfile"];
        const reconciliation = runPnpm(offlineArgs, workspace);
        expect(reconciliation.status, `${reconciliation.stdout}${reconciliation.stderr}`).toBe(0);
        expect(statSync(restoredPackageFile)).toMatchObject({
          dev: cachedIdentity.dev,
          ino: cachedIdentity.ino,
        });
        expect(readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8")).toBe(cachedLockfile);
        expect(
          readFileSync(path.join(consumer, "node_modules", "cache-proof-dep", "index.js"), "utf8"),
        ).toBe('module.exports = "cache-proof-v1";\n');
        // A stricter policy invalidates pnpm's saved verification and reads the
        // restored registry metadata. A 14-day-old release fails a 21-day gate.
        writeFileSync(
          path.join(workspace, "pnpm-workspace.yaml"),
          workspaceConfig.replace("minimumReleaseAge: 10080", "minimumReleaseAge: 30240"),
        );
        const stricterPolicy = runPnpm(offlineArgs, workspace);
        expect(stricterPolicy.status).toBe(1);
        expect(`${stricterPolicy.stdout}${stricterPolicy.stderr}`).toContain(
          "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
        );
        writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), workspaceConfig);
        writeConsumerManifest("2.0.0");
        const drift = runPnpm(offlineArgs, workspace);
        expect(drift.status).toBe(1);
        expect(`${drift.stdout}${drift.stderr}`).toContain('Cannot install with "frozen-lockfile"');
        expect(`${drift.stdout}${drift.stderr}`).toContain('in importers["packages/consumer"]');
        expect(`${drift.stdout}${drift.stderr}`).toContain(
          "cache-proof-dep (lockfile: 1.0.0, manifest: 2.0.0)",
        );
      } catch (error) {
        if (failures[0] !== error) {
          failures.unshift(error);
        }
      } finally {
        try {
          await stopRegistry();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "dependency cache fixture failed");
      }
    },
  );

  it("shares full-build caches by installed Node version across requests and generations", () => {
    const action = readWorkflow(".github/actions/setup-node-env/action.yml");
    const cacheStep = requiredWorkflowStep(action.runs.steps, "Restore build-all cache");
    const renderCacheKey = (
      template: string,
      runId: number,
      runAttempt: number,
      requestedNode = "24.x",
      resolvedNode = "24.21.0",
    ) =>
      template.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) =>
        String(
          runInNewContext(expression.replace(/\.([A-Za-z_][\w-]*)/gu, '["$1"]'), {
            github: { repository: "openclaw/openclaw", run_id: runId, run_attempt: runAttempt },
            inputs: { "build-all-cache-scope": "full", "node-version": requestedNode },
            runner: { os: "Linux", arch: "X64" },
            steps: { "setup-node": { outputs: { "resolved-version": resolvedNode } } },
            hashFiles: () => "unchanged-source",
          }),
        ),
      );
    // Actions cannot replace an exact key after a declaration group is rebuilt.
    const keys = (
      [
        [10, 1],
        [11, 1],
        [11, 2],
      ] as const
    ).map(([runId, runAttempt]) => renderCacheKey(cacheStep.with.key, runId, runAttempt));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key.startsWith(renderCacheKey(cacheStep.with["restore-keys"], 11, 2).trim())).toBe(
        true,
      );
    }
    expect(cacheStep.with["restore-keys"]).not.toContain("hashFiles");
    const warmerKey = renderCacheKey(cacheStep.with.key, 10, 1);
    const releasePrefix = renderCacheKey(cacheStep.with["restore-keys"], 11, 1, "24.21.0").trim();
    expect(warmerKey.startsWith(releasePrefix)).toBe(true);
    for (const resolvedNode of ["24.22.0", "26.7.0"]) {
      const otherRuntimePrefix = renderCacheKey(
        cacheStep.with["restore-keys"],
        11,
        1,
        "24.x",
        resolvedNode,
      ).trim();
      expect(warmerKey.startsWith(otherRuntimePrefix)).toBe(false);
    }
  });

  it("warms full builds with the release runtime without changing test cache selectors", () => {
    const warmer = readWorkflow(".github/workflows/vitest-cache-warm.yml");
    const npm = readWorkflow(".github/workflows/openclaw-npm-preflight.yml");
    const frv = readWorkflow(".github/workflows/full-release-validation.yml");
    const steps = warmer.jobs.warm.steps as WorkflowStep[];
    const setup = expectDefined(
      steps.find((step) => step.id === "setup-node-env"),
      "test setup",
    );
    const buildSetup = expectDefined(
      steps.find((step) => step.with?.["build-all-cache-scope"] === "full"),
      "release build setup",
    );
    const buildVersion = String(buildSetup.with?.["node-version"]).replace(
      /\$\{\{ env\.([A-Z_]+) \}\}/gu,
      (_: string, key: string) => warmer.env[key],
    );
    expect(buildVersion).toBe(npm.env.NODE_VERSION);
    expect(buildVersion).toBe(frv.env.NODE_VERSION);
    expect(buildSetup.if).toBe("${{ matrix.platform == 'linux' }}");
    expect(buildSetup.with?.["install-deps"]).toBe("false");
    expect(setup.with).not.toHaveProperty("node-version");
    expect(setup.with).not.toHaveProperty("build-all-cache-scope");
    const build = requiredWorkflowStep(steps, "Warm build cache");
    const save = requiredWorkflowStep(steps, "Save build-all cache");
    expect(save.with?.key).toBe(`\${{ steps.${buildSetup.id}.outputs.build-all-cache-key }}`);
    const restore = requiredWorkflowStep(steps, "Restore test Node runtime");
    expect(restore.with?.["node-version"]).toBe("${{ steps.test-node.outputs.version }}");
    expect(restore.with?.["cache-mode"]).toBe("off");
    expect(restore.with?.["install-deps"]).toBe("false");
    const ordered = [
      setup,
      steps.find((step) => step.id === "test-node"),
      steps.find((step) => step.name === "Save compiled Vitest workers"),
      buildSetup,
      build,
      save,
      restore,
      steps.find((step) => step.name === "Warm transform and compile caches"),
    ].map((step) => steps.indexOf(expectDefined(step, "ordered warming step")));
    expect(ordered).toEqual(ordered.toSorted((a, b) => a - b));
  });

  it("persists Node 26 minimum declarations through trusted bounded artifacts", () => {
    const workflow = readWorkflow(".github/workflows/node-runtime-compat.yml");
    const steps = workflow.jobs.compat.steps as WorkflowStep[];
    const setupStep = steps.find((step) => step.name === "Setup Node environment");
    const resolveStep = steps.find(
      (step) => step.name === "Resolve trusted declaration cache artifact",
    );
    const downloadStep = steps.find(
      (step) => step.name === "Restore trusted declaration cache artifact",
    );
    const uploadStep = steps.find(
      (step) => step.name === "Publish trusted declaration cache artifact",
    );

    expect(workflow.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(setupStep?.with).not.toHaveProperty("build-all-cache-scope");
    expect(resolveStep?.run).toContain('.head_branch == "main"');
    expect(resolveStep?.run).toContain('(.path | split("@")[0])');
    expect(resolveStep?.run).toContain('.conclusion == "success"');
    expect(resolveStep?.run).toContain("status=success&per_page=5");
    expect(resolveStep?.run).toContain("artifacts?per_page=10");
    expect(resolveStep?.run).not.toContain("--paginate");
    expect(downloadStep).toMatchObject({
      if: "steps.declaration_cache.outputs.artifact_id != ''",
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        path: ".artifacts/build-all-cache",
        repository: "${{ github.repository }}",
      },
    });
    expect(uploadStep).toMatchObject({
      if: "success() && github.repository == 'openclaw/openclaw' && github.ref == 'refs/heads/main'",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        "if-no-files-found": "error",
        "include-hidden-files": true,
        overwrite: true,
        path: ".artifacts/build-all-cache",
        "retention-days": 14,
      },
    });
  });

  it("shares transform generations with the warmer after CI exports its harness", () => {
    const action = readWorkflow(".github/actions/setup-node-env/action.yml");
    const generationStep = (action.runs.steps as WorkflowStep[]).find(
      (step) => step.name === "Resolve Vitest transform cache generation",
    );
    const expression = expectDefined(
      generationStep?.run?.match(/\$\{\{(.*?)\}\}/u)?.[1],
      "transform generation expression",
    );
    const sourceFiles = {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "pnpm-workspace.yaml": "packages: ['packages/*']",
      "package.json": '{"name":"fixture"}',
      "packages/worker/package.json": '{"name":"worker"}',
      "packages/worker/tsconfig.json": "{}",
      "vitest.config.ts": "export default {}",
      "test/vitest/shared.ts": "export const shared = {}",
      "src/state/schema.sql": "CREATE TABLE fixture (id TEXT);",
      ".github/actions/setup-security-review/package.json": '{"name":"review"}',
      ".ci-harness-source/package.json": '{"name":"real-source"}',
    };
    const files: Record<string, string> = { ...sourceFiles };
    const fingerprint = () =>
      runInNewContext(expression, {
        hashFiles: (...patterns: string[]) => {
          const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
          const excludes = patterns
            .filter((pattern) => pattern.startsWith("!"))
            .map((pattern) => pattern.slice(1));
          const hash = createHash("sha256");
          for (const [file, contents] of Object.entries(files).toSorted(([left], [right]) =>
            left.localeCompare(right),
          )) {
            if (
              includes.some((pattern) => minimatch(file, pattern, { dot: true })) &&
              !excludes.some((pattern) => minimatch(file, pattern, { dot: true }))
            ) {
              hash.update(createHash("sha256").update(contents).digest());
            }
          }
          return hash.digest("hex");
        },
      });
    const warmer = fingerprint();
    files[".ci-harness/.github/actions/setup-security-review/package.json"] =
      sourceFiles[".github/actions/setup-security-review/package.json"];
    files[".ci-harness/tsconfig.json"] = "{}";
    files["node_modules/dependency/package.json"] = '{"name":"dependency"}';
    expect(fingerprint()).toBe(warmer);
    for (const [file, contents] of Object.entries(sourceFiles)) {
      files[file] = `${contents}\n`;
      expect(fingerprint(), file).not.toBe(warmer);
      files[file] = contents;
    }
  });

  it("persists isolated transform and compile caches through immutable protected archives", () => {
    const action = readWorkflow(".github/actions/setup-node-env/action.yml");
    const step = (name: string) => requiredWorkflowStep(action.runs.steps, name);
    const transform = step("Restore Vitest transform cache");
    const compile = step("Restore Node compile cache");
    for (const reader of [transform, compile]) {
      expect(reader.uses).toBe(CACHE_V5);
      expect(reader.if).toContain("inputs.cache-mode != 'off'");
      expect(reader.if).toContain("inputs.restore-test-caches == 'true'");
      expect(reader.with.key).toContain("github.run_id");
      expect(reader.with.key).toContain("github.run_attempt");
    }
    expect(transform.if).toContain("runner.os != 'Windows'");
    expect(transform.if).not.toMatch(/runner\.(?:environment|labels|name)/u);
    expect(transform.with.key).toContain("vitest-fs-v4-protected-");
    expect(compile.with.key).toContain("node-compile-v3-test-protected-");
    expect(compile.with.key).not.toContain("pull_request");
    const transformConfiguration = step("Configure Vitest transform cache");
    expect(transformConfiguration.env.CACHE_WRITER).toBe("0");
    expect(transformConfiguration.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=");
    expect(step("Configure Node compile cache").run).toContain(
      "OPENCLAW_NODE_COMPILE_CACHE_WRITER=0",
    );
  });

  it("warms protected caches without main-run cancellation", () => {
    const warmer = readWorkflow(".github/workflows/vitest-cache-warm.yml");
    const steps = warmer.jobs.warm.steps as WorkflowStep[];
    const step = (name: string) => requiredWorkflowStep(steps, name);
    const warm = step("Warm transform and compile caches");
    const assertion = step("Assert cache warming succeeded");
    const cleanup = step("Clear native SDK boundary output before build");

    expect(warmer.jobs.warm.concurrency["cancel-in-progress"]).toBe(false);
    expect(warmer.on.push.branches).toEqual(["main"]);
    expect(warmer.jobs.warm.if).toContain("github.repository == 'openclaw/openclaw'");
    expect(warmer.on).not.toHaveProperty("pull_request");
    expect(warmer.on).not.toHaveProperty("pull_request_target");
    expect(warmer.on).not.toHaveProperty("workflow_run");
    for (const platform of ["linux", "linux-hosted"]) {
      const invocation = runWorkflowShellScript(
        `node() { printf '%s\\n' "$*"; return 23; }\n${warm.run}`,
        { env: { ...process.env, CACHE_WARM_PLATFORM: platform } },
      );
      expect(invocation.stdout.trim(), invocation.stderr).toBe(
        "--import tsx scripts/ci-warm-vitest-caches.mts",
      );
      expect(invocation.status, invocation.stderr).toBe(23);
    }
    expect(warm.id).toBe("warm-caches");
    expect(warm["continue-on-error"]).toBe(true);
    expect(warm.env).toMatchObject({
      OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: "1",
      OPENCLAW_NODE_COMPILE_CACHE_WRITER: "1",
    });
    expect(assertion.if).toBe("${{ always() }}");
    expect(assertion.run).toContain("steps.warm-caches.outcome");
    expect(assertion.run).toContain("exit 1");
    expect(steps.at(-1)).toBe(assertion);
    expect(steps.indexOf(cleanup)).toBeGreaterThan(
      steps.indexOf(step("Save native SDK boundary cache")),
    );
    expect(steps.indexOf(cleanup)).toBeLessThan(steps.indexOf(step("Warm build cache")));

    const root = tempDirs.make("openclaw-native-sdk-cleanup-");
    const sdkOutput = path.join(root, "packages/plugin-sdk/dist/native.d.ts");
    const sdkSource = path.join(root, "packages/plugin-sdk/src/core.ts");
    const siblingOutput = path.join(root, "packages/normalization-core/dist/index.js");
    const boundaryReceipt = path.join(
      root,
      ".artifacts/extension-package-boundary/plugin-sdk.json",
    );
    for (const file of [sdkOutput, sdkSource, siblingOutput, boundaryReceipt]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "sentinel\n");
    }
    const result = runWorkflowShellScript(expectDefined(cleanup.run, "cleanup"), {
      cwd: root,
      env: process.env,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(existsSync(sdkOutput)).toBe(false);
    expect(existsSync(sdkSource)).toBe(true);
    expect(existsSync(siblingOutput)).toBe(true);
    expect(existsSync(boundaryReceipt)).toBe(true);
  });

  it("keeps the Gradle sticky disk on O(1) per-task protected keys", () => {
    const workflow = readCiWorkflow();
    const androidSteps = workflow.jobs.android.steps as WorkflowStep[];
    const mountWith = expectDefined(
      androidSteps.find((step) => step.name === "Mount Gradle sticky disk")?.with,
      "Gradle sticky mount step",
    );
    const pointStep = requiredWorkflowStep(androidSteps, "Point Gradle at the sticky disk");

    // Task scope stays in the key (a light task like ktlint must never seed
    // heavy build lanes), but PR number and dependency hash must not: those
    // minted a backing disk per PR/bump until Blacksmith's installation-wide
    // budget 429-failed every mount fleet-wide.
    expect(mountWith.key).toBe("${{ github.repository }}-gradle-v2-${{ matrix.task }}");
    expect(androidSteps.find((step) => step.name === "Mount Gradle sticky disk")?.if).toContain(
      "vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'",
    );
    expect(pointStep.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    // Single semantic writer: protected pushes commit explicitly (on-change's
    // allocated-byte heuristic can miss a same-size refresh); PR clones stay read-only.
    expect(mountWith.commit).toBe(
      "${{ github.event_name != 'pull_request' && 'true' || 'false' }}",
    );
    // Gradle owns invalidation and expiry; dependency updates must retain reusable entries.
    const stickyRoot = tempDirs.make("openclaw-gradle-sticky-");
    const gradleHome = path.join(stickyRoot, "gradle-user-home");
    const cachedDependency = path.join(gradleHome, "caches", "dependency.jar");
    const githubEnv = path.join(stickyRoot, "github-env");
    mkdirSync(path.dirname(cachedDependency), { recursive: true });
    writeFileSync(cachedDependency, "cached dependency");
    writeFileSync(path.join(stickyRoot, ".openclaw-gradle-deps-fingerprint"), "old-inputs\n");
    const result = runWorkflowShellScript(
      expectDefined(pointStep.run, "Gradle sticky home").replace(
        "sticky_root=/var/tmp/openclaw-gradle",
        `sticky_root=${quoteShell(stickyRoot)}`,
      ),
      {
        env: {
          ...process.env,
          GITHUB_ENV: githubEnv,
          GRADLE_DEPS_FINGERPRINT: "new-inputs",
          STICKY_WRITER: "true",
        },
      },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readFileSync(cachedDependency, "utf8")).toBe("cached dependency");
    expect(readFileSync(githubEnv, "utf8")).toBe(`GRADLE_USER_HOME=${gradleHome}\n`);
  });

  function readStickyDisks() {
    const workflowFiles = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml"))
      .map((name) => `.github/workflows/${name}`);
    const actionFiles = readdirSync(".github/actions").map(
      (name) => `.github/actions/${name}/action.yml`,
    );
    const stickyKeys: Array<{ file: string; key: string }> = [];
    for (const file of [...workflowFiles, ...actionFiles]) {
      if (!existsSync(file)) {
        continue;
      }
      const parsed = readWorkflow(file);
      const jobs = parsed?.jobs ? Object.values(parsed.jobs) : [];
      const stepLists = [
        ...jobs.map((job) => (job as { steps?: WorkflowStep[] }).steps ?? []),
        (parsed?.runs?.steps ?? []) as WorkflowStep[],
      ];
      for (const step of stepLists.flat()) {
        if (typeof step?.uses !== "string" || !step.uses.startsWith("useblacksmith/stickydisk@")) {
          continue;
        }
        const key = step.with?.key;
        stickyKeys.push({ file, key: typeof key === "string" ? key : "" });
      }
    }
    return stickyKeys;
  }

  it("never keys a Blacksmith sticky disk by unbounded run dimensions", () => {
    // Blacksmith caps backing disks per installation; snapshot validity belongs
    // in in-job fingerprints, not per-PR, commit, run, or hash key segments.
    const stickyKeys = readStickyDisks();
    expect(stickyKeys.length).toBeGreaterThan(0);
    for (const { file, key } of stickyKeys) {
      expect(key, file).not.toContain("github.event.pull_request.number");
      expect(key, file).not.toContain("github.sha");
      expect(key, file).not.toContain("github.ref");
      expect(key, file).not.toContain("github.run_");
      expect(key, file).not.toContain("hashFiles(");
    }
  });

  it("deletes only exact allowlisted retired sticky disks from protected main", () => {
    const cleanupSource = readFileSync(".github/workflows/sticky-disk-cleanup.yml", "utf8");
    const cleanup = parse(cleanupSource);
    const job = cleanup.jobs.delete;
    const checkoutStep = job.steps.find(
      (step: WorkflowStep) => step.name === "Checkout protected manifest",
    );
    const validateStep = job.steps.find(
      (step: WorkflowStep) => step.name === "Validate exact retired key",
    );
    const deleteStep = job.steps.find(
      (step: WorkflowStep) => step.name === "Delete retired sticky disk",
    );
    const retiredDisks = JSON.parse(
      readFileSync(".github/retired-sticky-disks.json", "utf8"),
    ) as Array<{ architecture?: unknown; key?: unknown; region?: unknown }>;

    expect(Array.isArray(retiredDisks)).toBe(true);
    expect(
      retiredDisks.every(
        (disk) =>
          typeof disk.key === "string" &&
          disk.key.length > 0 &&
          disk.key === disk.key.trim() &&
          (disk.architecture === "amd64" || disk.architecture === "arm64") &&
          typeof disk.region === "string" &&
          disk.region.length > 0 &&
          disk.region === disk.region.trim(),
      ),
    ).toBe(true);
    expect(
      new Set(
        retiredDisks.map(
          (disk) => `${disk.key as string}:${disk.architecture as string}:${disk.region as string}`,
        ),
      ).size,
    ).toBe(retiredDisks.length);
    expect(cleanup.on).toHaveProperty("workflow_dispatch");
    expect({ permissions: cleanup.permissions, concurrency: cleanup.concurrency }).toEqual({
      permissions: { contents: "read" },
      concurrency: { group: "sticky-disk-cleanup", "cancel-in-progress": false },
    });
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("inputs.confirm");
    expect(checkoutStep.with.ref).toBe("refs/heads/main");
    expect(job["runs-on"]).toContain("inputs.architecture == 'arm64'");
    expect(validateStep.env).toMatchObject({
      RETIRED_ARCHITECTURE: "${{ inputs.architecture }}",
      RETIRED_KEY: "${{ inputs.retired_key }}",
      RETIRED_REGION: "${{ inputs.region }}",
    });
    expectIncludes(validateStep.run, [
      'process.env.BLACKSMITH_ENV?.includes("arm")',
      "requestedRegion !== process.env.BLACKSMITH_REGION",
      "requestedKey !== requestedKey.trim()",
      "disk?.key === requestedKey",
    ]);
    const rejectedKey = runWorkflowShellScript(validateStep.run, {
      env: {
        ...process.env,
        BLACKSMITH_ENV: "production-amd64",
        BLACKSMITH_REGION: "us-test-1",
        RETIRED_ARCHITECTURE: "amd64",
        RETIRED_KEY: "openclaw/openclaw-not-retired",
        RETIRED_REGION: "us-test-1",
      },
    });
    expect(rejectedKey.status).not.toBe(0);
    expect(rejectedKey.stderr).toContain("identity is not allowlisted for retirement");
    const paddedKey = runWorkflowShellScript(validateStep.run, {
      env: {
        ...process.env,
        BLACKSMITH_ENV: "production-amd64",
        BLACKSMITH_REGION: "us-test-1",
        RETIRED_ARCHITECTURE: "amd64",
        RETIRED_KEY: " openclaw/openclaw-active-key ",
        RETIRED_REGION: "us-test-1",
      },
    });
    expect(paddedKey.status).not.toBe(0);
    expect(paddedKey.stderr).toContain("key must be non-empty and canonical");
    expect(deleteStep).toMatchObject({
      uses: "useblacksmith/stickydisk-delete@3bd8d43f9da764c6b80c2cd6db129bdb568c79b6",
      with: {
        "delete-docker-cache": "false",
        "delete-key": "${{ inputs.retired_key }}",
      },
    });

    // A retired-key entry must never match any disk family still mounted by
    // the repository. Expressions stand for one non-empty resolved segment.
    const activeKeyPatterns = readStickyDisks().map(({ key }) => {
      const escapedParts = key
        .split(/\$\{\{[^}]+\}\}/u)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
      return new RegExp(`^${escapedParts.join(".+")}$`, "u");
    });
    for (const retiredDisk of retiredDisks) {
      expect(
        activeKeyPatterns.some((pattern) => pattern.test(retiredDisk.key as string)),
        `${retiredDisk.key as string} is still an active sticky-disk key`,
      ).toBe(false);
    }
  });

  it("retains fetch deadlines in other standalone workflows", () => {
    const workflowPaths = [[".github/workflows/crabbox-hydrate.yml", "30s"]] as const;

    for (const [workflowPath, timeoutSeconds] of workflowPaths) {
      const workflow = readFileSync(workflowPath, "utf8");
      const fetchTimeouts = workflow.match(
        new RegExp(
          `timeout --signal=TERM[^\\n]* ${timeoutSeconds} git(?: -C "(?:\\$workdir|\\$GITHUB_WORKSPACE|clawhub-source)")?`,
          "g",
        ),
      );

      expect(fetchTimeouts?.length, workflowPath).toBeGreaterThan(0);
      expect(
        fetchTimeouts?.every((line) =>
          line.startsWith(`timeout --signal=TERM --kill-after=10s ${timeoutSeconds} git`),
        ),
        workflowPath,
      ).toBe(true);
    }
  });

  it("keeps shared Mantis reaction ownership stable", () => {
    const resolveWorkflowPath = ".github/workflows/mantis-resolve-request.yml";
    const cleanupWorkflowPath = ".github/workflows/mantis-clear-reaction.yml";
    const resolveSource = readFileSync(resolveWorkflowPath, "utf8");
    const cleanupSource = readFileSync(cleanupWorkflowPath, "utf8");
    const resolveWorkflow = parse(resolveSource);
    const cleanupWorkflow = parse(cleanupSource);
    const expectedWorkflowCallSecrets = {
      MANTIS_GITHUB_APP_ID: { required: true },
      MANTIS_GITHUB_APP_PRIVATE_KEY: { required: true },
    };
    const resolveJob = resolveWorkflow.jobs.resolve;
    const cleanupJob = cleanupWorkflow.jobs.clear;
    const resolveSteps = resolveJob.steps as WorkflowStep[];
    const cleanupSteps = cleanupJob.steps as WorkflowStep[];
    const findStep = (steps: WorkflowStep[], id: string, workflowPath: string) =>
      expectDefined(
        steps.find((step) => step.id === id),
        `${workflowPath} ${id}`,
      );
    const createTokenStep = findStep(resolveSteps, "mantis_reaction_token", resolveWorkflowPath);
    const createStep = findStep(resolveSteps, "add_reaction", resolveWorkflowPath);
    const cleanupTokenStep = findStep(cleanupSteps, "mantis_reaction_token", cleanupWorkflowPath);
    const deleteStep = expectDefined(
      cleanupSteps.find((step) => step.env?.REACTION_ID),
      `${cleanupWorkflowPath} reaction cleanup step`,
    );

    expect(resolveWorkflow.on.workflow_call.secrets, resolveWorkflowPath).toEqual(
      expectedWorkflowCallSecrets,
    );
    expect(cleanupWorkflow.on.workflow_call.secrets, cleanupWorkflowPath).toEqual(
      expectedWorkflowCallSecrets,
    );
    expect(resolveJob.outputs.reaction_id, resolveWorkflowPath).toBe(
      "${{ steps.add_reaction.outputs.reaction_id }}",
    );
    for (const [label, tokenStep] of [
      ["creation", createTokenStep],
      ["cleanup", cleanupTokenStep],
    ] as const) {
      expect(tokenStep, `${label} token`).toMatchObject({
        uses: CREATE_GITHUB_APP_TOKEN_V3_3,
        with: {
          "app-id": "${{ secrets.MANTIS_GITHUB_APP_ID }}",
          "private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
        },
      });
      expect(
        Object.entries(tokenStep.with ?? {}).filter(([key]) => key.startsWith("permission-")),
        `${label} permissions`,
      ).toEqual([["permission-issues", "write"]]);
    }
    expect(createStep, resolveWorkflowPath).toMatchObject({
      if: "${{ steps.resolve.outputs.request_source == 'issue_comment' && steps.mantis_reaction_token.outcome == 'success' }}",
      uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      with: { "github-token": "${{ steps.mantis_reaction_token.outputs.token }}" },
    });
    expect(createStep.with?.script, resolveWorkflowPath).toContain("createForIssueComment");
    expect(createStep.with?.script, resolveWorkflowPath).toContain(
      'core.setOutput("reaction_id", String(reaction.id))',
    );
    expect(resolveSource.match(/createForIssueComment/gu), resolveWorkflowPath).toHaveLength(1);
    expect(cleanupJob.permissions, cleanupWorkflowPath).toEqual({});
    expect(deleteStep, cleanupWorkflowPath).toMatchObject({
      env: {
        COMMENT_ID: "${{ inputs.comment-id }}",
        REACTION_ID: "${{ inputs.reaction-id }}",
      },
      uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      with: { "github-token": "${{ steps.mantis_reaction_token.outputs.token }}" },
    });
    expect(deleteStep.with?.script, cleanupWorkflowPath).toContain("deleteForIssueComment");
    expect(deleteStep.with?.script, cleanupWorkflowPath).toContain(
      "Number(process.env.REACTION_ID)",
    );
    expect(deleteStep.with?.script, cleanupWorkflowPath).toContain("reaction_id: reactionId");
    expect(JSON.stringify(cleanupJob), cleanupWorkflowPath).not.toMatch(
      /listForIssueComment|\.filter\(|github-actions\[bot\]/u,
    );
  });

  it("bounds release ref validation fetches across checkout auth modes", () => {
    const resolveTargetSteps = readReleaseChecksWorkflow().jobs.resolve_target.steps;

    for (const stepName of ["Validate selected ref belongs to this repository"]) {
      const step = resolveTargetSteps.find(
        (candidate: WorkflowStep) => candidate.name === stepName,
      );

      expect(step?.run, stepName).toContain("local -a git_args=(git)");
      expect(step?.run, stepName).toContain(
        'git_args+=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}")',
      );
      expect(step?.run, stepName).toContain(
        'timeout --signal=TERM --kill-after=10s 120s "${git_args[@]}" fetch "$@"',
      );
      expect(step?.run, stepName).not.toContain('git -c "http.https://github.com/.extraheader');
    }
  });

  describe.skipIf(process.platform !== "linux")("release fallback history with real Git", () => {
    it.each(["orphan", "non-release-tag"] as const)("rejects %s history", (route) => {
      const { result, events } = runReleaseFallbackHistoryFixture({ route });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("but that commit is not reachable");
      expect(events.filter((event) => event.op.endsWith("-producer"))).toMatchObject([
        { op: "tag-producer", status: 0, signal: null },
        { op: "branch-producer", status: 0, signal: null },
      ]);
    });

    it.each(["fetch-branches", "fetch-tags"] as const)(
      "fails closed when the real %s command fails",
      (failure) => {
        const { result, events } = runReleaseFallbackHistoryFixture({ route: "branch", failure });
        expect(result.status).not.toBe(0);
        expect(events.find((event) => event.op === failure)).toMatchObject({
          status: 128,
          signal: null,
        });
        expect(events.some((event) => event.op.endsWith("-producer"))).toBe(false);
        expect(result.stderr).not.toContain("but that commit is not reachable");
      },
    );

    it.each(["branch", "tag"] as const)(
      "does not accept matching %s output followed by a real Git failure",
      (route) => {
        const { result, events } = runReleaseFallbackHistoryFixture({
          route,
          failure: `${route}-producer`,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("but that commit is not reachable");
        expect(events.find((event) => event.op === `${route}-producer`)).toMatchObject({
          status: 0,
          signal: null,
        });
        expect(events.find((event) => event.op === "post-output-failure")).toMatchObject({
          status: 128,
          signal: null,
        });
      },
    );

    it.each(["branch", "tag"] as const)(
      "accepts valid %s enumeration larger than the pipe capacity",
      (route) => {
        const { result, events } = runReleaseFallbackHistoryFixture({ route, many: true });
        expect(events.filter((event) => event.op.startsWith("fetch-"))).toMatchObject([
          { op: "fetch-branches", status: 0, signal: null },
          { op: "fetch-tags", status: 0, signal: null },
        ]);
        const producer = events.find((event) => event.op === `${route}-producer`);
        if (result.status !== 0) {
          expect(result.stderr).toContain("but that commit is not reachable");
          expect(producer).toMatchObject({ status: null, signal: "SIGPIPE", exitCode: 141 });
        }
        expect(result.status, JSON.stringify({ producer, stderr: result.stderr })).toBe(0);
        expect(producer).toMatchObject({ status: 0, signal: null });
      },
      60_000,
    );
  });

  it.each([true, false])(
    "pins qualification comparison inputs when workflow equals candidate: %s",
    (sameRevision) => {
      const step = readCiWorkflow().jobs.preflight.steps.find(
        (entry: WorkflowStep) => entry.name === "Resolve exact diff base",
      );
      const root = tempDirs.make("frozen-ci-base-");
      const head = "a".repeat(40);
      const workflow = sameRevision ? head : "b".repeat(40);
      const base = sameRevision ? head : "c".repeat(40);
      const output = path.join(root, "output");
      const result = runWorkflowShellScript(
        `git() { [[ "$*" == "rev-parse HEAD" ]] || return 1; printf "%s\\n" "$TEST_HEAD"; }
gh() {
  [[ "$*" == "api --method GET repos/openclaw/openclaw/compare/$WORKFLOW_REVISION...$TEST_HEAD --jq .merge_base_commit.sha" ]] || return 1
  printf "%s\\n" "$TEST_BASE"
}
${step.run}`,
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            DEFAULT_BRANCH: "main",
            DISPATCH_ID: "full-release-validation-123",
            EVENT_BASE_SHA: "",
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_OUTPUT: output,
            RELEASE_GATE: "false",
            TARGET_CONTEXT_REF: "release/2026.9.6",
            WORKFLOW_REVISION: workflow,
            TEST_HEAD: head,
            TEST_BASE: base,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readWorkflowOutputs(output)).toMatchObject({
        default_sha: workflow,
        sha: base,
        head_sha: head,
      });
    },
  );

  it("keeps manual candidates separate from trusted cache authority", () => {
    const workflow = readCiWorkflow();
    const preflight = workflow.jobs.preflight;
    const checkoutStep = requiredWorkflowStep(preflight.steps, "Checkout");
    expect(checkoutStep.env?.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    const harnessSteps = preflight.steps.filter(
      (step: WorkflowStep) =>
        step.uses?.startsWith("actions/checkout@") && step.with?.path === ".ci-harness",
    );
    expect(harnessSteps).toHaveLength(1);
    const harnessStep = expectDefined(harnessSteps[0], "different-revision harness checkout");
    expect(harnessStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ github.workflow_sha }}",
        path: ".ci-harness",
        "sparse-checkout": expect.stringContaining("/.github/actions/\n"),
        "sparse-checkout-cone-mode": false,
        "persist-credentials": false,
      },
    });
    const resolvedIndex = preflight.steps.findIndex(
      (step: WorkflowStep) => step.id === "checkout_ref",
    );
    const harnessIndex = preflight.steps.indexOf(harnessStep);
    const consumerIndex = preflight.steps.findIndex((step: WorkflowStep) =>
      step.uses?.startsWith("./.ci-harness/"),
    );
    expect(preflight.steps.indexOf(checkoutStep)).toBeLessThan(resolvedIndex);
    expect(resolvedIndex).toBeLessThan(harnessIndex);
    expect(harnessIndex).toBeLessThan(consumerIndex);
    const workflowSha = "a".repeat(40);
    for (const eventName of ["push", "pull_request", "workflow_dispatch"] as const) {
      for (const headRepository of ["openclaw/openclaw", "contributor/openclaw"]) {
        for (const selectedSha of [workflowSha, "b".repeat(40)]) {
          expect(
            evaluateWorkflowExpression(harnessStep.if, {
              eventName,
              headRepository,
              steps: { checkout_ref: { outputs: { sha: selectedSha } } },
              workflowSha,
            }),
          ).toBe(selectedSha !== workflowSha);
        }
      }
    }
    const trustStep = requiredWorkflowStep(preflight.steps, "Classify candidate cache trust");
    const nativeCheckout = requiredWorkflowStep(workflow.jobs["native-i18n"].steps, "Checkout");

    expect(preflight.outputs).toMatchObject({
      candidate_trust: "${{ steps.candidate_trust.outputs.trust }}",
      cache_mode: "${{ steps.candidate_trust.outputs.cache_mode }}",
      cache_write_allowed: "${{ steps.candidate_trust.outputs.cache_write_allowed }}",
    });
    expect(trustStep.env).toMatchObject({
      CHECKOUT_REVISION: "${{ steps.checkout_ref.outputs.sha }}",
      DEFAULT_SHA: "${{ steps.diff_base.outputs.default_sha }}",
      TARGET_REF: "${{ inputs.target_ref }}",
      WORKFLOW_REVISION: "${{ github.workflow_sha }}",
    });
    expectIncludes(trustStep.run, [
      "trust=untrusted",
      "cache_mode=off",
      "cache_write_allowed=false",
      'elif [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]',
      '"$RELEASE_GATE" == "true"',
      '"$CHECKOUT_REVISION" == "$DEFAULT_SHA"',
      '"$CHECKOUT_REVISION" == "$WORKFLOW_REVISION"',
      "cache_write_allowed=true",
    ]);

    const ciLocalActions = Object.values(workflow.jobs).flatMap(
      (job) =>
        (job as { steps?: WorkflowStep[] }).steps?.filter((step) =>
          step.uses?.includes("/.github/actions/"),
        ) ?? [],
    );
    expect(ciLocalActions.length).toBeGreaterThan(0);
    for (const step of ciLocalActions) {
      expect(step.uses, step.name).toContain("./.ci-harness/.github/actions/");
    }

    expect(nativeCheckout.uses).toBeUndefined();
    expect(nativeCheckout.env).toMatchObject({
      CHECKOUT_SHA: "${{ needs.preflight.outputs.checkout_revision }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of (job as { steps?: WorkflowStep[] }).steps ?? []) {
        if (step.uses?.startsWith("actions/cache/restore@")) {
          expect(String(step.if), `${jobName}: ${step.name}`).toContain(
            "preflight.outputs.cache_mode != 'off'",
          );
        }
        if (step.uses?.startsWith("actions/cache/save@")) {
          expect(String(step.if), `${jobName}: ${step.name}`).toContain(
            "preflight.outputs.cache_write_allowed == 'true'",
          );
        }
      }
    }

    const goSetup = requiredWorkflowStep(
      workflow.jobs["checks-node-core-test-nondist-shard"].steps,
      "Setup Go for docs i18n",
    );
    expect(goSetup.with?.cache).toBe(false);
  });

  it("bounds the workflow sanity ShellCheck download", () => {
    const workflow = readWorkflowSanityWorkflow();
    const shellcheckStep = requiredWorkflowStep(
      workflow.jobs.actionlint.steps,
      "Install ShellCheck",
    );
    expect(shellcheckStep.run).toContain("curl --connect-timeout 10 --max-time 120");
    expect(shellcheckStep.run).toContain("--retry 5 --retry-delay 2 --retry-all-errors");
  });

  it("pins workflow and pre-commit actionlint to the large-stdin deadlock fix", () => {
    const revision = "011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7";
    const steps: WorkflowStep[] = readWorkflowSanityWorkflow().jobs.actionlint.steps;
    const setupGo = expectDefined(
      steps.find((step) => step.uses === SETUP_GO_V6),
      "Go setup",
    );
    const install = requiredWorkflowStep(steps, "Install actionlint");

    expect(setupGo.with).toEqual({ "go-version": "1.27.1", cache: false });
    expect(steps.indexOf(setupGo)).toBeLessThan(steps.indexOf(install));
    expectIncludes(install.run, [
      `ACTIONLINT_REVISION="${revision}"`,
      'export GOBIN="$RUNNER_TEMP/actionlint-bin"',
      'go install "github.com/rhysd/actionlint/cmd/actionlint@${ACTIONLINT_REVISION}"',
      '"$GOBIN/actionlint" -version',
      "v1.7.13-0.20260419144658-${ACTIONLINT_REVISION:0:12}",
      'echo "$GOBIN" >> "$GITHUB_PATH"',
    ]);
    const preCommit = readWorkflow(".pre-commit-config.yaml");
    expect(
      preCommit.repos.find(
        (repo: { repo: string }) => repo.repo === "https://github.com/rhysd/actionlint",
      ).rev,
    ).toBe(revision);
  });

  it.each([
    { historical: false, hasWatchRtc: false, expected: true },
    { historical: true, hasWatchRtc: true, expected: true },
    { historical: true, hasWatchRtc: false, expected: false },
  ])("prepares Watch RTC by source capability: %j", ({ historical, hasWatchRtc, expected }) => {
    const workflow = readCiWorkflow();
    for (const jobName of ["ios-build", "ios-screenshot-capture"]) {
      const install = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Install Watch Rust toolchain",
      );
      const engine = workflow.jobs["ios-build"].steps.find(
        (step: WorkflowStep) => step.name === "Test Watch RTC engine",
      );
      for (const phase of ["smoke", "tests", "release"]) {
        const context: Parameters<typeof evaluateWorkflowCondition>[1] = {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          env: { HISTORICAL_TARGET: String(historical) },
          matrix: { phase },
          steps: {
            "watch-rust-toolchain": { outputs: {}, outcome: expected ? "success" : "skipped" },
          },
          fileHashes: hasWatchRtc ? { "apps/shared/OpenClawWatchRTC/Cargo.toml": "present" } : {},
        };
        expect(evaluateWorkflowCondition(install.if, context)).toBe(expected);
        expect(evaluateWorkflowCondition(engine.if, context)).toBe(expected && phase === "tests");
      }
    }
  });

  it("retries macOS release builds only when Sparkle metadata is incomplete", () => {
    const steps = readCiWorkflow().jobs["macos-swift"].steps;
    const buildStep = steps.find((step: WorkflowStep) => step.name === "Swift build (release)");
    const validateCacheStep = steps.find(
      (step: WorkflowStep) => step.name === "Validate Swift build cache",
    );
    const runFixture = (
      artifactState: "no-build" | "absent" | "incomplete" | "complete",
      mode: "cache" | "recover" | "fail",
    ) => {
      const root = tempDirs.make(`openclaw-swift-${mode}-${artifactState}-`);
      const binDir = path.join(root, "bin");
      const frameworkDir = path.join(
        root,
        "apps/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework",
      );
      const callsPath = path.join(root, "swift-calls");
      const outputPath = path.join(root, "github-output");
      mkdirSync(binDir, { recursive: true });
      if (artifactState === "absent" && mode === "cache") {
        mkdirSync(path.join(root, "apps/macos/.build"), { recursive: true });
      } else if (artifactState === "incomplete" || artifactState === "complete") {
        mkdirSync(frameworkDir, { recursive: true });
      }
      if (artifactState === "complete") {
        writeFileSync(path.join(frameworkDir, "Info.plist"), "complete\n", "utf8");
      }
      const buildScript =
        mode === "cache"
          ? ""
          : `
if [[ "\${1:-}" == "package" ]]; then
  exit 0
fi
build_count="$(grep -c '^build ' "$SWIFT_CALLS")"
if [[ "$BUILD_OUTCOME" == "recover" && "$build_count" -eq 2 ]]; then
  exit 0
fi
exit 1
`;
      writeFileSync(
        path.join(binDir, "swift"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SWIFT_CALLS"
${buildScript}`,
        { mode: 0o755 },
      );
      const result = runWorkflowShellScript(
        mode === "cache" ? validateCacheStep.run : buildStep.run,
        {
          cwd: root,
          env: {
            ...process.env,
            ...(mode === "cache" ? { GITHUB_OUTPUT: outputPath } : { BUILD_OUTCOME: mode }),
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            SWIFT_CALLS: callsPath,
          },
        },
      );
      return {
        calls:
          mode === "cache" && !existsSync(callsPath)
            ? []
            : readFileSync(callsPath, "utf8").trim().split("\n"),
        output:
          mode === "cache"
            ? readFileSync(outputPath, "utf8").trim()
            : `${result.stdout}${result.stderr}`,
        status: result.status,
      };
    };

    const releaseBuildCommand =
      "build --package-path apps/macos --product OpenClaw --configuration release";
    const packageResetCommand = "package --package-path apps/macos reset";
    const retryCalls = [releaseBuildCommand, packageResetCommand, releaseBuildCommand];
    for (const [artifactState, mode, status, calls, output] of [
      ["no-build", "cache", 0, [], "cache-valid=true"],
      ["complete", "cache", 0, [], "cache-valid=true"],
      ["absent", "cache", 0, [packageResetCommand], "cache-valid=false"],
      ["incomplete", "cache", 0, [packageResetCommand], "cache-valid=false"],
      ["absent", "fail", 1, [releaseBuildCommand]],
      ["complete", "fail", 1, [releaseBuildCommand]],
      ["incomplete", "fail", 1, retryCalls],
      ["incomplete", "recover", 0, retryCalls],
    ] as const) {
      const result = runFixture(artifactState, mode);
      expect(result).toMatchObject({ status, calls });
      if (output !== undefined) {
        expect(result.output).toBe(output);
      }
      if (mode === "recover") {
        expect(result.output).toContain("did not produce complete Sparkle metadata");
      }
    }
  });

  it("uses native macOS Swift tests and retains failures after completing every profile", () => {
    const workflow = readCiWorkflow();
    const macosSwift = workflow.jobs["macos-swift"];
    const testStep = macosSwift.steps.find((step: WorkflowStep) => step.name === "Swift test");
    const buildCache = macosSwift.steps.find(
      (step: WorkflowStep) => step.id === "swift-build-cache",
    );
    const nativeCachePrefix =
      "${{ runner.os }}-swift-build-${{ matrix.phase == 'tests' && 'v7' || 'v6' }}-${{ matrix.phase }}-${{ hashFiles('scripts/swift-build-cache-metadata.py') }}-graph-${{ steps.swift-toolchain.outputs.key }}-" +
      "${{ hashFiles('apps/macos/Package*.swift', 'apps/macos/Package.resolved', 'apps/shared/**/Package*.swift', 'apps/shared/**/Package.resolved', 'apps/swabble/Package*.swift', 'apps/swabble/Package.resolved') }}-";

    expect(buildCache.with).toMatchObject({
      key: expect.stringContaining(nativeCachePrefix),
      "restore-keys": `${nativeCachePrefix}\n`,
    });
    const restoreMetadata = macosSwift.steps.find(
      (step: WorkflowStep) => step.name === "Restore Swift build input timestamps",
    );
    const recordMetadata = macosSwift.steps.find(
      (step: WorkflowStep) => step.name === "Record Swift build input timestamps",
    );
    const saveBuildCache = macosSwift.steps.find(
      (step: WorkflowStep) => step.name === "Save Swift build directory cache",
    );
    expect(restoreMetadata.if).toBe(
      "steps.validate-swift-build-cache.outputs.cache-valid == 'true' && env.HISTORICAL_TARGET != 'true'",
    );
    expect(restoreMetadata.run).toBe("python3 -I -S scripts/swift-build-cache-metadata.py restore");
    const stepIndex = (step: WorkflowStep) => macosSwift.steps.indexOf(step);
    expect(stepIndex(restoreMetadata)).toBeLessThan(stepIndex(testStep));
    expect(stepIndex(recordMetadata)).toBeGreaterThan(stepIndex(testStep));
    expect(stepIndex(recordMetadata) + 1).toBe(stepIndex(saveBuildCache));
    expect(macosSwift.env).not.toHaveProperty("SWIFT_TEST_EXECUTION");
    expect(testStep.id).toBe("swift-test");
    const currentTargetBranch = testStep.run.split('elif [[ "$HISTORICAL_TARGET" == "true" ]]')[0];
    expect(currentTargetBranch).toContain('logical_cpu="$(sysctl -n hw.logicalcpu)"');
    expect(currentTargetBranch).toContain('[[ ! "$logical_cpu" =~ ^[1-9][0-9]*$ ]]');
    expect(currentTargetBranch).toContain(
      "swift_test_width=$(( logical_cpu < 12 ? logical_cpu : 12 ))",
    );
    expect(currentTargetBranch).toContain(
      'swift_test_args+=(--experimental-maximum-parallelization-width "$swift_test_width")',
    );
    expect(currentTargetBranch).not.toContain("swift_test_args+=(--parallel)");
    expect(currentTargetBranch).not.toContain("--no-parallel");
    expect(testStep.run).toContain("swift_test_args+=(--no-parallel)");

    for (const buildExitCode of [0, 23]) {
      const root = tempDirs.make(`openclaw-swift-test-${buildExitCode}-`);
      const binDir = path.join(root, "bin");
      const callsPath = path.join(root, "swift-calls");
      const outputPath = path.join(root, "github-output");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(path.resolve("scripts"), path.join(root, "scripts"), "dir");
      mkdirSync(path.join(root, ".ci-harness/scripts"), { recursive: true });
      symlinkSync(path.resolve("scripts/lib"), path.join(root, ".ci-harness/scripts/lib"), "dir");
      symlinkSync(
        path.resolve("scripts/ci-collect-checks.sh"),
        path.join(root, ".ci-harness/scripts/ci-collect-checks.sh"),
      );
      writeFileSync(
        path.join(binDir, "swift"),
        `#!/usr/bin/env bash
set -euo pipefail
SWIFT_CALLS=${JSON.stringify(callsPath)}
GITHUB_OUTPUT=${JSON.stringify(outputPath)}
BUILD_EXIT_CODE=${buildExitCode}
printf '%s\\n' "$*" >> "$SWIFT_CALLS"
if [[ "\${1:-}" == "build" ]]; then
  [[ ! -s "$GITHUB_OUTPUT" ]] || exit 24
  exit "$BUILD_EXIT_CODE"
fi
test_count="$(grep -c '^test ' "$SWIFT_CALLS")"
[[ "$test_count" -gt 1 ]]
`,
        "utf8",
      );
      chmodSync(path.join(binDir, "swift"), 0o755);
      writeFileSync(path.join(binDir, "sysctl"), "#!/usr/bin/env bash\nprintf '4\\n'\n", {
        mode: 0o755,
      });
      // This fixture executes the real launcher: never fall through to host Security.
      writeFileSync(
        path.join(binDir, "security"),
        `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
assert.notEqual(process.env.HOME, ${JSON.stringify(root)});
assert.equal(path.dirname(args.at(-1)), path.join(process.env.HOME, 'Library/Keychains'));
if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'inert keychain');
if (args[0] === 'delete-keychain') fs.unlinkSync(args.at(-1));
`,
        { mode: 0o755 },
      );
      const result = runWorkflowShellScript(testStep.run, {
        cwd: root,
        env: {
          ...process.env,
          CI: "true",
          GITHUB_ACTIONS: "true",
          RUNNER_OS: "macOS",
          RUNNER_TEMP: root,
          HOME: root,
          GITHUB_OUTPUT: outputPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SWIFT_TEST_EXECUTION: "serial",
          HISTORICAL_TARGET: "false",
        },
      });
      const calls = readFileSync(callsPath, "utf8").trim().split("\n");
      expect(result.status).toBe(buildExitCode || 1);
      expect(calls).toEqual([
        "build --package-path apps/macos --build-system native --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only --build-tests",
        ...(buildExitCode === 0
          ? [
              expect.stringMatching(
                /^test --package-path apps\/macos --build-system native --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only --skip-build --experimental-maximum-parallelization-width 4 --skip AppStateIsolationTests\|ProfileChatPreferencesTests\|QuickChatCatalogPresentationTests --event-stream-output-path \S+\/swift-testing-events\.jsonl --event-stream-version 6\.3$/,
              ),
              expect.stringMatching(
                /^test --package-path apps\/macos --build-system native --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only --skip-build --experimental-maximum-parallelization-width 4 --filter QuickChatCatalogPresentationTests --event-stream-output-path \S+\/swift-testing-events\.jsonl --event-stream-version 6\.3$/,
              ),
              expect.stringMatching(
                /^test --package-path apps\/macos --build-system native --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only --skip-build --experimental-maximum-parallelization-width 4 --filter AppStateIsolationTests\|ProfileChatPreferencesTests --event-stream-output-path \S+\/swift-testing-events\.jsonl --event-stream-version 6\.3$/,
              ),
            ]
          : []),
      ]);
      const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
      const outputLines = output.split("\n");
      if (buildExitCode === 0) {
        expect(outputLines).toHaveLength(4);
        expect(outputLines[0]).toBe("debug-tests-built=true");
        expect(
          outputLines[1]?.startsWith(`menu-default-artifact-path=${root}/openclaw-menu-default-`),
        ).toBe(true);
        expect(
          outputLines[2]?.startsWith(`menu-default-artifact-path=${root}/openclaw-menu-default-`),
        ).toBe(true);
        expect(
          outputLines[3]?.startsWith(`menu-named-artifact-path=${root}/openclaw-menu-named-`),
        ).toBe(true);
      } else {
        expect(output).toBe("");
      }
    }
  });

  it("bounds the Windows Crabbox hydrate main fetch", () => {
    const workflow = readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8");

    expectIncludes(workflow, [
      "$fetchInfo = New-Object System.Diagnostics.ProcessStartInfo",
      '$fetchInfo.FileName = "git"',
      "$fetchInfo.WorkingDirectory = $repo",
      "$fetchInfo.UseShellExecute = $false",
      "--no-tags --no-progress --prune --no-recurse-submodules --depth=50",
      "$fetch = New-Object System.Diagnostics.Process",
      "$fetch.StartInfo = $fetchInfo",
      "$fetch.WaitForExit(30000)",
      "$fetch.Kill()",
      'throw "git fetch failed with exit code $($fetch.ExitCode)"',
      'throw "git fetch timed out after 30 seconds"',
    ]);
    expectExcludes(workflow, [
      "$fetchInfo.RedirectStandardOutput = $true",
      "$fetchInfo.RedirectStandardError = $true",
      "StandardOutput.ReadToEnd()",
      "StandardError.ReadToEnd()",
      'git fetch --no-tags --depth=50 origin "+refs/heads/main:refs/remotes/origin/main"',
    ]);
  });

  it("bounds Mantis Slack runner IP discovery", () => {
    const workflow = parse(
      readFileSync(".github/workflows/mantis-slack-desktop-smoke.yml", "utf8"),
    ) as { jobs: { run_slack_desktop: { steps: WorkflowStep[] } } };
    const runStep = workflow.jobs.run_slack_desktop.steps.find(
      (step) => step.name === "Run Slack desktop scenario",
    );

    expectIncludes(runStep?.run, [
      "for attempt in 1 2 3",
      "curl -fsS --connect-timeout 5 --max-time 15 https://checkip.amazonaws.com",
      'runner_ip=""',
      '[[ ! "$runner_ip" =~ ^(0|[1-9][0-9]{0,2})\\.',
      "((10#$octet > 255))",
    ]);
    expect(runStep?.run).not.toContain("--retry");

    const discoveryBlock = runStep?.run?.match(
      /runner_ip=""[\s\S]*?echo "Using AWS SSH CIDR \$\{CRABBOX_AWS_SSH_CIDRS\}"/u,
    )?.[0];
    expect(discoveryBlock).toBeTruthy();

    const root = mkdtempSync(path.join(tmpdir(), "openclaw-mantis-runner-ip-"));
    try {
      const fakeBin = path.join(root, "bin");
      const callCount = path.join(root, "curl-calls");
      mkdirSync(fakeBin);
      writeFileSync(callCount, "0\n");
      writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/bin/bash
count="$(<"$CURL_CALL_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" >"$CURL_CALL_COUNT"
if [[ "$count" == "1" ]]; then
  printf '198.51.'
  exit 28
fi
printf '%s\n' "\${CURL_SUCCESS_IP:-203.0.113.7}"
`,
        { mode: 0o755 },
      );
      writeFileSync(path.join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `set -euo pipefail\n${discoveryBlock}\nprintf 'result=%s\\n' "$CRABBOX_AWS_SSH_CIDRS"`,
        ],
        {
          encoding: "utf8",
          env: {
            CURL_CALL_COUNT: callCount,
            PATH: `${fakeBin}:${process.env.PATH}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("result=203.0.113.7/32");
      expect(result.stdout).not.toContain("198.51.");
      expect(readFileSync(callCount, "utf8")).toBe("2\n");

      for (const invalidIp of ["999.0.0.1", "203.0.113.7."]) {
        writeFileSync(callCount, "0\n");
        const invalidResult = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-c", `set -euo pipefail\n${discoveryBlock}`],
          {
            encoding: "utf8",
            env: {
              CURL_CALL_COUNT: callCount,
              CURL_SUCCESS_IP: invalidIp,
              PATH: `${fakeBin}:${process.env.PATH}`,
            },
          },
        );
        expect(invalidResult.status).toBe(1);
        expect(invalidResult.stderr).toContain(
          "Could not resolve GitHub runner public IPv4 for AWS SSH ingress.",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails Windows Testbox setup when Blacksmith phone-home is not accepted", () => {
    const workflow = readFileSync(".github/workflows/windows-blacksmith-testbox.yml", "utf8");
    const job = parse(workflow).jobs.windows;
    const prepare = job.steps.find((step: WorkflowStep) => step.name === "Prepare Windows SSH");
    const finalize = job.steps.find((step: WorkflowStep) => step.name === "Run Testbox").run;

    // Windows administrators use the effective ProgramData file and native ACLs.
    // The native handshake is the behavioral proof; this guards workflow wiring.
    expect(prepare?.env).toEqual({
      TESTBOX_PUBLIC_KEY_PATH: "${{ steps.begin_testbox.outputs.public_key_path }}",
    });
    const nativeSetup = prepare?.run ?? "";
    expectIncludes(nativeSetup, [
      "WindowsPrincipal",
      '. "$env:GITHUB_WORKSPACE/scripts/windows-testbox-openssh.ps1"',
      "$installation = Get-WindowsTestboxOpenSshInstallation",
      "$sshd = $installation.Sshd",
      '-T -C "user=$nativeUser"',
      "authorizedkeysfile __PROGRAMDATA__/ssh/administrators_authorized_keys",
      "$keygen = $installation.Keygen",
      "-E sha256 -lf $env:TESTBOX_PUBLIC_KEY_PATH",
      "[IO.File]::AppendAllText($authorizedKeys,",
      "S-1-5-18",
      "S-1-5-32-544",
      "SetAccessRuleProtection($true, $false)",
      '"FullControl", "Allow"',
      "Set-Acl -LiteralPath $authorizedKeys",
    ]);
    expect(
      nativeSetup.indexOf("$installation = Get-WindowsTestboxOpenSshInstallation"),
    ).toBeLessThan(nativeSetup.indexOf("$effectiveConfig = & $sshd"));
    expect(workflow).not.toContain(">> ~/.ssh/authorized_keys");

    expect(finalize).toMatch(
      /if \[ "\$JOB_STATUS" != "success" \]; then\s+phone_home_status="hydration_failed"/u,
    );
    expect(finalize).toContain('--arg status "$phone_home_status"');
    expect(finalize.match(/\/api\/testbox\/phone-home/gu)).toHaveLength(1);
    expect(finalize.slice(0, finalize.indexOf('echo "Testbox ready!"'))).toMatch(
      /if \[ "\$phone_home_status" != "ready" \]; then[^]*?exit 1\s+fi/u,
    );

    expect(workflow.match(/--connect-timeout 10 --max-time 30/gu)).toHaveLength(2);
    expectIncludes(workflow, [
      'echo "phone_home_hydrating_curl=${hydrating_curl_status}"',
      'echo "phone_home_hydrating_http=${hydrating_http_code}"',
      'echo "phone_home_${phone_home_status}_curl=${final_curl_status}"',
      'echo "phone_home_${phone_home_status}_http=${http_code}"',
      'jq -e \'type == "number"\' <<<"$installation_model_id"',
      '--arg testbox_id "$TESTBOX_ID"',
      '--arg testbox_id "$testbox_id"',
      '--argjson installation_model_id "$installation_model_id"',
      '--data-binary @"$hydrating_body"',
      '--data-binary @"$final_body"',
    ]);
    const hydratingFailureBlock = workflow.slice(
      workflow.indexOf(
        'if (( hydrating_curl_status != 0 )) || [[ ! "$hydrating_http_code" =~ ^2 ]]; then',
      ),
      workflow.indexOf('response="$(cat "$hydrating_response")"'),
    );
    const missingSshKeyFailureBlock = workflow.slice(
      workflow.indexOf('if [ -z "$ssh_public_key" ]; then'),
      workflow.indexOf('public_key_path="$(cygpath'),
    );
    const finalFailureBlock = workflow.slice(
      workflow.indexOf('if (( final_curl_status != 0 )) || [[ ! "$http_code" =~ ^2 ]]; then'),
      workflow.indexOf('echo "============================================"'),
    );

    expect(workflow).toContain(')" || hydrating_curl_status=$?');
    expect(workflow).toContain(')" || final_curl_status=$?');
    expect(hydratingFailureBlock).toContain("exit 1");
    expect(missingSshKeyFailureBlock).toContain("exit 1");
    expect(finalFailureBlock).toContain("exit 1");
    expect(workflow).toContain(
      "Blacksmith phone-home did not return an SSH public key; testbox cannot accept native SSH connections.",
    );
    expect(workflow).not.toContain(
      'phone_home_${phone_home_status}_http=${http_code}"\n\n          echo "============================================"',
    );
    expect(workflow).not.toContain('\\"testbox_id\\": \\"${TESTBOX_ID}\\"');
    expect(workflow).not.toContain('cat > "$final_body" <<JSON');
    expect(workflow).not.toContain('"testbox_id": "${testbox_id}"');
  });

  it.each([false, true])("loads the Node shard planner from its owner (frozen=%s)", (frozen) => {
    const workflow = readCiWorkflow();
    const targetResolver = expectDefined(
      manifestSource.match(/const fromTarget = [^;]*;/u)?.[0],
      "target import resolver",
    );
    const selection = expectDefined(
      manifestSource.match(/const nodeTestPlanPath =[\s\S]*?(?=const importTargetPlan)/u)?.[0],
      "Node planner selection",
    );
    const root = tempDirs.make("ci-planner-owner-");
    writeFileSync(path.join(root, "candidate.txt"), "candidate-source");
    for (const [directory, owner] of [
      ["scripts/lib", "candidate"],
      [".ci-harness/scripts/lib", "workflow"],
    ] as const) {
      mkdirSync(path.join(root, directory), { recursive: true });
      writeFileSync(
        path.join(root, directory, "ci-node-test-plan.mts"),
        `import { readFileSync } from "node:fs";
         export const SOURCE_CHANNEL_TEST_POLICY = ${JSON.stringify(SOURCE_CHANNEL_TEST_POLICY)};
         export const createNodeTestShardBundles = () =>
           [${JSON.stringify(owner)}, readFileSync("candidate.txt", "utf8")];`,
      );
    }
    const entrypoint = path.join(root, ".ci-harness/scripts/ci-build-manifest.mjs");
    writeFileSync(
      entrypoint,
      `import { existsSync } from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        ${targetResolver}
        const frozenTarget = ${frozen};
        const compatibilityTarget = true;
        ${selection}
        console.log(JSON.stringify(createNodeTestPlan()));`,
    );
    const run = spawnSync(testNodeExecPath, [entrypoint], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([frozen ? "workflow" : "candidate", "candidate-source"]);
    if (frozen) {
      const checkout = workflow.jobs.preflight.steps.find(
        (entry: WorkflowStep) => entry.name === "Checkout trusted CI harness",
      );
      expect(checkout.with.ref).toBe("${{ github.workflow_sha }}");
      expect(checkout.with["sparse-checkout"]).toContain("/scripts/");
      expect(checkout.with["sparse-checkout"]).toContain("/test/vitest/");
      expect(checkout.with["sparse-checkout"]).toContain("/config/ci-test-timings.json");
      const sparseRoot = tempDirs.make("ci-planner-sparse-");
      for (const entry of String(checkout.with["sparse-checkout"]).trim().split("\n")) {
        const relative = entry.replace(/^\//u, "");
        const destination = path.join(sparseRoot, ".ci-harness", relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(relative, destination, { recursive: true });
      }
      const importResult = spawnSync(testNodeExecPath, ["--input-type=module"], {
        cwd: sparseRoot,
        input: 'await import("./.ci-harness/scripts/lib/ci-node-test-plan.mts");',
        encoding: "utf8",
      });
      expect(importResult.status, importResult.stderr).toBe(0);
    }
  });

  it.skipIf(process.platform === "win32")(
    "runs the dependency-free preflight manifest from the owner-exported harness",
    () => {
      const directory = tempDirs.make("ci-preflight-dependencies-");
      const harness = exportPreflightHarness(directory);
      const harnessPaths = new Set<string>();
      const steps: WorkflowStep[] = readCiWorkflow().jobs.preflight.steps;
      for (const step of steps) {
        for (const source of [step.run, step.uses]) {
          for (const match of (source ?? "").matchAll(/(?:\.\/)?\.ci-harness\/([\w./-]+)/gu)) {
            harnessPaths.add(expectDefined(match[1], "preflight harness path"));
          }
        }
      }
      expect(harnessPaths.size).toBeGreaterThan(0);
      expect(harnessPaths).toContain("scripts/ci-build-manifest.mjs");
      const missingPaths = [...harnessPaths].filter(
        (entry) => !existsSync(path.join(harness, entry)),
      );
      expect(missingPaths, `Missing preflight harness paths: ${missingPaths.join(", ")}`).toEqual(
        [],
      );
      const { result, manifest } = runDependencyFreePreflight(
        pathToFileURL(path.join(harness, "scripts/ci-build-manifest.mjs")),
        directory,
        testNodeExecPath,
      );
      expect(
        result.status,
        `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
      expect(manifest).toContain("run_node=false\n");
      expect(manifest).toContain("run_windows=true\n");
      const outputs = Object.fromEntries(
        manifest
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      expect(
        JSON.parse(expectDefined(outputs.checks_node_core_nondist_matrix, "Node test matrix")),
      ).toEqual({
        include: [],
      });
      expect(
        JSON.parse(expectDefined(outputs.checks_windows_matrix, "Windows test matrix")).include
          .length,
      ).toBeGreaterThan(0);
      expect(outputs.ui_test_groups_gzip_base64).toBeTruthy();
    },
  );

  it("keeps type-aware oxlint within hosted fork-runner resources", () => {
    const workflow = readCiWorkflow();
    const checkShardStep = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    const hostedCoreLint = workflow.jobs["check-lint-hosted-core-shard"];
    const hostedExtensionLint = workflow.jobs["check-lint-hosted-extension-shard"];
    const coreLintStep = hostedCoreLint.steps.find(
      (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
    );
    const extensionLintStep = hostedExtensionLint.steps.find(
      (step: WorkflowStep) => step.name === "Run hosted extension lint stripe",
    );
    type GoEnv = Partial<Pick<NodeJS.ProcessEnv, "GOMAXPROCS" | "GOGC" | "GOMEMLIMIT">>;
    const goEnvKeys = ["GOMAXPROCS", "GOGC", "GOMEMLIMIT"] as const;
    const runLintOwner = ({
      capability = true,
      cpuCount = 32,
      eventName = "workflow_dispatch",
      failStripe,
      frozenTarget = !capability,
      goEnv = {},
      expectedGoEnv = goEnv,
      lane,
      nodeRunnerBackend,
      profile = "hybrid",
      releaseGate = false,
      runAttempt = 1,
      stripe = 1,
      stripeCount = 6,
    }: {
      capability?: boolean;
      cpuCount?: number;
      eventName?: "pull_request" | "push" | "workflow_dispatch";
      failStripe?: number;
      frozenTarget?: boolean;
      goEnv?: GoEnv;
      expectedGoEnv?: GoEnv;
      lane: "check" | "core" | "extensions";
      nodeRunnerBackend?: "runson";
      profile?: "blacksmith" | "github" | "hybrid";
      releaseGate?: boolean;
      runAttempt?: number;
      stripe?: number;
      stripeCount?: number;
    }) => {
      const root = tempDirs.make("openclaw-hosted-lint-owner-");
      mkdirSync(path.join(root, ".ci-harness/scripts"), { recursive: true });
      copyFileSync(
        new URL("../../scripts/ci-collect-checks.sh", import.meta.url),
        path.join(root, ".ci-harness/scripts/ci-collect-checks.sh"),
      );
      copyFileSync(
        new URL("../../scripts/ci-static-step.sh", import.meta.url),
        path.join(root, ".ci-harness/scripts/ci-static-step.sh"),
      );
      const binDir = path.join(root, "bin");
      const callsPath = path.join(root, "calls.txt");
      const goEnvPath = path.join(root, "go-env.txt");
      mkdirSync(path.join(root, "scripts"), { recursive: true });
      mkdirSync(binDir);
      writeFileSync(
        path.join(root, "scripts/run-oxlint-shards.mts"),
        capability ? "// --extension-stripe\n" : "// legacy runner\n",
      );
      for (const command of ["node", "pnpm"]) {
        writeExecutable(path.join(binDir, command), [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf '${command} %s\\n' "$*" >> "$LINT_CALLS"`,
          'printf \'%s\\t%s\\t%s\\n\' "${GOMAXPROCS-}" "${GOGC-}" "${GOMEMLIMIT-}" >> "$LINT_GO_ENV"',
          ...(failStripe === undefined
            ? []
            : [
                `if [[ " $* " == *" --core-stripe=${failStripe}/5 "* || " $* " == *" --extension-stripe=${failStripe}/${stripeCount} "* ]]; then exit 23; fi`,
              ]),
        ]);
      }
      writeExecutable(path.join(binDir, "nproc"), [
        "#!/usr/bin/env bash",
        `printf '${cpuCount}\\n'`,
      ]);
      const expressionContext = {
        eventName,
        frozenTarget,
        matrix: { stripe, stripe_count: stripeCount },
        releaseGate,
        repository: "openclaw/openclaw",
        runnerProfile: profile,
        runAttempt,
        preflightOutputs: { node_runner_backend: nodeRunnerBackend ?? "" },
      };
      const step = { check: checkShardStep, core: coreLintStep, extensions: extensionLintStep }[
        lane
      ];
      const command = step.run.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
        String(evaluateWorkflowExpression(expression, expressionContext)),
      );
      const stepEnv = step.env;
      const result = spawnSync("bash", ["-c", command], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GOMAXPROCS: undefined,
          GOGC: undefined,
          GOMEMLIMIT: undefined,
          ...goEnv,
          ...Object.fromEntries(
            goEnvKeys.flatMap((key) => (stepEnv[key] === undefined ? [] : [[key, stepEnv[key]]])),
          ),
          FORMAT_CHECK: "false",
          CORE_STRIPE: String(stripe),
          EXTENSION_STRIPE: String(stripe),
          EXTENSION_STRIPE_COUNT: String(
            evaluateWorkflowExpression(
              extensionLintStep.env.EXTENSION_STRIPE_COUNT,
              expressionContext,
            ),
          ),
          FROZEN_TARGET: frozenTarget ? "true" : "false",
          HISTORICAL_TARGET: capability ? "false" : "true",
          HOSTED_RUNNER_STRIPES: profile === "blacksmith" ? "false" : "true",
          LINT_CALLS: callsPath,
          LINT_GO_ENV: goEnvPath,
          OPENCLAW_CI_STATIC_EVIDENCE: "0",
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          RELEASE_GATE: String(
            stepEnv.RELEASE_GATE
              ? evaluateWorkflowExpression(stepEnv.RELEASE_GATE, expressionContext)
              : false,
          ),
          RUN_CONTROL_UI_I18N: "false",
          RUNNER_PROFILE: profile,
          RUN_UI_TESTS: "false",
          TASK: "lint",
        },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(
        failStripe === undefined ? 0 : 23,
      );
      const calls = existsSync(callsPath)
        ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
        : [];
      expect(calls.length).toBeGreaterThan(0);
      expect(readFileSync(goEnvPath, "utf8").split("\n").filter(Boolean)).toEqual(
        calls.map(() => goEnvKeys.map((key) => expectedGoEnv[key] ?? "").join("\t")),
      );
      return calls;
    };

    const lintCommand = (flags: string, threads = 1) =>
      `node --import tsx scripts/run-oxlint-shards.mts ${flags}--threads=${threads}`;
    const coreCommands = (...stripes: number[]) =>
      stripes.map((stripe) => lintCommand(`--only=core --split-core --core-stripe=${stripe}/5 `));
    const extensionCommand = (stripe: number, count = 6) =>
      lintCommand(`--only=extensions --extension-stripe=${stripe}/${count} `);
    const scriptsCommand = lintCommand("--only=scripts ");
    const assertLint = (options: Parameters<typeof runLintOwner>[0], expected: string[]) =>
      expect(runLintOwner(options)).toEqual(expected);
    // Manifest tests own row admission; these cases execute every full-layout stripe.
    for (const eventName of ["pull_request", "push"] as const) {
      expect([1, 2].map((stripe) => runLintOwner({ eventName, lane: "core", stripe }))).toEqual(
        [
          [1, 2],
          [3, 4, 5],
        ].map((stripes) => coreCommands(...stripes)),
      );
    }
    for (const runAttempt of [1, 2]) {
      expect(
        [1, 2].flatMap((stripe) =>
          runLintOwner({
            lane: "core",
            nodeRunnerBackend: "runson",
            releaseGate: true,
            runAttempt,
            stripe,
          }),
        ),
      ).toEqual(coreCommands(1, 2, 3, 4, 5));
      assertLint({ lane: "check", nodeRunnerBackend: "runson", releaseGate: true, runAttempt }, [
        scriptsCommand,
      ]);
    }
    assertLint({ eventName: "pull_request", failStripe: 1, lane: "core" }, coreCommands(1, 2));
    assertLint(
      { eventName: "pull_request", failStripe: 4, lane: "core", stripe: 2 },
      coreCommands(3, 4, 5),
    );

    assertLint({ lane: "check", profile: "github" }, [extensionCommand(6), scriptsCommand]);
    assertLint({ eventName: "pull_request", lane: "core", profile: "github" }, [
      ...coreCommands(1),
      extensionCommand(1),
    ]);
    expect(
      runLintOwner({
        capability: false,
        lane: "check",
        profile: "github",
        expectedGoEnv: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" },
      }),
    ).toEqual([lintCommand("--only=extensions --only=scripts ")]);
    assertLint({ lane: "check" }, [scriptsCommand]);
    for (const stripeCount of [3, 6]) {
      for (let stripe = 1; stripe <= stripeCount; stripe++) {
        assertLint({ lane: "extensions", stripe, stripeCount }, [
          extensionCommand(stripe, stripeCount),
        ]);
      }
    }
    runLintOwner({
      failStripe: 2,
      lane: "extensions",
      stripe: 2,
    });
    assertLint({ lane: "check", profile: "blacksmith" }, [lintCommand("", 8)]);
    assertLint({ lane: "check", profile: "github", releaseGate: true }, [scriptsCommand]);
    for (const scenario of [
      {
        capability: false,
        lane: "core" as const,
        profile: "github" as const,
        expectedGoEnv: { GOMAXPROCS: "2" },
      },
      { lane: "core" as const },
      {
        lane: "core" as const,
        profile: "github" as const,
        releaseGate: true,
      },
    ]) {
      expect(runLintOwner(scenario)).toEqual(coreCommands(1));
    }

    for (const lane of ["check", "core"] as const) {
      runLintOwner({ cpuCount: 4, lane });
      runLintOwner({
        lane,
        profile: "github",
        goEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
      });
    }
    runLintOwner({ cpuCount: 4, lane: "check", profile: "blacksmith" });
    for (const [profile, cpuCount] of [
      ["hybrid", 32],
      ["blacksmith", 4],
    ] as const) {
      runLintOwner({
        cpuCount,
        frozenTarget: true,
        lane: "check",
        profile,
        expectedGoEnv: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" },
      });
    }
    runLintOwner({
      frozenTarget: true,
      lane: "check",
      profile: "blacksmith",
    });
  });

  it.skipIf(process.platform === "win32").for([
    { task: "bundled-protocol", eventName: "pull_request" },
    { task: "bundled-protocol", eventName: "workflow_dispatch" },
    { task: "guards", eventName: "pull_request" },
    { task: "guards", eventName: "push" },
    { task: "npm-lock", eventName: "pull_request" },
    { task: "npm-lock", eventName: "workflow_dispatch" },
  ] as const)(
    "uses prefetched CI base without later network access ($task, $eventName)",
    { timeout: 55_000 },
    async ({ task, eventName }, { signal }) => {
      const base = "c".repeat(40);
      const baseRef = "refs/remotes/origin/ci-ratchet-base";
      const jobName = task === "bundled-protocol" ? "checks-fast-core" : "check-shard";
      const job = readCiWorkflow().jobs[jobName];
      const needsBase =
        task === "bundled-protocol" ||
        (task === "guards" ? eventName === "pull_request" : eventName !== "workflow_dispatch");
      const checkoutBase = evaluateWorkflowExpression(job.env?.CHECKOUT_BASE_SHA ?? "${{ '' }}", {
        eventName,
        repository: "fixture/checkout",
        matrix: { task },
        preflightOutputs: { diff_base_revision: base },
      });
      const report = await runCiGitStep({
        signal,
        job: jobName,
        step:
          task === "bundled-protocol"
            ? "Run ${{ matrix.task }} (${{ matrix.runtime }})"
            : "Run check shard",
        checkoutBeforeStep: true,
        // The authenticated checkout and trusted harness fetch succeed. Network
        // access is unavailable afterward, even though the base is already local.
        fetchResults: [0, 0, 128],
        baseAvailableAfter: 0,
        revisions: { [`${baseRef}^{commit}`]: base },
        env: {
          TASK: task,
          RUN_BUNDLED_TESTS: String(eventName !== "pull_request"),
          RUN_PR_MADGE_IMPORT_CYCLES: String(eventName === "pull_request"),
          RUN_PR_KYSELY_GUARDRAILS: String(eventName === "pull_request"),
          SPLIT_PR_GUARDS: "false",
          GITHUB_EVENT_NAME: eventName,
          CHECKOUT_KIND: "linux-node",
          CHECKOUT_BASE_SHA: String(checkoutBase),
          CHECKOUT_TOKEN: "fixture-checkout-token",
          NARROW_CHECK_PATHS_JSON: "",
          CI_TYPE_GRAPHS_JSON: "",
          CI_CORE_TYPE_GRAPHS_JSON: "",
          CI_CORE_TYPE_CONCURRENCY: "",
          OPENCLAW_CI_STATIC_EVIDENCE: "0",
        },
      });
      expect(report.code, report.output).toBe(0);
      expect(report.fetches).toHaveLength(2);
      const sourceFetch = report.fetches.find(({ cwd }) => cwd === report.workspace);
      expect(sourceFetch?.args.includes(`+${base}:refs/remotes/origin/ci-ratchet-base`)).toBe(
        needsBase,
      );
      const consumers = report.commands.filter(({ tool }) => tool === "node" || tool === "pnpm");
      if (task === "bundled-protocol") {
        expect(consumers.map(({ args }) => args)).toEqual(
          eventName === "pull_request"
            ? [["protocol:check"]]
            : [["test:bundled"], ["protocol:check"]],
        );
      } else if (task === "guards") {
        const tempReport = consumers.find(
          ({ args }) => args[0] === "scripts/report-test-temp-creations.mjs",
        );
        expect(tempReport?.args).toEqual(
          needsBase
            ? [
                "scripts/report-test-temp-creations.mjs",
                "--base",
                base,
                "--head",
                "HEAD",
                "--no-merge-base",
              ]
            : undefined,
        );
      } else {
        expect(consumers.filter(({ tool }) => tool === "pnpm").map(({ args }) => args)).toEqual([
          needsBase
            ? ["deps:npm-lock:check:changed", "--base", base, "--head", "HEAD"]
            : ["deps:npm-lock:check"],
        ]);
      }
    },
  );

  it.each([
    {
      label: "current",
      frozenTarget: false,
      compatibilityTarget: false,
      policy: "bun-compatible",
      shards: [1, 2, 3],
    },
    {
      label: "frozen current",
      frozenTarget: true,
      compatibilityTarget: false,
      policy: "dual",
      shards: [1, 2, 3],
    },
  ])("executes the $label standalone UI envelope", (scenario) => {
    const workflow = readCiWorkflow();
    expect(workflow.env?.BUN_JSC_useFTLJIT).toBeUndefined();
    const ftlSteps: string[] = [];
    for (const [name, job] of Object.entries<{
      env?: Record<string, unknown>;
      steps?: WorkflowStep[];
    }>(workflow.jobs)) {
      expect(job.env?.BUN_JSC_useFTLJIT).toBeUndefined();
      for (const step of job.steps ?? []) {
        if (step.env?.BUN_JSC_useFTLJIT !== undefined) {
          ftlSteps.push(`${name}/${step.name}`);
        }
      }
    }
    expect(ftlSteps).toEqual([]);
    const ui = workflow.jobs["checks-ui"];
    const lint = ui.steps.find(
      (step: WorkflowStep) => step.name === "Lint Control UI window.open usage",
    );
    const test = ui.steps.find((step: WorkflowStep) => step.name === "Test Control UI");
    const diagnostics = requiredWorkflowStep(ui.steps, "Upload Control UI timeout diagnostics");
    expect(ui.steps.indexOf(diagnostics)).toBeGreaterThan(ui.steps.indexOf(test));
    expect(diagnostics).toMatchObject({
      if: "failure()",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "control-ui-test-timeout-${{ matrix.shard }}-${{ github.run_attempt }}",
        path: `${test.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR}/failure-*/failure.public.json`,
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
    const uiGroups = createUiTestShardGroups({
      includeReleaseOnlyTests: scenario.frozenTarget || scenario.compatibilityTarget,
    }).ui;
    const context = {
      eventName: scenario.frozenTarget ? "workflow_dispatch" : "pull_request",
      frozenTarget: scenario.frozenTarget,
      preflightOutputs: {
        compatibility_target: String(scenario.compatibilityTarget),
        ui_test_runtime_policy: scenario.policy,
        ui_test_matrix: JSON.stringify({ include: scenario.shards.map((shard) => ({ shard })) }),
        ui_test_shard_count: String(scenario.shards.length),
        ui_test_groups_gzip_base64: encodeNodeTestGroups(uiGroups),
      },
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerBackend: "hybrid",
      steps: {
        node_setup: { outputs: {}, outcome: "success" },
        ui_chromium: { outputs: {}, outcome: "success" },
      },
    } as const;
    const shards = evaluateWorkflowExpression(ui.strategy.matrix, context).include.map(
      (row: { shard: number }) => row.shard,
    );
    expect(shards).toEqual(scenario.shards);
    expect(ui.strategy).toMatchObject({ "fail-fast": false, "max-parallel": 3 });
    expect(ui.needs).toEqual(["preflight"]);
    expect(ui.if).toBe("needs.preflight.outputs.run_ui_tests == 'true'");
    expect(ui.permissions).toEqual({ contents: "read" });
    // Hosted rows (full-release dispatches, github backend, hybrid retries,
    // fork PRs) run the Control UI suites slower than Blacksmith; a frozen
    // full-release dispatch measured 15-20 min per shard against a 20 min cap.
    expect(evaluateWorkflowExpression(ui["timeout-minutes"], context)).toBe(
      scenario.frozenTarget ? 35 : 20,
    );
    for (const override of [
      { runnerBackend: "github" },
      { runnerBackend: "hybrid", runAttempt: 2 },
      { eventName: "pull_request", headRepository: "contributor/openclaw" },
    ] as const) {
      expect(evaluateWorkflowExpression(ui["timeout-minutes"], { ...context, ...override })).toBe(
        35,
      );
    }
    expect(
      evaluateWorkflowExpression(ui["timeout-minutes"], {
        ...context,
        eventName: "workflow_dispatch",
        preflightOutputs: { ...context.preflightOutputs, ci_shape: "main" },
      }),
    ).toBe(20);
    expect(workflow.jobs["ci-gate"].needs).toContain("checks-ui");

    const root = tempDirs.make("openclaw-ui-workflow-");
    const bin = path.join(root, "bin");
    const callsPath = path.join(root, "calls.txt");
    const argsPath = path.join(root, "vitest-args.json");
    mkdirSync(bin);
    for (const command of ["node", "pnpm"]) {
      writeExecutable(path.join(bin, command), [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' '${command} '"$*" >> "$UI_COMMAND_CALLS"`,
        ...(command === "node"
          ? ['printf "%s\\n" "$OPENCLAW_NODE_TEST_VITEST_ARGS_JSON" > "$UI_VITEST_ARGS"']
          : []),
      ]);
    }
    for (const shard of scenario.shards) {
      const rowContext = { ...context, matrix: { shard }, workspace: root };
      const resolveValue = (value: unknown): string =>
        String(value).replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
          String(evaluateWorkflowExpression(expression, rowContext)),
        );
      expect(resolveValue(ui.name)).toBe(
        scenario.compatibilityTarget
          ? "checks-ui"
          : `checks-ui (${shard}/${scenario.shards.length})`,
      );
      expect(evaluateWorkflowExpression(ui["runs-on"], rowContext)).toBe(
        scenario.frozenTarget ? "ubuntu-24.04" : "blacksmith-8vcpu-ubuntu-2404",
      );
      const env = Object.fromEntries(
        Object.entries({ ...ui.env, ...test.env }).map(([key, value]) => [
          key,
          resolveValue(value),
        ]),
      );
      expect(env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY).toBe("1");
      expect(env.BUN_JSC_useFTLJIT).toBeUndefined();
      expect(env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR).toBe(
        `${root}/.artifacts/control-ui-e2e-timeouts/ui-shard-${shard}-attempt-1`,
      );
      const flags = [
        "--maxWorkers",
        "3",
        "--reporter=verbose",
        "--reporter=github-actions",
        "--reporter=./scripts/lib/vitest-resource-reporter.mts",
        ...(scenario.compatibilityTarget ? [] : [`--shard=${shard}/${scenario.shards.length}`]),
      ];
      const steps = [
        ...(!lint.if || evaluateWorkflowCondition(lint.if, rowContext) ? [lint] : []),
        test,
      ];
      for (const step of steps) {
        const result = runWorkflowShellScript(step.run, {
          cwd: root,
          env: {
            ...process.env,
            ...env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            UI_COMMAND_CALLS: callsPath,
            UI_VITEST_ARGS: argsPath,
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
      }
      if (!scenario.compatibilityTarget) {
        expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual(flags);
      }
    }
    const calls = readFileSync(callsPath, "utf8").trim().split("\n");
    expect(calls.filter((call) => call === "pnpm lint:ui:no-raw-window-open")).toHaveLength(1);
    expect(calls.filter((call) => call !== "pnpm lint:ui:no-raw-window-open")).toEqual(
      scenario.compatibilityTarget
        ? ["pnpm --dir ui test --testTimeout=30000 --isolate"]
        : scenario.shards.map(() => "node --import tsx scripts/ci-run-node-test-shard.mts"),
    );
  });

  it("keeps private Control UI servers and resource-sensitive files under one serial owner", () => {
    assertControlUiE2eOwnership((prefix) => tempDirs.make(prefix), parser);
  });

  it.each([
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: false },
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: true },
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: false, sharded: false },
    { frozen: true, prebuilt: true, childExit: 0 },
    { frozen: true, prebuilt: false, childExit: 0 },
    { frozen: false, prebuilt: false, childExit: 0 },
  ])(
    "selects the real-Gateway tier without retrying failures: %j",
    ({ frozen, prebuilt, childExit, releaseTier, sharded }) => {
      const step = requiredWorkflowStep(
        readCiWorkflow().jobs["checks-ui-e2e-real-gateway"].steps,
        "Test Control UI suites with a real Gateway",
      );
      const directory = tempDirs.make("openclaw-real-gateway-command-");
      const bin = path.join(directory, "bin");
      const prebuiltConfig = "test/vitest/vitest.ui-e2e-prebuilt.config.ts";
      const serialConfig = "test/vitest/vitest.ui-e2e.config.ts";
      mkdirSync(bin);
      mkdirSync(path.join(directory, "test/vitest"), { recursive: true });
      writeFileSync(path.join(directory, serialConfig), "export default {};\n");
      if (prebuilt) {
        writeFileSync(path.join(directory, prebuiltConfig), "export default {};\n");
      }
      mkdirSync(path.join(directory, "scripts/lib"), { recursive: true });
      copyFileSync(
        "scripts/lib/ci-node-test-groups-codec.mts",
        path.join(directory, "scripts/lib/ci-node-test-groups-codec.mts"),
      );
      writeExecutable(path.join(bin, "node"), [
        "#!/bin/sh",
        'if [ "$1" = "--import" ]; then shift; shift; exec "$REAL_GATEWAY_NODE" "$@"; fi',
        'printf "%s\\n" "$@" > "$REAL_GATEWAY_COMMAND_ARGS"',
        'printf "%s" "${OPENCLAW_VITEST_INCLUDE_FILE:-}" > "$REAL_GATEWAY_INCLUDE_PATH"',
        'printf "called\\n" >> "$REAL_GATEWAY_COMMAND_CALLS"',
        'exit "$REAL_GATEWAY_COMMAND_EXIT"',
      ]);
      const desktop = "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts";
      const groups =
        releaseTier === undefined
          ? undefined
          : createUiTestShardGroups({ includeReleaseOnlyTests: releaseTier }).e2e;
      const rows =
        groups && !frozen && sharded !== false
          ? createUiRealGatewayTestShards(groups)
          : [{ shard: 1, shard_count: 1, run_desktop: true, groups }];
      const selectedFiles: string[] = [];
      for (const row of rows) {
        const rowDirectory = path.join(directory, String(row.shard));
        mkdirSync(rowDirectory);
        const argsPath = path.join(rowDirectory, "args");
        const callsPath = path.join(rowDirectory, "calls");
        const includePath = path.join(rowDirectory, "include-path");
        const context = {
          eventName: "push" as const,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          matrix: {
            ...row,
            test_groups_gzip_base64: row.groups ? encodeNodeTestGroups(row.groups) : "",
          },
          preflightOutputs: {
            frozen_target: String(frozen),
            ui_e2e_test_groups_gzip_base64: groups ? encodeNodeTestGroups(groups) : "",
          },
        };
        const result = runWorkflowShellScript(expectDefined(step.run, "real-Gateway script"), {
          linuxWorkflow: true,
          cwd: directory,
          env: {
            ...process.env,
            FROZEN_TARGET: String(evaluateWorkflowExpression(step.env.FROZEN_TARGET, context)),
            RUNNER_TEMP: rowDirectory,
            REAL_GATEWAY_NODE: testNodeExecPath,
            OPENCLAW_VITEST_INCLUDE_FILE: "",
            REAL_GATEWAY_INCLUDE_PATH: includePath,
            OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: String(
              evaluateWorkflowExpression(step.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64, context),
            ),
            REAL_GATEWAY_COMMAND_ARGS: argsPath,
            REAL_GATEWAY_COMMAND_CALLS: callsPath,
            REAL_GATEWAY_COMMAND_EXIT: String(childExit),
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        });
        const missingCurrentConfig = !prebuilt && !frozen;
        expect(result.status, result.stdout + result.stderr).toBe(
          missingCurrentConfig ? 1 : childExit,
        );
        if (missingCurrentConfig) {
          expect(result.stderr).toContain(`Current target is missing ${prebuiltConfig}`);
          expect(existsSync(callsPath)).toBe(false);
          return;
        }
        expect(readFileSync(callsPath, "utf8").trim().split("\n")).toEqual(["called"]);
        const args = readFileSync(argsPath, "utf8").trim().split("\n");
        expect(args.slice(0, 6)).toEqual([
          "scripts/run-vitest.mjs",
          "run",
          "--config",
          prebuilt ? prebuiltConfig : serialConfig,
          "--configLoader",
          "runner",
        ]);
        const reporterArgs = frozen
          ? []
          : [
              "--reporter",
              "verbose",
              "--reporter",
              "github-actions",
              "--reporter",
              "default",
              "--reporter",
              "./scripts/lib/vitest-resource-reporter.mts",
            ];
        expect(args.slice(6, 6 + reporterArgs.length)).toEqual(reporterArgs);
        expect(args.slice(6 + reporterArgs.length).toSorted()).toEqual(
          prebuilt ? ["--exclude", desktop] : frozenRealGatewayFiles.toSorted(),
        );
        const selectedConfig = createPrebuiltUiE2eVitestConfig(
          { OPENCLAW_VITEST_INCLUDE_FILE: readFileSync(includePath, "utf8") },
          [testNodeExecPath, ...args],
        );
        selectedFiles.push(
          ...(selectedConfig.test?.include ?? []).filter((file) => file !== desktop),
        );
        expect(
          resolveRunVitestSpawnEnv(
            { CI: "true", OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000" },
            args.slice(1),
          ).OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS,
        ).toBe("300000");
      }
      expect(new Set(selectedFiles).size).toBe(selectedFiles.length);
      expect(selectedFiles.toSorted()).toEqual(
        (prebuilt ? uiE2eRealGatewayTestFiles : frozenRealGatewayFiles)
          .filter(
            (file) =>
              file !== desktop &&
              (!groups ||
                groups.some(
                  (group) => !group.includePatterns || group.includePatterns.includes(file),
                )),
          )
          .toSorted(),
      );
      if (releaseTier === false) {
        expect(selectedFiles).toHaveLength(uiE2eRealGatewayTestFiles.length - 13);
        expectExcludes(selectedFiles, [
          "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
          "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
          "ui/src/e2e/chat-reconnect-continuity.real-gateway.e2e.test.ts",
          "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
        ]);
      }
    },
  );

  it("measures startup memory before the built artifact-check wave", () => {
    const steps = readCiWorkflow().jobs["build-artifacts"].steps;
    const verifier = requiredWorkflowStep(steps, "Run built artifact checks");
    const run = verifier.run;
    const at = (text: string, start = 0) => run.indexOf(text, start);
    const wait = (start: number, nested = false) =>
      at(nested ? "\n  wait_checks\n" : "\nwait_checks\n", start);
    const ordered = (...positions: number[]) => {
      expect(positions.every((position) => position >= 0)).toBe(true);
      for (let index = 1; index < positions.length; index++) {
        expect(positions[index]).toBeGreaterThan(positions[index - 1]!);
      }
    };
    const gateway = (parallel: boolean) =>
      at(
        'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" ' +
          (parallel ? "=" : "!=") +
          ' "true" ]; then',
      );
    const discord = (parallel: boolean) =>
      at(
        'if [ "$RUN_DISCORD_COMPONENT_PROOF" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" ' +
          (parallel ? "=" : "!=") +
          ' "true" ]; then',
      );
    const startup = at('run_verifier "startup-memory"');
    const doctor = at('run_verifier "doctor-plugin-index"');
    const plugin = at('run_verifier "plugin-singleton" pnpm test:build:singleton');
    const parallelDiscord = discord(true);
    const hostedDiscord = discord(false);
    const coreSupport = at('start_check "core-support-boundary"');
    const firstWait = wait(coreSupport);
    const tui = at('if [ "$RUN_TUI_PTY" = "true" ]; then');
    ordered(startup, wait(startup), doctor);
    ordered(
      plugin,
      wait(plugin),
      gateway(true),
      wait(gateway(true), true),
      doctor,
      parallelDiscord,
      wait(parallelDiscord),
      hostedDiscord,
    );
    ordered(
      coreSupport,
      firstWait,
      gateway(false),
      wait(gateway(false), true),
      hostedDiscord,
      wait(hostedDiscord, true),
      tui,
      wait(tui, true),
    );
    ordered(parallelDiscord, firstWait);
    ordered(doctor, wait(doctor, true), at('run_verifier "sqlite-session-lifecycle"'));
    expect(at('run_verifier "doctor-plugin-index" run_doctor_plugin_index')).toBe(doctor);
    expect(steps.some((step: WorkflowStep) => step.name === "Verify built runtime artifacts")).toBe(
      false,
    );
    expect(verifier.env).toMatchObject({
      OPENCLAW_STARTUP_MEMORY_PLUGINS_LIST_MB:
        "${{ runner.environment == 'github-hosted' && '425' || '400' }}",
      PARALLEL_BUILT_VERIFIERS: "${{ runner.environment != 'github-hosted' && 'true' || 'false' }}",
      PARALLEL_GATEWAY_WATCH: "${{ runner.environment != 'github-hosted' && 'true' || 'false' }}",
      RUN_CHANNELS:
        "${{ needs.preflight.outputs.run_proof_tier == 'true' && needs.preflight.outputs.run_checks == 'true' }}",
      FROZEN_TARGET: "${{ needs.preflight.outputs.frozen_target }}",
    });
    expectIncludes(run, [
      'OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="${RUNNER_TEMP}/vitest-module-cache/${name}"',
      "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts",
      "env OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=660000 node scripts/run-vitest.mjs run",
      "--config test/vitest/vitest.e2e.config.ts",
      "Selected target predates",
      "pnpm test:build:singleton",
      "scripts/ensure-cli-startup-build.mts",
      "scripts/check-cli-startup-memory.mjs",
      ".artifacts/startup-memory/summary.md",
      '["discord-component-attachments"]="skipped"',
      "OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_E2E_WORKERS=1",
      "OPENCLAW_E2E_VERBOSE=1 OPENCLAW_VITEST_MAX_WORKERS=1",
      'start_check "channels"',
      'start_check "gateway-watch"',
      "for name in channels core-support-boundary discord-component-attachments doctor-plugin-index gateway-watch plugin-singleton sqlite-session-lifecycle startup-memory tui-pty; do",
      "wait_checks()",
    ]);
    for (const slice of [
      run.slice(parallelDiscord, wait(parallelDiscord)),
      run.slice(hostedDiscord),
    ]) {
      expect(slice).toContain(
        'start_check "discord-component-attachments" run_discord_component_attachments',
      );
    }
    for (const name of [
      "doctor-plugin-index",
      "plugin-singleton",
      "sqlite-session-lifecycle",
      "startup-memory",
    ]) {
      expectIncludes(run, [`run_verifier "${name}"`, `["${name}"]="skipped"`]);
    }
    expectIncludes(run.slice(tui, wait(tui, true)), [
      "src/tui/tui-pty-local.e2e.test.ts",
      "--testNamePattern",
      "launches openclaw (chat as local mode|tui against a real Gateway) through a real PTY",
    ]);
    const upload = requiredWorkflowStep(steps, "Upload Discord component attachment proof");
    expect(upload.with["if-no-files-found"]).toBe("error");
    expectIncludes(upload.with.path, [
      "${{ runner.temp }}/discord-component-attachments.json",
      "${{ runner.temp }}/discord-component-attachments.log",
    ]);
    expect(run.match(/wait_checks$/gmu)).toHaveLength(9);
  });

  it.each([
    {
      fullNames: [
        "native host registration launches with the exact custom installation context when Chrome has no selectors",
      ],
      expected: 0,
    },
    {
      fullNames: [
        "does not inspect or migrate configuration before rejecting a malformed native request",
        "rejects an unauthorized bootstrap caller before config, keys or database creation",
        "rejects an unauthorized ensure_relay caller before config, keys or database creation",
        'preserves invalid-config diagnostics for ordinary extension command "status"',
        'preserves invalid-config diagnostics for ordinary extension command "setup"',
        'preserves invalid-config diagnostics for ordinary extension command "pair"',
        "launches launcher with the exact custom installation context when Chrome has no selectors",
        "launches cli with the exact custom installation context when Chrome has no selectors",
      ].map((name) => `native host registration ${name}`),
      expected: 0,
    },
    { fullNames: ["historical native-host proof"], expected: 1 },
  ])(
    "validates a complete known frozen native-host test inventory: $fullNames",
    ({ fullNames, expected }) => {
      const step = readCiWorkflow().jobs["build-artifacts"].steps.find(
        (entry: WorkflowStep) => entry.name === "Verify built browser native host",
      );
      const root = tempDirs.make("openclaw-frozen-browser-proof-report-");
      const file = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
      const report = {
        success: true,
        numFailedTestSuites: 0,
        numPendingTestSuites: 0,
        numTotalTests: fullNames.length,
        numPassedTests: fullNames.length,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [
          {
            name: path.join(root, file),
            status: "passed",
            assertionResults: fullNames.map((fullName) => ({ fullName, status: "passed" })),
          },
        ],
      };
      mkdirSync(path.join(root, "scripts"));
      writeFileSync(
        path.join(root, "scripts/run-vitest.mjs"),
        `import fs from "node:fs";
       const args = process.argv.slice(2);
       fs.writeFileSync(args[args.indexOf("--outputFile.json") + 1], ${JSON.stringify(JSON.stringify(report))});`,
      );
      const result = runWorkflowShellScript(step.run, {
        cwd: root,
        env: { ...process.env, ...step.env, FROZEN_TARGET: "true", RUNNER_TEMP: root },
      });
      expect(result.status, result.stderr).toBe(expected);
    },
  );

  it("restores dist in PR CI and saves it only from the trusted warmer", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const stepNames = buildArtifactSteps.map((step: WorkflowStep) => step.name);
    const restoreStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Restore dist build cache",
    );
    const buildDistStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Build dist",
    );
    const warmer = readWorkflow(".github/workflows/vitest-cache-warm.yml");
    const warmerSteps = warmer.jobs.warm.steps as WorkflowStep[];
    const saveStep = requiredWorkflowStep(warmerSteps, "Save dist build cache");

    expect(stepNames.indexOf("Restore dist build cache")).toBeLessThan(
      stepNames.indexOf("Build dist"),
    );
    expect(stepNames.indexOf("Build dist")).toBeLessThan(
      stepNames.indexOf("Smoke test CLI launcher help"),
    );
    expect(stepNames).not.toContain("Save dist build cache");
    expect(restoreStep.uses).toBe(CACHE_V5);
    expect(buildDistStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.uses).toBe("actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
    expect(saveStep.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
    expect(saveStep.with?.key).toBe("${{ runner.os }}-dist-build-v3-${{ github.sha }}");
    expect(restoreStep.with.path).toContain("dist/");
    expect(restoreStep.with.path).toContain("dist-runtime/");
    expect(restoreStep.with.path).toContain("packages/*/dist/");
    expect(saveStep.with?.path).toContain("packages/*/dist/");
    expect(restoreStep.with.key).toContain("dist-build-v3-");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/.bundle.hash");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/*.bundle.js");
    expect(warmerSteps.indexOf(saveStep)).toBeGreaterThan(
      warmerSteps.findIndex((step) => step.name === "Warm build cache"),
    );
    expect(buildArtifactSteps.map((step: WorkflowStep) => step.name)).not.toContain(
      "Cache dist build",
    );
  });

  it("keeps the AI runtime in Testbox build artifact caches", () => {
    const workflow = readBuildArtifactsTestboxWorkflow();
    const steps = workflow.jobs["build-artifacts"].steps;
    const resolveSeedsStep = steps.find(
      (step: WorkflowStep) => step.name === "Resolve release dist cache seeds",
    );
    const setupStep = requiredWorkflowStep(steps, "Setup Node environment");
    const restoreStep = steps.find(
      (step: WorkflowStep) => step.name === "Restore dist build cache",
    );
    const verifyStep = steps.find((step: WorkflowStep) => step.name === "Verify build artifacts");
    const saveStep = steps.find((step: WorkflowStep) => step.name === "Save dist build cache");

    expect(resolveSeedsStep.run).toContain('cache_prefix="${RUNNER_OS}-dist-build-v2-"');
    expect(restoreStep.with.path).toContain("packages/*/dist/");
    expect(restoreStep.with.key).toContain("dist-build-v2-");
    expect(verifyStep.run).toContain("test -f packages/ai/dist/internal/runtime.mjs");
    expect(saveStep.with.path).toContain("packages/*/dist/");
    expect(saveStep.with.key).toContain("dist-build-v2-");
    expect(setupStep.with["cache-mode"]).toContain("'read-write'");
    expect(saveStep.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
  });

  it.each([
    { mode: "private-qa", outcome: "success", expected: "1" },
    { mode: "runtime", outcome: "success", expected: "" },
    { mode: "private-qa", outcome: "failure", expected: "" },
  ] as const)("hands prepared E2E runtime to children only after $mode $outcome", (scenario) => {
    const steps = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps;
    const build = steps.find((step: WorkflowStep) => step.name === "Build Node test runtime");
    const run = steps.find((step: WorkflowStep) => step.name === "Run Node test shard");
    const prebuilt = evaluateWorkflowExpression(run.env.OPENCLAW_E2E_USE_PREBUILT_DIST, {
      matrix: { pretest_build_mode: scenario.mode },
      steps: { [build.id]: { outputs: {}, outcome: scenario.outcome } },
    });
    expect(prebuilt).toBe(scenario.expected);
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(run));
  });

  it("fails and retries quiet Node test shard stalls quickly", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const runStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Run Node test shard",
    );
    const buildRuntimeStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Build Node test runtime",
    );
    const installRipgrepStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Install ripgrep for native grep tests",
    );

    expect(manifestSource).toContain("pretest_build_mode: shard.pretestBuildMode");
    expect(manifestSource).toContain("requires_ripgrep:");
    expect(manifestSource).toContain("src/agents/sessions/tools/index.test.ts");
    expect(nodeTestJob["timeout-minutes"]).toBe("${{ matrix.timeout_minutes || 60 }}");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '660000' || '300000' }}",
    );
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBeUndefined();
    expect(runStep.env.OPENCLAW_NODE_TEST_ENV_JSON).toBe("${{ toJson(matrix.env) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_TARGETS_JSON).toBe("${{ toJson(matrix.targets) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64).toBe(
      "${{ matrix.groups_pool && steps.node-test-groups.outputs.groups_gzip_base64 || matrix.groups_gzip_base64 || '' }}",
    );
    expect(runStep.env.OPENCLAW_NODE_TEST_GROUPS_JSON).toBe(
      "${{ matrix.groups && toJson(matrix.groups) || '' }}",
    );
    expect(runStep.env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '[\"--hookTimeout=600000\"]' || '[]' }}",
    );
    expect(buildRuntimeStep).toMatchObject({
      if: "matrix.pretest_build_mode != null",
      env: {
        OPENCLAW_BUILD_PRIVATE_QA: "${{ matrix.pretest_build_mode == 'private-qa' && '1' || '0' }}",
        VITEST: "1",
      },
      run: "pnpm build qaRuntime",
    });
    expect(installRipgrepStep).toMatchObject({
      if: "matrix.requires_ripgrep == true && runner.os == 'Linux'",
      uses: "./.ci-harness/.github/actions/setup-ripgrep",
    });
    expect(nodeTestJob.steps.indexOf(buildRuntimeStep)).toBeLessThan(
      nodeTestJob.steps.indexOf(runStep),
    );
    expect(nodeTestJob.steps.indexOf(installRipgrepStep)).toBeLessThan(
      nodeTestJob.steps.indexOf(runStep),
    );
    const trustedRunnerStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout trusted Node shard runner",
    );
    expect(trustedRunnerStep).toMatchObject({
      if: "${{ hashFiles('scripts/ci-run-node-test-shard.mts') == '' }}",
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ github.workflow_sha }}",
        path: ".ci-workflow",
        "sparse-checkout": expect.stringContaining("scripts/ci-run-node-test-shard.mts"),
        "sparse-checkout-cone-mode": false,
        "persist-credentials": false,
      },
    });
    // Non-cone sparse-checkout ignores missing paths silently, so a renamed
    // script would surface only as a runtime module-not-found on the frozen
    // lane. Require every listed path to exist at this revision.
    const sparseCheckoutPaths = String(trustedRunnerStep?.with?.["sparse-checkout"] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(sparseCheckoutPaths).toContain("scripts/ci-run-node-test-shard.mts");
    for (const sparsePath of sparseCheckoutPaths) {
      expect({ sparsePath, exists: existsSync(sparsePath) }).toEqual({ sparsePath, exists: true });
    }
    const runtimeFiles = collectRuntimeImportClosure(process.cwd(), [
      "scripts/ci-run-node-test-shard.mts",
    ]).filter((file) => file.startsWith("scripts/"));
    expect(runtimeFiles.toSorted()).toEqual(sparseCheckoutPaths.toSorted());
    expect(runtimeFiles).not.toContain("scripts/lib/vitest-worker-run.mts");
  });

  it("keeps RunsOn Node workers bounded without invoking the Blacksmith scheduler", () => {
    const step = requiredWorkflowStep(
      readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps,
      "Configure Node test resources",
    );
    const root = tempDirs.make("runson-node-workers-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeExecutable(path.join(bin, "nproc"), ["#!/bin/sh", 'printf "%s\\n" "$FIXTURE_CORES"']);
    writeExecutable(path.join(bin, "node"), ["#!/bin/sh", "exit 64"]);
    for (const [cores, workers] of [
      [32, 2],
      [1, 1],
    ]) {
      const output = path.join(root, "github-env");
      writeFileSync(output, "");
      const result = runWorkflowShellScript(expectDefined(step.run, "resource script"), {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          GITHUB_ENV: output,
          FIXTURE_CORES: String(cores),
          RUNSON_JOB: "true",
          RUNNER_ENVIRONMENT: "self-hosted",
          FROZEN_TARGET: "false",
          SHARD_PLAN_CONCURRENCY: "1",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readWorkflowOutputs(output)).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: String(workers) });
    }
  });

  it("uses candidate-owned script interfaces for frozen target CI", () => {
    const workflow = readCiWorkflow();
    const buildChecks = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Run built artifact checks",
    );
    const qaBuild = workflow.jobs["qa-smoke-ci-profile"].steps.find(
      (step: WorkflowStep) => step.name === "Build QA smoke runtime",
    );

    expect(buildChecks.run).toContain("pnpm test:gateway:watch-regression -- --skip-build");
    expect(buildChecks.run).not.toContain("scripts/check-gateway-watch-regression.mts");
    expect(buildChecks.run).toContain(
      "startup_builder=(node --import tsx scripts/ensure-cli-startup-build.mts)",
    );
    expect(buildChecks.run).toContain(
      "startup_builder=(node scripts/ensure-cli-startup-build.mjs)",
    );
    expect(qaBuild.run.match(/pnpm build qaRuntime/gu)).toHaveLength(1);
    expect(qaBuild.run).not.toContain("package-openclaw-for-docker");
    expect(readTrackedText("scripts/ci-additional-checks.sh")).toContain(
      "boundary_runner=(node --import tsx scripts/run-additional-boundary-checks.mts)",
    );
    expect(readTrackedText("scripts/ci-additional-checks.sh")).toContain(
      "boundary_runner=(node scripts/run-additional-boundary-checks.mjs)",
    );
    expect(readTrackedText("scripts/ci-additional-checks.sh")).not.toContain(
      "if [ ! -f scripts/check-session-accessor-boundary.mts ]",
    );
    expect(readTrackedText("scripts/ci-additional-checks.sh")).not.toContain(
      "if [ ! -f scripts/check-session-transcript-reader-boundary.mts ]",
    );
    const checkLint = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    const hostedCoreLint = workflow.jobs["check-lint-hosted-core-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
    );
    const lintBoundaryFingerprint = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Compute extension boundary input fingerprint",
    );
    const additionalBoundaryFingerprint = workflow.jobs["check-additional-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Compute extension boundary input fingerprint",
    );

    // The frozen candidate owns the older full lint and boundary builders;
    // current-only stripe and cache mechanics must not replace that coverage.
    expect(checkLint.run).toContain("if [[ ! -f scripts/run-oxlint-shards.mts ]]; then");
    expect(checkLint.run).toContain("pnpm lint");
    expect(hostedCoreLint.run).toContain("target does not support core lint stripes");
    expect(lintBoundaryFingerprint.run).toContain("enabled=false");
    expect(additionalBoundaryFingerprint.run).toContain("enabled=false");
  });

  it("skips generated-asset validation only when a frozen candidate lacks the contract", () => {
    const workflow = readCiWorkflow();
    const buildArtifactsJob = workflow.jobs["build-artifacts"];
    const assetCheckStep = buildArtifactsJob.steps.find(
      (step: WorkflowStep) => step.name === "Check bundled plugin generated assets",
    );

    expect(assetCheckStep.run).toContain('packageJson.scripts?.["plugins:assets:check"]');
    expect(assetCheckStep.run).toContain("pnpm plugins:assets:check");
    expect(assetCheckStep.run).toContain("predates plugins:assets:check");
  });

  it("keeps network CodeQL off unrelated source-only refactors", () => {
    const workflow = readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
    const networkConfig = readFileSync(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
      "utf8",
    );
    const rawSocketQuery = readFileSync(
      ".github/codeql/openclaw-boundary/queries/raw-socket-callsite-classification.ql",
      "utf8",
    );
    const networkSelector = workflow.slice(
      workflow.indexOf(".github/codeql/codeql-network-runtime-boundary-critical-quality.yml"),
      workflow.indexOf("network-runtime-boundary:"),
    );
    const broadCodeqlSelector = workflow.slice(
      workflow.indexOf(".github/codeql/*|.github/workflows/codeql-critical-quality.yml"),
      workflow.indexOf("src/**/*.test.ts|src/**/*.test.tsx"),
    );

    expect(broadCodeqlSelector).not.toContain("network_runtime=true");
    expect(networkSelector).toContain(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
    );
    expect(networkSelector).not.toContain("src/*.ts|src/**/*.ts");
    expect(networkSelector).not.toContain("extensions/*.ts|extensions/**/*.ts");
    expect(networkSelector).toContain("src/infra/net/*");
    expect(networkSelector).toContain("src/infra/ssh-tunnel.ts");
    expect(networkSelector).toContain("packages/net-policy/src/*");
    expect(networkConfig).not.toContain("\n  - src\n");
    expect(networkConfig).not.toContain("\n  - extensions\n");
    expect(networkConfig).toContain("\n  - src/infra/net\n");
    expect(networkConfig).toContain("\n  - packages/net-policy/src\n");
    expectIncludes(workflow, [
      "Fast PR network boundary diff scan",
      '| select(.filename | test("(^|/)[^/]+\\\\.(?:e2e\\\\.)?test\\\\.tsx?$") | not)',
      "Network runtime boundary-sensitive added lines",
      'codex_transport="extensions/codex/src/app-server/transport-websocket.ts"',
      "network_codeql_contract_pattern='^\\.github/codeql/(codeql-network-runtime-boundary-critical-quality\\.yml|openclaw-boundary/queries/(raw-socket-callsite-classification|managed-proxy-runtime-mutation)\\.ql)$'",
      'if grep -Eq "$network_codeql_contract_pattern" "$changed_files" ||',
    ]);
    expect(workflow).not.toContain('grep -Fv "$codex_transport: " "$added_lines"');
    expect(workflow).toContain("packages/net-policy/src/");
    expect(workflow).toContain(
      "grep -En 'HTTP_PROXY|HTTPS_PROXY|NO_PROXY|GLOBAL_AGENT_|OPENCLAW_PROXY_' \"$added_lines\"",
    );
    expect(workflow).toContain('echo "full_codeql=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "if: ${{ github.event_name != 'pull_request' || steps.network-diff-scan.outputs.full_codeql == 'true' }}",
    );
    expect(rawSocketQuery).toMatch(
      /allowedOwnerScope\(\s*call\s*,\s*"extensions\/codex\/src\/app-server\/transport-websocket\.ts"\s*,\s*"connectCodexAppServerUnixSocket"\s*\)/,
    );
    expect(rawSocketQuery).not.toContain(
      'call.getFile().getRelativePath() = "extensions/codex/src/app-server/transport-websocket.ts"',
    );
  });

  it("keeps the Crabbox gate publisher on protected main with minimal permissions", () => {
    const workflow = readWorkflow(".github/workflows/pr-crabbox-gate-publisher.yml");
    const publisher = readFileSync("scripts/pr-crabbox-gate-publisher.mjs", "utf8");
    const job = workflow.jobs.publish;
    expect(workflow.permissions).toEqual({});
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(evaluateWorkflowRunner(job["runs-on"])).toBe("ubuntu-24.04");
    expect(job.environment).toBe("qa-live-shared");
    expect(job["timeout-minutes"]).toBe(270);
    expect(job.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(job.steps[0]).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        "fetch-depth": 0,
        "persist-credentials": false,
        ref: "${{ github.workflow_sha }}",
      },
    });
    expect(job.steps.at(-1)).toMatchObject({
      env: {
        CRABBOX_ACCESS_CLIENT_ID: "${{ secrets.CRABBOX_ACCESS_CLIENT_ID }}",
        CRABBOX_ACCESS_CLIENT_SECRET: "${{ secrets.CRABBOX_ACCESS_CLIENT_SECRET }}",
        CRABBOX_COORDINATOR:
          "${{ secrets.CRABBOX_COORDINATOR || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR }}",
        CRABBOX_COORDINATOR_TOKEN:
          "${{ secrets.CRABBOX_COORDINATOR_TOKEN || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN }}",
        GH_APP_TOKEN:
          "${{ steps.publish-app-token.outputs.token || steps.publish-app-token-fallback.outputs.token }}",
        GH_TOKEN: "${{ github.token }}",
      },
      run: "node scripts/pr-crabbox-gate-publisher.mjs --publish",
    });
    expect(job.steps[2].run).toContain("crabbox_0.77.0_linux_amd64.tar.gz");
    expect(job.steps[2].run).toContain(
      "cbf6cb74251a454c65d13d7a92b070cf8c37ee81c300c97123063b9d21206d5f",
    );
    expect(job.steps.slice(3, 5)).toMatchObject([
      {
        id: "app-token",
        uses: CREATE_GITHUB_APP_TOKEN_V3_3,
        with: { "app-id": "2729701", "permission-members": "read" },
      },
      {
        id: "app-token-fallback",
        uses: CREATE_GITHUB_APP_TOKEN_V3_3,
        with: { "app-id": "2971289", "permission-members": "read" },
      },
    ]);
    expect(publisher).toContain("const CHECK_NAME = CRABBOX_GATE_CHECK_NAME");
    expect(readFileSync("scripts/pr-lib/crabbox-gate-contract.mjs", "utf8")).toContain(
      'CRABBOX_GATE_CHECK_NAME = "openclaw/crabbox-gate"',
    );
    expect(publisher).not.toContain('const CHECK_NAME = "openclaw/ci-gate"');
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted()).toEqual([
      "base_sha",
      "head_sha",
      "pr_number",
    ]);
  });
});

function expectProcessExit<
  T extends { status: number | null; stdout: string | Buffer; stderr: string | Buffer },
>(result: T, code = 0): T {
  expect(result.status, `${result.stdout.toString()}${result.stderr.toString()}`).toBe(code);
  return result;
}

it("pins generated publisher and maturity owners before credentials and selected checkout", () => {
  const pinned = {
    name: "Prepare Git owner",
    uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
  };
  const action = readWorkflow(PUBLISH_GENERATED_PR_ACTION);
  expect(action.runs.steps.map(({ name }: WorkflowStep) => name)).toEqual([
    "Prepare Git owner",
    "Create generated PR tokens",
    "Publish generated pull request",
  ]);
  expect(action.runs.steps[0]).toEqual(pinned);
  const steps: WorkflowStep[] = readMaturityScorecardWorkflow().jobs.validate_selected_ref.steps;
  const checkout = steps.findIndex(({ name }) => name === "Checkout selected ref");
  expect(steps[checkout - 1]).toEqual(pinned);
  expect(steps[checkout + 1]?.name).toBe("Validate selected ref");
  const policy = expectDefined(steps[checkout + 1]?.run, "validation body");
  expect(policy).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
  expect(policy.match(/timeout=\d+/gu)).toEqual(["timeout=60"]);
  expect(policy).not.toMatch(
    /timeout --|(?:^|\s)git (?:fetch|ls-remote|rev-parse|diff|tag|merge-base|check-ref-format)\b|except (?:Exception|BaseException|RuntimeError|SystemExit)|backoff\(/mu,
  );
  for (const file of [
    CONTROL_UI_LOCALE_REFRESH_WORKFLOW,
    NATIVE_APP_LOCALE_REFRESH_WORKFLOW,
    ".github/workflows/ci-test-timings-refit.yml",
    MATURITY_SCORECARD_WORKFLOW,
  ]) {
    const workflow = readWorkflow(file);
    const publishers = Object.values(workflow.jobs).flatMap((job) => {
      const jobSteps = (job as { steps?: WorkflowStep[] }).steps ?? [];
      return jobSteps.flatMap((step, index) =>
        step.uses === "./.github/actions/publish-generated-pr"
          ? [{ index, length: jobSteps.length }]
          : [],
      );
    });
    expect(publishers, file).toHaveLength(1);
    expect(publishers[0]?.index, file).toBe(publishers[0]!.length - 1);
  }
});

it.each(["publish", "promote"])(
  "requests independent Linux publication after stable %s activation",
  (owner) => {
    const workflow = readWorkflow(`.github/workflows/openclaw-release-${owner}.yml`);
    const job = workflow.jobs.publish_linux;
    expect(job, "stable publication must request the Linux release owner").toBeDefined();
    expect(job["continue-on-error"]).toBe(true);
    for (const [tag, channel, activation, expected] of [
      ["v2026.9.4", "latest", "success", true],
      ["v2026.9.4", "beta", "success", true],
      ["v2026.9.4-beta.1", "beta", "success", false],
      ["v2026.8.33", "extended-stable", "success", false],
      ["v2026.9.4", "latest", "failure", false],
      ["v2026.9.4", "latest", "skipped", false],
    ]) {
      const admitted = runInNewContext(job.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        cancelled: () => false,
        contains: (value: string, part: string) => value.includes(part),
        inputs: { tag, npm_dist_tag: channel },
        needs: {
          publish: {
            result: "success",
            outputs: { release_tag: tag, npm_dist_tag: channel },
          },
          finalize: { result: activation },
          finalize_github_release: { result: activation },
        },
      });
      expect(admitted, `${owner}: ${tag}/${channel}/${activation}`).toBe(expected);
    }
    const dispatch = (job.steps as WorkflowStep[]).find(
      ({ name }) => name === "Dispatch detached Linux release request",
    );
    expect(dispatch?.run).toContain("dispatch_linux_release_assets");
    const finalize = workflow.jobs[owner === "publish" ? "finalize_github_release" : "finalize"];
    expect(finalize.needs).not.toContain("publish_linux");
    const approvalId = owner === "publish" ? "approve_github_release" : "approve_activation";
    expect(workflow.jobs[approvalId].environment).toBe("npm-release");
    expect(workflow.jobs[approvalId].permissions).toEqual({});
    expect(workflow.jobs[approvalId].concurrency).toBeUndefined();
    expect(finalize.environment).toBeUndefined();
    expect(finalize.needs).toContain(approvalId);
    for (const result of ["success", "failure", "skipped", "cancelled"]) {
      expect(
        runInNewContext(finalize.if.replace(/^\$\{\{|\}\}$/gu, ""), {
          always: () => true,
          contains: (value: string, part: string) => value.includes(part),
          inputs: {
            tag: "v2026.9.4",
            prepared_plugins: "",
            publish_openclaw_npm: true,
            finalize_release_before_docker: false,
          },
          needs: {
            publish: { result: "success" },
            publish_docker: { result: "success" },
            finalize_github_release_before_docker: { result: "skipped" },
            verify: { result: "success" },
            [approvalId]: { result },
          },
        }),
      ).toBe(result === "success");
    }
    const activationCommand =
      owner === "publish" ? "linux-app-channel.mjs finalize-core" : "gh release edit";
    const activation = (finalize.steps as WorkflowStep[]).find(({ run }) =>
      run?.includes(activationCommand),
    )?.run;
    expect(activation).toContain("node scripts/linux-updater-manifest.mjs carry");
    expect(activation?.indexOf("linux-updater-manifest.mjs carry")).toBeLessThan(
      activation?.indexOf(activationCommand) ?? -1,
    );
  },
);

it("serializes Linux manifests with stable activation and reuses completed Linux builds", () => {
  const linux = readWorkflow(".github/workflows/linux-app-release.yml");
  const finalizers = (
    [
      ["openclaw-release-publish.yml", "finalize_github_release"],
      ["openclaw-release-promote.yml", "finalize"],
    ] as const
  ).map(([file, job]) => readWorkflow(`.github/workflows/${file}`).jobs[job]);
  const mirror = readWorkflow(".github/workflows/linux-app-mirror.yml");
  for (const job of [...finalizers, linux.jobs.publish, mirror.jobs.mirror_legacy]) {
    expect(job.concurrency).toEqual({
      group: "linux-app-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
  }
  expect(linux.concurrency["cancel-in-progress"]).toBe(false);
  expect(linux.concurrency.queue).toBe("max");
  expect(linux.concurrency.group).not.toBe(linux.jobs.publish.concurrency.group);
  for (const alreadyPublished of ["true", "false"]) {
    expect(
      runInNewContext(linux.jobs.build_linux.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        needs: { validate_release: { outputs: { already_published: alreadyPublished } } },
      }),
    ).toBe(alreadyPublished !== "true");
  }
  // Windows companion publication is temporarily off; see WINDOWS_COMPANION_RELEASE.
  expect(linux.env.WINDOWS_COMPANION_RELEASE).toBe("false");
  for (const [alreadyPublished, windowsBuild, expected] of [
    ["true", "true", false],
    ["false", "false", false],
    ["false", "true", true],
  ]) {
    expect(
      runInNewContext(linux.jobs.build_windows.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        needs: {
          validate_release: {
            outputs: { already_published: alreadyPublished, windows_build: windowsBuild },
          },
        },
      }),
    ).toBe(expected);
  }
  for (const [alreadyPublished, windowsBuild, linuxResult, windowsResult, expected] of [
    ["true", "false", "skipped", "skipped", true],
    ["false", "true", "success", "success", true],
    ["false", "true", "success", "failure", false],
    ["false", "true", "success", "skipped", false],
    ["false", "false", "success", "skipped", true],
    ["false", "false", "failure", "skipped", false],
    ["false", "false", "skipped", "skipped", false],
  ]) {
    expect(
      runInNewContext(linux.jobs.publish.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        always: () => true,
        needs: {
          validate_release: {
            outputs: {
              already_published: alreadyPublished,
              desktop_test_bundles: "false",
              windows_build: windowsBuild,
            },
          },
          build_linux: { result: linuxResult },
          sign_linux: { result: linuxResult },
          build_windows: { result: windowsResult },
          sign_desktop: { result: windowsResult },
        },
      }),
    ).toBe(expected);
  }
  const steps = linux.jobs.publish.steps as WorkflowStep[];
  for (const name of [
    "Download Debian bundle",
    "Download signed AppImage",
    "Assemble release assets and updater manifest",
  ]) {
    const condition = expectDefined(requiredWorkflowStep(steps, name).if, name);
    expect(
      runInNewContext(condition.replace(/^\$\{\{|\}\}$/gu, ""), {
        needs: { validate_release: { outputs: { already_published: "true" } } },
      }),
    ).toBe(false);
  }
  const publisher = requiredWorkflowStep(
    steps,
    "Publish immutable bundles, canonical Linux channel, and legacy mirror",
  );
  expect(publisher.if).toBeUndefined();
  expect(publisher.run).toContain("linux-app-channel.mjs publish");
  expect(publisher.run).toContain("input_args=()");
  expect(publisher.run).toContain('"${input_args[@]}"');
  expect(publisher.run).toContain("--request-run-id");
  expect(JSON.stringify(steps)).not.toContain("linux-updater-manifest.mjs publish");
  expect(JSON.stringify(steps)).not.toContain("--clobber");
});

it("hands this run's signed Linux inputs to the publisher when bundles are already public", () => {
  const steps = readWorkflow(".github/workflows/linux-app-release.yml").jobs.publish
    .steps as WorkflowStep[];
  const publisher = requiredWorkflowStep(
    steps,
    "Publish immutable bundles, canonical Linux channel, and legacy mirror",
  );
  const localInputs = publisher.env?.LOCAL_INPUTS;
  if (typeof localInputs !== "string") {
    throw new Error("Linux publisher must select its local inputs from validate_release");
  }
  // The Ubuntu runner's Bash expands an empty array under `set -u`; macOS /bin/bash 3.2 does not.
  const bash = expectDefined(
    ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(
      (binary) =>
        existsSync(binary) &&
        spawnSync(binary, ["--noprofile", "--norc", "-c", "((BASH_VERSINFO[0] >= 5))"]).status ===
          0,
    ),
    "Bash 5 (on macOS: brew install bash)",
  );
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-linux-publisher-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const calls = path.join(root, "publish-args");
    writeFileSync(
      path.join(bin, "node"),
      `#!/bin/bash
if [[ "$1" == scripts/linux-updater-manifest.mjs ]]; then
  printf '%s\\n' "$FIXTURE_STATUS"
else
  printf '%s\\n' "$@" > "$FIXTURE_CALLS"
fi
`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$TAG_SHA"\n', {
      mode: 0o755,
    });
    // Drain the checksum pipe so the publisher's printf cannot fail with SIGPIPE under pipefail.
    writeFileSync(path.join(bin, "sha256sum"), "#!/bin/sh\ncat > /dev/null\n", { mode: 0o755 });
    const run = (alreadyPublished: string, status: object, desktop = "false") => {
      rmSync(calls, { force: true });
      const result = spawnSync(bash, ["--noprofile", "--norc", "-c", publisher.run ?? ""], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          FIXTURE_CALLS: calls,
          FIXTURE_STATUS: JSON.stringify(status),
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_STEP_SUMMARY: devNull,
          RUNNER_TEMP: root,
          RELEASE_TAG: "v2026.10.3",
          TAG_SHA: "a".repeat(40),
          WORKFLOW_SHA: "b".repeat(40),
          WORKFLOW_REF: "main",
          WORKFLOW_FULL_REF: "refs/heads/main",
          REQUEST_RUN_ID: "43",
          REQUEST_RUN_ATTEMPT: "1",
          MINISIGN_BINARY_SHA256: "c".repeat(64),
          DESKTOP_TEST_BUNDLES: desktop,
          WINDOWS_COMPANION_RELEASE: "false",
          LOCAL_INPUTS: String(
            runInNewContext(localInputs.replace(/^\$\{\{|\}\}$/gu, ""), {
              needs: { validate_release: { outputs: { already_published: alreadyPublished } } },
            }),
          ),
        },
      });
      return {
        status: result.status,
        stderr: result.stderr,
        args: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : undefined,
      };
    };
    const complete = { state: "published", assetsComplete: true };
    const localArgs = [
      "--assets",
      "dist/release",
      "--signature",
      "dist/input/linux/signatures/OpenClaw-2026.10.3-amd64.AppImage.sig",
    ];
    // An interrupted publication leaves complete public bundles while the
    // run's signed Windows manifest exists only in its local inputs.
    const resumed = run("false", complete);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.args?.join(" ")).toContain(localArgs.join(" "));
    const reused = run("true", complete);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.args).not.toContain("--assets");
    const fresh = run("false", { state: "pending", assetsComplete: false });
    expect(fresh.args?.join(" ")).toContain(localArgs.join(" "));
    expect(fresh.args?.join(" ")).toContain("--windows false");
    const desktop = run("false", complete, "true");
    expect(desktop.status).toBe(1);
    expect(desktop.args).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("assembles a Linux-only release without Windows companion inputs", () => {
  const assemble = requiredWorkflowStep(
    readWorkflow(".github/workflows/linux-app-release.yml").jobs.publish.steps,
    "Assemble release assets and updater manifest",
  );
  const root = tempDirs.make("openclaw-linux-assemble-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  // Linux-only assembly must not read release metadata for desktop manifests.
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const linuxInputs = path.join(root, "dist/input/linux/release");
  mkdirSync(linuxInputs, { recursive: true });
  writeFileSync(path.join(linuxInputs, "OpenClaw-2026.10.5-amd64.AppImage"), "appimage");
  writeFileSync(path.join(linuxInputs, "OpenClaw-2026.10.5-amd64.deb"), "deb");
  const result = spawnSync("bash", ["-c", assemble.run ?? ""], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      RUNNER_TEMP: root,
      RELEASE_TAG: "v2026.10.5",
      DESKTOP_TEST_BUNDLES: "false",
      WINDOWS_BUILD: "false",
      WINDOWS_COMPANION_RELEASE: "false",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(path.join(root, "dist/release")).toSorted()).toEqual([
    "OpenClaw-2026.10.5-amd64.AppImage",
    "OpenClaw-2026.10.5-amd64.deb",
    "SHA256SUMS.linux-app.txt",
  ]);
});

it("detaches Linux mirror-only writers from both completed core finalizers", () => {
  const linux = readWorkflow(".github/workflows/linux-app-release.yml");
  expect(Object.keys(linux.on)).toEqual(["workflow_run"]);
  const mirror = readWorkflow(".github/workflows/linux-app-mirror.yml");
  expect(Object.keys(mirror.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(mirror.jobs)).toEqual(["mirror_legacy"]);
  for (const event_name of ["push", "pull_request", "workflow_run", "workflow_dispatch"]) {
    expect(
      runInNewContext(mirror.jobs.mirror_legacy.if.slice(3, -2), {
        github: { repository: "openclaw/openclaw", event_name },
      }),
    ).toBe(event_name === "workflow_dispatch");
  }
  expect(linux.on.push).toBeUndefined();
  expect(linux.on.pull_request).toBeUndefined();
  const mirrorSteps = mirror.jobs.mirror_legacy.steps as WorkflowStep[];
  expect(JSON.stringify(mirrorSteps)).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  expect(JSON.stringify(mirrorSteps)).not.toContain("linux-app-channel.mjs publish");
  expect(JSON.stringify(mirrorSteps)).not.toContain("cargo");
  const admission = requiredWorkflowStep(mirrorSteps, "Verify detached mirror dispatch identity");
  expect(admission.run).toContain("refs/tags/release-publish/*");
  expect(admission.run).toContain('"$EXPECTED_TOOLING_SHA" == "$WORKFLOW_SHA"');
  expect(admission.run).toContain("--release-publish-parent-state-policy active-or-success");
  for (const [file, finalizer] of [
    ["openclaw-release-publish.yml", "finalize_github_release"],
    ["openclaw-release-promote.yml", "finalize"],
  ] as const) {
    const workflow = readWorkflow(`.github/workflows/${file}`);
    const dispatch = workflow.jobs.dispatch_linux_mirror;
    expect(dispatch.needs).toContain(finalizer);
    expect(dispatch["continue-on-error"]).toBe(true);
    expect(dispatch["timeout-minutes"]).toBe(5);
    expect(dispatch.concurrency).toBeUndefined();
    expect(workflow.jobs[finalizer].needs).not.toContain("dispatch_linux_mirror");
    const dispatchStep = requiredWorkflowStep(dispatch.steps, "Dispatch detached Linux mirror");
    expect(dispatchStep.run).toContain("dispatch_linux_mirror");
    expect(dispatchStep.run).not.toMatch(/\b(?:watch|sleep|until|while)\b/u);
  }
  const prepared = readWorkflow(".github/workflows/openclaw-release-promote.yml");
  const preparedDispatch = JSON.stringify(prepared.jobs.dispatch_linux_mirror);
  expect(preparedDispatch).toContain(".releaseRunId");
  expect(preparedDispatch).toContain(".releaseRunAttempt");
  expect(preparedDispatch).toContain(".tooling.fullRef");
  expect(preparedDispatch).not.toContain("$GITHUB_RUN_ID");
  const directory = tempDirs.make("openclaw-linux-mirror-dispatch-");
  const toolingSha = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  const toolingRef = `release-publish/${toolingSha.slice(0, 12)}-123`;
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source scripts/lib/release-publish-children.sh
       verify_release_tag_target() { return 0; }
       node() { return 0; }
       dispatch_workflow_at_ref() {
         printf '%s\\n' "$@" > "$RUNNER_TEMP/dispatch-args"
         printf '456\\n'
       }
       dispatch_linux_mirror "$GITHUB_REF_NAME" "$GITHUB_REF" "$PARENT_WORKFLOW_SHA" 123 2`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_REF_NAME: toolingRef,
        GITHUB_REF: `refs/tags/${toolingRef}`,
        PARENT_WORKFLOW_SHA: toolingSha,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
        RUNNER_TEMP: directory,
        RELEASE_TAG: "v2026.8.2",
        TARGET_SHA: sourceSha,
      },
    },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(readFileSync(path.join(directory, "dispatch-args"), "utf8").trim().split("\n")).toEqual([
    toolingRef,
    toolingSha,
    "linux-app-mirror.yml",
    "-f",
    "release_tag=v2026.8.2",
    "-f",
    `source_sha=${sourceSha}`,
    "-f",
    `tooling_sha=${toolingSha}`,
    "-f",
    "release_publish_run_id=123",
    "-f",
    "release_publish_run_attempt=2",
  ]);
  expect(
    JSON.parse(readFileSync(path.join(directory, "linux-mirror-dispatch.json"), "utf8")),
  ).toEqual({
    tag: "v2026.8.2",
    sourceSha,
    state: "dispatched",
    mirrorVerified: false,
    childRunId: "456",
  });
});

it("reports stale Linux release requests before selected code runs", () => {
  const workflow = readWorkflow(".github/workflows/linux-app-release.yml");
  const job = workflow.jobs.validate_release;
  const requestStep = expectDefined((job.steps as WorkflowStep[])[0], "first request validation");
  const requestSha = "a".repeat(40);
  const requestRun = {
    repository: { full_name: "openclaw/openclaw" },
    event: "workflow_dispatch",
    name: "Linux App Release Request [v2026.8.2] desktop=false",
    path: ".github/workflows/linux-app-release-request.yml",
    head_branch: "main",
    head_sha: requestSha,
    conclusion: "success",
  };
  const github = {
    repository: "openclaw/openclaw",
    event_name: "workflow_run",
    workflow_sha: requestSha,
    event: { workflow_run: requestRun },
  };
  const admitted = (context: typeof github) => runInNewContext(job.if, { github: context });
  expect(admitted({ ...github, repository: "untrusted/openclaw" })).toBe(false);
  for (const changedRun of [
    { repository: { full_name: "untrusted/openclaw" } },
    { event: "push" },
    { path: ".github/workflows/another-workflow.yml" },
    { head_branch: "topic" },
    { conclusion: "failure" },
  ]) {
    expect(admitted({ ...github, event: { workflow_run: { ...requestRun, ...changedRun } } })).toBe(
      false,
    );
  }
  for (const workflowSha of ["b".repeat(40), requestSha]) {
    expect(admitted({ ...github, workflow_sha: workflowSha })).toBe(true);
    expect(requestStep.name).toBe("Validate trusted release request");
    const output = path.join(tempDirs.make("openclaw-linux-request-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", expectDefined(requestStep.run, "request validation")], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        REQUEST_TITLE: "Linux App Release Request [v2026.8.2] desktop=false",
        REQUEST_HEAD_SHA: requestSha,
        WORKFLOW_SHA: workflowSha,
      },
    });
    const matching = workflowSha === requestSha;
    expectProcessExit(result, matching ? 0 : 1);
    expect(readFileSync(output, "utf8")).toBe(
      matching ? "release_tag=v2026.8.2\ndesktop_test_bundles=false\n" : "",
    );
    if (!matching) {
      expect(`${result.stdout}${result.stderr}`).toContain(
        "::error::Main advanced after this Linux release request. Dispatch a new Linux App Release Request",
      );
    }
  }
});

it.each(["success", "failure"])(
  "records the exact Linux request and builder admission (%s)",
  (status) => {
    const workflow = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
    const step = (workflow.jobs.validate_release.steps as WorkflowStep[]).find(
      ({ name }) => name === "Record Linux builder admission",
    );
    const directory = tempDirs.make("openclaw-linux-admission-");
    const summary = path.join(directory, "summary");
    const result = spawnSync("bash", ["-c", expectDefined(step?.run, "admission owner")], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: directory,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "456",
        GITHUB_RUN_ATTEMPT: "2",
        REQUEST_RUN_ID: "123",
        REQUEST_RUN_ATTEMPT: "1",
        REQUEST_HEAD_SHA: "a".repeat(40),
        WORKFLOW_SHA: "a".repeat(40),
        RELEASE_TAG: status === "success" ? "v2026.8.2" : "",
        TAG_SHA: status === "success" ? "b".repeat(40) : "",
        ADMISSION_STATUS: status,
      },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(directory, "linux-release-admission.json"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      repository: "openclaw/openclaw",
      request: { runId: "123", runAttempt: "1", headSha: "a".repeat(40) },
      builder: { runId: "456", runAttempt: "2", toolingSha: "a".repeat(40) },
      tag: status === "success" ? "v2026.8.2" : null,
      sourceSha: status === "success" ? "b".repeat(40) : null,
      admission: status === "success" ? "admitted" : "rejected",
    });
  },
);

it("retains exact completed Linux bundle bytes after packaging fails without admitting signing", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
  const steps = workflow.jobs.build_linux.steps as WorkflowStep[];
  const step = steps.find(({ name }) => name === "Retain completed unqualified Linux bundles");
  const directory = tempDirs.make("openclaw-linux-unqualified-");
  const runner = path.join(directory, "runner");
  mkdirSync(runner);
  for (const [kind, filename, bytes] of [
    ["deb", "OpenClaw.deb", "completed deb bytes"],
    ["appimage", "OpenClaw.AppImage", "completed appimage bytes"],
  ] as const) {
    const bundleDirectory = path.join(
      directory,
      "apps/linux/src-tauri/target/release/bundle",
      kind,
    );
    mkdirSync(bundleDirectory, { recursive: true });
    writeFileSync(path.join(bundleDirectory, filename), bytes);
  }
  const result = spawnSync("bash", ["-c", expectDefined(step?.run, "diagnostic retention")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: runner,
      GITHUB_STEP_SUMMARY: path.join(runner, "summary"),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      RELEASE_TAG: "v2026.8.2",
      TAG_SHA: "b".repeat(40),
      WORKFLOW_SHA: "a".repeat(40),
      FINALIZE_OUTCOME: "success",
      STAGING_OUTCOME: "success",
      RUNTIME_OUTCOME: "failure",
    },
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const retained = path.join(runner, "linux-unqualified-bundles");
  expect(readFileSync(path.join(retained, "bundles/OpenClaw.deb"), "utf8")).toBe(
    "completed deb bytes",
  );
  expect(readFileSync(path.join(retained, "bundles/OpenClaw.AppImage"), "utf8")).toBe(
    "completed appimage bytes",
  );
  expect(JSON.parse(readFileSync(path.join(retained, "identity.json"), "utf8"))).toMatchObject({
    qualification: "unqualified",
    sourceSha: "b".repeat(40),
    toolingSha: "a".repeat(40),
    runId: "456",
    runAttempt: "1",
    checks: { packagedRuntime: "failure" },
  });
  const hashes = spawnSync("sha256sum", ["--check", "SHA256SUMS"], {
    cwd: retained,
    encoding: "utf8",
  });
  expect(hashes.status, hashes.stderr).toBe(0);
  // Model the Actions failure boundary: normal uploads skip, and failed build
  // blocks the signing dependency. Diagnostic retention has no promoted outputs.
  const context = {
    eventName: "workflow_run" as const,
    repository: "openclaw/openclaw",
    runAttempt: 1,
    failed: true,
    steps: { "bundle-build": { outcome: "success" as const, outputs: {} } },
  };
  expect(evaluateWorkflowExpression(expectDefined(step?.if, "retention condition"), context)).toBe(
    true,
  );
  for (const name of ["Upload Debian bundle", "Upload finalized unsigned AppImage"]) {
    expect(steps.find((entry) => entry.name === name)?.if).toBeUndefined();
  }
  expect(workflow.jobs.sign_linux.needs).toContain("build_linux");
  expect(workflow.jobs.sign_linux.if).toBeUndefined();
  expect(workflow.jobs.build_linux.outputs).not.toHaveProperty("unqualified_artifact_id");
});

it("isolates release credentials and verifies trusted AppImage and signing tools", () => {
  const pinned = {
    name: "Prepare Git owner",
    uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
  };
  for (const [file, job, checkoutName] of [
    ["linux-app-release.yml", "validate_release", "Checkout selected tag"],
    ["macos-release.yml", "validate_macos_release_request", "Checkout selected tag"],
    ["npm-placeholder-bootstrap.yml", "plan", "Checkout selected source"],
  ] as const) {
    const steps = readWorkflow(`.github/workflows/${file}`).jobs[job].steps as WorkflowStep[];
    const checkout = steps.findIndex(({ name }) => name === checkoutName);
    expect(steps[checkout - 1]).toEqual(pinned);
  }

  const request = readWorkflow(".github/workflows/linux-app-release-request.yml");
  const linux = readWorkflow(".github/workflows/linux-app-release.yml");
  expect(request.permissions).toEqual({});
  expect(request.jobs.validate_request.permissions).toBeUndefined();
  expect(JSON.stringify(request)).not.toContain("${{ secrets.");
  expect(linux.on.workflow_run).toEqual({
    workflows: ["Linux App Release Request"],
    branches: ["main"],
    types: ["completed"],
  });
  expect(linux.permissions).toEqual({});
  const tauriSigningEnvNames = [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_PRIVATE_KEY",
    "TAURI_PRIVATE_KEY_PATH",
    "TAURI_PRIVATE_KEY_PASSWORD",
    "TAURI_KEY_PASSWORD",
  ];
  const selectedTagJobs = ["validate_release", "build_linux", "build_macos", "build_windows"];
  for (const jobName of selectedTagJobs) {
    const job = linux.jobs[jobName];
    const checkout = expectDefined(
      (job.steps as WorkflowStep[]).find(({ name }) => name === "Checkout selected tag"),
      `${jobName} selected-tag checkout`,
    );
    expect(job.permissions, jobName).toEqual({ contents: "read" });
    expect(checkout.with?.["persist-credentials"], jobName).toBe(false);
    const jobJson = JSON.stringify(job);
    expect(jobJson, jobName).not.toContain("${{ secrets.");
    for (const envName of tauriSigningEnvNames) {
      expect(jobJson, jobName).not.toContain(envName);
    }
  }
  expect(
    Object.entries(linux.jobs)
      .filter(
        ([, job]) =>
          (job as { permissions?: { contents?: string } }).permissions?.contents === "write",
      )
      .map(([name]) => name),
  ).toEqual([]);
  expect(linux.jobs.publish.permissions).toEqual({ actions: "read", contents: "read" });
  expect(
    Object.entries(linux.jobs)
      .filter(([, job]) => JSON.stringify(job).includes("${{ secrets.TAURI_SIGNING_PRIVATE_KEY"))
      .map(([name]) => name),
  ).toEqual(["sign_linux", "sign_desktop"]);
  const linuxSteps = linux.jobs.validate_release.steps as WorkflowStep[];
  expect(requiredWorkflowStep(linuxSteps, "Checkout trusted release tooling").with).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: ".release-tooling",
    "persist-credentials": false,
    "sparse-checkout":
      "apps/linux/src-tauri/tauri.conf.json\nscripts/lib/record-shared.mjs\nscripts/release-tooling-identity.mjs\nscripts/linux-updater-manifest.mjs\nscripts/lib/release-version.mjs\n",
  });
  const tooling = requiredWorkflowStep(linuxSteps, "Verify trusted release tooling identity");
  expect(tooling?.env).toMatchObject({
    WORKFLOW_FULL_REF: "${{ github.ref }}",
    WORKFLOW_REF: "${{ github.ref_name }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  });
  expect(tooling?.run).toContain(
    "node .release-tooling/scripts/release-tooling-identity.mjs verify",
  );
  expect(tooling?.run).not.toContain("--allow-prevalidated-ref");
  expect(linuxSteps.indexOf(tooling!)).toBeLessThan(
    linuxSteps.findIndex(({ id }) => id === "ancestry"),
  );
  const releaseRequest = expectDefined(
    linuxSteps.find(({ id }) => id === "request"),
    "trusted release request validation",
  );
  expect(releaseRequest.env).toEqual({
    REQUEST_TITLE: "${{ github.event.workflow_run.display_title }}",
    REQUEST_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  });
  const requestRoot = tempDirs.make("openclaw-linux-release-request-");
  const requestOutput = path.join(requestRoot, "output");
  const runReleaseRequest = (title: string) =>
    spawnSync("bash", ["-c", releaseRequest.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: requestOutput,
        REQUEST_TITLE: title,
        REQUEST_HEAD_SHA: "a".repeat(40),
        WORKFLOW_SHA: "a".repeat(40),
      },
    });
  const acceptedRequest = runReleaseRequest("Linux App Release Request [v2026.8.2] desktop=true");
  expectProcessExit(acceptedRequest);
  expect(readFileSync(requestOutput, "utf8")).toBe(
    "release_tag=v2026.8.2\ndesktop_test_bundles=true\n",
  );
  const rejectedRequest = runReleaseRequest(
    "Linux App Release Request [v2026.8.2] desktop=true extra",
  );
  expect(rejectedRequest.status).toBe(1);
  const updaterTrust = expectDefined(
    linuxSteps.find(({ id }) => id === "updater_trust"),
    "updater trust-root validation",
  );
  expect(updaterTrust.run).toContain("selected_config=apps/linux/src-tauri/tauri.conf.json");
  expect(updaterTrust.run).toContain(
    "trusted_config=.release-tooling/apps/linux/src-tauri/tauri.conf.json",
  );
  expect(updaterTrust.run).toContain('-L "$selected_config"');
  expect(updaterTrust.run).toContain('-L "$trusted_config"');
  expect(updaterTrust.run).toContain('"$selected_pubkey" != "$trusted_pubkey"');
  expect(updaterTrust.run).toContain('echo "updater_pubkey=$trusted_pubkey" >> "$GITHUB_OUTPUT"');
  for (const jobName of ["build_linux", "build_macos", "build_windows"]) {
    const steps = linux.jobs[jobName].steps as WorkflowStep[];
    const checkoutIndex = steps.findIndex(({ name }) => name === "Checkout selected tag");
    expect(steps[checkoutIndex]?.with?.ref).toBe("${{ needs.validate_release.outputs.tag_sha }}");
    expect(checkoutIndex, `${jobName} selected checkout order`).toBeGreaterThan(0);
    expect(
      steps.slice(0, checkoutIndex).some(({ uses }) => uses?.startsWith("./")),
      `${jobName} pre-checkout local action`,
    ).toBe(false);
    expect(
      steps.slice(checkoutIndex + 1).some(({ uses }) => uses?.startsWith("./")),
      `${jobName} selected-tag local action`,
    ).toBe(false);
    expect(JSON.stringify(steps), `${jobName} Actions cache usage`).not.toContain("actions/cache");
  }
  const linuxBuildSteps = linux.jobs.build_linux.steps as WorkflowStep[];
  const selectedTagCheckout = linuxBuildSteps.findIndex(
    ({ name }) => name === "Checkout selected tag",
  );
  const trustedToolingCheckout = linuxBuildSteps.findIndex(
    ({ name }) => name === "Checkout trusted Linux packaging tooling",
  );
  const selectedTagInstall = linuxBuildSteps.findIndex(
    ({ name }) => name === "Install selected-tag dependencies",
  );
  expect(selectedTagCheckout).toBeGreaterThan(0);
  expect(selectedTagInstall).toBeGreaterThan(selectedTagCheckout);
  expect(trustedToolingCheckout).toBe(selectedTagInstall + 1);
  const trustedToolingOptions = linuxBuildSteps[trustedToolingCheckout]?.with;
  expect(trustedToolingOptions).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: ".release-tooling",
    "fetch-depth": 1,
    "persist-credentials": false,
    "sparse-checkout-cone-mode": false,
  });
  const trustedToolingFiles = [
    "apps/linux/scripts/stage-appimage-gstreamer.sh",
    "apps/linux/scripts/tauri-appimage-tools.sh",
    "apps/linux/scripts/tauri-appimage-tools-x86_64.tsv",
    "apps/linux/scripts/finalize-appimage.sh",
    "apps/linux/tests/packaged_runtime_smoke.py",
    "apps/linux/tests/first_run.py",
  ];
  expect(String(trustedToolingOptions?.["sparse-checkout"]).trim().split("\n")).toEqual(
    trustedToolingFiles,
  );
  const finalizeAppImage = requiredWorkflowStep(linuxBuildSteps, "Finalize AppImage");
  for (const name of tauriSigningEnvNames) {
    expect(finalizeAppImage.env ?? {}).not.toHaveProperty(name);
  }
  expect(finalizeAppImage.run).not.toContain("signer sign");
  expect(linuxBuildSteps.find(({ name }) => name === "Sign finalized AppImage")).toBeUndefined();
  const signingJob = linux.jobs.sign_linux;
  const signingSteps = signingJob.steps as WorkflowStep[];
  expect(requiredWorkflowStep(signingSteps, "Download finalized unsigned AppImage").with).toEqual({
    "artifact-ids": "${{ needs.build_linux.outputs.unsigned_appimage_artifact_id }}",
    path: "dist/signing-input",
  });
  const signAppImage = requiredWorkflowStep(signingSteps, "Sign finalized AppImage");
  const signingToolsInstaller = requiredWorkflowStep(signingSteps, "Install trusted signing tools");
  expect(signingToolsInstaller.run?.match(/--proto '=https' --tlsv1\.2/gu)).toHaveLength(2);
  expect(signingToolsInstaller.run?.match(/--connect-timeout 10 --max-time 120/gu)).toHaveLength(2);
  expectIncludes(signingToolsInstaller.run, [
    '--output "$minisign_archive" "$MINISIGN_URL"',
    'printf \'%s  %s\\n\' "$MINISIGN_ARCHIVE_SHA256" "$minisign_archive" | sha256sum --check -',
    'tar -xzf "$minisign_archive" -C "${RUNNER_TEMP}/bin" --strip-components=2 \\\n  minisign-linux/x86_64/minisign',
    'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign" |',
    'printf \'%s  %s\\n\' "$TAURI_CLI_ARCHIVE_SHA256" "$tauri_archive" | sha256sum --check -',
    '--output "$tauri_archive" "$TAURI_CLI_URL"',
    'tar -xzf "$tauri_archive" -C "${RUNNER_TEMP}/bin" cargo-tauri',
    'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri" |',
    'chmod 0555 "${RUNNER_TEMP}/bin/cargo-tauri" "${RUNNER_TEMP}/bin/minisign"',
    '"${RUNNER_TEMP}/bin/cargo-tauri" --version',
    '"${RUNNER_TEMP}/bin/minisign" -v',
  ]);
  expect(signingToolsInstaller.run).not.toMatch(
    /apt-get|GITHUB_PATH|(?:^|\n)\s*(?:export\s+)?PATH=/u,
  );
  for (const [jobName, job] of Object.entries(linux.jobs)) {
    if (jobName === "sign_linux" || jobName === "sign_desktop") {
      continue;
    }
    expect(JSON.stringify(job), `${jobName} must not reference signer binaries`).not.toMatch(
      /\$\{RUNNER_TEMP\}\/bin\/(?:cargo-tauri|minisign)/u,
    );
  }
  const windowsSigner = linux.jobs.sign_windows;
  expect(windowsSigner.environment).toBe("release-signing");
  expect(windowsSigner.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(JSON.stringify(windowsSigner)).not.toContain("actions/checkout");
  const azureSigning = windowsSigner.steps.find(
    (step: WorkflowStep) => step.name === "Sign Windows installer",
  );
  expect(azureSigning.uses).toBe(
    "azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82",
  );
  for (const [enabled, result, expected] of [
    ["true", "success", true],
    ["true", "failure", false],
    ["false", "success", false],
  ]) {
    expect(
      runInNewContext(windowsSigner.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        vars: { OPENCLAW_RELEASE_WINDOWS_SIGNED: enabled },
        needs: { build_windows: { result } },
      }),
    ).toBe(expected);
  }
  for (const [enabled, signed, expected] of [
    ["true", "failure", false],
    ["true", "skipped", false],
    ["true", "success", true],
    ["false", "skipped", true],
  ]) {
    expect(
      runInNewContext(linux.jobs.sign_desktop.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        always: () => true,
        vars: { OPENCLAW_RELEASE_WINDOWS_SIGNED: enabled },
        needs: {
          validate_release: { outputs: { desktop_test_bundles: "false" } },
          build_windows: { result: "success" },
          sign_windows: { result: signed },
        },
      }),
    ).toBe(expected);
  }
  const desktopSigningJob = linux.jobs.sign_desktop;
  const desktopSigningSteps = desktopSigningJob.steps as WorkflowStep[];
  expect(
    requiredWorkflowStep(desktopSigningSteps, "Download finalized macOS updater archive").with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_macos.outputs.unsigned_updater_artifact_id }}",
    path: "dist/signing-input/macos",
  });
  expect(
    requiredWorkflowStep(desktopSigningSteps, "Download finalized Windows updater installer").with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_windows.outputs.unsigned_updater_artifact_id }}",
    path: "dist/signing-input/windows",
  });
  for (const enabled of ["true", "false"]) {
    const downloads = desktopSigningSteps.filter((step) =>
      step.name?.endsWith("Windows updater installer"),
    );
    const selected = downloads.filter((step) =>
      runInNewContext((step.if ?? "").replace(/^\$\{\{|\}\}$/gu, ""), {
        vars: { OPENCLAW_RELEASE_WINDOWS_SIGNED: enabled },
      }),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.with?.["artifact-ids"]).toBe(
      enabled === "true"
        ? "${{ needs.sign_windows.outputs.signed_installer_artifact_id }}"
        : "${{ needs.build_windows.outputs.unsigned_updater_artifact_id }}",
    );
  }
  const signDesktop = requiredWorkflowStep(
    desktopSigningSteps,
    "Sign finalized desktop updater bundles",
  );
  expect(requiredWorkflowStep(desktopSigningSteps, "Install trusted signing tools")).toEqual(
    signingToolsInstaller,
  );
  for (const [job, step, needs, downloads] of [
    [signingJob, signAppImage, ["validate_release", "build_linux"], 1],
    [
      desktopSigningJob,
      signDesktop,
      ["validate_release", "build_macos", "build_windows", "sign_windows"],
      3,
    ],
  ] as const) {
    const steps = job.steps as WorkflowStep[];
    expect(job.needs).toEqual(needs);
    expect(job.permissions).toEqual({});
    expect(steps.map(({ uses }) => uses).filter((uses) => uses !== undefined)).toEqual([
      ...Array.from({ length: downloads }, () => DOWNLOAD_ARTIFACT_V8),
      UPLOAD_ARTIFACT_V7,
    ]);
    expect(steps.some((entry) => entry["working-directory"] !== undefined)).toBe(false);
    const bodies = steps.map(({ run }) => run ?? "").join("\n");
    expect(bodies).not.toMatch(/(?:^|\s)(?:git|cargo)\s|\.release-tooling|apps\/linux\//mu);
    expect(bodies).not.toMatch(/\b(?:npm|pnpm|npx|corepack)\b/u);
    expect(step.env).toMatchObject({
      RELEASE_TAG: "${{ needs.validate_release.outputs.release_tag }}",
      TAG_SHA: "${{ needs.validate_release.outputs.tag_sha }}",
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
      UPDATER_PUBLIC_KEY: "${{ needs.validate_release.outputs.updater_pubkey }}",
    });
    expectIncludes(step.run, [
      'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri"',
      'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign"',
    ]);
    expect(step.run).not.toMatch(/\b(?:curl|wget|npm|pnpm|npx|corepack)\b|https?:\/\//u);
    expect(step.run).not.toMatch(/(?:^|\n)\s*(?:export\s+)?PATH=/u);
  }

  expect(linux.jobs.publish.needs).toContain("sign_linux");
  expect(linux.jobs.publish.needs).toContain("sign_desktop");
  expect(linux.jobs.publish.if).toContain("needs.sign_linux.result == 'success'");
  expect(linux.jobs.publish.if).toContain("needs.sign_desktop.result == 'success'");
  expect(linux.jobs.publish.if).not.toContain("inputs.");
  for (const [name, artifactId, destination] of [
    ["Download Debian bundle", "build_linux.outputs.deb_artifact_id", "dist/input/linux/release"],
    [
      "Download signed AppImage",
      "sign_linux.outputs.signed_appimage_artifact_id",
      "dist/input/linux",
    ],
    ["Download macOS test DMG", "build_macos.outputs.dmg_artifact_id", "dist/input/macos/release"],
    [
      "Download signed desktop updater bundles",
      "sign_desktop.outputs.signed_desktop_artifact_id",
      "dist/input",
    ],
  ] as const) {
    expect(requiredWorkflowStep(linux.jobs.publish.steps, name).with).toEqual({
      "artifact-ids": `\${{ needs.${artifactId} }}`,
      path: destination,
    });
  }
  const publishLinuxMetadata = requiredWorkflowStep(
    linux.jobs.publish.steps,
    "Publish immutable bundles, canonical Linux channel, and legacy mirror",
  );
  expect(publishLinuxMetadata.run).toContain(
    '--assets dist/release --signature "dist/input/linux/signatures/OpenClaw-${RELEASE_TAG#v}-amd64.AppImage.sig"',
  );
  const publicationToken = expectDefined(
    (linux.jobs.publish.steps as WorkflowStep[]).find(({ id }) => id === "publication_token"),
    "Linux release-owner token for protected control-tag creation",
  );
  expect(publicationToken.with).toMatchObject({
    "client-id": "Iv23liOECG0slfuhz093",
    "private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
    owner: "openclaw",
    repositories: "openclaw",
    "permission-actions": "read",
    "permission-contents": "write",
    "permission-workflows": "write",
  });
  expect(publishLinuxMetadata.env?.GH_TOKEN).toBe("${{ steps.publication_token.outputs.token }}");
  const appImageToolsPath = "apps/linux/scripts/tauri-appimage-tools.sh";
  const appImageTools = readFileSync(appImageToolsPath, "utf8");
  expectIncludes(appImageTools, [
    "--proto '=https' --tlsv1.2",
    "--connect-timeout 10 --max-time 120",
    "--retry 3 --retry-all-errors",
  ]);

  const prLinux = readWorkflow(".github/workflows/linux-app.yml");
  for (const [job, helper, label] of [
    [prLinux.jobs.build, appImageToolsPath, "pull request"],
    [linux.jobs.build_linux, `.release-tooling/${appImageToolsPath}`, "release"],
  ] as const) {
    const steps = job.steps as WorkflowStep[];
    const prepareIndex = steps.findIndex(({ name }) => name === "Prepare pinned AppImage tools");
    const buildIndex = steps.findIndex(({ name }) => name === "Build Linux companion bundles");
    const finalizeIndex = steps.findIndex(({ name }) => name === "Finalize AppImage");
    expect(prepareIndex, `${label} prepare`).toBeGreaterThan(0);
    expect(buildIndex, `${label} build`).toBe(prepareIndex + 1);
    expect(finalizeIndex, `${label} finalize`).toBe(buildIndex + 1);
    for (const index of [prepareIndex, buildIndex, finalizeIndex]) {
      expect(steps[index]?.env?.XDG_CACHE_HOME, `${label} cache path`).toBe(
        "${{ runner.temp }}/openclaw-tauri-cache",
      );
    }
    expectIncludes(steps[prepareIndex]?.run, [`${helper} prepare`, `${helper} verify pre-build`]);
    expect(steps[buildIndex]?.run, label).toContain("@tauri-apps/cli@2.11.4");
    expect(steps[buildIndex]?.run, label).toMatch(/\\?"useLocalToolsDir\\?":false/u);
    expect(steps[finalizeIndex]?.run, label).toMatch(
      /finalize-appimage\.sh "?\\?\$?bundle_dir"?|finalize-appimage\.sh apps\/linux\/src-tauri\/target\/release\/bundle\/appimage/u,
    );
    expect(JSON.stringify(job), label).not.toContain("${{ secrets.");
  }
  const finalizerSource = readFileSync("apps/linux/scripts/finalize-appimage.sh", "utf8");
  const postBuildVerifications =
    finalizerSource.match(/"\$tools_helper" verify post-build/gu) ?? [];
  expect(postBuildVerifications).toHaveLength(2);
  expect(finalizerSource.indexOf(postBuildVerifications[0]!)).toBeLessThan(
    finalizerSource.indexOf("mapfile -d '' forbidden_libraries"),
  );
  expect(finalizerSource.lastIndexOf(postBuildVerifications[1]!)).toBeLessThan(
    finalizerSource.indexOf('"$plugin" --appdir "$appdir"'),
  );
  const architectureRoot = tempDirs.make("openclaw-appimage-architecture-");
  const architectureBin = path.join(architectureRoot, "bin");
  const architectureCache = path.join(architectureRoot, "cache");
  mkdirSync(architectureBin);
  writeExecutable(path.join(architectureBin, "uname"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'case "$1" in',
    '  -s) printf "%s\\n" "${SYNTHETIC_UNAME_SYSTEM:?}" ;;',
    '  -m) printf "%s\\n" "${SYNTHETIC_UNAME_MACHINE:?}" ;;',
    "  *) exit 64 ;;",
    "esac",
  ]);
  const architectureEnv = (system: string, machine: string, cache = architectureCache) => ({
    ...process.env,
    PATH: `${architectureBin}${path.delimiter}${process.env.PATH ?? ""}`,
    SYNTHETIC_UNAME_MACHINE: machine,
    SYNTHETIC_UNAME_SYSTEM: system,
    XDG_CACHE_HOME: cache,
  });
  const inspectArchitecture = (command: string, system: string, machine: string, cache?: string) =>
    spawnSync(path.resolve(appImageToolsPath), [command], {
      encoding: "utf8",
      env: architectureEnv(system, machine, cache),
    });
  for (const [machine, expected] of [
    ["x86_64", "x86_64"],
    ["amd64", "x86_64"],
    ["aarch64", "aarch64"],
    ["arm64", "aarch64"],
  ] as const) {
    const result = inspectArchitecture("architecture", "Linux", machine);
    expectProcessExit(result);
    expect(result.stdout).toBe(`${expected}\n`);
    expect(existsSync(architectureCache)).toBe(false);
  }
  const runtimePath = inspectArchitecture("runtime-path", "Linux", "arm64");
  expectProcessExit(runtimePath);
  expect(runtimePath.stdout).toBe(`${architectureCache}/tauri/.appimage-runtime-aarch64\n`);
  expect(existsSync(architectureCache)).toBe(false);
  const relativeRuntimePath = inspectArchitecture(
    "runtime-path",
    "Linux",
    "x86_64",
    "relative-cache",
  );
  expect(relativeRuntimePath.status).not.toBe(0);
  for (const [system, machine] of [
    ["Darwin", "arm64"],
    ["Linux", "riscv64"],
  ] as const) {
    const rejectedCache = path.join(architectureRoot, `${system}-${machine}`);
    const result = inspectArchitecture("prepare", system, machine, rejectedCache);
    expect(result.status).not.toBe(0);
    expect(existsSync(rejectedCache)).toBe(false);
  }
  if (process.platform === "linux") {
    const selectedTagRoot = tempDirs.make("openclaw-linux-release-v2026.8.2-");
    const inTag = (...parts: string[]) => path.join(selectedTagRoot, ...parts);
    const trustedScript = (name: string) => inTag(".release-tooling/apps/linux/scripts", name);
    const trustedTools = trustedScript("tauri-appimage-tools.sh");
    const trustedToolsManifest = trustedScript("tauri-appimage-tools-x86_64.tsv");
    const trustedArmToolsManifest = trustedScript("tauri-appimage-tools-aarch64.tsv");
    const trustedFinalizer = trustedScript("finalize-appimage.sh");
    const bundleDir = inTag("apps/linux/src-tauri/target/release/bundle/appimage");
    const cacheRoot = inTag(".cache");
    const toolSourceDir = inTag("tool-sources");
    const fakeBin = inTag("fake-bin");
    const pluginSentinel = inTag("plugin-executed");
    const makeBundle = (directory: string, architecture: string) => {
      const appDir = path.join(directory, "OpenClaw.AppDir");
      const appImage = path.join(directory, `OpenClaw_2026.8.2_${architecture}.AppImage`);
      const library = path.join(appDir, "usr/lib/libwayland-client.so.0");
      return {
        appImage,
        reset() {
          rmSync(directory, { force: true, recursive: true });
          mkdirSync(path.dirname(library), { recursive: true });
          writeFileSync(library, "host-incompatible");
          writeFileSync(appImage, "pre-finalized", { mode: 0o755 });
          chmodSync(appImage, 0o755);
          writeFileSync(`${appImage}.sig`, "stale-signature");
        },
        state(sentinel: string) {
          return {
            bytes: readFileSync(appImage),
            library: existsSync(library),
            signature: existsSync(`${appImage}.sig`),
            executed: existsSync(sentinel) ? readFileSync(sentinel, "utf8") : false,
          };
        },
      };
    };
    const bundle = makeBundle(bundleDir, "amd64");
    const { appImage } = bundle;
    mkdirSync(fakeBin, { recursive: true });
    for (const name of [
      "tauri-appimage-tools.sh",
      "tauri-appimage-tools-x86_64.tsv",
      "finalize-appimage.sh",
    ]) {
      mkdirSync(path.dirname(trustedScript(name)), { recursive: true });
      copyFileSync(`apps/linux/scripts/${name}`, trustedScript(name));
    }
    chmodSync(trustedTools, 0o755);
    chmodSync(trustedFinalizer, 0o755);

    const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
    const pluginSource = Buffer.from(
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ ${1:-} == "--appimage-offset" ]]; then',
        "  printf '16\\n'",
        "  exit 0",
        "fi",
        '[[ "$1" == "--appdir" && -d "$2" ]]',
        '[[ "${ARCH:?}" == "${EXPECTED_ARCH:?}" ]]',
        '[[ -f "${LDAI_RUNTIME_FILE:?}" ]]',
        'printf "executed\\n" > "$PLUGIN_SENTINEL"',
        'cat "$LDAI_RUNTIME_FILE" > "$LDAI_OUTPUT"',
        `printf '\\n#!/bin/sh\\nexit 0\\n' >> "$LDAI_OUTPUT"`,
        'chmod +x "$LDAI_OUTPUT"',
        "",
      ].join("\n"),
    );
    const createToolFixtures = (
      arch: "x86_64" | "aarch64",
      sourceDir: string,
      manifest: string,
    ) => {
      const linuxdeploy = `linuxdeploy-${arch}.AppImage` as const;
      const toolNames = [
        `AppRun-${arch}`,
        linuxdeploy,
        "linuxdeploy-plugin-gtk.sh",
        "linuxdeploy-plugin-gstreamer.sh",
        "linuxdeploy-plugin-appimage.AppImage",
      ] as const;
      mkdirSync(sourceDir, { recursive: true });
      const toolSources = new Map<string, Buffer>();
      for (const toolName of toolNames) {
        const contents =
          toolName === "linuxdeploy-plugin-appimage.AppImage"
            ? pluginSource
            : Buffer.from(`#!/bin/sh\n# synthetic ${toolName}\nexit 0\n`);
        toolSources.set(toolName, contents);
        writeFileSync(path.join(sourceDir, toolName), contents, { mode: 0o755 });
      }
      const postBuildLinuxdeploy = Buffer.from(
        expectDefined(toolSources.get(linuxdeploy), "linuxdeploy source"),
      );
      postBuildLinuxdeploy.fill(0, 8, 11);
      const writeManifest = (wrongDigest = false) => {
        writeFileSync(
          manifest,
          toolNames
            .map((name, index) => {
              const contents = expectDefined(toolSources.get(name), `${name} source`);
              return [
                name,
                `https://example.invalid/${name}`,
                wrongDigest && index === 0 ? "0".repeat(64) : digest(contents),
                digest(name === linuxdeploy ? postBuildLinuxdeploy : contents),
                name === linuxdeploy ? "0755" : "0555",
              ].join("\t");
            })
            .join("\n") + "\n",
        );
      };
      return { toolNames, toolSources, postBuildLinuxdeploy, writeManifest };
    };
    const {
      toolNames,
      toolSources,
      postBuildLinuxdeploy,
      writeManifest: writeSyntheticManifest,
    } = createToolFixtures("x86_64", toolSourceDir, trustedToolsManifest);
    writeFileSync(
      path.join(fakeBin, "curl"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "output=",
        "url=",
        "while [[ $# -gt 0 ]]; do",
        '  case "$1" in',
        "    --output) output=$2; shift 2 ;;",
        "    https://*) url=$1; shift ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        '[[ -n "$output" && -n "$url" ]]',
        'if [[ ${CACHE_RACE_TOOL:-} == "${url##*/}" ]]; then',
        '  mkdir -p "$XDG_CACHE_HOME/tauri"',
        '  printf "raced\\n" > "$XDG_CACHE_HOME/tauri/race-marker"',
        "fi",
        'cp "$TOOL_SOURCE_DIR/${url##*/}" "$output"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    copyFileSync(path.join(architectureBin, "uname"), path.join(fakeBin, "uname"));
    chmodSync(path.join(fakeBin, "uname"), 0o755);
    const toolEnv = {
      ...process.env,
      EXPECTED_ARCH: "x86_64",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      SYNTHETIC_UNAME_MACHINE: "x86_64",
      SYNTHETIC_UNAME_SYSTEM: "Linux",
      TOOL_SOURCE_DIR: toolSourceDir,
      XDG_CACHE_HOME: cacheRoot,
    };
    const runTools = (args: string[], env: NodeJS.ProcessEnv = toolEnv) =>
      spawnSync(trustedTools, args, { cwd: selectedTagRoot, encoding: "utf8", env });
    writeSyntheticManifest(true);
    const rejectedPrepare = runTools(["prepare"]);
    expect(rejectedPrepare.status).not.toBe(0);
    expect(existsSync(path.join(cacheRoot, "tauri"))).toBe(false);

    writeSyntheticManifest();
    const rejectedRacedPrepare = runTools(["prepare"], {
      ...toolEnv,
      CACHE_RACE_TOOL: "linuxdeploy-plugin-appimage.AppImage",
    });
    expect(
      rejectedRacedPrepare.status,
      `${rejectedRacedPrepare.stdout}${rejectedRacedPrepare.stderr}`,
    ).not.toBe(0);
    expect(readFileSync(path.join(cacheRoot, "tauri/race-marker"), "utf8")).toBe("raced\n");
    expect(globSync(path.join(cacheRoot, ".tauri-tools.*"))).toEqual([]);
    rmSync(path.join(cacheRoot, "tauri"), { recursive: true });

    expectProcessExit(runTools(["prepare"]));
    expect(globSync(path.join(cacheRoot, ".tauri-tools.*"))).toEqual([]);
    expectProcessExit(runTools(["verify", "pre-build"]));
    const toolsDir = path.join(cacheRoot, "tauri");
    const runtime = path.join(toolsDir, ".appimage-runtime-x86_64");
    const appImagePlugin = expectDefined(
      toolSources.get("linuxdeploy-plugin-appimage.AppImage"),
      "AppImage plugin source",
    );
    expect(readFileSync(runtime)).toEqual(appImagePlugin.subarray(0, 16));
    expect(statSync(runtime).mode & 0o777).toBe(0o444);
    const rejectedStaleCache = runTools(["prepare"]);
    expect(rejectedStaleCache.status).not.toBe(0);

    const linuxdeploy = path.join(toolsDir, "linuxdeploy-x86_64.AppImage");
    writeFileSync(linuxdeploy, postBuildLinuxdeploy);
    chmodSync(linuxdeploy, 0o755);
    expectProcessExit(runTools(["verify", "post-build"]));

    const resetBundle = () => {
      bundle.reset();
      rmSync(pluginSentinel, { force: true });
    };
    const runFinalizer = (
      directory = bundleDir,
      env: NodeJS.ProcessEnv = { ...toolEnv, PLUGIN_SENTINEL: pluginSentinel },
    ) => spawnSync(trustedFinalizer, [directory], { cwd: selectedTagRoot, encoding: "utf8", env });
    const restoreTool = (toolName: (typeof toolNames)[number]) => {
      const contents =
        toolName === "linuxdeploy-x86_64.AppImage"
          ? postBuildLinuxdeploy
          : expectDefined(toolSources.get(toolName), `${toolName} source`);
      rmSync(path.join(toolsDir, toolName), { force: true });
      writeFileSync(path.join(toolsDir, toolName), contents, { mode: 0o755 });
      chmodSync(
        path.join(toolsDir, toolName),
        toolName === "linuxdeploy-x86_64.AppImage" ? 0o755 : 0o555,
      );
    };

    for (const toolName of toolNames) {
      resetBundle();
      const tool = path.join(toolsDir, toolName);
      chmodSync(tool, 0o755);
      writeFileSync(tool, Buffer.concat([readFileSync(tool), Buffer.from("tampered")]));
      const rejected = runFinalizer();
      expect(rejected.status, `${toolName}: ${rejected.stdout}${rejected.stderr}`).not.toBe(0);
      expect(bundle.state(pluginSentinel), toolName).toEqual({
        bytes: Buffer.from("pre-finalized"),
        library: true,
        signature: true,
        executed: false,
      });
      expect(readFileSync(`${appImage}.sig`, "utf8"), toolName).toBe("stale-signature");
      restoreTool(toolName);
    }

    resetBundle();
    const appRun = path.join(toolsDir, "AppRun-x86_64");
    rmSync(appRun);
    symlinkSync(path.join(toolSourceDir, "AppRun-x86_64"), appRun);
    const rejectedSymlink = runFinalizer();
    expect(rejectedSymlink.status).not.toBe(0);
    expect(existsSync(pluginSentinel)).toBe(false);
    restoreTool("AppRun-x86_64");

    resetBundle();
    const gtkPlugin = path.join(toolsDir, "linuxdeploy-plugin-gtk.sh");
    chmodSync(gtkPlugin, 0o444);
    const rejectedNonExecutable = runFinalizer();
    expect(rejectedNonExecutable.status).not.toBe(0);
    expect(existsSync(pluginSentinel)).toBe(false);
    restoreTool("linuxdeploy-plugin-gtk.sh");

    resetBundle();
    chmodSync(runtime, 0o644);
    writeFileSync(runtime, Buffer.concat([readFileSync(runtime), Buffer.from("tampered")]));
    const rejectedRuntime = runFinalizer();
    expect(rejectedRuntime.status).not.toBe(0);
    expect(bundle.state(pluginSentinel)).toMatchObject({
      bytes: Buffer.from("pre-finalized"),
      library: true,
      executed: false,
    });
    writeFileSync(runtime, appImagePlugin.subarray(0, 16), { mode: 0o644 });
    chmodSync(runtime, 0o444);

    resetBundle();
    expectProcessExit(runFinalizer());
    expect(readFileSync(appImage).subarray(0, 16)).toEqual(appImagePlugin.subarray(0, 16));
    expect(readFileSync(appImage, "utf8")).toContain("#!/bin/sh");
    expect(bundle.state(pluginSentinel)).toMatchObject({
      signature: false,
      library: false,
      executed: "executed\n",
    });
    const trustedFirstRun = inTag(".release-tooling/apps/linux/tests/first_run.py");
    mkdirSync(path.dirname(trustedFirstRun), { recursive: true });
    copyFileSync("apps/linux/tests/first_run.py", trustedFirstRun);
    expect(existsSync(inTag("apps/linux/scripts/finalize-appimage.sh"))).toBe(false);
    expectProcessExit(
      spawnSync("python3", [trustedFirstRun, "--help"], {
        cwd: selectedTagRoot,
        encoding: "utf8",
      }),
    );

    const armToolSourceDir = inTag("arm-tool-sources");
    const armCacheRoot = inTag(".arm-cache");
    const armBundleDir = inTag("arm-bundle");
    const armBundle = makeBundle(armBundleDir, "arm64");
    const armPluginSentinel = inTag("arm-plugin-executed");
    const { postBuildLinuxdeploy: armPostBuildLinuxdeploy, writeManifest: writeArmManifest } =
      createToolFixtures("aarch64", armToolSourceDir, trustedArmToolsManifest);
    writeArmManifest();
    const armToolEnv = {
      ...toolEnv,
      EXPECTED_ARCH: "aarch64",
      SYNTHETIC_UNAME_MACHINE: "arm64",
      TOOL_SOURCE_DIR: armToolSourceDir,
      XDG_CACHE_HOME: armCacheRoot,
    };
    expectProcessExit(runTools(["prepare"], armToolEnv));
    const armRuntimePath = expectProcessExit(runTools(["runtime-path"], armToolEnv));
    expect(armRuntimePath.stdout).toBe(`${armCacheRoot}/tauri/.appimage-runtime-aarch64\n`);
    const armToolsDir = path.join(armCacheRoot, "tauri");
    const armLinuxdeploy = path.join(armToolsDir, "linuxdeploy-aarch64.AppImage");
    writeFileSync(armLinuxdeploy, armPostBuildLinuxdeploy);
    chmodSync(armLinuxdeploy, 0o755);
    armBundle.reset();
    expectProcessExit(
      runFinalizer(armBundleDir, {
        ...armToolEnv,
        PLUGIN_SENTINEL: armPluginSentinel,
      }),
    );
    expect(armBundle.state(armPluginSentinel)).toMatchObject({
      signature: false,
      library: false,
      executed: "executed\n",
    });
    expect(readFileSync(armBundle.appImage).subarray(0, 16)).toEqual(
      appImagePlugin.subarray(0, 16),
    );

    const writeSigningToolFixtures = (root: string) => {
      const bin = path.join(root, "bin");
      const poisonBin = path.join(root, "poison-bin");
      const tauri = path.join(bin, "cargo-tauri");
      const tauriLog = path.join(root, "cargo-tauri.log");
      const minisignLog = path.join(root, "minisign.log");
      mkdirSync(bin, { recursive: true });
      mkdirSync(poisonBin, { recursive: true });
      writeExecutable(tauri, [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        '[[ "$#" -eq 3 && "$1" == "signer" && "$2" == "sign" ]]',
        '[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]',
        '[[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]',
        'printf "%s\\n" "$*" >> "$TAURI_SIGN_LOG"',
        'printf "ephemeral-signature:%s" "$(basename "$3")" | base64 > "$3.sig"',
      ]);
      writeExecutable(path.join(bin, "minisign"), [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        '[[ "$#" -eq 6 && "$1" == "-Vm" && "$3" == "-x" && "$5" == "-p" ]]',
        '[[ -z "${TAURI_SIGNING_PRIVATE_KEY+x}" ]]',
        '[[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]',
        '[[ -s "$2" && -s "$4" && -s "$6" ]]',
        '[[ "$(cat "$6")" == "ephemeral-public-key" ]]',
        'printf "%s\\n" "$(basename "$2")" >> "$MINISIGN_LOG"',
      ]);
      for (const command of ["cargo-tauri", "minisign", "npm", "pnpm", "npx", "corepack"]) {
        writeFileSync(path.join(poisonBin, command), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
      }
      return {
        minisignBinarySha256: digest(readFileSync(path.join(bin, "minisign"))),
        minisignLog,
        path: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}`,
        tauriBinarySha256: digest(readFileSync(tauri)),
        tauriLog,
      };
    };
    const runSigning = (
      root: string,
      step: WorkflowStep,
      tools: ReturnType<typeof writeSigningToolFixtures>,
      desktop = true,
    ) =>
      spawnSync("bash", ["-c", step.run ?? ""], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: tools.path,
          RELEASE_TAG: "v2026.8.2",
          DESKTOP_TEST_BUNDLES: String(desktop),
          RUNNER_TEMP: root,
          TAG_SHA: "a".repeat(40),
          MINISIGN_BINARY_SHA256: tools.minisignBinarySha256,
          TAURI_CLI_BINARY_SHA256: tools.tauriBinarySha256,
          TAURI_SIGN_LOG: tools.tauriLog,
          TAURI_SIGNING_PRIVATE_KEY: "ephemeral-test-key",
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "ephemeral-test-password",
          UPDATER_PUBLIC_KEY: Buffer.from("ephemeral-public-key").toString("base64"),
          MINISIGN_LOG: tools.minisignLog,
        },
      });

    const proveSigning = (
      label: string,
      signingStep: WorkflowStep,
      artifacts: Array<[name: string, platform: string, bytes: string, exactSignature?: boolean]>,
      desktop = true,
    ) => {
      const root = tempDirs.make(`openclaw-${label}-signing-job-`);
      const paths = artifacts.map(([name, platform, bytes, exactSignature]) => ({
        name,
        bytes,
        exactSignature,
        input: path.join("dist/signing-input", platform, name),
        output: path.join(platform ? "dist/desktop-test" : "dist/linux-app", platform),
      }));
      for (const artifact of paths) {
        const file = path.join(root, artifact.input);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, artifact.bytes);
      }
      const tools = writeSigningToolFixtures(root);
      expectProcessExit(runSigning(root, signingStep, tools, desktop));
      for (const artifact of paths) {
        expect(readFileSync(path.join(root, artifact.input), "utf8")).toBe(artifact.bytes);
        expect(
          readFileSync(path.join(root, artifact.output, "release", artifact.name), "utf8"),
        ).toBe(artifact.bytes);
        const signature = readFileSync(
          path.join(root, artifact.output, "signatures", `${artifact.name}.sig`),
          "utf8",
        );
        if (artifact.exactSignature) {
          expect(signature).toBe(
            `${Buffer.from(`ephemeral-signature:${artifact.name}`).toString("base64")}\n`,
          );
        } else {
          expect(Buffer.from(signature, "base64").toString()).toContain(artifact.name);
        }
      }
      expect(readFileSync(tools.tauriLog, "utf8")).toBe(
        paths.map(({ input }) => `signer sign ${input}\n`).join(""),
      );
      expect(readFileSync(tools.minisignLog, "utf8")).toBe(
        paths.map(({ name }) => `${name}\n`).join(""),
      );
      for (const directory of [".release-tooling", "apps"]) {
        expect(existsSync(path.join(root, directory))).toBe(false);
      }
    };
    proveSigning("linux", signAppImage, [
      ["OpenClaw-2026.8.2-amd64.AppImage", "", "trusted-finalized-bytes", true],
    ]);
    proveSigning("desktop", signDesktop, [
      ["OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz", "macos", "finalized-macos-updater-bytes"],
      ["OpenClaw-2026.8.2-windows-x86_64.exe", "windows", "finalized-windows-updater-bytes"],
    ]);
    proveSigning(
      "windows",
      signDesktop,
      [["OpenClaw-2026.8.2-windows-x86_64.exe", "windows", "finalized-windows-only-bytes"]],
      false,
    );
  }
  const linuxBuildBodies = linuxBuildSteps.map(({ run }) => run ?? "").join("\n");
  for (const helper of [
    "apps/linux/scripts/stage-appimage-gstreamer.sh",
    "apps/linux/scripts/finalize-appimage.sh",
    "apps/linux/tests/packaged_runtime_smoke.py",
  ]) {
    expect(linuxBuildBodies).toContain(`.release-tooling/${helper}`);
    expect(linuxBuildBodies).not.toMatch(new RegExp(`(^|\\s)${helper.replaceAll(".", "\\.")}`));
  }
});

it("pins trusted Performance Git owners before checkout", () => {
  const source = readFileSync(".github/workflows/openclaw-performance.yml", "utf8");
  const workflow = parse(source);
  const targets = [
    ["resolve_target", "Checkout target metadata", undefined],
    ["kova", "Checkout OpenClaw", "Decide lane"],
    ["source_performance", "Checkout OpenClaw source target", undefined],
    ["publish", "Checkout performance publisher helper", "Decide report publication lane"],
  ] as const;
  for (const [jobId, checkout, decision] of targets) {
    const job = workflow.jobs[jobId];
    const steps = job.steps as WorkflowStep[];
    const index = steps.findIndex(({ name }) => name === "Prepare Git owner");
    expect(index).toBe(decision ? 1 : 0);
    expect(steps[index + 1]?.name).toBe(checkout);
    if (decision) {
      expect(steps[index - 1]?.name).toBe(decision);
    }
    expect(steps[index]).toEqual({
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@a379bbd73e30b84a89aca4d54744ab9ca19082e7",
      ...(decision ? { if: "steps.lane.outputs.run == 'true'" } : {}),
    });
  }
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.publish.permissions).toEqual({ actions: "read", contents: "read" });
  expect(workflow.concurrency).toEqual({
    group:
      "${{ github.event_name == 'workflow_dispatch' && format('{0}-{1}', github.workflow, github.run_id) || format('{0}-{1}', github.workflow, github.ref) }}",
    "cancel-in-progress": false,
  });
});

describe("frozen CI compatibility contracts", () => {
  it("skips current-only launcher and QA contracts for frozen targets", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const launcher = readCiWorkflow().jobs["build-artifacts"].steps.find((step: WorkflowStep) =>
      step.run?.includes("bun openclaw.mjs --help"),
    );
    for (const frozenTarget of [false, true]) {
      expect(
        evaluateWorkflowCondition(launcher.if, {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          frozenTarget,
          steps: {
            dist_build: { outputs: {}, outcome: "success" },
            dist_build_cache: { outputs: {} },
          },
        }),
      ).toBe(!frozenTarget);
    }
    expect(source).toContain(
      "[skip] ${partId} is not declared by this checkout's legacy smoke plan",
    );
    expect(source).not.toContain('"control-ui-chat-flow-playwright",');
    expect(source).toContain("if (!source.includes(marker)) process.exit(0);");
  });
});

describe("workflow file size", () => {
  // GitHub refuses workflow files above 500 KiB: it creates a run named after
  // the file that fails with no jobs, so CI stops without reporting a failure.
  const GITHUB_WORKFLOW_MAX_BYTES = 512_000;
  const WORKFLOW_SOFT_LIMIT_BYTES = 480_000;

  it("keeps every workflow file well below GitHub's size limit", () => {
    const oversized = readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => `.github/workflows/${name}`)
      .map((file) => ({ file, bytes: statSync(file).size }))
      .filter(({ bytes }) => bytes > WORKFLOW_SOFT_LIMIT_BYTES)
      .map(({ file, bytes }) => `${file}: ${bytes} bytes`);

    expect(
      oversized,
      `Workflow files must stay at or below ${WORKFLOW_SOFT_LIMIT_BYTES} bytes. GitHub's hard limit is ` +
        `${GITHUB_WORKFLOW_MAX_BYTES} bytes (500 KiB); above it, GitHub creates a run named after the ` +
        `file that fails immediately with no jobs, so all PR and main CI silently stops. Shrink the file ` +
        `(for example, YAML anchors/aliases for byte-identical expressions) before raising this limit.`,
    ).toEqual([]);
  });
});
