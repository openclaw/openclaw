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
import { parse } from "yaml";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createUiRealGatewayTestShards,
  createUiTestShardGroups,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { resolveRunVitestSpawnEnv } from "../../scripts/lib/vitest-process-env.mts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { sharedVitestConfig } from "../vitest/vitest.shared.config.ts";
import { createPrebuiltUiE2eVitestConfig } from "../vitest/vitest.ui-e2e-prebuilt.config.ts";
import { createUiE2eVitestConfig } from "../vitest/vitest.ui-e2e.config.ts";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import { runDependencyFreePreflight } from "./ci-preflight-dependencies.test-support.js";
import { assertControlUiE2eOwnership } from "./ci-ui-e2e-ownership.test-support.js";
import {
  AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC,
  CACHE_SAVE_V5,
  CACHE_V5,
  CHECKOUT_V6,
  DOWNLOAD_ARTIFACT_V8,
  MANTIS_GITHUB_APP_CLIENT_ID,
  MATURITY_SCORECARD_WORKFLOW,
  SETUP_GO_V6,
  UPLOAD_ARTIFACT_V7,
  evaluateWorkflowExpression,
  evaluateWorkflowRunner,
  quoteShell,
  readAndroidToolchainAction,
  readBuildArtifactsTestboxWorkflow,
  readCiWorkflow,
  readMaturityScorecardWorkflow,
  readReleaseChecksWorkflow,
  readTrackedText,
  readWorkflow,
  readWorkflowOutputs,
  runGit,
  runWorkflowShellScript,
  testNodeExecPath,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";
import { runGeneratedPublisherScenario } from "./generated-publisher.test-support.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

const SETUP_GRADLE_V6 = "gradle/actions/setup-gradle@9c971963bec38e04b3d30dcc455b5382be2fdbfb";
const CREATE_GITHUB_APP_TOKEN_V3 =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const MANTIS_MANUAL_ONLY_WORKFLOWS = [
  ".github/workflows/mantis-web-ui-chat-proof.yml",
  ".github/workflows/mantis-discord-status-reactions.yml",
  ".github/workflows/mantis-discord-thread-attachment.yml",
] as const;
const OPENGREP_PR_DIFF_WORKFLOW = ".github/workflows/opengrep-precise.yml";
const OPENGREP_FULL_WORKFLOW = ".github/workflows/opengrep-precise-full.yml";
const CONTROL_UI_LOCALE_REFRESH_WORKFLOW = ".github/workflows/control-ui-locale-refresh.yml";
const NATIVE_APP_LOCALE_REFRESH_WORKFLOW = ".github/workflows/native-app-locale-refresh.yml";
const CREATE_GENERATED_PR_TOKENS_ACTION = ".github/actions/create-generated-pr-tokens/action.yml";
const PUBLISH_GENERATED_PR_ACTION = ".github/actions/publish-generated-pr/action.yml";
const OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS = new Set<string>();
const AMBIGUOUS_MAIN_PUSH_GUARD = `if [ "$GITHUB_EVENT_NAME" = "push" ] && [[ "$base_sha" =~ ^0+$ ]]; then
  echo "${AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC}" >&2
  exit 1
fi`;
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
  const step = expectDefined(
    readCiWorkflow().jobs.preflight.steps.find(
      (candidate: WorkflowStep) => candidate.name === stepName,
    ),
    stepName,
  );
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
  return parse(readFileSync(".github/workflows/android-release.yml", "utf8"));
}

function readTestboxWorkflow() {
  return parse(readFileSync(".github/workflows/ci-check-testbox.yml", "utf8"));
}

function readWorkflowSanityWorkflow() {
  return parse(readFileSync(".github/workflows/workflow-sanity.yml", "utf8"));
}

function readRealBehaviorProofWorkflow() {
  return parse(readFileSync(".github/workflows/real-behavior-proof.yml", "utf8"));
}

function readCriticalQualityWorkflow() {
  return readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
}

const PULL_REQUEST_EDIT_FIELDS = ["title", "body", "base"] as const;

function readPullRequestEditFields(condition: unknown) {
  const expression = typeof condition === "string" ? condition : "";
  return PULL_REQUEST_EDIT_FIELDS.filter((field) =>
    expression.includes(`github.event.changes.${field}`),
  );
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
      if (
        !uses ||
        uses.startsWith("./") ||
        uses.startsWith("docker://") ||
        OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS.has(uses)
      ) {
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
    const beforeBytes = allocatedBytes();
    expect(beforeBytes).toBeLessThan(256 * 1024 * 1024);
    console.info(
      "fallback-fixture-before",
      JSON.stringify({ ...options, refs: count, enumerationBytes, allocatedBytes: beforeBytes }),
    );
    const step = expectDefined(
      readReleaseChecksWorkflow().jobs.resolve_target.steps.find(
        (candidate: WorkflowStep) =>
          candidate.name === "Validate selected ref belongs to this repository",
      ) as WorkflowStep | undefined,
      "fallback history validation",
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
    const afterBytes = allocatedBytes();
    expect(afterBytes).toBeLessThan(256 * 1024 * 1024);
    console.info(
      "fallback-fixture-result",
      JSON.stringify({
        ...options,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        enumerationBytes,
        containingBranches,
        allocatedBytes: afterBytes,
        events,
        rejection: result.stderr.includes("but that commit is not reachable"),
      }),
    );
    expect(result.error).toBeUndefined();
    expect(events.every((event) => event.error === undefined)).toBe(true);
    return { result, events };
  } finally {
    ownedDirs.cleanup();
    expect(existsSync(root)).toBe(false);
    console.info("fallback-fixture-cleanup", JSON.stringify({ ...options, remaining: 0 }));
  }
}
describe("ci workflow guards", () => {
  it("isolates mutations between workflow fixtures", () => {
    const workflow = readCiWorkflow();
    const expected = structuredClone(workflow);

    workflow.jobs.preflight.steps[0].name = "mutated fixture";
    workflow.jobs.preflight.steps.pop();
    delete workflow.jobs["ci-gate"];

    expect(readCiWorkflow()).toEqual(expected);
  });

  it.each([
    ["artifact", 1],
    ["source", 0],
    ["published", 0],
  ] as const)(
    "fetches the required release preparation history for %s mode",
    (packageMode, depth) => {
      const prepare = readReleaseChecksWorkflow().jobs.prepare_release_package;
      const checkout = prepare.steps.find(
        (step: WorkflowStep) => step.name === "Checkout trusted workflow ref",
      );
      expect(checkout.with.ref).toBe("${{ github.sha }}");
      expect(checkout.with["persist-credentials"]).toBe(false);
      expect(checkout.with.filter).toBe("blob:none");
      const fetchDepth = checkout.with["fetch-depth"];
      expect(
        typeof fetchDepth === "string"
          ? evaluateWorkflowExpression(fetchDepth, {
              eventName: "workflow_dispatch",
              repository: "openclaw/openclaw",
              runAttempt: 1,
              resolveTargetOutputs: { package_mode: packageMode },
            })
          : fetchDepth,
      ).toBe(depth);
    },
  );

  it("gates frozen runtime-pair compatibility on the trusted suite outcome", () => {
    const workflow = readReleaseChecksWorkflow();
    const laneJob = workflow.jobs.qa_lab_runtime_pair_lane_release_checks;
    const suiteValidation = laneJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate runtime-pair lane",
    );
    const reportValidation = laneJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate runtime-pair lane report",
    );

    for (const step of [suiteValidation, reportValidation]) {
      expect(step?.env?.CANDIDATE_SUITE_OUTCOME).toBe(
        "${{ steps.candidate_runtime_pair.outcome }}",
      );
      expect(step?.run).toContain('--candidate-suite-outcome "$CANDIDATE_SUITE_OUTCOME"');
      expect(step?.run).toContain('--target-sha "$RELEASE_CHECK_TARGET_SHA"');
      expect(step?.run).toContain('--lane "$RUNTIME_PAIR_LANE"');
    }
  });

  it("separates release QA lanes without weakening their resource locks", () => {
    const workflowPath = ".github/workflows/qa-live-transports-convex.yml";
    const workflowSource = readFileSync(workflowPath, "utf8");
    const workflow = parse(workflowSource);
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
    expect(workflow.jobs.run_live_matrix.concurrency).toEqual({
      group: "qa-live-matrix-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(workflow.jobs.run_live_buzz.concurrency).toEqual({
      group: "qa-live-buzz-shared",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(releaseWorkflow.jobs.qa_live_release_checks.with.lock_scope).toBe("matrix");
    expect(releaseWorkflow.jobs.qa_live_buzz_release_checks.with.lock_scope).toBe("buzz");
  });

  it("runs full-access restart proof as a failing nightly gate", () => {
    const workflow = readWorkflow(".github/workflows/qa-live-transports-convex.yml");
    const job = workflow.jobs.run_live_runtime_token_efficiency;
    const step = job.steps.find((candidate: WorkflowStep) =>
      candidate.run?.includes("--scenario gateway-restart-full-access-live"),
    );

    expect(workflow.on.schedule.length).toBeGreaterThan(0);
    expect(job.if).toBe("github.event_name == 'schedule'");
    expect(step).toBeDefined();
    expect(step?.env?.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(step?.["continue-on-error"]).toBeUndefined();
    expect(step?.if).toBeUndefined();
    expect(step?.run).toContain("--provider-mode live-frontier");
    expect(step?.run).toContain("--model openai/gpt-5.6-luna");
    expect(step?.run).toContain("--alt-model openai/gpt-5.6-luna");
    expect(step?.run).toContain("--concurrency 1");
    expect(step?.run).not.toContain("--allow-failures");
    expect(step?.run).toContain(
      '--output-dir "${{ steps.run_lane.outputs.output_dir }}/gateway-restart-full-access"',
    );
  });

  it.each([0, 7])("preserves module heredocs and cleans artifacts after exit %i", (exitCode) => {
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

  it("routes PR edited metadata only to interested automation", () => {
    const autoResponse = readWorkflow(".github/workflows/auto-response.yml");
    const clawsweeperDispatch = readWorkflow(".github/workflows/clawsweeper-dispatch.yml");
    const labeler = readWorkflow(".github/workflows/labeler.yml");
    const realBehaviorProof = readWorkflow(".github/workflows/real-behavior-proof.yml");

    for (const workflow of [autoResponse, clawsweeperDispatch, labeler, realBehaviorProof]) {
      expect(workflow.on.pull_request_target.types).toContain("edited");
    }

    expect({
      autoResponse: readPullRequestEditFields(autoResponse.jobs["auto-response"].if),
      clawsweeperDispatch: readPullRequestEditFields(clawsweeperDispatch.jobs.dispatch.if),
      labeler: readPullRequestEditFields(labeler.jobs.label.if),
      realBehaviorProof: readPullRequestEditFields(
        realBehaviorProof.jobs["real-behavior-proof"].if,
      ),
    }).toEqual({
      autoResponse: ["title", "body", "base"],
      clawsweeperDispatch: [],
      labeler: ["title", "base"],
      realBehaviorProof: ["body", "base"],
    });

    const labelerSteps = labeler.jobs.label.steps;
    const changedFieldsForStep = (matcher: (step: WorkflowStep) => boolean) =>
      readPullRequestEditFields(labelerSteps.find(matcher)?.if);
    expect({
      pathLabels: changedFieldsForStep(
        (step) => step.uses?.startsWith("actions/labeler@") === true,
      ),
      size: changedFieldsForStep((step) => step.name === "Apply PR size label"),
      contributor: changedFieldsForStep(
        (step) => step.name === "Apply maintainer or trusted-contributor label",
      ),
      betaBlocker: changedFieldsForStep((step) => step.name === "Apply beta-blocker title label"),
      activePrLimit: changedFieldsForStep((step) => step.name === "Apply too-many-prs label"),
    }).toEqual({
      pathLabels: ["base"],
      size: ["base"],
      contributor: [],
      betaBlocker: ["title"],
      activePrLimit: [],
    });
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
      steps.find((step) => step.name === "Dispatch GitHub activity to ClawSweeper")?.run,
      "ClawSweeper GitHub activity dispatch",
    );
    expect(activityRun).toMatch(
      /push: \(if \$event_name == "push" then \{\s+before: \.before,\s+after: \.after,\s+ref: \.ref,\s+compare: \.compare,\s+head_commit: \.head_commit\.id\s+\} else null end\)/u,
    );

    const exactReviewStep = expectDefined(
      steps.find((step) => step.name === "Dispatch exact ClawSweeper review"),
      "ClawSweeper exact-review dispatch",
    );
    expect(exactReviewStep.env?.TARGET_BRANCH).toBe(
      "${{ github.event.repository.default_branch }}",
    );
    expect(exactReviewStep.run).toContain('--arg target_branch "$TARGET_BRANCH"');
    expect(exactReviewStep.run).toContain("target_branch:$target_branch");
    expect(exactReviewStep.run).toContain('ingress_route:"target_dispatcher"');
    expect(exactReviewStep.run).toContain("ingress_fingerprint:$ingress_fingerprint");
  });

  it("admits ClawSweeper content changes, commands, and stale-bug verification before allocation", () => {
    const condition = String(
      readWorkflow(".github/workflows/clawsweeper-dispatch.yml").jobs.dispatch.if,
    )
      .replace(/^\$\{\{|\}\}$/gu, "")
      .replace("github.event.issue.labels.*.name", "issueLabels");
    const cases: {
      eventName: string;
      action: string;
      changes?: Record<string, unknown>;
      allowed: boolean;
      actor?: string;
      actorId?: string;
      label?: string;
      issueLabels?: string[];
    }[] = [
      { eventName: "pull_request_target", action: "edited", changes: {}, allowed: false },
      { eventName: "issues", action: "edited", changes: {}, allowed: false },
      { eventName: "pull_request_target", action: "edited", allowed: true },
      ...["title", "body", "base", "maintainer_can_modify", "unknown"].map((field) => ({
        eventName: "pull_request_target",
        action: "edited",
        changes: { [field]: { from: "" } },
        allowed: true,
      })),
      { eventName: "issues", action: "edited", changes: { body: { from: "" } }, allowed: true },
      { eventName: "pull_request_target", action: "synchronize", allowed: true },
      { eventName: "pull_request_target", action: "labeled", allowed: true },
      { eventName: "pull_request_target", action: "unlabeled", allowed: true },
      { eventName: "issue_comment", action: "created", allowed: true },
      { eventName: "issue_comment", action: "edited", allowed: true },
      { eventName: "pull_request_review", action: "edited", allowed: true },
      { eventName: "pull_request_review_comment", action: "edited", allowed: true },
      { eventName: "issues", action: "labeled", actor: "github-actions[bot]", allowed: false },
      {
        eventName: "issues",
        action: "labeled",
        actor: "github-actions[bot]",
        actorId: "257215752",
        label: "stale",
        issueLabels: ["bug", "stale"],
        allowed: true,
      },
    ];
    for (const event of cases) {
      expect(
        Boolean(
          runInNewContext(condition, {
            github: {
              actor: event.actor ?? "maintainer",
              actor_id: event.actorId ?? "",
              event_name: event.eventName,
              event: {
                action: event.action,
                changes: event.changes,
                label: { name: event.label ?? "enhancement" },
              },
            },
            issueLabels: event.issueLabels ?? [],
            contains: (values: string[], value: string) => values.includes(value),
            endsWith: (value: string, suffix: string) => value.endsWith(suffix),
            startsWith: (value: unknown, prefix: string) => String(value).startsWith(prefix),
            toJSON: (value: unknown) => JSON.stringify(value),
            vars: { OPENCLAW_RELEASE_PRIORITY_RUN: "" },
          }),
        ),
        JSON.stringify(event),
      ).toBe(event.allowed);
    }
  });

  it("keeps existing ClawSweeper per-item coalescing after admission", () => {
    const workflow = readWorkflow(".github/workflows/clawsweeper-dispatch.yml");
    expect(workflow.concurrency).toBeUndefined();
    const concurrency = workflow.jobs.dispatch.concurrency;
    const evaluate = (
      expression: string,
      eventName: "issues" | "pull_request_target" | "issue_comment",
      action: string,
      runId: number,
    ) =>
      evaluateWorkflowExpression(expression, {
        repository: "openclaw/openclaw",
        eventName,
        runAttempt: 1,
        runId,
        githubEvent: { action, issue: { number: 123 }, pull_request: { number: 123 } },
      });
    const opened = evaluate(concurrency.group, "pull_request_target", "opened", 1);
    expect(evaluate(concurrency.group, "pull_request_target", "edited", 2)).toBe(opened);
    expect(evaluate(concurrency["cancel-in-progress"], "pull_request_target", "edited", 2)).toBe(
      true,
    );
    expect(evaluate(concurrency.group, "issue_comment", "created", 3)).toBe(opened);
    expect(evaluate(concurrency.group, "issue_comment", "edited", 4)).toBe(opened);
    expect(evaluate(concurrency["cancel-in-progress"], "issue_comment", "created", 3)).toBe(false);
    expect(evaluate(concurrency["cancel-in-progress"], "issue_comment", "edited", 4)).toBe(true);
  });

  it("runs the PR context and evidence gate only for relevant PR changes", () => {
    const workflow = readRealBehaviorProofWorkflow();
    const job = workflow.jobs["real-behavior-proof"];

    expect(workflow.name).toBe("PR context and evidence");
    expect(workflow.jobs["real-behavior-proof"].name).toBe("PR context and evidence");
    expect(workflow.on.pull_request_target.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]);
    expect(workflow.concurrency).toBeUndefined();
    expect(job.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.event.pull_request.number }}",
    );
    expect(job.concurrency["cancel-in-progress"]).toBe(true);
  });

  it.each([
    // name, body, override, permission, issue, admitted, reacts
    ["plain", "Thanks", "", "write", false, false, false],
    ["empty", "", "", "write", false, false, false],
    ["multiline", "context\r\n \t/merge now \r\n", "", "write", false, true, true],
    ["slash nonmatch", "/landscape", "", "write", false, true, false],
    ["custom words", "ship it now", " ship it ,", "write", false, true, true],
    ["custom Unicode", "  ✅ later  ", "✅", "write", false, true, true],
    ["false override", "false", "false", "write", false, true, true],
    ["zero override", "0", "0", "write", false, true, true],
    ["empty parsed override", "Thanks", " , ", "write", false, true, false],
    ["non-maintainer", "/merge", "", "read", false, true, false],
    ["issue autoclose", "/autoclose reason", "", "write", true, true, true],
    ["issue non-autoclose", "/merge", "", "write", true, true, false],
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

  it("keeps reaction admission open for every configured default and closed for bot actors", () => {
    const workflow = readWorkflow(".github/workflows/maintainer-command-reactions.yml");
    const job = workflow.jobs.react;
    const context = {
      repository: "openclaw/openclaw",
      runAttempt: 1,
      eventName: "issue_comment" as const,
      actor: "maintainer",
    };
    const defaults = String(
      evaluateWorkflowExpression(job.env.MAINTAINER_COMMAND_REACTIONS, context),
    );
    for (const command of defaults.split(",")) {
      // A future nonslash default would invalidate the necessary-character admission guard.
      expect(command, "default commands must retain slash admission").toContain("/");
      const githubEvent = { comment: { body: `earlier line\n  ${command} args  ` } };
      expect(evaluateWorkflowExpression(job.if, { ...context, githubEvent })).toBe(true);
      expect(
        evaluateWorkflowExpression(job.if, {
          ...context,
          githubEvent,
          actor: "automation[bot]",
          maintainerCommands: "ship",
        }),
      ).toBe(false);
    }
    expect(workflow.on.issue_comment.types).toEqual(["created", "edited"]);
  });

  it.each([
    ["issue_comment", "created", "Bot", "human", false],
    ["issue_comment", "created", "User", "clawsweeper[bot]", true],
    ["issue_comment", "created", undefined, "human", true],
    ["issues", "opened", "Bot", "clawsweeper[bot]", true],
    ["pull_request_target", "opened", "Bot", "clawsweeper[bot]", true],
    ["pull_request_target", "labeled", "Bot", "clawsweeper[bot]", false],
    ["pull_request_target", "unlabeled", "Bot", "openclaw-clawsweeper[bot]", false],
    ["pull_request_target", "labeled", "Bot", "openclaw-barnacle[bot]", true],
    ["pull_request_target", "labeled", "User", "maintainer", true],
  ] as const)(
    "preserves Barnacle comment admission for %s/%s/%s/%s",
    (eventName, action, type, actor, admitted) => {
      const job = readWorkflow(".github/workflows/auto-response.yml").jobs["auto-response"];
      expect(
        evaluateWorkflowExpression(job.if, {
          repository: "openclaw/openclaw",
          runAttempt: 1,
          eventName,
          actor,
          githubEvent: {
            action,
            issue: { author_association: "NONE" },
            pull_request: { author_association: "NONE" },
            comment: { body: "testflight @openclaw/maintainer", user: { type } },
          },
        }),
      ).toBe(admitted);
    },
  );

  it("isolates auto-response per item and ignores ClawSweeper PR label feedback", () => {
    const workflow = readWorkflow(".github/workflows/auto-response.yml");
    const job = workflow.jobs["auto-response"];
    const guard = job.if;

    expect(workflow.on.issues.types).toEqual(["opened", "edited", "labeled"]);
    expect(workflow.on.issue_comment.types).toEqual(["created"]);
    expect(workflow.on.pull_request_target.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
      "labeled",
      "unlabeled",
    ]);
    expect(workflow.concurrency).toBeUndefined();
    expect(job.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.event.issue.number || github.event.pull_request.number }}",
    );
    expect(job.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request_target' && github.event.action == 'synchronize' }}",
    );
    expect(guard).toContain("github.event_name != 'pull_request_target'");
    expect(guard).toContain("github.event.action != 'labeled'");
    expect(guard).toContain("github.event.action != 'unlabeled'");
    expect(guard).toContain("github.actor != 'clawsweeper[bot]'");
    expect(guard).toContain("github.actor != 'openclaw-clawsweeper[bot]'");
    expect(guard).not.toContain("openclaw-barnacle[bot]");
  });

  it("routes stale bug issues through ClawSweeper instead of Barnacle closure", () => {
    const staleWorkflow = readWorkflow(".github/workflows/stale.yml");
    const staleSteps = staleWorkflow.jobs.stale.steps as WorkflowStep[];
    const stepNamed = (name: string) =>
      expectDefined(
        staleSteps.find((step) => step.name === name),
        name,
      );

    for (const name of [
      "Mark stale unassigned issues and pull requests (primary)",
      "Mark stale assigned issues (primary)",
      "Mark stale unassigned issues and pull requests (fallback)",
      "Mark stale assigned issues (fallback)",
    ]) {
      const exemptLabels = String(stepNamed(name).with?.["exempt-issue-labels"])
        .split(",")
        .map((label) => label.trim());
      expect(exemptLabels, name).toContain("bug");
    }

    const bugJob = staleWorkflow.jobs["stale-bug-verification"];
    expect(bugJob.permissions).toEqual({ issues: "write" });
    expect(evaluateWorkflowRunner(bugJob["runs-on"])).toBe("ubuntu-24.04");
    const bugScript = String(
      (bugJob.steps as WorkflowStep[]).find(
        (step) => step.name === "Mark inactive bugs for ClawSweeper verification",
      )?.with?.script,
    );
    expect(bugScript).toContain("const maxMarks = 25;");
    expect(bugScript).toContain('labels: "bug"');
    expect(bugScript).toContain("github.rest.issues.addLabels");
    expect(bugScript).toContain("github.rest.issues.removeLabel");
    expect(bugScript).toContain("Inactivity alone will not close a bug report.");
    expect(bugScript).toContain("requires separate backfill approval");
    expect(bugScript).toContain("slice(staleEventIndex + 1)");
    expect(bugScript).toContain("updatedAtMs > lastAutomationAtMs");
    expect(bugScript).toContain('item.state !== "open"');
    expect(bugScript).not.toContain("15_000");
    expect(bugScript).not.toContain("github.rest.issues.update");

    const backfillScript = String(
      (staleWorkflow.jobs["backfill-stale-closures"].steps as WorkflowStep[]).find(
        (step) => step.name === "Backfill stale closures",
      )?.with?.script,
    );
    expect(backfillScript).toMatch(/issueExemptLabels[\s\S]*"bug"/);

    const dispatchWorkflow = readWorkflow(".github/workflows/clawsweeper-dispatch.yml");
    const dispatchCondition = String(dispatchWorkflow.jobs.dispatch.if);
    expect(dispatchCondition).toContain("github.event.label.name == 'stale'");
    expect(dispatchCondition).toContain("contains(github.event.issue.labels.*.name, 'bug')");
    expect(dispatchCondition).toContain("github.actor_id == '257215752'");
    expect(dispatchCondition).toContain("github.actor_id == '264559031'");

    const auditJob = staleWorkflow.jobs["audit-bug-closure-reasons"];
    expect(auditJob.permissions).toEqual({ issues: "read" });
    const auditScript = String((auditJob.steps as WorkflowStep[])[0]?.with?.script);
    expect(auditScript).toContain('item.state_reason !== "not_planned"');
    expect(auditScript).toContain("github.rest.issues.listEventsForTimeline");
    expect(auditScript).toContain("github.paginate.iterator(");
    expect(auditScript).toContain("new Set([257215752, 264559031])");
    expect(auditScript).toContain("escapeSummaryCell(violation.title)");
    expect(auditScript).toContain('.replaceAll("<", "&lt;")');
    expect(auditScript).toContain("core.setFailed(");
    expect(auditScript).not.toContain("github.rest.issues.update");
    expect(auditScript).not.toContain("github.rest.issues.createComment");
  });

  it("makes the hosted release-gate fallback explicit and exact-SHA only", () => {
    const workflow = readCiWorkflow();
    const releaseGate = workflow.on.workflow_dispatch.inputs.release_gate;

    expect(releaseGate).toEqual({
      description:
        "Run an exact-SHA maintainer release-gate fallback when PR CI is capacity-stalled.",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_dispatch.inputs.dispatch_id).toEqual({
      description: "Optional parent workflow dispatch identifier",
      required: false,
      default: "",
      type: "string",
    });
    expect(workflow.on.workflow_dispatch.inputs.pull_request_number).toEqual({
      description: "Pull request number required by the exact-SHA release gate.",
      required: false,
      default: "",
      type: "string",
    });
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("loc_base_ref");
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("pr_number");
    expect(workflow.on.workflow_dispatch.inputs.release_scope).toMatchObject({
      default: "full",
      type: "choice",
      options: ["full", "npm-beta", "npm-stable"],
    });
    expect(workflow.jobs.preflight.outputs.release_scope).toBe(
      "${{ steps.manifest.outputs.release_scope }}",
    );
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "run-name: ${{ github.event_name == 'workflow_dispatch' && inputs.dispatch_id != '' && format('CI {0}', inputs.dispatch_id) || (github.event_name == 'workflow_dispatch' && inputs.release_gate && format('CI release gate {0}', inputs.target_ref) || 'CI') }}",
    );
    const preflightSteps = workflow.jobs.preflight.steps;
    expect(
      preflightSteps.find((step: WorkflowStep) => step.name === "Build CI manifest").env,
    ).toMatchObject({
      OPENCLAW_CI_RELEASE_SCOPE: "${{ inputs.release_scope || 'full' }}",
      OPENCLAW_CI_PULL_REQUEST_NUMBER: "${{ inputs.pull_request_number }}",
      OPENCLAW_CI_TARGET_REF: "${{ inputs.target_ref }}",
      OPENCLAW_CI_TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
      OPENCLAW_CI_HISTORICAL_TARGET_TAG: "${{ inputs.historical_target_tag }}",
    });
    const validationStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Validate release-gate dispatch",
    );
    expect(validationStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(validationStep.run).toContain(
      "release_gate requires target_ref to be a full commit SHA",
    );
    expect(validationStep.run).toContain("release_gate requires pull_request_number");
    expect(validationStep.run).toContain("release_gate must run from the branch at target_ref");
    expect(validationStep.run).toContain(
      "release_gate cannot be combined with historical_target_tag",
    );
    const diffBaseStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Resolve exact diff base",
    );
    expect(diffBaseStep.env).toMatchObject({
      PULL_REQUEST_NUMBER: "${{ inputs.pull_request_number }}",
      RELEASE_GATE: "${{ inputs.release_gate }}",
    });
    expect(diffBaseStep.run).toContain("refs/pull/${PULL_REQUEST_NUMBER}/merge");
    expect(diffBaseStep.run).toContain('release_gate_head="$(git rev-parse "${merge_ref}^2")"');
    expect(diffBaseStep.run).toContain(
      "release_gate pull request head ${release_gate_head} does not match target ${target_head}",
    );
    expect(diffBaseStep.run).toContain('base_sha="$(git rev-parse "${merge_ref}^1")"');
    expect(diffBaseStep.run).toContain('head_sha="$(git rev-parse "$merge_ref")"');
    expect(diffBaseStep.run).toContain('echo "head_sha=$head_sha" >> "$GITHUB_OUTPUT"');
    const changedScopeStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Detect changed scopes",
    );
    expect(changedScopeStep.if).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(changedScopeStep.env?.OPENCLAW_ALLOW_RELEASE_GENERATED_MIX).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(changedScopeStep.run).toContain('elif [ "${{ github.event_name }}" = "pull_request" ]');
    expect(changedScopeStep.run).toContain('HEAD_SHA="${{ steps.diff_base.outputs.head_sha }}"');
    expect(changedScopeStep.run).toContain(
      'node scripts/ci-changed-scope.mjs --base "$BASE" --head "$HEAD_SHA"',
    );
    expect(workflow.jobs.preflight.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
    });
    expect(workflow.jobs.preflight.outputs.run_ios_screenshots).toBe(
      "${{ steps.changed_scope.outputs.run_ios_screenshots }}",
    );
    const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflowSource).toContain(
      "OPENCLAW_CI_RUN_MACOS: ${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.run_macos || 'false' }}",
    );
    expect(workflowSource).toContain(
      "OPENCLAW_CI_RUN_IOS_BUILD: ${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.run_ios_build || 'false' }}",
    );
    const manifestEnv = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    ).env;
    for (const [
      requestedRunnerBackend,
      isReleaseGate,
      includeAndroid,
      changedAndroid,
      expected,
    ] of [
      ["runson", true, false, false, false],
      ["runson", true, false, true, true],
      ["runson", true, true, false, true],
      ["default", true, false, false, true],
      ["default", false, false, false, false],
      ["default", false, true, false, true],
    ] as const) {
      expect(
        evaluateWorkflowExpression(manifestEnv.OPENCLAW_CI_RUN_ANDROID, {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          requestedRunnerBackend,
          releaseGate: isReleaseGate,
          includeAndroid,
          steps: {
            runner_profile: {
              outputs: {
                runner_profile: "hybrid",
                node_runner_backend: requestedRunnerBackend === "runson" ? "runson" : "hybrid",
              },
            },
            changed_scope: { outputs: { run_android: String(changedAndroid) } },
          },
        }),
        JSON.stringify({ requestedRunnerBackend, isReleaseGate, includeAndroid, changedAndroid }),
      ).toBe(String(expected));
    }
    for (const [environmentKey, scopeKey] of [
      ["OPENCLAW_CI_RUN_WINDOWS", "run_windows"],
      ["OPENCLAW_CI_RUN_SKILLS_PYTHON", "run_skills_python"],
      ["OPENCLAW_CI_RUN_CONTROL_UI_I18N", "run_control_ui_i18n"],
      ["OPENCLAW_CI_RUN_UI_TESTS", "run_ui_tests"],
      ["OPENCLAW_CI_RUN_NATIVE_I18N", "run_native_i18n"],
    ] as const) {
      for (const nodeRunnerBackend of ["runson", "hybrid"]) {
        for (const selected of [false, true]) {
          expect(
            evaluateWorkflowExpression(manifestEnv[environmentKey], {
              eventName: "workflow_dispatch",
              releaseGate: true,
              repository: "openclaw/openclaw",
              runAttempt: 1,
              steps: {
                runner_profile: {
                  outputs: { runner_profile: "hybrid", node_runner_backend: nodeRunnerBackend },
                },
                changed_scope: { outputs: { [scopeKey]: String(selected) } },
              },
            }),
            `${environmentKey}/${nodeRunnerBackend}/${selected}`,
          ).toBe(String(nodeRunnerBackend === "runson" ? selected : true));
        }
      }
    }

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const runsOn = (job as { "runs-on"?: unknown })["runs-on"];
      if (typeof runsOn !== "string" || !runsOn.includes("blacksmith-")) {
        continue;
      }
      expect(
        evaluateWorkflowExpression(runsOn, {
          eventName: "workflow_dispatch",
          releaseGate: true,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerBackend: "hybrid",
        }),
        `${jobName} must use GitHub-hosted capacity for release gates`,
      ).toMatch(/^(?:ubuntu|windows|macos)-/u);
    }

    expect(
      workflow.jobs["macos-node"]["runs-on"],
      "macOS Node retries must escape stalled Blacksmith capacity",
    ).toContain("github.run_attempt > 1");
  });

  it("retains main runner placement and native worker policy for admitted main qualification", () => {
    const workflow = readCiWorkflow();
    const push = {
      eventName: "push" as const,
      repository: "openclaw/openclaw",
      runnerBackend: "hybrid" as const,
      runAttempt: 1,
      matrix: { runner: "blacksmith-8vcpu-ubuntu-2404", check_name: "fixture", task: "test" },
      preflightOutputs: { node_runner_backend: "hybrid", runner_profile: "hybrid" },
    };
    const qualification = {
      ...push,
      eventName: "workflow_dispatch" as const,
      ref: "refs/heads/qualification-branch",
      releaseGate: true,
      ciShape: "main" as const,
      requestedRunnerBackend: "hybrid" as const,
      preflightOutputs: {
        ...push.preflightOutputs,
        ci_qualification: "true",
        ci_shape: "main",
        qualification_runner_backend: "hybrid",
      },
    };
    for (const [name, rawJob] of Object.entries(workflow.jobs)) {
      const job = rawJob as {
        "runs-on": string;
        "timeout-minutes"?: string | number;
        needs?: string[] | string;
      };
      if (!String(job.needs).includes("preflight")) {
        continue;
      }
      for (const key of ["runs-on", "timeout-minutes"] as const) {
        const expression = job[key];
        if (typeof expression === "string" && expression.startsWith("${{")) {
          expect(evaluateWorkflowExpression(expression, qualification), `${name}.${key}`).toEqual(
            evaluateWorkflowExpression(expression, push),
          );
        }
      }
    }
    expect(
      evaluateWorkflowExpression(workflow.jobs.android["timeout-minutes"], {
        ...qualification,
        matrix: { task: "build-play" },
      }),
    ).toBe(20);
    expect(evaluateWorkflowExpression(workflow.jobs.preflight["runs-on"], qualification)).toBe(
      "ubuntu-24.04",
    );
    expect(
      evaluateWorkflowExpression(
        workflow.jobs["macos-swift"].env.OPENCLAWKIT_TEST_EXECUTION,
        qualification,
      ),
    ).toBe("parallel");
    expect(
      evaluateWorkflowExpression(
        `\${{ ${workflow.jobs["checks-node-compat"].if} }}`,
        qualification,
      ),
    ).toBe(false);
  });

  it("starts Apple builds and screenshots directly on hosted capacity", () => {
    const workflow = readCiWorkflow();
    for (const jobName of ["macos-swift", "ios-build", "ios-screenshot-shard"]) {
      expect(evaluateWorkflowRunner(workflow.jobs[jobName]["runs-on"]), jobName).toBe("xcode-27");
    }
    expect(workflow.jobs["macos-swift"]["timeout-minutes"]).toBe(30);
  });

  it("serializes the shared Swift package suite on hosted macOS retries", () => {
    const macosSwift = readCiWorkflow().jobs["macos-swift"];

    expect(macosSwift.env.OPENCLAWKIT_TEST_EXECUTION).toContain("github.run_attempt > 1");
    const openClawKitTests = macosSwift.steps.find(
      (candidate: WorkflowStep) => candidate.name === "OpenClawKit tests",
    );
    expect(openClawKitTests?.run).toContain('if [[ "$OPENCLAWKIT_TEST_EXECUTION" == "parallel" ]]');
    expect(openClawKitTests?.run).toContain("--parallel");
    expect(openClawKitTests?.run).toContain("--no-parallel");
  });

  it("keeps Testbox runner admission and job budget compatible with delegated proof", () => {
    const workflow = readTestboxWorkflow();

    expect(workflow.on.workflow_dispatch.inputs.timeout_minutes.default).toBe(240);
    expect(workflow.jobs.check["timeout-minutes"]).toBe(
      "${{ fromJSON(inputs.timeout_minutes || '240') }}",
    );
    expect(workflow.jobs.check["runs-on"]).toBe(
      "${{ github.event_name == 'pull_request' && 'ubuntu-24.04' || 'blacksmith-16vcpu-ubuntu-2404' }}",
    );
    const beginStep = workflow.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Begin Testbox",
    );
    const runStep = workflow.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Run Testbox",
    );
    expect(beginStep).toMatchObject({
      if: "github.event_name == 'workflow_dispatch'",
      with: { testbox_id: "${{ inputs.testbox_id }}" },
    });
    expect(runStep).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && always()",
    });
  });

  it("keeps every path-filtered hosted gate runnable on landing-relevant events", () => {
    const workflows = [
      [".github/workflows/ci-check-testbox.yml", "check"],
      [".github/workflows/ci-check-arm-testbox.yml", "check-arm"],
      [".github/workflows/ci-build-artifacts-testbox.yml", "build-artifacts"],
    ] as const;

    for (const [workflowPath, jobName] of workflows) {
      const workflow = readWorkflow(workflowPath);
      expect(workflow.on.pull_request).toEqual({
        types: ["opened", "reopened", "synchronize", "ready_for_review"],
        paths: [".github/workflows/**"],
      });
      expect(workflow.jobs[jobName].if).toBe(
        "${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}",
      );
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
    const mainGuard = expectDefined(
      planSteps.find((step) => step.name === "Require a main-branch run"),
      "Docker refresh main-branch guard",
    );
    const resolve = expectDefined(
      planSteps.find((step) => step.name === "Resolve refresh plan"),
      "Docker refresh plan step",
    );

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
    expect(resolve.run).toContain("docker-release-policy.mjs --current");
    expect(resolve.run).toContain('git rev-parse "refs/tags/${stable_tag}^{commit}"');
    expect(resolve.run).toContain('git rev-parse "refs/tags/${extended_stable_tag}^{commit}"');
    expect(resolve.run).toContain('suffix="-r$(date -u +%Y%m%d)"');
    expect(resolve.run).toContain('echo "matrix=${matrix}"');
    expect(resolve.run).toContain('} >> "${GITHUB_OUTPUT}"');
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

  it("forbids moving reusable workflow references", () => {
    expect([...OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS]).toEqual([]);
  });

  it("keeps locale refresh matrices alive and publishes each aggregate through a PR", () => {
    const controlUiWorkflow = parse(readFileSync(CONTROL_UI_LOCALE_REFRESH_WORKFLOW, "utf8"));
    const workflow = parse(readFileSync(NATIVE_APP_LOCALE_REFRESH_WORKFLOW, "utf8"));
    const controlUiResolveBase = controlUiWorkflow.jobs["resolve-base"];
    const nativeResolveBase = workflow.jobs["resolve-base"];
    const controlUiPreflight = controlUiWorkflow.jobs["publisher-preflight"];
    const nativePreflight = workflow.jobs["publisher-preflight"];
    const refresh = workflow.jobs.refresh;
    const nativeFinalize = workflow.jobs.finalize;
    const controlUiFinalize = controlUiWorkflow.jobs.finalize;
    const refreshStep = refresh.steps.find(
      (step: { name?: string }) => step.name === "Refresh locale translations",
    );
    const nativeArtifactStep = refresh.steps.find(
      (step: { name?: string }) => step.name === "Prepare locale artifact",
    );
    const nativeGeneratedStep = nativeFinalize.steps.find(
      (step: { name?: string }) => step.name === "Refresh native generated artifacts",
    );
    const nativeValidationStep = nativeFinalize.steps.find(
      (step: { name?: string }) => step.name === "Validate native locale refresh",
    );
    const nativePublishStep = nativeFinalize.steps.find(
      (step: { name?: string }) => step.name === "Open or update generated locale PR",
    );
    const controlUiRefreshStep = controlUiWorkflow.jobs.refresh.steps.find(
      (step: { name?: string }) => step.name === "Refresh locale translations",
    );
    const controlUiAggregateStep = controlUiFinalize.steps.find(
      (step: { name?: string }) => step.name === "Finalize control UI generated artifacts",
    );
    const controlUiValidationStep = controlUiFinalize.steps.find(
      (step: { name?: string }) => step.name === "Validate control UI locale refresh",
    );

    expect(refresh.if).toBe(
      "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success'",
    );
    expect(refresh.strategy.matrix.locale).toEqual(NATIVE_I18N_LOCALES);
    expect(controlUiWorkflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(controlUiWorkflow.concurrency.group.replace(/\s+/gu, " ")).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.token_preflight_only && format('control-ui-locale-token-preflight-{0}', github.ref) || 'control-ui-locale-refresh' }}",
    );
    expect(controlUiWorkflow.jobs.plan).toBeUndefined();
    expect(controlUiResolveBase.outputs.locales).toBe("${{ steps.base.outputs.locales }}");
    expect(controlUiWorkflow.jobs.refresh.if).toBe(
      "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && !(github.event_name == 'workflow_dispatch' && inputs.token_preflight_only)",
    );
    expect(controlUiWorkflow.jobs.refresh.strategy.matrix.locale).toBe(
      "${{ fromJSON(needs.resolve-base.outputs.locales) }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency.group).toBe("native-app-locale-refresh");
    expect(controlUiResolveBase.if).not.toContain("chore(ui): refresh control ui locales");
    const controlResolveCondition = controlUiResolveBase.if.replace(/\s+/gu, " ");
    expect(controlResolveCondition).toBe(
      "github.repository == 'openclaw/openclaw' && (github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main')",
    );
    expect(controlResolveCondition).not.toContain("inputs.token_preflight_only");
    expect(controlResolveCondition).not.toContain("github.ref_type");
    expect(nativeResolveBase.if).toBe(
      "github.repository == 'openclaw/openclaw' && (github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main')",
    );
    expect(controlUiWorkflow.on.workflow_dispatch.inputs.token_preflight_only).toEqual({
      description: "Verify generated PR App permissions without running locale generation.",
      required: false,
      default: false,
      type: "boolean",
    });
    for (const owner of [workflow, controlUiWorkflow]) {
      expect(owner.on.workflow_dispatch.inputs.full_refresh).toMatchObject({
        default: false,
        type: "boolean",
      });
    }
    expect(workflow.on.push.paths).toContain("ui/src/i18n/.i18n/glossary.*.json");
    expect(nativePublishStep.with["invalidation-paths"].trim().split("\n")).toContain(
      "ui/src/i18n/.i18n/glossary.*.json",
    );
    expect(workflow.on.push.paths).toContain("apps/.i18n/native/**");
    expect(workflow.on.push.paths).toContain("apps/.i18n/native-source.json");
    for (const sourceRoot of [
      "apps/android/app/src/main",
      "apps/android/app/src/play",
      "apps/android/app/src/thirdParty",
      "apps/android/wear/src/main",
      "apps/ios",
      "apps/macos/Sources",
      "apps/shared/OpenClawKit/Sources",
    ]) {
      expect(workflow.on.push.paths).toContain(`${sourceRoot}/**`);
      expect(nativePublishStep.with["invalidation-paths"].trim().split("\n")).toContain(sourceRoot);
    }
    expect(workflow.on.push.paths).toContain("apps/macos/Package.swift");
    expect(nativePublishStep.with["invalidation-paths"]).toContain("apps/macos/Package.swift");
    expect(workflow.on.push.paths).toContain(".github/actions/publish-generated-pr/policy.py");
    expect(nativePublishStep.with["invalidation-paths"]).toContain(
      ".github/actions/publish-generated-pr/policy.py",
    );
    for (const generatorInput of [
      "scripts/android-app-i18n.ts",
      "scripts/apple-app-i18n.ts",
      "scripts/native-app-i18n.ts",
      "scripts/native-i18n-locales.ts",
    ]) {
      expect(workflow.on.push.paths).toContain(generatorInput);
      expect(nativePublishStep.with["invalidation-paths"].trim().split("\n")).toContain(
        generatorInput,
      );
    }
    expect(refreshStep.env.OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY || secrets.OPENAI_API_KEY }}",
    );
    expect(refreshStep.env.OPENCLAW_CONTROL_UI_I18N_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_MODEL }}",
    );
    expect(refreshStep.env.OPENCLAW_I18N_FALLBACK_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_FALLBACK_MODEL }}",
    );
    expect(refreshStep.env.FULL_REFRESH).toBe("${{ inputs.full_refresh || false }}");
    expect(refreshStep.run).toContain("args+=(--force)");
    expect(nativeArtifactStep.run).toContain("git add -A apps/.i18n/native");
    expect(nativeArtifactStep.run).not.toContain("native-source.json");
    expect(nativeGeneratedStep.run).toBe(
      "node --import tsx scripts/native-app-i18n.ts sync --write",
    );
    expect(nativeValidationStep.run).toBe("node --import tsx scripts/native-app-i18n.ts check");
    expect(nativeFinalize.steps.map((step: { name?: string }) => step.name)).not.toContain(
      "Refresh Android native resources",
    );
    expect(nativeFinalize.steps.map((step: { name?: string }) => step.name)).not.toContain(
      "Refresh Apple native resources",
    );
    expect(nativePublishStep.with["generated-paths"].trim().split("\n")).toEqual([
      "apps/.i18n/native",
      "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt",
      "apps/android/app/src/main/res/values*/assistant.xml",
      "apps/android/app/src/main/res/values*/strings.xml",
      "apps/android/app/src/thirdParty/res/values*/accessibility_strings.xml",
      "apps/android/wear/src/main/res/values*/strings.xml",
      "apps/ios/Resources/Localizable.xcstrings",
      "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings",
      "apps/ios/Sources/*.lproj/InfoPlist.strings",
      "apps/ios/WatchApp/*.lproj/InfoPlist.strings",
      "apps/ios/ShareExtension/*.lproj/InfoPlist.strings",
      "apps/ios/ActivityWidget/*.lproj/InfoPlist.strings",
    ]);
    expect(nativePublishStep.with["invalidation-paths"]).toContain("apps/.i18n/native-source.json");
    expect(nativePublishStep.with["invalidation-paths"]).toContain("apps/android/app/src/play");
    expect(nativePublishStep.with["invalidation-paths"]).toContain(
      "apps/android/app/src/thirdParty",
    );
    expect(nativePublishStep.with["auto-merge"]).toBe("true");
    expect(controlUiRefreshStep.env.OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY || secrets.OPENAI_API_KEY }}",
    );
    expect(controlUiRefreshStep.env.OPENCLAW_CONTROL_UI_I18N_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_MODEL }}",
    );
    expect(controlUiRefreshStep.env.OPENCLAW_I18N_FALLBACK_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_FALLBACK_MODEL }}",
    );
    expect(controlUiRefreshStep.env.FULL_REFRESH).toBe("${{ inputs.full_refresh || false }}");
    expect(controlUiRefreshStep.run).toContain("args+=(--force)");
    expect(controlUiRefreshStep.env.OPENCLAW_CONTROL_UI_I18N_AUTH_OPTIONAL).toBe("0");
    const controlUiArtifactStep = controlUiWorkflow.jobs.refresh.steps.find(
      (step: { name?: string }) => step.name === "Prepare locale artifact",
    );
    expect(controlUiArtifactStep.run).toContain(
      ":(exclude)ui/src/i18n/.i18n/catalog-fallbacks.json",
    );
    expect(controlUiArtifactStep.run).toContain("ui/src/i18n/.i18n/${LOCALE}.tm.jsonl");
    expect(controlUiArtifactStep.run).toContain("ui/src/i18n/.i18n/${LOCALE}.meta.json");
    expect(controlUiArtifactStep.run).not.toContain("git add -A ui/src/i18n");
    expect(controlUiAggregateStep.run).toBe(
      "node --import tsx scripts/control-ui-i18n.ts sync --write",
    );
    const controlUiPublishStep = controlUiFinalize.steps.find(
      (step: { name?: string }) => step.name === "Open or update generated locale PR",
    );
    const controlUiCatalogInputs = [
      "scripts/lib/control-ui-i18n-catalog.ts",
      "ui/src/i18n/lib/config-hint-translation.ts",
      "ui/src/lib/fnv1a.ts",
      "src/config/schema*.ts",
      "src/config/zod-schema*.ts",
      "src/config/media-audio-field-metadata.ts",
      "src/config/talk-defaults.ts",
      "src/config/channel-config-keys.ts",
    ];
    const nativeInputOwners = [
      workflow.on.push.paths,
      nativePublishStep.with["invalidation-paths"].trim().split("\n"),
    ];
    const controlUiInputOwners = [
      controlUiWorkflow.on.push.paths,
      controlUiPublishStep.with["invalidation-paths"].trim().split("\n"),
    ];
    for (const catalogInput of controlUiCatalogInputs) {
      for (const ownerPaths of controlUiInputOwners) {
        expect(ownerPaths).toContain(catalogInput);
      }
      for (const ownerPaths of nativeInputOwners) {
        expect(ownerPaths).not.toContain(catalogInput);
      }
    }
    for (const sharedTranslationInput of [
      "scripts/control-ui-i18n.ts",
      "scripts/lib/control-ui-i18n-catalog-values.ts",
      "scripts/lib/control-ui-i18n-config.json",
      "scripts/lib/control-ui-i18n-config.ts",
      "scripts/lib/control-ui-i18n-sync-plan.ts",
    ]) {
      for (const ownerPaths of [...nativeInputOwners, ...controlUiInputOwners]) {
        expect(ownerPaths).toContain(sharedTranslationInput);
      }
    }
    expect(controlUiPublishStep.with["generated-paths"].trim().split("\n")).toEqual([
      "ui/src/i18n/.i18n/*.tm.jsonl",
      "ui/src/i18n/.i18n/*.meta.json",
      "ui/src/i18n/.i18n/catalog-fallbacks.json",
    ]);
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "scripts/lib/control-ui-i18n-sync-plan.ts",
    );
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain("ui/src/i18n/locales/*.ts");
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "ui/src/i18n/locales/en-agents.ts",
    );
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "scripts/control-ui-i18n-verify.ts",
    );
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "scripts/lib/control-ui-i18n-raw-copy.ts",
    );
    expect(controlUiFinalize.steps.indexOf(controlUiAggregateStep)).toBeLessThan(
      controlUiFinalize.steps.indexOf(controlUiValidationStep),
    );

    for (const ownerWorkflow of [controlUiWorkflow, workflow]) {
      expect(ownerWorkflow.on.push.paths).toContain(CREATE_GENERATED_PR_TOKENS_ACTION);
      expect(ownerWorkflow.on.push.paths).toContain(PUBLISH_GENERATED_PR_ACTION);
      const resolveBase = ownerWorkflow.jobs["resolve-base"];
      const resolveStep = resolveBase.steps.find(
        (step: { name?: string }) =>
          step.name ===
          (ownerWorkflow === controlUiWorkflow
            ? "Resolve source commit"
            : "Resolve default branch head"),
      );
      expect(resolveBase.outputs.sha).toBe("${{ steps.base.outputs.sha }}");
      expect(resolveStep.env.GH_TOKEN).toBe("${{ github.token }}");
      if (ownerWorkflow === controlUiWorkflow) {
        expect(resolveStep.run.match(/gh api/gu)).toHaveLength(1);
        expect(resolveStep.run).toContain("gh api graphql");
      } else {
        expect(resolveStep.run).toContain(
          'gh api --method GET "repos/${REPOSITORY}/commits/${DEFAULT_BRANCH}" --jq .sha',
        );
      }
      expect(resolveStep.run).toContain('[[ ! "${sha}" =~ ^[0-9a-f]{40}$ ]]');

      const checkoutSteps = (
        Object.values(ownerWorkflow.jobs) as Array<{
          steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
        }>
      ).flatMap((job: { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }) =>
        (job.steps ?? []).filter((step: WorkflowStep) => step.uses === CHECKOUT_V6),
      );
      expect(checkoutSteps.length).toBeGreaterThan(0);
      for (const checkoutStep of checkoutSteps) {
        expect(checkoutStep.with?.ref).toBe("${{ needs.resolve-base.outputs.sha }}");
        expect(checkoutStep.with?.["persist-credentials"]).toBe(false);
      }
    }

    const controlUiResolveStep = controlUiResolveBase.steps.find(
      (step: { name?: string }) => step.name === "Resolve source commit",
    );
    expect(controlUiResolveStep.env.TOKEN_PREFLIGHT_ONLY).toContain("inputs.token_preflight_only");
    expect(controlUiResolveStep.env.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    expect(controlUiResolveStep.run).toContain(
      'if [[ "${TOKEN_PREFLIGHT_ONLY}" == "true" ]]; then',
    );
    expect(controlUiResolveStep.run).toContain('source_ref="${WORKFLOW_SHA}"');
    expect(controlUiResolveStep.run).toContain(
      '-F configRef="${source_ref}:scripts/lib/control-ui-i18n-config.json"',
    );
    expect(controlUiResolveStep.run).toContain(
      "jq -ce '.data.repository.config.text | fromjson | [.[].locale]",
    );

    for (const preflight of [controlUiPreflight, nativePreflight]) {
      expect(preflight.needs).toBe("resolve-base");
      expect(preflight.if).toBe("needs.resolve-base.result == 'success'");
      expect(preflight.strategy).toBeUndefined();
      expect(preflight.steps).toHaveLength(3);
      const checkoutStep = preflight.steps.find(
        (step: { uses?: string }) => step.uses === CHECKOUT_V6,
      );
      const tokensStep = preflight.steps.find(
        (step: { name?: string }) => step.name === "Create generated PR tokens",
      );
      expect(checkoutStep.with).toMatchObject({
        ref: "${{ needs.resolve-base.outputs.sha }}",
        "persist-credentials": false,
      });
      expect(tokensStep.uses).toBe("./.github/actions/create-generated-pr-tokens");
      expect(tokensStep.with).toEqual({
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
        "pull-request-contents-permission": "write",
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      });
    }
    for (const preflight of [controlUiPreflight, nativePreflight]) {
      const tokensStep = preflight.steps.find(
        (step: { name?: string }) => step.name === "Create generated PR tokens",
      );
      const autoMergeSettingStep = preflight.steps.find(
        (step: { name?: string }) => step.name === "Verify repository auto-merge setting",
      );
      expect(tokensStep.id).toBe("tokens");
      expect(autoMergeSettingStep.env.GH_TOKEN).toBe(
        "${{ steps.tokens.outputs.pull-request-token }}",
      );
      expect(autoMergeSettingStep.run).toContain("autoMergeAllowed");
      expect(autoMergeSettingStep.run).toContain("Repository auto-merge must be enabled");
    }

    const tokenAction = parse(readFileSync(CREATE_GENERATED_PR_TOKENS_ACTION, "utf8"));
    const tokenActionSource = readFileSync(CREATE_GENERATED_PR_TOKENS_ACTION, "utf8");
    const contentsTokenStep = tokenAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated branch app token",
    );
    const pullRequestTokenStep = tokenAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated PR app token",
    );
    const publishAction = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
    const publishActionSource = readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8");
    const createTokensStep = publishAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated PR tokens",
    );
    const actionPublishStep = publishAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Publish generated pull request",
    );

    expect(tokenAction.runs.steps).toHaveLength(2);
    for (const input of [
      "contents-client-id",
      "contents-private-key",
      "pull-request-client-id",
      "pull-request-private-key",
    ]) {
      expect(tokenAction.inputs[input].required).toBe(true);
      expect(publishAction.inputs[input].required).toBe(true);
    }
    expect(`${tokenActionSource}\n${publishActionSource}`).not.toMatch(
      /2729701|2971289|primary-private-key|fallback-private-key/u,
    );
    expect(contentsTokenStep).toEqual({
      name: "Create generated branch app token",
      id: "contents-token",
      uses: CREATE_GITHUB_APP_TOKEN_V3,
      with: {
        "client-id": "${{ inputs.contents-client-id }}",
        "private-key": "${{ inputs.contents-private-key }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "write",
      },
    });
    expect(pullRequestTokenStep).toEqual({
      name: "Create generated PR app token",
      id: "pull-request-token",
      uses: CREATE_GITHUB_APP_TOKEN_V3,
      with: {
        "client-id": "${{ inputs.pull-request-client-id }}",
        "private-key": "${{ inputs.pull-request-private-key }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "${{ inputs.pull-request-contents-permission }}",
        "permission-pull-requests": "write",
      },
    });
    expect(tokenAction.inputs["pull-request-contents-permission"].required).toBe(false);
    expect(tokenAction.outputs["contents-token"].value).toBe(
      "${{ steps.contents-token.outputs.token }}",
    );
    expect(tokenAction.outputs["pull-request-token"].value).toBe(
      "${{ steps.pull-request-token.outputs.token }}",
    );
    expect(createTokensStep).toMatchObject({
      id: "tokens",
      uses: "./.github/actions/create-generated-pr-tokens",
      with: {
        "contents-client-id": "${{ inputs.contents-client-id }}",
        "contents-private-key": "${{ inputs.contents-private-key }}",
        "pull-request-client-id": "${{ inputs.pull-request-client-id }}",
        "pull-request-contents-permission": "${{ inputs.auto-merge == 'true' && 'write' || '' }}",
        "pull-request-private-key": "${{ inputs.pull-request-private-key }}",
      },
    });
    expect(
      publishAction.runs.steps.filter(
        (step: { uses?: string }) => step.uses === CREATE_GITHUB_APP_TOKEN_V3,
      ),
    ).toEqual([]);
    expect(actionPublishStep.env.CONTENTS_TOKEN).toBe("${{ steps.tokens.outputs.contents-token }}");
    expect(actionPublishStep.env.GH_TOKEN).toBe("${{ steps.tokens.outputs.pull-request-token }}");
    expect(actionPublishStep.env.INVALIDATION_PATHS).toBe("${{ inputs.invalidation-paths }}");
    expect(publishAction.inputs["invalidation-paths"]).toEqual({
      description: "Newline-delimited generator input paths that make an older run stale.",
      required: false,
      default: "",
    });
    expect(publishAction.inputs["working-directory"]).toEqual({
      description: "Repository root containing the generated files.",
      required: false,
      default: ".",
    });
    expect(actionPublishStep["working-directory"]).toBe("${{ inputs.working-directory }}");
    expect(publishAction.inputs["overlap-policy"]).toEqual({
      description: "Whether stale inputs or owned-path overlap defer to a successor run or fail.",
      required: false,
      default: "defer",
    });
    expect(publishAction.inputs["auto-merge"]).toEqual({
      description: "Enable squash auto-merge; false rejects an inherited auto-merge request.",
      required: false,
      default: "false",
    });
    expect(actionPublishStep.env.OVERLAP_POLICY).toBe("${{ inputs.overlap-policy }}");
    expect(actionPublishStep.env.AUTO_MERGE).toBe("${{ inputs.auto-merge }}");
    const publishPolicy = readFileSync(".github/actions/publish-generated-pr/policy.py", "utf8");
    expect(actionPublishStep.run).toContain('case "${OVERLAP_POLICY}" in');
    expect(actionPublishStep.run).toContain("defer | fail");
    expect(actionPublishStep.run).toContain("GIT_TERMINAL_PROMPT=0");
    expect(
      actionPublishStep.run.match(/timeout --signal=TERM --kill-after=10s 60s/gu),
    ).toHaveLength(6);
    expect(actionPublishStep.env.PUBLISH_ACTION_PATH).toBe("${{ github.action_path }}");
    expect(actionPublishStep.run).toContain(
      'exec python3 -I -S "$CI_GIT_OWNER" --policy "$PUBLISH_ACTION_PATH/policy.py"',
    );
    expect(actionPublishStep.run).not.toMatch(
      /(?:^|[\s;])git (?:config|fetch|push|diff|ls-tree|ls-remote|rev-parse|merge-base|add|commit|switch|restore|rm)\b/mu,
    );
    expect(publishPolicy).not.toMatch(
      /except (?:Exception|BaseException|SystemExit|RuntimeError)|backoff\(|subprocess\.(?:run|Popen)\([^\n]*["']git/u,
    );
    expect(publishPolicy.match(/timeout=\d+/gu)).toEqual([
      "timeout=60",
      "timeout=120",
      "timeout=60",
    ]);
    for (const contract of [
      'auth_key = "http.https://github.com/.extraheader"',
      'f"AUTHORIZATION: basic {git_auth}"',
      'print(f"::add-mask::{git_auth}"',
      'git("config", "--local", "--unset-all", auth_key)',
      "except GitFailure:",
      "except PublicationFailure as error:",
      "finally:\n    cleanup_git_auth()",
      "--force-with-lease=refs/heads/{head_branch}:{expected_head}",
      "GH013|repository rule violations|required status check",
      "bool(remote_head) and not current_remote_head",
      'push_generated_branch("")',
    ]) {
      expect(publishPolicy).toContain(contract);
    }
    // The real repository scenarios below own overlap, invalidation, tree/lease,
    // reconciliation and auto-merge behavior; spelling is no longer Bash policy.
    for (const contract of [
      'gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls"',
      '-f "head=${GITHUB_REPOSITORY_OWNER}:${HEAD_BRANCH}"',
      ".head.repo.full_name == env.GITHUB_REPOSITORY",
      ".head.ref == env.HEAD_BRANCH",
      ".head.sha",
      "gh pr edit",
      "gh pr create",
      '--base "${BASE_BRANCH}"',
      '--head "${HEAD_BRANCH}"',
      '--body-file "${body_file}"',
      "--json autoMergeRequest",
      '--auto --squash --match-head-commit "${published_commit}"',
    ]) {
      expect(actionPublishStep.run).toContain(contract);
    }
    for (const forbidden of [
      "gh auth setup-git",
      "gh pr list",
      "gh pr close",
      'GH_TOKEN="${CONTENTS_TOKEN}"',
      'HEAD:"${BASE_BRANCH}"',
    ]) {
      expect(actionPublishStep.run).not.toContain(forbidden);
    }
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "OPENCLAW_ALLOW_RELEASE_GENERATED_MIX",
    );

    for (const [
      ownerWorkflow,
      refreshJob,
      finalizeJob,
      artifactPattern,
      commitMessage,
      automationBranch,
    ] of [
      [
        workflow,
        refresh,
        nativeFinalize,
        "native-locale-*",
        "chore(i18n): refresh native locales",
        "automation/native-app-locale-refresh",
      ],
      [
        controlUiWorkflow,
        controlUiWorkflow.jobs.refresh,
        controlUiFinalize,
        "control-ui-locale-*",
        "chore(ui): refresh control ui locales",
        "automation/control-ui-locale-refresh",
      ],
    ] as const) {
      const uploadStep = refreshJob.steps.find(
        (step: { name?: string }) => step.name === "Upload locale artifact",
      );
      const downloadStep = finalizeJob.steps.find(
        (step: { name?: string }) => step.name === "Download locale artifacts",
      );
      const checkoutStep = finalizeJob.steps.find(
        (step: { uses?: string }) => step.uses === CHECKOUT_V6,
      );
      const publishStep = finalizeJob.steps.find(
        (step: { name?: string }) => step.name === "Open or update generated locale PR",
      );

      expect(ownerWorkflow.permissions.contents).toBe("read");
      expect(refreshJob.needs).toEqual(["resolve-base", "publisher-preflight"]);
      expect(finalizeJob.needs).toEqual(["resolve-base", "publisher-preflight", "refresh"]);
      const isNative = automationBranch.includes("native");
      expect(finalizeJob.if).toBe(
        isNative
          ? "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && needs.refresh.result == 'success'"
          : "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && needs.refresh.result == 'success' && !(github.event_name == 'workflow_dispatch' && inputs.token_preflight_only)",
      );
      expect(uploadStep.uses).toBe(UPLOAD_ARTIFACT_V7);
      expect(downloadStep.uses).toBe(DOWNLOAD_ARTIFACT_V8);
      expect(downloadStep.with.pattern).toBe(artifactPattern);
      expect(downloadStep.with["merge-multiple"]).toBe(true);
      expect(checkoutStep.with["persist-credentials"]).toBe(false);
      expect(checkoutStep.with["fetch-depth"]).toBe(0);
      expect(publishStep.uses).toBe("./.github/actions/publish-generated-pr");
      expect(publishStep.with).toMatchObject({
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
        "base-branch": "${{ github.event.repository.default_branch }}",
        "head-branch": automationBranch,
        "commit-message": commitMessage,
        "pr-title": commitMessage,
      });
      expect(publishStep.with["generated-paths"]).toContain(
        automationBranch.includes("native") ? "apps/.i18n/native" : "ui/src/i18n",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        automationBranch.includes("native")
          ? "apps/android/app/src/main"
          : "ui/src/i18n/locales/en.ts",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        ".github/actions/create-generated-pr-tokens/action.yml",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        ".github/actions/publish-generated-pr/action.yml",
      );
      expect(publishStep.with).not.toHaveProperty("overlap-policy");
      expect(publishStep.with["auto-merge"]).toBe("true");
      expect(publishStep.with["pr-body"]).toContain("## What Problem This Solves");
      expect(publishStep.with["pr-body"]).toContain("## Evidence");
      expect(publishStep.with["pr-body"]).toContain("${{ needs.resolve-base.outputs.sha }}");
      expect(publishStep.with["pr-body"]).not.toContain("${{ github.sha }}");
    }
  });

  it.skipIf(process.platform === "win32")(
    "enables auto-merge for the exact generated pull request head",
    () => {
      const result = runGeneratedPublisherScenario(null, { autoMerge: true });

      expect(result.branchExists).toBe(true);
      expect(result.mergeCalls).toContain("pr merge https://github.com/openclaw/openclaw/pull/1");
      expect(result.mergeCalls).toContain("--auto --squash --match-head-commit");
      expect(result.summary).toContain("Enabled squash auto-merge for exact generated head");
    },
  );

  it.skipIf(process.platform === "win32")(
    "waits for the published pull request head before enabling auto-merge",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        stalePrViewHeadOnce: true,
      });

      expect(result.mergeCalls).toContain("--auto --squash --match-head-commit");
      expect(result.publishOutput).toContain(
        "Generated pull request head has not converged yet; rechecking",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves inherited auto-merge while replacing a generated pull request head",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
      });

      expect(result.generatedA).toBe("desired-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).toContain(
        "Squash auto-merge already enabled for generated pull request",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts inherited auto-merge completing immediately after publication",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        mergeGeneratedPush: true,
      });

      expect(result.branchExists).toBe(false);
      expect(result.mainGeneratedA).toBe("desired-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).toContain(
        "Generated output was merged before pull request reconciliation",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "waits for the existing pull request head before replacing it",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        stalePrHeadOnce: true,
      });

      expect(result.generatedA).toBe("desired-a");
      expect(result.publishOutput).toContain(
        "Generated pull request head has not converged yet; rechecking",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to replace an auto-merge-enabled head when publication opts out",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: false,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        expectFailure: true,
      });

      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.publishOutput).toContain("auto-merge enabled while publication opted out");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not mutate inherited auto-merge when generated publication fails",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        expectFailure: true,
        failGeneratedPush: true,
      });

      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).not.toContain("auto-merge");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an incompatible inherited auto-merge method without mutating it",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "MERGE",
        existingPr: true,
        expectFailure: true,
      });

      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.publishOutput).toContain(
        "Generated pull request already uses incompatible MERGE auto-merge",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers a newer owned snapshot even when the desired diff is disjoint",
    () => {
      const result = runGeneratedPublisherScenario("b");

      expect(result.branchExists).toBe(false);
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers stale generator inputs and preserves an existing pull request and disarms auto-merge",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        updateSource: true,
      });

      expect(result.branchHead).not.toBe(result.mainHead);
      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
      expect(result.mergeCalls).toContain("--disable-auto");
      expect(result.summary).toContain("Preserved stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers timing refits when only the runtime group codec changes on main",
    () => {
      const workflow = readWorkflow(".github/workflows/ci-test-timings-refit.yml");
      const publisher = expectDefined(
        workflow.jobs.refit.steps.find(
          (step: WorkflowStep) => step.uses === "./.github/actions/publish-generated-pr",
        ),
        "timing refit publisher",
      );
      const result = runGeneratedPublisherScenario(null, {
        invalidationPaths: publisher.with["invalidation-paths"],
        updateSource: "scripts/lib/ci-node-test-groups-codec.mts",
      });

      expect(result.branchExists).toBe(false);
      expect(result.mainGeneratedA).toBe("old-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["src/config/schema.help.runtime.ts", "src/config/zod-schema.agent-runtime.ts"])(
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
    "defers native publication when shared translation config changes",
    () => {
      const workflow = readWorkflow(NATIVE_APP_LOCALE_REFRESH_WORKFLOW);
      const publisher = expectDefined(
        workflow.jobs.finalize.steps.find(
          (step: WorkflowStep) => step.uses === "./.github/actions/publish-generated-pr",
        ),
        "native locale publisher",
      );
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        invalidationPaths: publisher.with["invalidation-paths"],
        updateSource: "scripts/lib/control-ui-i18n-config.json",
      });

      expect(result.branchHead).toBe(result.initialBranch);
      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toContain("--disable-auto");
      expect(result.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "publishes after unrelated source changes when input invalidation is disabled",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        invalidationPaths: "",
        overlapPolicy: "fail",
        updateSource: true,
      });

      expect(result.branchExists).toBe(true);
      expect(result.generatedA).toBe("desired-a");
      expect(result.publishOutput).not.toContain("Refusing stale generated output");
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves an existing pull request when a no-change run becomes stale",
    () => {
      const result = runGeneratedPublisherScenario("b", {
        existingPr: true,
        noGeneratedChange: true,
      });

      expect(result.branchHead).toBe(result.initialBranch);
      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.generatedB).toBe("old-b");
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
      expect(result.summary).toContain("Preserved stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32").each([false, true])(
    "disarms stale output when inputs advance during PR publication (inherited=%s)",
    (inherited) => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingPr: inherited,
        existingAutoMergeMethod: inherited ? "SQUASH" : undefined,
        updateSourceBeforeAutoMerge: true,
      });
      expect(result.generatedA).toBe("desired-a");
      expect(result.branchHead).not.toBe(result.mainHead);
      expect(result.mergeCalls).not.toContain("--auto --squash");
      expect(result.mergeCalls.includes("--disable-auto")).toBe(inherited);
      expect(result.summary).toContain("Deferred stale generated output");
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves a current no-change run's existing pull request and auto-merge unchanged",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        noGeneratedChange: true,
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
      });
      expect(result.branchHead).toBe(result.initialBranch);
      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).toBe("");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not overwrite a successor that moves while stale auto-merge is disabled",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        updateSource: true,
        existingAutoMergeMethod: "SQUASH",
        autoMerge: true,
        disarmRace: true,
        expectFailure: true,
      });
      expect(result.branchHead).not.toBe(result.initialBranch);
      expect(result.generatedA).toBe("old-a");
      expect(result.mergeCalls).toContain("--disable-auto");
      expect(result.mergeCalls).not.toContain("--auto --squash");
      expect(result.summary).not.toContain("Preserved stale");
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

      const publishRun = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8")).runs.steps.find(
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
    const cases = [
      {
        workflowPath: OPENGREP_PR_DIFF_WORKFLOW,
        artifactName: "opengrep-pr-diff-sarif",
      },
      {
        workflowPath: OPENGREP_FULL_WORKFLOW,
        artifactName: "opengrep-full-sarif",
      },
    ];

    for (const item of cases) {
      const workflow = parse(readFileSync(item.workflowPath, "utf8"));
      const uploadStep = workflow.jobs.scan.steps.find(
        (step: WorkflowStep) => step.name === "Upload SARIF as workflow artifact",
      );

      expect(uploadStep.if, item.workflowPath).toBe("always()");
      expect(uploadStep.uses, item.workflowPath).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with, item.workflowPath).toMatchObject({
        name: item.artifactName,
        path: ".opengrep-out/precise.sarif",
        "if-no-files-found": "error",
      });
    }
  });

  it("verifies the pinned OpenGrep release binary before installing it", () => {
    for (const workflowPath of [OPENGREP_PR_DIFF_WORKFLOW, OPENGREP_FULL_WORKFLOW]) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const installStep = expectDefined(
        workflow.jobs.scan.steps.find((step: WorkflowStep) => step.name === "Install opengrep"),
        `Install opengrep step in ${workflowPath}`,
      );
      const run = expectDefined(installStep.run, `Install opengrep script in ${workflowPath}`);

      expect(installStep.env, workflowPath).toMatchObject({
        OPENGREP_VERSION: "v1.30.0",
        OPENGREP_LINUX_X64_SHA256:
          "35779bdd72e92129c8df2a77f0c55e8c08356801ea92591ef32108d6b28d564c",
      });
      expect(run, workflowPath).toContain('binary="$(mktemp "${RUNNER_TEMP}/opengrep.XXXXXX")"');
      expect(run, workflowPath).toContain("trap 'rm -f \"$binary\"' EXIT");
      expect(run, workflowPath).toContain(
        "curl -fsSL --retry 4 --retry-all-errors --retry-delay 2",
      );
      expect(run, workflowPath).toContain("--connect-timeout 10 --max-time 300");
      expect(run, workflowPath).toContain('-o "$binary"');
      expect(run, workflowPath).toContain(
        "https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/opengrep_manylinux_x86",
      );
      expect(run, workflowPath).toContain(
        'printf \'%s  %s\\n\' "$OPENGREP_LINUX_X64_SHA256" "$binary" | sha256sum --check',
      );
      expect(run, workflowPath).toContain('install -m 0755 "$binary" "$install_dir/opengrep"');
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

    expect(action).toContain("base-sha:");
    expect(action).toContain("docs_only:");
    expect(action).toContain("docs_changed:");
    expect(action).toContain("BASE_SHA: ${{ inputs.base-sha }}");
    expect(action).toContain('BASE="$BASE_SHA"');
    expect(action).toContain(
      'CHANGED=$(git diff --no-renames --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")',
    );
    expect(action).toContain('if [ "$CHANGED" = "UNKNOWN" ] || [ -z "$CHANGED" ]; then');
    expect(action).toContain("docs_only=false");
    expect(action).toContain("docs_changed=false");
    expect(action).toContain("test/fixtures/*)");
    expect(action).toContain("docs/* | *.md | *.mdx | config/markdownlint*.jsonc)");

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
      });
      expect(readFileSync(trace, "utf8")).not.toContain('"fetch"');
      expect(localObjects()).not.toContain(sourceBlob);
    }
  });

  it("runs generated docs checks in the docs-only job", () => {
    const job = readCiWorkflow().jobs["check-docs"];
    const configDocsCheck = job.steps.find(
      (step: WorkflowStep) => step.name === "Check config docs baseline",
    );
    const pluginInventoryCheck = job.steps.find(
      (step: WorkflowStep) => step.name === "Check plugin inventory",
    );

    expect(job.if).toBe("needs.preflight.outputs.run_check_docs == 'true'");
    expect(configDocsCheck?.run).toBe("pnpm config:docs:check");
    expect(pluginInventoryCheck?.run).toBe("pnpm plugins:inventory:check");
  });

  it("bounds matrix fan-out for runner-registration pressure", () => {
    const workflow = readCiWorkflow();

    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name == 'pull_request'",
    );
    expect(workflow.jobs["checks-fast-core"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-node-core-test-nondist-shard"].strategy["max-parallel"]).toBe(96);
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
      [{ eventName: "pull_request", authorAssociation: "NONE" }, 2],
      [{ eventName: "push", runnerBackend: "github" }, 2],
      [{ eventName: "push", runnerBackend: "blacksmith", runAttempt: 2 }, 2],
      [{ eventName: "workflow_dispatch", runnerBackend: "blacksmith" }, 2],
      [{ eventName: "pull_request", headRepository: "contributor/openclaw" }, 2],
      [{ eventName: "push", repository: "contributor/openclaw" }, 2],
    ] as const) {
      expect(
        evaluateWorkflowExpression(workflow.jobs.android.strategy["max-parallel"], {
          repository: "openclaw/openclaw",
          runAttempt: 1,
          ...context,
        }),
        JSON.stringify(context),
      ).toBe(expected);
    }
  });

  it("runs the Docker seed tier with the published updater and a checked main smoke package", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const jobs = readCiWorkflow().jobs;
    const job = jobs["docker-seed-e2e"];
    expect(source).toContain("docker-seed-e2e-contract-v1");
    expect(source).toContain('typeof dockerSeedPlan.resolveDockerSeedLanes === "function"');
    expect(jobs.preflight.outputs).toMatchObject({
      docker_seed_lanes: "${{ steps.manifest.outputs.docker_seed_lanes }}",
      run_docker_seed_e2e: "${{ steps.manifest.outputs.run_docker_seed_e2e }}",
    });
    expect(job.if).toBe("needs.preflight.outputs.run_docker_seed_e2e == 'true'");
    expect(job.needs).toEqual(["preflight"]);
    expect(job["timeout-minutes"]).toBe(60);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.strategy).toBeUndefined();
    expect(job.steps[0]).toEqual(jobs["build-artifacts"].steps[0]);
    expect(job.steps[1].uses).toBe("./.ci-harness/.github/actions/setup-node-env");
    expect(job.steps[1].with).toMatchObject({
      "build-all-cache-scope": "full",
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
    });
    const run = job.steps.find(
      (step: WorkflowStep) => step.name === "Run Docker seed tier",
    ) as WorkflowStep;
    const parallelism = run.env?.OPENCLAW_DOCKER_ALL_PARALLELISM;
    expect(run).toMatchObject({
      run: "pnpm test:docker:all",
      env: {
        OPENCLAW_DOCKER_ALL_LANES: "${{ needs.preflight.outputs.docker_seed_lanes }}",
        OPENCLAW_DOCKER_ALL_LIVE_MODE: "skip",
        OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG: "1",
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "legacy-operator-state",
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
        OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM: parallelism,
      },
    });
    expect(parallelism).toContain("&& 3 || 1");
    expect(run.env).not.toHaveProperty("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC");
    const prepare = job.steps.find(
      (step: WorkflowStep) => step.name === "Prepare main Docker smoke package",
    ) as WorkflowStep;
    for (const eventName of ["push", "pull_request"] as const) {
      expect(
        evaluateWorkflowExpression("${{ " + prepare.if + " }}", {
          eventName,
          repository: "openclaw/openclaw",
          runAttempt: 1,
        }),
      ).toBe(eventName === "push");
    }
    expect(prepare.run).toContain("pnpm build:ci-artifacts");
    expect(prepare.run).toContain("node scripts/package-openclaw-for-docker.mjs --skip-build");
    expect(prepare.run).not.toContain("--skip-check");
    expect(prepare.run).toContain("OPENCLAW_CURRENT_PACKAGE_TGZ=");
    expect(job.steps.indexOf(prepare)).toBeLessThan(job.steps.indexOf(run));
    const baseline = job.steps.find(
      (step: WorkflowStep) => step.name === "Resolve published Docker seed upgrade baseline",
    ) as WorkflowStep;
    expect(baseline.if).toBe(
      "contains(format(' {0} ', needs.preflight.outputs.docker_seed_lanes), ' published-upgrade-survivor ')",
    );
    expect(baseline.env).toEqual({
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref || github.base_ref || github.ref_name }}",
    });
    expect(job.steps.indexOf(baseline)).toBeLessThan(job.steps.indexOf(run));
    const survivorProof = job.steps.find(
      (step: WorkflowStep) => step.name === "Upload sanitized upgrade survivor proof",
    ) as WorkflowStep;
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

  it.each([
    { candidate: "2026.9.3", expected: "openclaw@2026.9.2" },
    { candidate: "2026.9.2", expected: "openclaw@2026.9.1" },
    { candidate: "2026.9.4-beta.1", expected: "openclaw@2026.9.3" },
    { candidate: "2026.9.3-beta.1", expected: "openclaw@2026.9.2" },
    {
      candidate: "2026.6.35",
      context: "extended-stable/2026.6.33",
      expected: "openclaw@2026.6.34",
    },
    { candidate: "2026.6.34", expected: undefined },
  ])("hands Docker seed a strictly older published baseline for $candidate", (fixture) => {
    const job = readCiWorkflow().jobs["docker-seed-e2e"];
    const baseline = job.steps.find(
      (step: WorkflowStep) => step.name === "Resolve published Docker seed upgrade baseline",
    ) as WorkflowStep | undefined;
    const run = job.steps.find(
      (step: WorkflowStep) => step.name === "Run Docker seed tier",
    ) as WorkflowStep;
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-upgrade-baseline-"));
    try {
      const bin = path.join(root, "bin");
      const tooling = path.join(root, ".ci-harness", "scripts", "lib");
      mkdirSync(bin);
      mkdirSync(tooling, { recursive: true });
      for (const name of ["release-upgrade-baseline.mjs", "release-version.mjs"]) {
        copyFileSync(path.resolve("scripts", "lib", name), path.join(tooling, name));
      }
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ version: fixture.candidate }),
      );
      writeFileSync(
        path.join(root, ".ci-harness", "package.json"),
        JSON.stringify({ version: "2026.10.1" }),
      );
      symlinkSync(process.execPath, path.join(bin, "node"));
      writeFileSync(
        path.join(bin, "npm"),
        `#!${process.execPath}
const args = process.argv.slice(2);
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
`,
        { mode: 0o755 },
      );
      writeFileSync(path.join(root, "github-env"), "");
      const inheritedBaseline = run.env?.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC;
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
            TARGET_CONTEXT_REF: fixture.context ?? "main",
          },
        },
      );
      const receipt = path.join(root, "scheduler-baseline");
      if (fixture.expected) {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(receipt, "utf8")).toBe(fixture.expected);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("no published stable OpenClaw baseline predates candidate");
        expect(existsSync(receipt)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps Windows projects serial on each runner while shard jobs remain parallel",
    () => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs["checks-windows"];
      const runStep = job.steps.find(
        (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
      );
      const cwd = tempDirs.make("windows-project-budget-");
      const bin = path.join(cwd, "bin");
      mkdirSync(bin);
      writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({
          scripts: { "test:windows:ci:1": "fixture", "test:windows:ci:2": "fixture" },
        }),
      );
      const pnpm = path.join(bin, "pnpm");
      writeFileSync(
        pnpm,
        '#!/bin/sh\nprintf "project_parallelism=%s\\n" "${OPENCLAW_TEST_PROJECTS_PARALLEL:-1}"\n',
      );
      chmodSync(pnpm, 0o755);
      const targets = ["test/windows-first.test.ts", "test/windows-second.test.ts"];
      mkdirSync(path.join(cwd, "scripts"));
      writeFileSync(path.join(cwd, "scripts/tsx.mjs"), "export {};\n");
      writeFileSync(
        path.join(cwd, "scripts/test-projects.mts"),
        `
        console.log("project_parallelism=" + process.env.OPENCLAW_TEST_PROJECTS_PARALLEL);
        console.log("targets=" + JSON.stringify(process.argv.slice(2)));
      `,
      );
      for (const task of ["test", "test-1", "test-2"]) {
        for (const runner of ["github-hosted", "self-hosted"]) {
          const result = runWorkflowShellScript(runStep.run, {
            cwd,
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              TASK: task,
              WINDOWS_TARGETS_JSON: String(
                evaluateWorkflowExpression(runStep.env.WINDOWS_TARGETS_JSON, {
                  eventName: "push",
                  repository: "openclaw/openclaw",
                  runAttempt: 1,
                  matrix: { targets },
                }),
              ),
              RUNNER_ENVIRONMENT: runner,
              OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
            },
          });
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(result.stdout).toContain("project_parallelism=1");
          if (task === "test") {
            expect(result.stdout).toContain(
              `targets=${JSON.stringify([...targets, "--fileParallelism"])}`,
            );
          }
        }
      }
      expect(job.strategy["max-parallel"]).toBe(5);
      expect(runStep.env.OPENCLAW_VITEST_MAX_WORKERS).toBe(
        "${{ runner.environment == 'self-hosted' && 4 || 1 }}",
      );
      expect(runStep.run).toContain("pnpm test:windows:ci:1 -- --fileParallelism");
      expect(runStep.run).toContain("pnpm test:windows:ci:2 -- --fileParallelism");
    },
  );

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

    const sdkRestoreStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Restore Android SDK cache"),
      "Android SDK cache restore step",
    );
    const sdkSaveStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Save Android SDK cache"),
      "Android SDK cache save step",
    );
    const gradleCacheStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Setup Gradle cache"),
      "Gradle cache setup step",
    );
    const javaStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Setup Java"),
      "Android Java setup step",
    );
    const installStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Install Android SDK packages"),
      "Android SDK package install step",
    );

    expect(javaStep.uses).toBe("actions/setup-java@de7274f081f381c8f8158605e0321c36c376e2e6");
    expect(javaStep.with).toMatchObject({
      distribution: "temurin",
      "java-version": 17,
    });
    expect(javaStep.with?.["set-default"]).not.toBe(false);
    const gradleJavaStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Setup Gradle Java"),
      "Gradle Java setup step",
    );
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
    expect(sdkRestoreStep.with?.key).toContain(
      "${{ inputs.install-screenshot-emulators == 'true' && 'screenshot-emulators' || 'base' }}",
    );
    expect(String(sdkRestoreStep.with?.["restore-keys"])).toContain(
      "inputs.install-screenshot-emulators == 'true'",
    );
    expect(sdkSaveStep.if).toContain("inputs.cache-mode == 'read-write'");
    expect(sdkSaveStep.if).toContain("steps.android-sdk-cache.outputs.cache-hit != 'true'");
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
  });

  it("binds frozen target context to the declared live release branch", () => {
    const workflow = readCiWorkflow();
    const input = workflow.on.workflow_dispatch.inputs.target_context_ref;
    const step = expectDefined(
      workflow.jobs.preflight.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Validate target context",
      ),
      "target context validation step",
    );
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
  });

  it.each([
    { kind: "historical", ref: "v2026.8.1" },
    { kind: "historical", ref: "v2026.8.1-beta.2" },
    { kind: "historical", ref: "v2026.8.1-1" },
    { kind: "candidate", ref: "release/2026.8.1" },
    { kind: "candidate", ref: "release/2026.8.1-1" },
    { kind: "candidate", ref: "extended-stable/2026.8.33" },
  ] as const)("binds authenticated $kind ref $ref to its exact commit", (identity) => {
    const targetSha = "a".repeat(40);
    const accepted = runCiReleaseRefValidation({ ...identity, targetSha, resolvedSha: targetSha });
    expect(accepted.status, accepted.output).toBe(0);
    expect(accepted.outputs.eligible).toBe("true");

    const mismatched = runCiReleaseRefValidation({ ...identity, targetSha });
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.output).toContain(`does not resolve to ${targetSha}`);
    expect(mismatched.outputs).not.toHaveProperty("eligible");
  });

  it.each([
    { kind: "context", ref: "release/2026.8.1", apiError: "ref" },
    { kind: "context", ref: "release/2026.8.1", apiError: "comparison" },
    { kind: "historical", ref: "v2026.8.1", apiError: "ref" },
    { kind: "candidate", ref: "release/2026.8.1", apiError: "ref" },
  ] as const)("rejects unavailable authenticated $kind $apiError evidence", (identity) => {
    const targetSha = "a".repeat(40);
    const result = runCiReleaseRefValidation({
      ...identity,
      targetSha,
      resolvedSha: targetSha,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("HTTP 503");
    expect(result.outputs).not.toHaveProperty("eligible");
  });

  it.each([
    { kind: "historical", ref: "refs/heads/v2026.8.1" },
    { kind: "historical", ref: "release/2026.8.1" },
    { kind: "candidate", ref: "refs/tags/release/2026.8.1" },
    { kind: "candidate", ref: "v2026.8.1" },
  ] as const)("rejects wrong-namespace $kind ref $ref before remote admission", (identity) => {
    const result = runCiReleaseRefValidation({ ...identity, targetSha: "a".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("must be a canonical OpenClaw release");
    expect(result.outputs).not.toHaveProperty("eligible");
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

  it("selects the declared compiler for native builds and analysis", () => {
    const codeql = parse(
      readFileSync(".github/workflows/codeql-macos-critical-security.yml", "utf8"),
    );
    const codeqlJob = codeql.jobs.macos;
    const codeqlSelect = expectDefined(
      codeqlJob.steps.find((step: WorkflowStep) => step.name === "Select Xcode"),
      "CodeQL macOS Xcode selection",
    );

    const codeqlInitializeIndex = codeqlJob.steps.findIndex(
      (step: WorkflowStep) => step.name === "Initialize CodeQL",
    );
    const codeqlBuildIndex = codeqlJob.steps.findIndex(
      (step: WorkflowStep) => step.name === "Build macOS for CodeQL",
    );
    const codeqlAnalyzeIndex = codeqlJob.steps.findIndex(
      (step: WorkflowStep) => step.name === "Analyze",
    );
    const codeqlBuild = expectDefined(codeqlJob.steps[codeqlBuildIndex], "CodeQL macOS build");
    const codeqlPrepare = codeql.jobs["prepare-mermaid"];
    const codeqlPrepareSteps = codeqlPrepare.steps as WorkflowStep[];
    const codeqlPrepareCheckout = expectDefined(
      codeqlPrepareSteps.find((step) => step.name === "Checkout"),
      "CodeQL Mermaid checkout",
    );
    const codeqlPrepareSetup = expectDefined(
      codeqlPrepareSteps.find((step) => step.name === "Setup Node environment"),
      "CodeQL Mermaid Node setup",
    );
    const codeqlPrepareInstall = expectDefined(
      codeqlPrepareSteps.find((step) => step.name === "Install Mermaid renderer dependencies"),
      "CodeQL Mermaid dependency install",
    );
    const codeqlPrepareAssets = expectDefined(
      codeqlPrepareSteps.find((step) => step.name === "Prepare Apple Mermaid assets"),
      "CodeQL Mermaid asset preparation",
    );
    const codeqlUpload = expectDefined(
      codeqlPrepareSteps.find((step) => step.name === "Upload Mermaid assets"),
      "CodeQL Mermaid artifact upload",
    );
    const codeqlDownloadIndex = codeqlJob.steps.findIndex(
      (step: WorkflowStep) => step.name === "Download Mermaid assets",
    );
    const codeqlDownload = expectDefined(
      codeqlJob.steps[codeqlDownloadIndex],
      "CodeQL Mermaid artifact download",
    );

    expect(evaluateWorkflowRunner(codeqlPrepare["runs-on"])).toBe("ubuntu-24.04");
    expect(codeqlPrepare["timeout-minutes"]).toBe(10);
    expect(codeqlPrepare.permissions).toEqual({ contents: "read" });
    expect(codeqlPrepare.outputs["artifact-id"]).toBe("${{ steps.upload.outputs.artifact-id }}");
    expect(codeqlPrepareCheckout.with).toMatchObject({
      "fetch-depth": 1,
      "persist-credentials": false,
      ref: "${{ github.sha }}",
      submodules: false,
    });
    expect(codeqlPrepareSetup.with).toMatchObject({
      "cache-mode": "restore",
      "install-bun": "false",
      "install-deps": "false",
    });
    expect(codeqlPrepareInstall.env).toEqual({ CI: "true" });
    expect(codeqlPrepareInstall.run).toContain(
      "pnpm install --frozen-lockfile --prefer-offline --optional",
    );
    expect(codeqlPrepareInstall.run).toContain("--filter '@openclaw/mermaid-renderer...'");
    expect(codeqlPrepareInstall.run).toContain("--config.ignore-scripts=false");
    expect(codeqlPrepareInstall.run).toContain("--config.engine-strict=false");
    expect(codeqlPrepareInstall.run).toContain("--config.enable-pre-post-scripts=true");
    expect(codeqlPrepareInstall.run).toContain("--config.side-effects-cache=true");
    expect(codeqlPrepareAssets.run).toBe("node scripts/prepare-apple-mermaid.mjs");
    expect(codeqlUpload).toMatchObject({
      id: "upload",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "codeql-macos-mermaid-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid",
        "if-no-files-found": "error",
        "retention-days": 1,
      },
    });
    expect(codeqlPrepareSteps.indexOf(codeqlPrepareInstall)).toBeLessThan(
      codeqlPrepareSteps.indexOf(codeqlPrepareAssets),
    );
    expect(codeqlPrepareSteps.indexOf(codeqlPrepareAssets)).toBeLessThan(
      codeqlPrepareSteps.indexOf(codeqlUpload),
    );
    expect(codeqlJob.needs).toBe("prepare-mermaid");
    expect(evaluateWorkflowRunner(codeqlJob["runs-on"])).toBe("macos-26-intel");
    expect(codeqlJob["timeout-minutes"]).toBe(90);
    const codeqlCheckout = expectDefined(
      codeqlJob.steps.find((step: WorkflowStep) => step.name === "Checkout"),
      "CodeQL macOS checkout",
    );
    expect(codeqlCheckout.with).toMatchObject({
      "fetch-depth": 1,
      "persist-credentials": false,
      ref: "${{ github.sha }}",
      submodules: false,
    });
    expect(
      codeqlJob.steps.some(
        (step: WorkflowStep) => step.uses === "./.github/actions/setup-node-env",
      ),
    ).toBe(false);
    expect(
      codeqlJob.steps.some((step: WorkflowStep) => step.run?.includes("prepare-apple-mermaid.mjs")),
    ).toBe(false);
    expect(codeqlDownload).toMatchObject({
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        "artifact-ids": "${{ needs.prepare-mermaid.outputs.artifact-id }}",
        path: "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid",
      },
    });
    expect(codeqlDownloadIndex).toBeLessThan(codeqlInitializeIndex);
    expect(codeqlInitializeIndex).toBeGreaterThanOrEqual(0);
    expect(codeqlInitializeIndex).toBeLessThan(codeqlBuildIndex);
    expect(codeqlBuildIndex).toBeLessThan(codeqlAnalyzeIndex);
    expect(codeqlBuild.run).toBe(
      "swift build --package-path apps/macos --product OpenClaw --arch arm64 --disable-index-store -debug-info-format none",
    );
    expect(codeqlSelect.run).toContain("/Applications/Xcode_26.6.app/Contents/Developer");
    expect(codeqlSelect.run).toContain('if [[ "$xcode_version" != 26.6* ]]; then');

    for (const [workflowPath, jobNames] of [
      [".github/workflows/ci.yml", ["macos-swift", "ios-build", "ios-screenshot-shard"]],
      [".github/workflows/ios-periphery.yml", ["scan"]],
      [".github/workflows/macos-periphery.yml", ["scan"]],
      [".github/workflows/shared-openclawkit-periphery.yml", ["scan-ios", "scan-macos"]],
    ] as const) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      for (const jobName of jobNames) {
        const job = workflow.jobs[jobName];
        expect(evaluateWorkflowRunner(job["runs-on"]), `${workflowPath}: ${jobName}`).toBe(
          "xcode-27",
        );
        const selection = expectDefined(
          job.steps.find((step: WorkflowStep) =>
            ["Select Xcode 27", "Verify Xcode"].includes(step.name ?? ""),
          ),
          `${workflowPath}: ${jobName} toolchain selection`,
        );
        const toolingRoot = workflowPath === ".github/workflows/ci.yml" ? ".ci-harness/" : "";
        expect(selection.run).toContain(`source ${toolingRoot}scripts/lib/swift-toolchain.sh`);
        expect(selection.run).toContain("select_xcode_toolchain 27.0");
      }
    }
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
      "sparse-checkout": ".github/actions",
    });
    expect(checkoutIndex).toBeLessThan(actionCheckoutIndex);
    expect(actionCheckoutIndex).toBeLessThan(setupIndex);
  });

  it("bounds Android SDK command-line tools downloads", () => {
    const action = readAndroidToolchainAction();
    const restoreStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Restore Android SDK cache"),
      "Android SDK cache restore step",
    );
    const setupStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) =>
        step.run?.includes("commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"),
      ),
      "Android SDK setup step",
    );

    expect(restoreStep.with?.key).toBe(
      "${{ runner.os }}-android-sdk-v2-cmdline-15859902-platform-37.0-build-tools-36.0.0-${{ inputs.install-screenshot-emulators == 'true' && 'screenshot-emulators' || 'base' }}",
    );
    expect(String(restoreStep.with?.["restore-keys"]).trim().split("\n")).toEqual([
      "${{ inputs.install-screenshot-emulators == 'true' && format('{0}-android-sdk-v2-cmdline-15859902-platform-37.0-build-tools-36.0.0-base', runner.os) || '' }}",
      "${{ runner.os }}-android-sdk-v1-cmdline-15859902-platform-37.0-build-tools-36.0.0",
      "${{ runner.os }}-android-sdk-v1-cmdline-15859902-",
    ]);
    expect(setupStep.run).toContain('CMDLINE_TOOLS_VERSION="15859902"');
    expect(setupStep.run).toContain(
      'CMDLINE_TOOLS_SHA256="4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583"',
    );
    expect(setupStep.run).toContain("curl -fsSL --connect-timeout 10 --max-time 300");
    expect(setupStep.run).toContain("sha256sum --check -");
  });

  it("covers Android app variants, lint, and benchmark compilation", () => {
    const workflow = readCiWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const androidJob = workflow.jobs.android;
    const runStep = expectDefined(
      androidJob.steps.find((step: WorkflowStep) => step.name === "Run Android ${{ matrix.task }}"),
      "Android task runner",
    );
    const nativeResourcesSetup = expectDefined(
      androidJob.steps.find(
        (step: WorkflowStep) => step.name === "Setup Node environment for native resources",
      ),
      "Android native resources Node setup",
    );
    const buildPlayCase = expectDefined(
      runStep.run?.match(/^\s*build-play\)\n([\s\S]*?)^\s*;;$/mu)?.[1],
      "Android build-play case",
    );
    const buildTasks = [
      ":app:assemblePlayDebug",
      ":app:assembleThirdPartyDebug",
      ":app:lintPlayDebug",
      ":app:lintThirdPartyDebug",
      ":benchmark:assembleDebug",
      ":wear-shared:assembleDebug",
      ":wear-shared:lintDebug",
    ];
    const buildRoot = tempDirs.make("openclaw-android-build-routing-");
    const commandLog = path.join(buildRoot, "gradle.log");
    writeExecutable(path.join(buildRoot, "gradlew"), [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$GRADLE_LOG"',
    ]);
    const buildContexts = (["", "github", "blacksmith", "hybrid"] as const).flatMap(
      (runnerBackend) => [
        {
          runnerBackend,
          eventName: "push" as const,
          mainShape: false,
          runAttempt: 1,
          expectedCommands: runnerBackend === "github" ? 3 : 1,
        },
        {
          runnerBackend,
          eventName: "workflow_dispatch" as const,
          mainShape: false,
          runAttempt: 1,
          expectedCommands: 3,
        },
        {
          runnerBackend,
          eventName: "workflow_dispatch" as const,
          mainShape: true,
          runAttempt: 1,
          expectedCommands: 1,
        },
        {
          runnerBackend,
          eventName: "workflow_dispatch" as const,
          mainShape: true,
          runAttempt: 2,
          expectedCommands: 3,
        },
      ],
    );
    for (const {
      runnerBackend,
      eventName,
      mainShape,
      runAttempt,
      expectedCommands,
    } of buildContexts) {
      const context = {
        eventName,
        runAttempt,
        repository: "openclaw/openclaw",
        runnerBackend,
        matrix: { task: "build-play" },
        preflightOutputs: {
          ci_shape: mainShape ? "main" : "default",
          ci_qualification: String(mainShape),
          qualification_runner_backend: mainShape ? "hybrid" : "",
        },
      };
      const expectedHosted = expectedCommands === 3;
      expect(evaluateWorkflowExpression(androidJob["runs-on"], context)).toBe(
        expectedHosted ? "ubuntu-24.04" : "blacksmith-8vcpu-ubuntu-2404",
      );
      expect(evaluateWorkflowExpression(androidJob["timeout-minutes"], context)).toBe(
        expectedHosted ? 35 : 20,
      );
      expect(evaluateWorkflowExpression(runStep.env.CI_RUNNER_BACKEND, context)).toBe(
        expectedHosted ? "github" : "blacksmith",
      );
      writeFileSync(commandLog, "");
      const result = runWorkflowShellScript(buildPlayCase, {
        cwd: buildRoot,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: eventName,
          GRADLE_LOG: commandLog,
          CI_RUNNER_BACKEND: String(
            evaluateWorkflowExpression(runStep.env.CI_RUNNER_BACKEND, context),
          ),
          CI_MAIN_QUALIFICATION: String(
            evaluateWorkflowExpression(runStep.env.CI_MAIN_QUALIFICATION, context),
          ),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const commands = readFileSync(commandLog, "utf8").trim().split("\n");
      expect(commands, `${runnerBackend}/${eventName}/${mainShape}/${runAttempt}`).toHaveLength(
        expectedCommands,
      );
      const tasks = commands.flatMap((command) =>
        command.split(/\s+/u).filter((argument) => argument.startsWith(":")),
      );
      expect(tasks.toSorted()).toEqual(buildTasks.toSorted());
      if (expectedCommands === 1) {
        expect(tasks).toEqual(buildTasks);
      }
    }

    expect(source).toContain('task: useCompatibleAndroidCi ? "test-play-compat" : "test-play"');
    expect(source).toContain('task: "test-third-party"');
    expect(source.match(/check_name: "android-build-play"/gu)).toHaveLength(1);
    expect(source).toContain('task: useCompatibleAndroidCi ? "build-play-compat" : "build-play"');
    expect(androidJob.name).toBe("${{ matrix.check_name || 'android' }}");
    expect(runStep.env.CI_RUNNER_BACKEND).toContain(
      "contains(fromJSON('[\"hybrid\",\"runson\"]'), (needs.preflight.outputs.ci_qualification == 'true' && (github.run_attempt == 1 && needs.preflight.outputs.qualification_runner_backend || 'github') || vars.OPENCLAW_CI_RUNNER_BACKEND)) && github.run_attempt > 1",
    );
    expect(nativeResourcesSetup.uses).toBe("./.ci-harness/.github/actions/setup-node-env");
    expect(nativeResourcesSetup.if).toBe(
      "needs.preflight.outputs.use_compatible_android_ci != 'true'",
    );
    expect(nativeResourcesSetup.with).toMatchObject({
      "install-bun": "false",
      "install-deps": "false",
    });
    const nativeResourcesInstall = expectDefined(
      androidJob.steps.find(
        (step: WorkflowStep) => step.name === "Install Mermaid renderer dependencies",
      ),
      "Android native resources dependency install",
    );
    expect(nativeResourcesInstall.if).toBe(nativeResourcesSetup.if);
    expect(nativeResourcesInstall.env).toEqual({ CI: "true" });
    expect(nativeResourcesInstall.run.trim().split(/\s+/u)).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--optional",
      "--filter",
      "'@openclaw/mermaid-renderer...'",
      "--config.ignore-scripts=false",
      "--config.engine-strict=false",
      "--config.enable-pre-post-scripts=true",
      "--config.side-effects-cache=true",
    ]);
    expect(androidJob.steps.indexOf(nativeResourcesSetup)).toBeLessThan(
      androidJob.steps.indexOf(nativeResourcesInstall),
    );
    expect(androidJob.steps.indexOf(nativeResourcesInstall)).toBeLessThan(
      androidJob.steps.indexOf(runStep),
    );
  });

  it.each(["plugin", "channel"] as const)(
    "joins %s contract envelopes and stops admission on any failure",
    (family) => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs[`checks-fast-${family}-contracts-shard`];
      const step = job.steps.find(
        (candidate: WorkflowStep) => candidate.name === `Run ${family} contract shard`,
      );
      expect(step.env.OPENCLAW_CONTRACT_INCLUDE_PATTERNS_JSON).toBe("${{ toJson(matrix) }}");
      expect(step.env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe(family === "channel" ? "4" : undefined);
      const fixture = tempDirs.make("openclaw-contract-groups-");
      const binDir = path.join(fixture, "bin");
      mkdirSync(binDir);
      const commandLog = path.join(fixture, "commands.jsonl");
      const pnpm = path.join(binDir, "pnpm");
      writeFileSync(
        pnpm,
        String.raw`#!${process.execPath}
const fs = require("node:fs");
const files = JSON.parse(fs.readFileSync(process.env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"));
const record = { args: process.argv.slice(2), files, parallel: process.env.OPENCLAW_TEST_PROJECTS_PARALLEL ?? null };
fs.appendFileSync(process.env.CONTRACT_COMMAND_LOG, JSON.stringify({ ...record, phase: "start" }) + "\n");
setImmediate(() => {
  fs.appendFileSync(process.env.CONTRACT_COMMAND_LOG, JSON.stringify({ ...record, phase: "end" }) + "\n");
  process.exitCode = files[0] === "first.test.ts" ? Number(process.env.CONTRACT_FIRST_EXIT) : 0;
});

`,
      );
      chmodSync(pnpm, 0o755);
      for (const firstExit of [0, 7, 143]) {
        writeFileSync(commandLog, "");
        const run = runWorkflowShellScript(step.run, {
          cwd: fixture,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RUNNER_TEMP: fixture,
            CONTRACT_COMMAND_LOG: commandLog,
            CONTRACT_FIRST_EXIT: String(firstExit),
            OPENCLAW_TEST_PROJECTS_PARALLEL: step.env.OPENCLAW_TEST_PROJECTS_PARALLEL,
            OPENCLAW_CONTRACT_INCLUDE_PATTERNS_JSON: JSON.stringify({
              task: `contracts-${family}s`,
              groups: [
                { checkName: "first-envelope", includePatterns: ["first.test.ts"] },
                { checkName: "second-envelope", includePatterns: ["second.test.ts"] },
              ],
            }),
          },
        });
        expect(run.status, `${run.stdout}${run.stderr}`).toBe(firstExit);
        const files = firstExit === 0 ? ["first.test.ts", "second.test.ts"] : ["first.test.ts"];
        expect(
          readFileSync(commandLog, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          files.flatMap((file) =>
            ["start", "end"].map((phase) => ({
              args: [`test:contracts:${family}s`],
              files: [file],
              parallel: family === "channel" ? "4" : null,
              phase,
            })),
          ),
        );
      }
    },
  );

  it("keeps CodeQL critical quality scans off Blacksmith registrations", () => {
    const source = readCriticalQualityWorkflow();
    const workflow = parse(source);
    const blacksmithJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job && typeof job === "object")
      .filter(([, job]) => (job as Record<string, unknown>)["runs-on"] !== "ubuntu-24.04")
      .map(([name]) => name);

    expect(blacksmithJobs).toEqual([]);
    expect(source).not.toContain("blacksmith-");
  });

  it("keeps trusted hybrid controls on Blacksmith when optional hosted admission is closed", () => {
    const workflow = readCiWorkflow();
    expect(evaluateWorkflowRunner(workflow.jobs["ci-gate"]["runs-on"])).toBe("ubuntu-24.04");
    const context = {
      eventName: "pull_request",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerBackend: "hybrid",
    } as const;

    for (const jobName of ["preflight", "security-fast"]) {
      const expression = workflow.jobs[jobName]["runs-on"];
      for (const eventName of ["pull_request", "push"] as const) {
        expect(evaluateWorkflowExpression(expression, { ...context, eventName }), jobName).toBe(
          jobName === "preflight"
            ? "blacksmith-16vcpu-ubuntu-2404"
            : "blacksmith-4vcpu-ubuntu-2404",
        );
      }
      for (const override of [
        { runAttempt: 0 },
        { runAttempt: 2 },
        { runAttempt: 2, headRepository: "contributor/openclaw" },
        { runnerBackend: "github" },
        { eventName: "workflow_dispatch" },
        { repository: "contributor/openclaw" },
        { authorAssociation: "NONE", headRepository: "contributor/openclaw" },
      ] as const) {
        expect(evaluateWorkflowExpression(expression, { ...context, ...override }), jobName).toBe(
          "ubuntu-24.04",
        );
      }
      for (const runnerBackend of ["", "blacksmith"] as const) {
        for (const eventName of ["pull_request", "push"] as const) {
          expect(
            evaluateWorkflowExpression(expression, { ...context, eventName, runnerBackend }),
            jobName,
          ).toBe(jobName === "security-fast" ? "ubuntu-24.04" : "blacksmith-4vcpu-ubuntu-2404");
        }
      }
    }
    for (const [jobName, task, expected] of [
      ["preflight", undefined, "blacksmith-16vcpu-ubuntu-2404"],
      ["security-fast", undefined, "ubuntu-24.04"],
      ["checks-ui", undefined, "ubuntu-24.04"],
      ["checks-ui-e2e", "browser-extension", "ubuntu-24.04"],
      ["checks-ui-e2e", "control-ui", "blacksmith-16vcpu-ubuntu-2404"],
      ["checks-ui-e2e-real-gateway", undefined, "blacksmith-32vcpu-ubuntu-2404"],
    ] as const) {
      expect(
        evaluateWorkflowExpression(workflow.jobs[jobName]["runs-on"], {
          ...context,
          matrix: { task },
          preflightOutputs: { hybrid_hosted_offload: "true" },
        }),
        `${jobName}: ${task ?? "default"}`,
      ).toBe(expected);
    }
    for (const authorAssociation of ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]) {
      for (const headRepository of ["openclaw/openclaw", "contributor/openclaw"]) {
        expect(
          evaluateWorkflowExpression(workflow.jobs.preflight["runs-on"], {
            ...context,
            authorAssociation,
            headRepository,
          }),
          `${authorAssociation}: ${headRepository}`,
        ).toBe("blacksmith-16vcpu-ubuntu-2404");
      }
    }
  });

  it.each(
    [
      {
        file: "full-release-validation.yml",
        runner: "blacksmith-4vcpu-ubuntu-2404",
        jobs: [
          "release_checks_independent",
          "release_checks_candidate",
          "performance",
          "release_execution_plan",
          "release_decision",
          "diagnostic_drain",
        ],
      },
      {
        file: "openclaw-npm-preflight.yml",
        runner: "blacksmith-32vcpu-ubuntu-2404",
        jobs: [
          "check_openclaw_npm",
          "prepare_openclaw_npm",
          "check_sdk_npm",
          "check_dependencies_npm",
          "check_contents_npm",
          "verify_openclaw_npm",
        ],
      },
      {
        file: "qa-live-transports-convex.yml",
        runner: "blacksmith-8vcpu-ubuntu-2404",
        jobs: ["authorize_actor", "validate_selected_ref"],
      },
      {
        file: "qa-live-transports-convex.yml",
        runner: "blacksmith-16vcpu-ubuntu-2404",
        jobs: [
          "run_mock_parity",
          "run_live_runtime_token_efficiency",
          "run_live_matrix",
          "run_live_buzz",
          "run_live_telegram",
          "run_live_discord",
          "run_live_whatsapp",
          "run_live_slack",
        ],
      },
      {
        file: "openclaw-performance.yml",
        runner: "blacksmith-16vcpu-ubuntu-2404",
        jobs: ["kova", "source_performance"],
      },
      {
        file: "npm-telegram-beta-e2e.yml",
        runner: "blacksmith-32vcpu-ubuntu-2404",
        jobs: ["run_package_telegram_e2e"],
      },
      {
        file: "openclaw-live-and-e2e-checks-reusable.yml",
        runner: "blacksmith-32vcpu-ubuntu-2404",
        jobs: ["validate_docker_openwebui"],
      },
      {
        file: "openclaw-release-checks.yml",
        runner: "blacksmith-8vcpu-ubuntu-2404",
        jobs: ["qa_lab_runtime_pair_lane_release_checks"],
      },
    ].flatMap(({ file, runner, jobs }) => jobs.map((job) => ({ file, runner, job }))),
  )("honors the global hosted runner override for $file/$job", ({ file, runner, job }) => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
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
                repository: "openclaw/openclaw",
                runAttempt: 1,
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

  it.each(["", "release/2026.9.1"])(
    "honors trusted dispatch runner selection for check shards with context %j",
    (targetContextRef) => {
      const runsOn = readCiWorkflow().jobs["check-shard"]["runs-on"];
      const lintMatrix = {
        runner: "blacksmith-32vcpu-ubuntu-2404",
        task: "lint",
      };
      const evaluateDispatch = (
        runnerBackend: "blacksmith" | "github" | "hybrid",
        overrides: {
          dispatchId?: string;
          frozenTarget?: boolean;
          matrix?: Record<string, unknown>;
          releaseGate?: boolean;
          repository?: string;
          targetContextRef?: string;
        } = {},
      ) =>
        evaluateWorkflowExpression(runsOn, {
          eventName: "workflow_dispatch",
          matrix: lintMatrix,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerBackend,
          ...overrides,
        });

      expect(evaluateDispatch("blacksmith")).toBe("blacksmith-32vcpu-ubuntu-2404");
      expect(evaluateDispatch("blacksmith", { releaseGate: true })).toBe("ubuntu-24.04");
      expect(evaluateDispatch("github")).toBe("ubuntu-24.04");
      expect(evaluateDispatch("hybrid")).toBe("ubuntu-24.04");

      const frozenFrv = {
        dispatchId: "full-release-validation-33128772779-ci",
        frozenTarget: true,
        targetContextRef,
      };
      expect(evaluateDispatch("hybrid", frozenFrv)).toBe("blacksmith-32vcpu-ubuntu-2404");
      expect(evaluateDispatch("github", frozenFrv)).toBe("ubuntu-24.04");
      expect(evaluateDispatch("hybrid", { ...frozenFrv, frozenTarget: false })).toBe(
        "ubuntu-24.04",
      );
      expect(evaluateDispatch("hybrid", { ...frozenFrv, dispatchId: "manual-ci-proof" })).toBe(
        "ubuntu-24.04",
      );
      expect(evaluateDispatch("hybrid", { ...frozenFrv, releaseGate: true })).toBe("ubuntu-24.04");
      expect(
        evaluateDispatch("hybrid", {
          ...frozenFrv,
          matrix: { runner: "blacksmith-16vcpu-ubuntu-2404", task: "test-types" },
        }),
      ).toBe("ubuntu-24.04");
      expect(evaluateDispatch("hybrid", { ...frozenFrv, repository: "fork/openclaw" })).toBe(
        "ubuntu-24.04",
      );
      expect(
        evaluateWorkflowExpression(runsOn, {
          authorAssociation: "NONE",
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          matrix: lintMatrix,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerBackend: "blacksmith",
        }),
      ).toBe("ubuntu-24.04");
    },
  );

  it("encodes GitHub, Blacksmith, and hybrid runner-backend shapes", () => {
    const workflow = readCiWorkflow();
    const jobs = workflow.jobs as Record<string, { "runs-on": unknown }>;
    const expectedHostedRunners = {
      android: "ubuntu-24.04",
      "build-artifacts": "ubuntu-24.04",
      "check-additional-shard": "ubuntu-24.04",
      "check-shard": "ubuntu-24.04",
      "checks-baseline-ratchets": "ubuntu-24.04",
      "checks-fast-channel-contracts-shard": "ubuntu-24.04",
      "checks-fast-core": "ubuntu-24.04",
      "checks-fast-plugin-contracts-shard": "ubuntu-24.04",
      "checks-node-compat": "ubuntu-24.04",
      "checks-node-core-test-nondist-shard": "ubuntu-24.04",
      "checks-ui": "ubuntu-24.04",
      "checks-ui-e2e": "ubuntu-24.04",
      "checks-ui-e2e-real-gateway": "ubuntu-24.04",
      "control-ui-i18n": "ubuntu-24.04",
      "control-ui-performance": "ubuntu-24.04",
      "docker-seed-e2e": "ubuntu-24.04",
      "macos-node": "macos-15",
      "native-i18n": "ubuntu-24.04",
      preflight: "ubuntu-24.04",
      "security-fast": "ubuntu-24.04",
      "qa-smoke-ci-profile": "ubuntu-24.04",
      "skills-python": "ubuntu-24.04",
      "check-test-types-hosted-core-shard": "ubuntu-24.04",
      "checks-windows": "windows-2025",
    } as const;
    const expectedHybridFirstAttemptRunners = {
      ...expectedHostedRunners,
      preflight: "blacksmith-16vcpu-ubuntu-2404",
      "security-fast": "blacksmith-4vcpu-ubuntu-2404",
      android: "blacksmith-8vcpu-ubuntu-2404",
      "build-artifacts": "blacksmith-16vcpu-ubuntu-2404",
      "checks-node-core-test-nondist-shard": "blacksmith-32vcpu-ubuntu-2404",
      "checks-ui-e2e": "blacksmith-8vcpu-ubuntu-2404",
      "checks-ui-e2e-real-gateway": "blacksmith-32vcpu-ubuntu-2404",
      "docker-seed-e2e": "blacksmith-16vcpu-ubuntu-2404",
      "qa-smoke-ci-profile": "blacksmith-16vcpu-ubuntu-2404",
      "check-test-types-hosted-core-shard": "blacksmith-16vcpu-ubuntu-2404",
      "checks-ui": "blacksmith-8vcpu-ubuntu-2404",
      "checks-windows": "blacksmith-16vcpu-windows-2025",
    } as const;
    const expectedHybridForkRunners = {
      ...expectedHybridFirstAttemptRunners,
      "docker-seed-e2e": "ubuntu-24.04",
    } as const;
    const configurableJobs = Object.entries(jobs)
      .filter(
        ([, job]) =>
          String(job["runs-on"]).includes("OPENCLAW_CI_RUNNER_BACKEND") ||
          String(job["runs-on"]).includes("matrix.runner"),
      )
      .map(([jobName]) => jobName)
      .toSorted();
    const canonicalPullRequest = {
      eventName: "pull_request",
      headRepository: "openclaw/openclaw",
      matrix: { runner: "blacksmith-32vcpu-ubuntu-2404" },
      repository: "openclaw/openclaw",
      runAttempt: 1,
    } as const;
    expect(configurableJobs).toEqual(Object.keys(expectedHostedRunners).toSorted());
    expect(evaluateWorkflowRunner(jobs["check-lint-hosted-core-shard"]?.["runs-on"])).toBe(
      "ubuntu-24.04",
    );
    expect(evaluateWorkflowRunner(jobs["check-lint-hosted-extension-shard"]?.["runs-on"])).toBe(
      "ubuntu-24.04",
    );
    // check-docs stays hosted in every mode: its ClawHub clone is unauthenticated by design.
    expect(evaluateWorkflowRunner(jobs["check-docs"]?.["runs-on"])).toBe("ubuntu-24.04");
    for (const [jobName, hostedRunner] of Object.entries(expectedHostedRunners)) {
      const expression = jobs[jobName]?.["runs-on"];
      for (const [label, overrides, expectedRunner] of [
        ["github backend", { runnerBackend: "github" }, hostedRunner],
        [
          "hybrid first attempt",
          { runnerBackend: "hybrid" },
          expectedHybridFirstAttemptRunners[jobName as keyof typeof expectedHostedRunners],
        ],
        ["hybrid retry", { runnerBackend: "hybrid", runAttempt: 2 }, hostedRunner],
        [
          "RunsOn ordinary rows retain hybrid routing",
          { runnerBackend: "runson" },
          expectedHybridFirstAttemptRunners[jobName as keyof typeof expectedHostedRunners],
        ],
        ["RunsOn retry", { runnerBackend: "runson", runAttempt: 2 }, hostedRunner],
        [
          "explicit Blacksmith matches default",
          { runnerBackend: "blacksmith" },
          evaluateWorkflowExpression(expression, canonicalPullRequest),
        ],
        // New contributors stay hosted. GitHub can also report maintainers as
        // CONTRIBUTOR when organization membership is concealed.
        [
          "untrusted fork",
          {
            authorAssociation: "NONE",
            headRepository: "contributor/openclaw",
            runnerBackend: "hybrid",
          },
          hostedRunner,
        ],
        [
          "returning-contributor fork",
          {
            authorAssociation: "CONTRIBUTOR",
            headRepository: "contributor/openclaw",
            runnerBackend: "hybrid",
          },
          expectedHybridForkRunners[jobName as keyof typeof expectedHostedRunners],
        ],
      ] as const) {
        expect(
          evaluateWorkflowExpression(expression, { ...canonicalPullRequest, ...overrides }),
          `${jobName}: ${label}`,
        ).toBe(expectedRunner);
      }
      for (const runnerBackend of ["", "blacksmith", "hybrid"] as const) {
        expect(
          evaluateWorkflowExpression(expression, {
            ...canonicalPullRequest,
            authorAssociation: "CONTRIBUTOR",
            headRepository: "contributor/openclaw",
            runnerBackend,
            runAttempt: 2,
          }),
          `${jobName}: returning-contributor fork retry (${runnerBackend || "unset"})`,
        ).toBe(hostedRunner);
      }
    }

    const widenedHybridMatrixRows = [
      ...["lint", "test-types", "dependencies"].map((task) => ({
        jobName: "check-shard",
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", task },
        runner: "blacksmith-32vcpu-ubuntu-2404",
      })),
      ...["extension-package-boundary", "runtime-topology-architecture"].map((group) => ({
        jobName: "check-additional-shard",
        matrix: { group, runner: "blacksmith-32vcpu-ubuntu-2404" },
        runner: "blacksmith-32vcpu-ubuntu-2404",
      })),
      {
        jobName: "check-additional-shard",
        matrix: { group: "plugin-sdk-api-diff", runner: "blacksmith-4vcpu-ubuntu-2404" },
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      ...[4, 8].map((size) => ({
        jobName: "checks-node-core-test-nondist-shard",
        matrix: { runner: `blacksmith-${size}vcpu-ubuntu-2404` },
        runner: `blacksmith-${size}vcpu-ubuntu-2404`,
      })),
      // Preserve planner capacity for parallel, tooling and explicit large owners.
      ...["small-3", "small-4", "small-7", "small-10", "large-10", "large32-1"].map((bin) => ({
        jobName: "checks-node-core-test-nondist-shard",
        matrix: {
          check_name: `checks-node-compact-${bin}`,
          runner: "blacksmith-32vcpu-ubuntu-2404",
        },
        runner: "blacksmith-32vcpu-ubuntu-2404",
      })),
      ...[
        ["changed-extensions-bundle-16", 8],
        ["changed-extensions-bundle-25", 8],
        ["compact-large-5", 16],
        ["compact-large-9", 16],
      ].map(([bin, size]) => ({
        jobName: "checks-node-core-test-nondist-shard",
        matrix: { check_name: `checks-node-${bin}`, runner: "blacksmith-8vcpu-ubuntu-2404" },
        runner: `blacksmith-${size}vcpu-ubuntu-2404`,
      })),
    ] as const;
    for (const { jobName, matrix, runner } of widenedHybridMatrixRows) {
      const expression = jobs[jobName]?.["runs-on"];
      for (const [label, overrides, expectedRunner] of [
        ["hybrid attempt 1", { runnerBackend: "hybrid" }, runner],
        ["hybrid main", { eventName: "push", runnerBackend: "hybrid" }, runner],
        ["Blacksmith main", { eventName: "push", runnerBackend: "blacksmith" }, runner],
        ["hybrid retry", { runnerBackend: "hybrid", runAttempt: 2 }, "ubuntu-24.04"],
        ["github backend", { runnerBackend: "github" }, "ubuntu-24.04"],
        [
          "untrusted fork pull request",
          {
            authorAssociation: "NONE",
            headRepository: "contributor/openclaw",
            runnerBackend: "hybrid",
          },
          "ubuntu-24.04",
        ],
        [
          "workflow dispatch",
          { eventName: "workflow_dispatch", runnerBackend: "hybrid" },
          "ubuntu-24.04",
        ],
      ] as const) {
        expect(
          evaluateWorkflowExpression(expression, { ...canonicalPullRequest, matrix, ...overrides }),
          `${jobName}: ${label}`,
        ).toBe(expectedRunner);
      }
    }
  });

  it("gives breaker-routed hosted jobs their hosted timeout budgets", () => {
    const workflow = readCiWorkflow();
    const jobs = workflow.jobs as Record<string, { "timeout-minutes": unknown }>;
    const expectedHostedTimeouts = {
      android: 35,
      "build-artifacts": 35,
      "checks-ui": 35,
      "checks-ui-e2e-real-gateway": 40,
    } as const;
    const routeDependentTimeoutJobs = Object.entries(jobs)
      .filter(([, job]) => {
        const timeout = job["timeout-minutes"];
        return typeof timeout === "string" && timeout.includes("github.");
      })
      .map(([jobName]) => jobName)
      .toSorted();
    const canonicalPullRequest = {
      eventName: "pull_request",
      headRepository: "openclaw/openclaw",
      matrix: { task: "build-play" },
      repository: "openclaw/openclaw",
      runAttempt: 1,
    } as const;
    const evaluateTimeout = (
      jobName: string,
      context: Parameters<typeof evaluateWorkflowExpression>[1],
    ) => {
      const value = jobs[jobName]?.["timeout-minutes"];
      return typeof value === "number" ? value : evaluateWorkflowExpression(value, context);
    };

    for (const [jobName, hostedTimeout] of Object.entries(expectedHostedTimeouts)) {
      for (const [overrides, expectedTimeout] of [
        [{ runnerBackend: "github" }, hostedTimeout],
        [{ runnerBackend: "blacksmith" }, 20],
        [{ runnerBackend: "hybrid" }, 20],
        [{ runnerBackend: "hybrid", runAttempt: 2 }, hostedTimeout],
      ] as const) {
        expect(evaluateTimeout(jobName, { ...canonicalPullRequest, ...overrides }), jobName).toBe(
          expectedTimeout,
        );
      }
      expect(jobs[jobName]?.["timeout-minutes"], jobName).toContain(
        "(needs.preflight.outputs.ci_qualification == 'true' && (github.run_attempt == 1 && needs.preflight.outputs.qualification_runner_backend || 'github') || vars.OPENCLAW_CI_RUNNER_BACKEND) == 'github'",
      );
    }
    expect(routeDependentTimeoutJobs).toEqual(Object.keys(expectedHostedTimeouts).toSorted());

    const androidRunStep = expectDefined(
      workflow.jobs.android.steps.find(
        (step: WorkflowStep) => step.name === "Run Android ${{ matrix.task }}",
      ),
      "Android task runner",
    );
    const androidRunEnv = expectDefined(androidRunStep.env, "Android task environment");
    const androidRoutes = [
      ["GitHub override", { runnerBackend: "github" }, "ubuntu-24.04"],
      ["hybrid retry", { runnerBackend: "hybrid", runAttempt: 2 }, "ubuntu-24.04"],
      ["manual dispatch", { eventName: "workflow_dispatch" }, "ubuntu-24.04"],
      ["non-canonical repository", { repository: "contributor/openclaw" }, "ubuntu-24.04"],
      ["untrusted author", { authorAssociation: "NONE" }, "ubuntu-24.04"],
      [
        "untrusted fork",
        { authorAssociation: "FIRST_TIME_CONTRIBUTOR", headRepository: "contributor/openclaw" },
        "ubuntu-24.04",
      ],
      [
        "trusted fork first attempt",
        { headRepository: "contributor/openclaw" },
        "blacksmith-8vcpu-ubuntu-2404",
      ],
      [
        "trusted fork retry",
        { headRepository: "contributor/openclaw", runAttempt: 2 },
        "ubuntu-24.04",
      ],
      ["same-repository Blacksmith retry", { runAttempt: 2 }, "blacksmith-8vcpu-ubuntu-2404"],
    ] as const;
    for (const [label, overrides, runner] of androidRoutes) {
      const context = { ...canonicalPullRequest, ...overrides };
      expect(evaluateWorkflowExpression(workflow.jobs.android["runs-on"], context), label).toBe(
        runner,
      );
      if (runner === "ubuntu-24.04") {
        expect(evaluateWorkflowExpression(androidRunEnv.CI_RUNNER_BACKEND, context), label).toBe(
          "github",
        );
      }
      for (const task of [
        "build-play",
        "build-play-compat",
        "build-wear",
        "ktlint",
        "test-play",
        "test-play-compat",
        "test-third-party",
        "test-wear",
      ]) {
        for (const lint of [undefined, false, true]) {
          const extendedBudget = task === "build-play" && runner === "ubuntu-24.04";
          expect(
            evaluateTimeout("android", { ...context, matrix: { task, lint } }),
            `${label}: ${task}, lint=${lint}`,
          ).toBe(extendedBudget ? 35 : 20);
        }
      }
    }

    const realGateway = workflow.jobs["checks-ui-e2e-real-gateway"];
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      for (const repository of ["openclaw/openclaw", "contributor/openclaw"]) {
        for (const authorAssociation of ["CONTRIBUTOR", "NONE"]) {
          for (const runnerBackend of ["", "blacksmith", "github", "hybrid"] as const) {
            for (const runAttempt of [1, 2]) {
              const context = {
                ...canonicalPullRequest,
                eventName,
                repository,
                authorAssociation,
                runnerBackend,
                runAttempt,
              };
              const runner = evaluateWorkflowExpression(realGateway["runs-on"], context);
              expect(
                evaluateTimeout("checks-ui-e2e-real-gateway", context),
                JSON.stringify(context),
              ).toBe(runner === "ubuntu-24.04" ? 40 : 20);
            }
          }
        }
      }
    }
  });

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
      const action = parse(readFileSync(actionPath, "utf8"));
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
      const parsed = parse(readFileSync(file, "utf8"));
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
    expect(writeAuthorizedCallers).toHaveLength(4);
    expect(writeAuthorizedCallers).toEqual(
      expect.arrayContaining([
        {
          file: ".github/workflows/ci-build-artifacts-testbox.yml",
          mode: expect.stringContaining("'read-write'"),
          step: expect.objectContaining({ name: "Setup Node environment" }),
        },
        {
          file: ".github/workflows/openclaw-npm-preflight.yml",
          mode: "read-write",
          step: expect.objectContaining({ name: "Setup Node environment" }),
        },
        {
          file: ".github/workflows/vitest-cache-warm.yml",
          mode: "read-write",
          step: expect.objectContaining({ name: "Setup Node environment" }),
        },
      ]),
    );

    const nodeCachePathPattern =
      /(?:^|\n)\s*(?:\.artifacts\/build-all-cache|dist\/|dist-runtime\/|packages\/\*\/dist\/|extensions\/\*\/dist\/|~\/\.cache\/ms-playwright|~\/\.local\/share\/pnpm|~\/\.cache\/pnpm|node_modules)(?:\n|$)/u;
    for (const { file, step, jobId, jobCondition } of directCaches) {
      if (step.uses?.startsWith("actions/cache/save@")) {
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

  it("owns one exact immutable semantic dependency cache", () => {
    const actionSource = readFileSync(".github/actions/setup-node-env/action.yml", "utf8");
    const ciSource = readFileSync(".github/workflows/ci.yml", "utf8");
    const action = parse(actionSource);
    const workflow = parse(ciSource);
    const actionSteps = action.runs.steps as WorkflowStep[];
    const step = (name: string) =>
      expectDefined(
        actionSteps.find((candidate) => candidate.name === name),
        name,
      );
    const configureStore = step("Configure dependency cache store");
    const resolve = step("Resolve dependency cache key");
    const prepare = step("Prepare dependency cache restore");
    const restore = step("Restore exact dependency cache");
    const prepareFallback = step("Prepare dependency cache miss fallback");
    const setupPnpm = step("Setup pnpm");
    const install = step("Install dependencies");
    const installScript = readFileSync(
      ".github/actions/setup-node-env/install-dependencies.sh",
      "utf8",
    );
    const cachePaths =
      "node_modules\nui/node_modules\npackages/*/node_modules\nextensions/*/node_modules\nexamples/*/node_modules\n.cache/openclaw-pnpm-store\n";

    expect(action.inputs["cache-mode"].default).toBe("off");
    expect(action.inputs["dependency-cache"].default).toBe("false");
    expect(action.inputs).not.toHaveProperty("save-dependency-cache");
    expect(action.inputs).not.toHaveProperty("save-actions-cache");
    expect(action.inputs).not.toHaveProperty("use-actions-cache");
    expect(action.inputs).not.toHaveProperty("sticky-disk");
    expect(action.inputs).not.toHaveProperty("save-sticky-disk");
    expect(actionSource).not.toContain("useblacksmith/stickydisk");

    for (const mode of ["off", "restore", "read-write"]) {
      for (const exact of ["false", "true"]) {
        expect(
          runInNewContext(
            expectDefined(configureStore.if, "store configuration condition").replace(
              /inputs\.([a-z-]+)/gu,
              'inputs["$1"]',
            ),
            { inputs: { "cache-mode": mode, "dependency-cache": exact }, runner: { os: "Linux" } },
          ),
          `store-only and exact consumers share the publisher path: ${mode}/${exact}`,
        ).toBe(mode !== "off");
      }
    }
    expect(configureStore.run).toContain(
      'echo "PNPM_CONFIG_STORE_DIR=$GITHUB_WORKSPACE/.cache/openclaw-pnpm-store"',
    );
    expect(resolve.if).toBe("inputs.cache-mode != 'off' && inputs.dependency-cache == 'true'");
    expect(resolve.run).toContain('node "$GITHUB_ACTION_PATH/dependency-fingerprint.mjs"');
    expect(resolve.run).toContain("${GITHUB_REPOSITORY:?}-node-deps-v4");
    expect(resolve.run).toContain("${RUNNER_OS:?}-arch-${RUNNER_ARCH:?}");
    expect(resolve.run).toContain("node-$(node --version)-${deps_input_fingerprint:?}");
    expect(resolve.run).not.toMatch(/GITHUB_(?:REF|SHA|RUN_ID)|RUN_(?:ID|ATTEMPT)/u);
    expect(actionSteps.indexOf(resolve)).toBeLessThan(actionSteps.indexOf(restore));
    for (const cleanup of [prepare, prepareFallback]) {
      expect(cleanup.run).toContain('rm -rf "$GITHUB_WORKSPACE/node_modules"');
      expect(cleanup.run).toContain('"$GITHUB_WORKSPACE/.cache/openclaw-pnpm-store"');
      expect(cleanup.run).toContain('"$GITHUB_WORKSPACE/packages"');
      expect(cleanup.run).toContain("-name node_modules");
    }
    expect(actionSteps.indexOf(prepare)).toBeLessThan(actionSteps.indexOf(restore));
    expect(restore).toMatchObject({
      if: "inputs.cache-mode != 'off' && inputs.dependency-cache == 'true'",
      uses: CACHE_V5,
      with: { key: "${{ steps.dependency-cache-key.outputs.key }}", path: cachePaths },
    });
    expect((restore as WorkflowStep & { "continue-on-error"?: boolean })["continue-on-error"]).toBe(
      true,
    );
    expect(restore.with).not.toHaveProperty("restore-keys");
    expect(prepareFallback.if).toContain("steps.dependency-cache.outputs.cache-hit != 'true'");
    expect(prepareFallback.run).toContain(
      "actions/cache treats service, download, and extraction failures as",
    );
    expect(actionSteps.indexOf(restore)).toBeLessThan(actionSteps.indexOf(prepareFallback));
    expect(actionSteps.indexOf(prepareFallback)).toBeLessThan(actionSteps.indexOf(setupPnpm));
    expect(setupPnpm.with?.["cache-mode"]).toContain(
      "steps.dependency-cache.outputs.cache-hit != 'true'",
    );
    expect(setupPnpm.with?.["cache-mode"]).toContain("inputs.cache-mode != 'off'");
    expect(setupPnpm.with?.["cache-mode"]).toContain("'restore' || 'off'");
    expect(actionSteps.indexOf(restore)).toBeLessThan(actionSteps.indexOf(setupPnpm));

    expect(install.run).toBe('bash "$GITHUB_ACTION_PATH/install-dependencies.sh"');
    expect(installScript).toContain("export PNPM_CONFIG_PACKAGE_IMPORT_METHOD=hardlink");
    expect(installScript).toContain("run_pnpm_install --offline");
    expect(installScript).toContain("run_pnpm_install --prefer-offline");
    expect(installScript).toContain('[ "$DEPENDENCY_CACHE_HIT" = "true" ]');
    expect(installScript).toContain('rm -rf "$GITHUB_WORKSPACE/node_modules"');
    expect(installScript).toContain('"$GITHUB_WORKSPACE/packages"');
    expect(installScript).toContain("-name node_modules");
    expect(installScript).toContain('"${PNPM_CONFIG_STORE_DIR:?}"');
    expect(installScript.match(/run_pnpm_install/g)).toHaveLength(5);
    expect(installScript).toContain('echo "OPENCLAW_BUILD_ALL_NO_PNPM=1" >> "$GITHUB_ENV"');
    expect(installScript).toContain(
      'echo "pnpm_config_verify_deps_before_run=false" >> "$GITHUB_ENV"',
    );
    expect(
      actionSteps.some(
        (candidate) =>
          candidate.uses?.startsWith("actions/cache@") ||
          candidate.uses?.startsWith("actions/cache/save@"),
      ),
    ).toBe(false);

    const dependencySetups = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      ((job as { steps?: WorkflowStep[] }).steps ?? []).flatMap((candidate) =>
        candidate.uses?.endsWith("/.github/actions/setup-node-env") &&
        candidate.with?.["dependency-cache"] !== undefined
          ? [{ jobName, step: candidate }]
          : [],
      ),
    );
    const preflightRestore = dependencySetups.find(({ jobName }) => jobName === "preflight");
    expect(preflightRestore?.step).toMatchObject({
      if: expect.stringContaining("steps.manifest.outputs.run_node == 'true'"),
      with: {
        "cache-mode": "${{ steps.candidate_trust.outputs.cache_mode }}",
        "dependency-cache": "true",
        "install-bun": "false",
      },
    });
    expect(preflightRestore?.step.if).toContain("github.ref == 'refs/heads/main'");
    expect(preflightRestore?.step.if).toContain("github.event_name == 'pull_request'");
    expect(preflightRestore?.step.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    expect(preflightRestore?.step.if).toContain(
      '!contains(fromJSON(\'["hybrid","runson"]\'), vars.OPENCLAW_CI_RUNNER_BACKEND)',
    );
    const consumers = dependencySetups.filter(({ jobName }) => jobName !== "preflight");
    expect(consumers.map(({ jobName }) => jobName).toSorted()).toEqual([
      "build-artifacts",
      "check-additional-shard",
      "check-docs",
      "check-lint-hosted-core-shard",
      "check-shard",
      "check-test-types-hosted-core-shard",
      "checks-baseline-ratchets",
      "checks-fast-channel-contracts-shard",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-node-core-test-nondist-shard",
      "checks-ui",
      "checks-ui-e2e",
      "checks-ui-e2e-real-gateway",
      "control-ui-i18n",
      "control-ui-performance",
      "docker-seed-e2e",
      "native-i18n",
      "qa-smoke-ci-profile",
    ]);
    for (const { jobName, step: consumer } of consumers) {
      const needs = workflow.jobs[jobName].needs;
      expect(Array.isArray(needs) ? needs : [needs], jobName).toContain("preflight");
      expect(consumer.with, jobName).not.toHaveProperty("save-dependency-cache");
      expect(consumer.with?.["dependency-cache"], jobName).toContain("'true' || 'false'");
      expect(consumer.with?.["cache-mode"], jobName).toBe(
        "${{ needs.preflight.outputs.cache_mode }}",
      );
      const canonical = {
        eventName: "push",
        matrix: {
          group: "extension-package-boundary",
          node_version: "24.x",
          runner: "blacksmith-32vcpu-ubuntu-2404",
          task: "lint",
        },
        repository: "openclaw/openclaw",
        runAttempt: 1,
      } as const;
      const scenarios = [
        { eventName: "push", trusted: true },
        { eventName: "pull_request", headRepository: "openclaw/openclaw", trusted: true },
        { eventName: "pull_request", headRepository: "contributor/openclaw", trusted: false },
        {
          eventName: "pull_request",
          headRepository: "contributor/openclaw",
          authorAssociation: "NONE",
          trusted: false,
        },
        { eventName: "workflow_dispatch", trusted: false },
        { eventName: "push", repository: "contributor/openclaw", trusted: false },
      ] as const;
      for (const runnerBackend of ["", "blacksmith", "github", "hybrid"] as const) {
        for (const runAttempt of [1, 2]) {
          for (const { trusted, ...scenario } of scenarios) {
            const context = { ...canonical, ...scenario, runnerBackend, runAttempt };
            const runsOn = workflow.jobs[jobName]["runs-on"] as string;
            const routedRunner = runsOn.startsWith("${{")
              ? evaluateWorkflowExpression(runsOn, context)
              : runsOn;
            const selfHosted = String(routedRunner).startsWith("blacksmith-");
            expect(
              evaluateWorkflowExpression(consumer.with?.["dependency-cache"], {
                ...context,
                runnerEnvironment: selfHosted ? "self-hosted" : "github-hosted",
              }),
              `${jobName} ${JSON.stringify(context)} on ${routedRunner}`,
            ).toBe(trusted && selfHosted ? "true" : "false");
          }
        }
      }
      // The actual runner must fence restores even when the configured backend
      // still names Blacksmith or hybrid (including hosted retry routing).
      for (const runnerEnvironment of ["", "github-hosted"] as const) {
        expect(
          evaluateWorkflowExpression(consumer.with?.["dependency-cache"], {
            ...canonical,
            runnerBackend: "hybrid",
            runnerEnvironment,
          }),
          `${jobName} actual runner ${runnerEnvironment}`,
        ).toBe("false");
      }
      if (jobName === "checks-node-core-test-nondist-shard") {
        expect(
          evaluateWorkflowExpression(consumer.with?.["dependency-cache"], {
            ...canonical,
            matrix: { ...canonical.matrix, node_version: "22.x" },
            runnerBackend: "hybrid",
            runnerEnvironment: "self-hosted",
          }),
        ).toBe("false");
      }
    }
    for (const { jobName: setupJobName, step: setup } of Object.entries(workflow.jobs).flatMap(
      ([jobName, job]) =>
        ((job as { steps?: WorkflowStep[] }).steps ?? [])
          .filter((candidate) => candidate.uses?.endsWith("/.github/actions/setup-node-env"))
          .map((candidate) => ({ jobName, step: candidate })),
    )) {
      expect(setup.with, setupJobName).not.toHaveProperty("sticky-disk");
      expect(setup.with, setupJobName).not.toHaveProperty("save-sticky-disk");
      expect(
        [
          "off",
          "restore",
          "read-write",
          "${{ needs.preflight.outputs.cache_mode }}",
          "${{ steps.candidate_trust.outputs.cache_mode }}",
        ],
        setupJobName,
      ).toContain(setup.with?.["cache-mode"]);
    }

    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const dependencySave = warmer.jobs.dependencies.steps.find(
      (candidate: WorkflowStep) => candidate.name === "Save exact dependency cache",
    );
    expect(dependencySave).toMatchObject({
      uses: "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      with: {
        key: "${{ steps.setup-node-env.outputs.dependency-cache-key }}",
        path: cachePaths,
      },
    });
    expect(dependencySave.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
  });

  it.skipIf(process.platform === "win32").each([
    {
      name: "uncached frozen",
      cache: false,
      frozen: "true",
      exits: [0],
      modes: ["--prefer-offline"],
      status: 0,
    },
    {
      name: "uncached mutable",
      cache: false,
      frozen: "false",
      exits: [0],
      modes: ["--prefer-offline"],
      status: 0,
    },
    {
      name: "invalid frozen policy",
      cache: false,
      frozen: "invalid",
      exits: [],
      modes: [],
      status: 2,
    },
    {
      name: "uncached failure",
      cache: false,
      frozen: "true",
      exits: [23],
      modes: ["--prefer-offline"],
      status: 23,
    },
    {
      name: "cached success",
      cache: true,
      frozen: "true",
      exits: [0],
      modes: ["--offline"],
      status: 0,
    },
    {
      name: "cached relink",
      cache: true,
      frozen: "true",
      exits: [23, 0],
      modes: ["--offline", "--offline"],
      status: 0,
    },
    {
      name: "cached store rebuild",
      cache: true,
      frozen: "true",
      exits: [23, 23, 0],
      modes: ["--offline", "--offline", "--prefer-offline"],
      status: 0,
    },
    {
      name: "cached terminal failure",
      cache: true,
      frozen: "true",
      exits: [23, 23, 23],
      modes: ["--offline", "--offline", "--prefer-offline"],
      status: 23,
    },
  ])("executes the dependency install recipe: $name", ({ cache, frozen, exits, modes, status }) => {
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
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const step: WorkflowStep = expectDefined(
      action.runs.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Install dependencies",
      ),
      "Install dependencies",
    );
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
          CI: "true",
          DEPENDENCY_CACHE: String(cache),
          DEPENDENCY_CACHE_HIT: String(cache),
          FROZEN_LOCKFILE: frozen,
          RECIPE_LOG: log,
          RECIPE_PAYLOAD: payload,
          RECIPE_EXITS: JSON.stringify(exits),
          ...config,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(existsSync(payload)).toBe(status === 0);
    const calls: Array<{ args: string[]; cwd: string; importMethod: string }> = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    const expectedArgs = [
      "install",
      "--config.ignore-scripts=false",
      "--config.engine-strict=false",
      "--config.enable-pre-post-scripts=true",
      "--config.side-effects-cache=true",
      ...(frozen === "true" ? ["--frozen-lockfile"] : []),
      "--config.cache-dir=" + config.PNPM_CONFIG_CACHE_DIR,
      "--config.child-concurrency=3",
      "--config.network-concurrency=4",
      "--config.package-import-method=" + (cache ? "hardlink" : "copy"),
      "--config.store-dir=" + store,
      "--config.virtual-store-dir=" + config.PNPM_CONFIG_VIRTUAL_STORE_DIR,
    ];
    expect(calls).toEqual(
      modes.map((mode) => ({
        args: [...expectedArgs, mode],
        cwd: workspace,
        importMethod: cache ? "hardlink" : "copy",
      })),
    );
    expect(existsSync(path.join(workspace, "node_modules", "before"))).toBe(modes.length < 2);
    expect(existsSync(path.join(store, "before"))).toBe(modes.length < 3);
    expect(readFileSync(path.join(store, "toolchain", "pnpm.tgz"), "utf8")).toBe(
      "authenticated archive",
    );
    expect(existsSync(githubEnv)).toBe(cache && status === 0);
    if (cache && status === 0) {
      expect(readFileSync(githubEnv, "utf8")).toBe(
        "OPENCLAW_BUILD_ALL_NO_PNPM=1\npnpm_config_verify_deps_before_run=false\n",
      );
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves pnpm hard links and validates cached importers and supply-chain policy offline",
    async ({ onTestFinished, signal }) => {
      const fixtureDirs = createTempDirTracker();
      // oxlint-disable-next-line prefer-const -- Failure cleanup can run before the registry is started.
      let stopRegistry: (() => Promise<void>) | undefined;
      let readyTimeout: NodeJS.Timeout | undefined;
      // Timeout does not join the test body. Keep close and deletion in one hook,
      // outside afterEach, so a failed join cannot release the registry's files.
      onTestFinished(async () => {
        clearTimeout(readyTimeout);
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
      const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
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
        const port = await new Promise<number>((resolve, reject) => {
          readyTimeout = setTimeout(() => reject(new Error("fixture registry not ready")), 2_000);
          registryServer.once("message", (message) => {
            if (typeof message !== "number") {
              reject(new Error("fixture registry sent an invalid port"));
              return;
            }
            resolve(message);
          });
          registryServer.once("error", reject);
          void registryClosed.then(() => reject(new Error("fixture registry closed before ready")));
        });
        clearTimeout(readyTimeout);
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
        clearTimeout(readyTimeout);
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

  it("restores compiled workers only for opted-in Linux consumers with a shared seed", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const steps = action.runs.steps as WorkflowStep[];
    const restore = expectDefined(
      steps.find((step) => step.id === "vitest-worker-cache"),
      "compiled worker restore",
    );
    const enable = expectDefined(
      steps.find((step) => step.name === "Enable restored Vitest workers"),
      "compiled worker opt-in",
    );
    expect(action.inputs["vitest-worker-cache"].default).toBe("false");
    expect(restore).toMatchObject({
      uses: CACHE_V5,
      "continue-on-error": true,
      with: { path: ".artifacts/vitest-worker-cache" },
    });
    expect(restore.with?.key).toContain("${{ steps.setup-node.outputs.resolved-version }}");
    expect(restore.with?.key).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
    expect(restore.with?.["restore-keys"]).toContain(
      "-protected-${{ runner.os }}-${{ runner.arch }}-",
    );
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const warmerSteps = warmer.jobs.warm.steps as WorkflowStep[];
    const prepare = expectDefined(
      warmerSteps.find((step) => step.name === "Prepare compiled Vitest workers"),
      "compiled worker preparation",
    );
    const save = expectDefined(
      warmerSteps.find((step) => step.name === "Save compiled Vitest workers"),
      "compiled worker publication",
    );
    expect(prepare).toMatchObject({
      run: "node scripts/prepare-vitest-worker-cache.mts",
      env: { NODE_OPTIONS: "--max-old-space-size=8192", OPENCLAW_VITEST_WORKER_CACHE: "1" },
    });
    expect(save).toMatchObject({
      uses: CACHE_SAVE_V5,
      with: {
        path: restore.with?.path,
        key: "${{ steps.setup-node-env.outputs.vitest-worker-cache-key }}",
      },
    });
    expect(save.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
    expect(save.if).not.toMatch(/always\(|failure\(|cancelled\(/u);
    expect(warmerSteps.indexOf(prepare)).toBeLessThan(warmerSteps.indexOf(save));
    for (const step of [prepare, save]) {
      expect(step.if).toContain("matrix.platform == 'linux'");
    }
    expect(warmer.jobs.dependencies.steps.map((step: WorkflowStep) => step.name)).not.toContain(
      "Prepare compiled Vitest workers",
    );
    expect(warmerSteps.indexOf(save)).toBeLessThan(
      warmerSteps.findIndex((step) => step.name === "Prepare native SDK boundary cache"),
    );
    for (const mode of ["off", "restore", "read-write"]) {
      for (const optedIn of ["true", "false"]) {
        for (const os of ["Linux", "macOS", "Windows"]) {
          for (const matched of ["", "protected-seed"]) {
            const enabled = (step: WorkflowStep) =>
              runInNewContext(String(step.if).replace(/\.([a-z][a-z-]*)/gu, '["$1"]'), {
                inputs: { "cache-mode": mode, "vitest-worker-cache": optedIn },
                runner: { os },
                steps: { "vitest-worker-cache": { outputs: { "cache-matched-key": matched } } },
              });
            const eligible = mode !== "off" && optedIn === "true" && os === "Linux";
            expect(enabled(restore)).toBe(eligible);
            expect(enabled(enable)).toBe(eligible && matched !== "");
          }
        }
      }
    }
    const shard = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"];
    const setup = expectDefined(
      shard.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "Node shard setup",
    );
    for (const frozenTarget of [false, true]) {
      for (const pretestBuild of [null, "runtime", "private-qa"]) {
        for (const nodeVersion of [null, "24.x", "26.x"]) {
          expect(
            evaluateWorkflowExpression(setup.with["vitest-worker-cache"], {
              eventName: "pull_request",
              repository: "openclaw/openclaw",
              runAttempt: 1,
              frozenTarget,
              matrix: { pretest_build_mode: pretestBuild, node_version: nodeVersion },
            }),
          ).toBe(
            String(
              !frozenTarget &&
                pretestBuild === null &&
                (nodeVersion === null || nodeVersion === "24.x"),
            ),
          );
        }
      }
    }
  });

  it("persists content-validated public full-build declarations", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const installStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Install dependencies",
    );
    const cacheStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore build-all cache",
    );

    expect(action.inputs["build-all-cache-scope"].default).toBe("");
    expect(cacheStep).toMatchObject({
      if: "inputs.cache-mode != 'off' && inputs.build-all-cache-scope != ''",
      uses: CACHE_V5,
      with: { path: ".artifacts/build-all-cache" },
    });
    expect(cacheStep.with.key).toContain("build-all-v1-${{ inputs.build-all-cache-scope }}");
    expect(cacheStep.with.key).toContain("${{ runner.os }}-${{ runner.arch }}");
    const renderCacheKey = (template: string, runId: number, runAttempt: number) =>
      template.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) =>
        String(
          runInNewContext(expression.replace(/inputs\.([a-z-]+)/gu, 'inputs["$1"]'), {
            github: { repository: "openclaw/openclaw", run_id: runId, run_attempt: runAttempt },
            inputs: { "build-all-cache-scope": "full", "node-version": "24.x" },
            runner: { os: "Linux", arch: "X64" },
            hashFiles: () => "unchanged-source",
          }),
        ),
      );
    // A new warmer or rerun must publish rebuilt groups even when an outer input
    // fingerprint would be unchanged; per-group signatures own content validity.
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
    expect(action.runs.steps.indexOf(installStep)).toBeLessThan(
      action.runs.steps.indexOf(cacheStep),
    );
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const buildSave = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Save build-all cache",
    );
    expect(buildSave).toMatchObject({
      uses: "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      with: {
        key: "${{ steps.setup-node-env.outputs.build-all-cache-key }}",
        path: ".artifacts/build-all-cache",
      },
    });
    expect(buildSave.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");

    const privateQaWorkflows = [
      ".github/workflows/mantis-discord-smoke.yml",
      ".github/workflows/mantis-discord-status-reactions.yml",
      ".github/workflows/mantis-discord-thread-attachment.yml",
      ".github/workflows/mantis-slack-desktop-smoke.yml",
      ".github/workflows/qa-live-transports-convex.yml",
    ];
    for (const workflowPath of privateQaWorkflows) {
      const source = readFileSync(workflowPath, "utf8");
      expect(source, workflowPath).not.toContain("build-all-cache-scope:");
    }

    const releaseChecks = parse(
      readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
    );
    const repoE2eWorkflow = readWorkflow(".github/workflows/openclaw-repo-e2e-reusable.yml");
    const pipelines = [
      releaseChecks.jobs.validate_repo_e2e_gateway,
      releaseChecks.jobs.validate_repo_e2e_runtime,
    ];
    expect(releaseChecks.jobs.validate_live_docker_provider_suites.env).toMatchObject({
      OPENCLAW_SELECTED_SHA: "${{ needs.validate_selected_ref.outputs.selected_sha }}",
      OPENCLAW_TOOLING_SHA: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
    });
    const repoE2eRows = pipelines.flatMap((pipeline) => JSON.parse(pipeline.with.suites)) as Array<{
      name: string;
      command: string;
      target_script?: string;
    }>;
    expect(pipelines.map((pipeline) => pipeline.with.build_profile)).toEqual([
      "full",
      "ciArtifacts",
    ]);
    for (const pipeline of pipelines) {
      // Each profile starts independently; a slow/full declaration build cannot hold up UI readers.
      expect(pipeline.needs).toBe("validate_selected_ref");
      expect(pipeline.if).toBe(
        "(!inputs.prepare_only) && inputs.include_repo_e2e && inputs.live_suite_filter == ''",
      );
      expect(pipeline.uses).toBe("./.github/workflows/openclaw-repo-e2e-reusable.yml");
      expect(pipeline.with.ref).toBe("${{ needs.validate_selected_ref.outputs.selected_sha }}");
      expect(pipeline.with.advisory).toBeUndefined();
      expect(pipeline.with.allow_frozen_target_scenario_omissions).toBe(
        "${{ inputs.allow_frozen_target_scenario_omissions }}",
      );
    }
    expect(repoE2eRows.map((row) => row.command)).toEqual([
      ...Array.from({ length: 4 }, (_, index) => `pnpm test:e2e:gateway --shard=${index + 1}/4`),
      ...Array.from({ length: 4 }, (_, index) => `pnpm test:ui:e2e --shard=${index + 1}/4`),
      "pnpm test:e2e:agent-plugin-gateway",
    ]);
    expect(new Set(repoE2eRows.map((row) => row.name)).size).toBe(9);
    expect(repoE2eRows.find((row) => row.name === "Agent plugin Gateway")).toMatchObject({
      target_script: "test:e2e:agent-plugin-gateway",
    });
    expect(repoE2eWorkflow.env).toMatchObject({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_VITEST_MAX_WORKERS: "2",
      OPENCLAW_SELECTED_SHA: "${{ inputs.ref }}",
      OPENCLAW_TOOLING_SHA: "${{ inputs.workflow_sha }}",
      OPENCLAW_DOCKER_E2E_REPO_ROOT: "${{ github.workspace }}",
    });
    const producer = repoE2eWorkflow.jobs.build;
    const repoE2e = repoE2eWorkflow.jobs.test;
    expect(repoE2e.needs).toBe("build");
    expect(repoE2e.name).toBe("Repo E2E (${{ matrix.name }})");
    expect(repoE2e["timeout-minutes"]).toBe(90);
    expect(repoE2e.strategy).toMatchObject({ "fail-fast": false, "max-parallel": 4 });
    expect(repoE2e["continue-on-error"]).toBeUndefined();
    const producerSteps = producer.steps as WorkflowStep[];
    expect(producerSteps.find((step) => step.name === "Build dist for repo E2E")?.run).toContain(
      "full) pnpm build",
    );
    expect(producerSteps.find((step) => step.name === "Build dist for repo E2E")?.run).toContain(
      "ciArtifacts) pnpm build:ci-artifacts",
    );
    expect(producerSteps.find((step) => step.uses === UPLOAD_ARTIFACT_V7)?.with?.name).toContain(
      "${{ github.run_attempt }}",
    );
    const repoE2eSteps = repoE2e.steps as WorkflowStep[];
    expect(repoE2eSteps.find((step) => step.name === "Checkout selected ref")?.with?.ref).toBe(
      "${{ inputs.ref }}",
    );
    expect(repoE2eSteps.find((step) => step.uses === DOWNLOAD_ARTIFACT_V8)?.with).toMatchObject({
      "artifact-ids": "${{ needs.build.outputs.artifact_id }}",
      "run-id": "${{ needs.build.outputs.artifact_run_id }}",
      "github-token": "${{ github.token }}",
    });
    expect(repoE2eSteps.some((step) => step.run?.includes("pnpm build"))).toBe(false);
    const restoreIndex = repoE2eSteps.findIndex((step) => step.name === "Restore repo E2E build");
    const sandboxSetupIndex = repoE2eSteps.findIndex(
      (step) => step.run === "scripts/sandbox-setup.sh",
    );
    const repoE2eIndex = repoE2eSteps.findIndex((step) => step.name === "Run repo E2E suite");
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(sandboxSetupIndex).toBeGreaterThan(restoreIndex);
    expect(repoE2eIndex).toBeGreaterThan(sandboxSetupIndex);
    expect(repoE2eSteps[repoE2eIndex]).toMatchObject({
      env: {
        OPENCLAW_E2E_WORKERS: "2",
        OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
        TARGET_REQUIRED_SCRIPT: "${{ matrix.target_script || '' }}",
      },
    });
    const repoE2eRun = repoE2eSteps[repoE2eIndex]?.run;
    expect(repoE2eRun).toContain("OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS");
    expect(repoE2eRun).toContain("Selected target does not provide required repo E2E capability");
    expect(repoE2eRun).toContain("selected target does not provide this newer repo E2E capability");
    expect(repoE2eRun).toContain("${{ matrix.command }}");
    const targetedGroupStep = releaseChecks.jobs.plan_docker_lane_groups.steps.find(
      (step: WorkflowStep) => step.name === "Build targeted Docker lane groups",
    );
    expect(targetedGroupStep.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS).toBe(
      "${{ inputs.published_upgrade_survivor_scenarios }}",
    );
    expect(releaseChecks.jobs.validate_docker_lanes["timeout-minutes"]).toBe(
      "${{ matrix.group.timeout_minutes || 60 }}",
    );
    expect(releaseChecks.jobs.validate_docker_lanes.strategy["max-parallel"]).toBe(32);
    expect(releaseChecks.jobs.validate_docker_lanes.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS).toBe(
      "${{ matrix.group.published_upgrade_survivor_scenarios || inputs.published_upgrade_survivor_scenarios }}",
    );
  });

  it("persists Node 26 minimum declarations through trusted bounded artifacts", () => {
    const workflow = parse(readFileSync(".github/workflows/node-runtime-compat.yml", "utf8"));
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

  it("hashes transform inputs once per enabled setup and never for skipped caches", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const transformSteps = (action.runs.steps as WorkflowStep[]).filter((step) =>
      step.name?.includes("Vitest transform cache"),
    );
    const output = path.join(tempDirs.make("openclaw-transform-generation-"), "output");
    for (const os of ["Linux", "macOS", "Windows"]) {
      for (const mode of ["off", "restore", "read-write"]) {
        for (const flags of [
          ["false", "false"],
          ["true", "false"],
          ["false", "true"],
          ["true", "true"],
        ]) {
          for (const generation of ["a".repeat(64), "b".repeat(64)]) {
            const hashes: string[][] = [];
            const steps: Record<string, { outputs: Record<string, string> }> = {};
            const context = {
              github: { repository: "openclaw/openclaw", run_id: 10, run_attempt: 2 },
              inputs: {
                "cache-mode": mode,
                "vitest-fs-cache": flags[0],
                "restore-test-caches": flags[1],
                "node-version": "24.x",
              },
              runner: { os, arch: "X64" },
              steps,
              hashFiles: (...patterns: string[]) => {
                hashes.push(patterns);
                return generation;
              },
            };
            const evaluate = (expression: string): unknown =>
              runInNewContext(
                expression.replace(/(inputs|steps)\.([a-z-]+)/gu, '$1["$2"]'),
                context,
              );
            const render = (value: unknown) =>
              String(value).replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) => {
                const result = evaluate(expression);
                if (result == null) {
                  return "";
                }
                if (
                  typeof result === "string" ||
                  typeof result === "number" ||
                  typeof result === "boolean"
                ) {
                  return String(result);
                }
                throw new TypeError(`non-scalar workflow interpolation: ${expression}`);
              });
            let cacheInputs: Record<string, string> | undefined;
            let configuredGeneration: string | undefined;
            let configuredRestored: string | undefined;
            for (const step of transformSteps) {
              // Runner v2.336.0 evaluates embedded env before if; run/with inputs
              // are evaluated only after admission (CompositeActionHandler/ActionRunner).
              const env = Object.fromEntries(
                Object.entries(step.env ?? {}).map(([key, value]) => [key, render(value)]),
              );
              if (!evaluate(step.if ?? "true")) {
                if (step.id) {
                  steps[step.id] = { outputs: {} };
                }
                continue;
              }
              if (step.name === "Resolve Vitest transform cache generation") {
                writeFileSync(output, "");
                execFileSync("bash", ["-e", "-c", render(step.run)], {
                  env: { ...process.env, GITHUB_OUTPUT: output },
                });
                steps[expectDefined(step.id, "transform generation step id")] = {
                  outputs: Object.fromEntries(
                    readFileSync(output, "utf8")
                      .trim()
                      .split("\n")
                      .map((line) => line.split("=")),
                  ),
                };
              } else if (step.uses) {
                cacheInputs = Object.fromEntries(
                  Object.entries(step.with ?? {}).map(([key, value]) => [key, render(value)]),
                );
                // Exercise misses and prefix hits; neither reports cache-hit=true.
                steps[expectDefined(step.id, "transform restore step id")] = {
                  outputs: {
                    "cache-hit": generation === "a".repeat(64) ? "" : "false",
                    "cache-matched-key":
                      generation === "a".repeat(64)
                        ? ""
                        : `${expectDefined(cacheInputs["restore-keys"], "transform restore prefix").trim()}9-1`,
                  },
                };
              } else {
                configuredGeneration = env.CACHE_GENERATION;
                configuredRestored = env.CACHE_RESTORED;
              }
            }
            const enabled = os !== "Windows" && mode !== "off" && flags.includes("true");
            expect(hashes, JSON.stringify({ os, mode, flags, generation })).toHaveLength(
              enabled ? 1 : 0,
            );
            if (enabled) {
              expect(hashes[0]).toEqual([
                "pnpm-lock.yaml",
                "pnpm-workspace.yaml",
                "**/package.json",
                "**/tsconfig*.json",
                "vitest.config.*",
                "test/vitest/**",
                "src/state/*.sql",
                "!**/node_modules/**",
                "!.ci-harness/**",
              ]);
              const prefix = `openclaw/openclaw-vitest-fs-v4-protected-${os}-X64-node-24.x-${generation}-`;
              expect(cacheInputs).toEqual({
                path: "/var/tmp/openclaw-vitest-fs-cache",
                key: `${prefix}10-2`,
                "restore-keys": `${prefix}\n`,
              });
              expect(configuredGeneration).toBe(generation);
              expect(configuredRestored).toBe(generation === "a".repeat(64) ? "false" : "true");
            } else {
              expect(cacheInputs).toBeUndefined();
              expect(configuredGeneration).toBeUndefined();
              expect(configuredRestored).toBeUndefined();
            }
          }
        }
      }
    }
  });

  it("shares transform generations with the warmer after CI exports its harness", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
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
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const setupNodeStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const readerStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore Vitest transform cache",
    );
    const configureStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Configure Vitest transform cache",
    );
    const compileReaderStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore Node compile cache",
    );
    const compileConfigureStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Configure Node compile cache",
    );
    const buildSetupNodeStep = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const hostedTestCacheInput =
      "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && 'true' || 'false' }}";
    const hostedTestCacheJobs = [
      "checks-ui",
      "checks-ui-e2e",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
    ];
    const hostedFastCoreTestCacheInput =
      "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && (matrix.task == 'bundled-protocol' || matrix.task == 'contracts-plugins-ci-routing' || matrix.task == 'ci-routing' || matrix.task == 'bun-launcher') && 'true' || 'false' }}";

    expect(setupNodeStep.with).toMatchObject({
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "node-compile-cache": "true",
      "vitest-fs-cache": "true",
    });
    expect(setupNodeStep.with).not.toHaveProperty("save-node-compile-cache");
    expect(setupNodeStep.with).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs["vitest-fs-cache"].default).toBe("false");
    expect(action.inputs["restore-test-caches"].default).toBe("false");
    expect(action.inputs).not.toHaveProperty("save-vitest-fs-cache");
    expect(action.inputs["node-compile-cache"].default).toBe("false");
    expect(action.inputs).not.toHaveProperty("node-compile-cache-scope");
    expect(action.inputs).not.toHaveProperty("save-node-compile-cache");
    expect(
      action.runs.steps.some((step: WorkflowStep) =>
        step.name?.includes("transform cache sticky disk"),
      ),
    ).toBe(false);
    expect(
      action.runs.steps.some((step: WorkflowStep) =>
        step.name?.includes("compile cache sticky disk"),
      ),
    ).toBe(false);
    expect(readerStep.uses).toBe(CACHE_V5);
    expect(readerStep.if).toContain("inputs.cache-mode != 'off'");
    expect(readerStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(readerStep.if).toContain("runner.os != 'Windows'");
    expect(readerStep.if).not.toMatch(/runner\.(?:environment|labels|name)/u);
    expect(readerStep.with.key).toContain("vitest-fs-v4-protected-");
    expect(readerStep.with.key).toContain("github.run_id");
    expect(readerStep.with.key).toContain("github.run_attempt");
    expect(configureStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(configureStep.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT=$cache_root");
    expect(configureStep.run).toContain(".openclaw-transform-generation");
    expect(configureStep.run).not.toContain("protected Vitest transform seed");
    expect(configureStep.env.CACHE_WRITER).toBe("0");
    expect(configureStep.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=");
    expect(compileReaderStep.with.key).toContain("node-compile-v3-test-protected-");
    expect(compileReaderStep.with.key).toContain("github.run_id");
    expect(compileReaderStep.with.key).toContain("github.run_attempt");
    expect(compileReaderStep.with.key).not.toContain("pull_request");
    expect(compileReaderStep.if).toContain("inputs.cache-mode != 'off'");
    expect(compileReaderStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(compileConfigureStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(compileConfigureStep.run).toContain("NODE_COMPILE_CACHE=$cache_root");
    expect(compileConfigureStep.run).toContain("NODE_COMPILE_CACHE_PORTABLE=1");
    expect(compileConfigureStep.run).toContain("OPENCLAW_NODE_COMPILE_CACHE_WRITER=0");
    expect(buildSetupNodeStep.with).toMatchObject({
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "node-compile-cache": "true",
      "build-all-cache-scope": "full",
    });
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    for (const job of [...Object.values(workflow.jobs), ...Object.values(warmer.jobs)]) {
      for (const step of (job as { steps?: WorkflowStep[] }).steps ?? []) {
        if (step.uses?.endsWith("/.github/actions/setup-node-env")) {
          expect(step.with, step.name).not.toHaveProperty("node-compile-cache-scope");
        }
      }
    }

    for (const jobName of hostedTestCacheJobs) {
      const setup = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Setup Node environment",
      );
      expect(setup.with["restore-test-caches"], jobName).toBe(hostedTestCacheInput);
      expect(
        evaluateWorkflowExpression(setup.with["restore-test-caches"], {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        }),
        jobName,
      ).toBe("true");
      expect(
        evaluateWorkflowExpression(setup.with["restore-test-caches"], {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend: "blacksmith",
          runAttempt: 1,
        }),
        jobName,
      ).toBe("false");
      expect(setup.with, jobName).not.toHaveProperty("save-node-compile-cache");
      expect(setup.with, jobName).not.toHaveProperty("save-vitest-fs-cache");
    }
    const fastCoreSetup = workflow.jobs["checks-fast-core"].steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    expect(fastCoreSetup.with["restore-test-caches"]).toBe(hostedFastCoreTestCacheInput);
    for (const task of [
      "bundled-protocol",
      "contracts-plugins-ci-routing",
      "ci-routing",
      "bun-launcher",
    ]) {
      expect(
        evaluateWorkflowExpression(fastCoreSetup.with["restore-test-caches"], {
          eventName: "push",
          matrix: { task },
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        }),
        task,
      ).toBe("true");
    }
    for (const task of ["startup-corpus", "coercion-helpers"]) {
      expect(
        evaluateWorkflowExpression(fastCoreSetup.with["restore-test-caches"], {
          eventName: "push",
          matrix: { task },
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        }),
        task,
      ).toBe("false");
    }
    expect(
      evaluateWorkflowExpression(fastCoreSetup.with["restore-test-caches"], {
        eventName: "push",
        matrix: { task: "bundled-protocol" },
        repository: "openclaw/openclaw",
        runnerBackend: "blacksmith",
        runAttempt: 1,
      }),
    ).toBe("false");
    expect(fastCoreSetup.with).not.toHaveProperty("save-node-compile-cache");
    expect(fastCoreSetup.with).not.toHaveProperty("save-vitest-fs-cache");

    for (const jobName of ["checks-ui-e2e-real-gateway", "native-i18n", "control-ui-i18n"]) {
      const setup = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Setup Node environment",
      );
      expect(setup.with, jobName).not.toHaveProperty("restore-test-caches");
    }
  });

  it("publishes dependencies independently of long backend-local code warming", () => {
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    expect(warmer).not.toHaveProperty("concurrency");
    expect(warmer.on.push["paths-ignore"]).toEqual(readCiWorkflow().on.push["paths-ignore"]);
    const dependencies = warmer.jobs.dependencies;
    const code = warmer.jobs.warm;
    expect(dependencies.concurrency["cancel-in-progress"]).toBe(false);
    expect(code.concurrency["cancel-in-progress"]).toBe(false);
    expect(code.concurrency.group).not.toBe(dependencies.concurrency.group);
    for (const job of [dependencies, code]) {
      expect(job).not.toHaveProperty("needs");
      expect(job.concurrency.group).toContain("matrix.platform");
      expect(job.concurrency.group).toContain("github.ref");
      for (const repository of ["openclaw/openclaw", "example/fork"]) {
        for (const ref of ["refs/heads/main", "refs/heads/feature"]) {
          expect(
            evaluateWorkflowExpression(job.if, {
              eventName: "workflow_dispatch",
              repository,
              ref,
              runAttempt: 1,
            }),
          ).toBe(repository === "openclaw/openclaw" && ref === "refs/heads/main");
        }
      }
      const hosted = { eventName: "push" as const, repository: "openclaw/openclaw", runAttempt: 1 };
      expect(
        evaluateWorkflowExpression(job.concurrency.group, {
          ...hosted,
          runnerBackend: "hybrid",
          matrix: { platform: "linux-hosted" },
        }),
      ).toBe(
        evaluateWorkflowExpression(job.concurrency.group, {
          ...hosted,
          runnerBackend: "github",
          matrix: { platform: "linux" },
        }),
      );
    }
    const dependencySaveNames = [
      "Save Node toolchain cache",
      "Save exact dependency cache",
      "Save pnpm store cache",
    ];
    expect(
      dependencies.steps
        .filter((step: WorkflowStep) => step.uses?.startsWith("actions/cache/save@"))
        .map((step: WorkflowStep) => step.name),
    ).toEqual(dependencySaveNames);
    expect(
      code.steps.some((step: WorkflowStep) => dependencySaveNames.includes(step.name ?? "")),
    ).toBe(false);
    const setup = dependencies.steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    for (const key of [
      "vitest-fs-cache",
      "vitest-worker-cache",
      "node-compile-cache",
      "build-all-cache-scope",
    ]) {
      expect(setup.with).not.toHaveProperty(key);
    }
    for (const save of dependencies.steps.filter((step: WorkflowStep) =>
      dependencySaveNames.includes(step.name ?? ""),
    )) {
      expect(save.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
      expect(save.if).not.toMatch(/\b(?:always|failure|cancelled)\(/u);
      expect(dependencies.steps.indexOf(save)).toBeGreaterThan(dependencies.steps.indexOf(setup));
    }
  });

  it("warms protected caches without main-run cancellation", () => {
    const warmerSource = readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8");
    const warmer = parse(warmerSource);
    const warmerSetup = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const checkoutStep = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Checkout",
    );
    const bunSetup = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Setup pinned Bun test runtime",
    );
    const warmStep = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Warm transform and compile caches",
    );
    const warmerSteps = warmer.jobs.warm.steps as WorkflowStep[];
    const buildStep = expectDefined(
      warmerSteps.find((step) => step.name === "Warm build cache"),
      "cache warm build",
    );
    const boundaryRestoreStep = expectDefined(
      warmerSteps.find((step) => step.name === "Restore native SDK boundary cache"),
      "native SDK boundary cache restore",
    );
    const boundaryPrepareStep = expectDefined(
      warmerSteps.find((step) => step.name === "Prepare native SDK boundary cache"),
      "native SDK boundary cache preparation",
    );
    const boundarySaveStep = expectDefined(
      warmerSteps.find((step) => step.name === "Save native SDK boundary cache"),
      "native SDK boundary cache publication",
    );
    const boundaryCleanupStep = expectDefined(
      warmerSteps.find((step) => step.name === "Clear native SDK boundary output before build"),
      "native SDK boundary output cleanup",
    );
    const warmAssertionStep = expectDefined(
      warmerSteps.find((step) => step.name === "Assert cache warming succeeded"),
      "final cache warming assertion",
    );

    expect(warmer.jobs.warm.concurrency["cancel-in-progress"]).toBe(false);
    // hosted-mode cache recovery needs a maintainer-operated fallback when the
    // scheduled seed is missing or stale.
    expect(warmer.on).toHaveProperty("workflow_dispatch");
    expect(warmer.on.push.branches).toEqual(["main"]);
    expect(warmer.on.repository_dispatch.types).toEqual(["vitest-cache-warm"]);
    expect(warmer.jobs.warm.if).toContain("github.repository == 'openclaw/openclaw'");
    expect(warmer.jobs.warm.strategy["fail-fast"]).toBe(false);
    expect(warmer.on).not.toHaveProperty("pull_request");
    expect(warmer.on).not.toHaveProperty("pull_request_target");
    for (const eventName of ["push", "workflow_dispatch"] as const) {
      for (const runnerBackend of ["blacksmith", "hybrid", "github"] as const) {
        const configuredPlatforms = warmer.jobs.warm.strategy.matrix.platform;
        const platforms =
          typeof configuredPlatforms === "string"
            ? evaluateWorkflowExpression(configuredPlatforms, {
                eventName,
                repository: "openclaw/openclaw",
                runAttempt: 1,
                runnerBackend,
              })
            : configuredPlatforms;
        expect(platforms).toEqual(
          runnerBackend === "hybrid" ? ["linux", "linux-hosted"] : ["linux"],
        );
        for (const platform of platforms as string[]) {
          const context = {
            eventName,
            matrix: { platform },
            repository: "openclaw/openclaw",
            runAttempt: 1,
            runnerBackend,
          };
          const full = platform === "linux";
          const expectedRunner =
            platform === "macos"
              ? "macos-15"
              : platform === "linux-hosted" || runnerBackend === "github"
                ? "ubuntu-24.04"
                : "blacksmith-8vcpu-ubuntu-2404";
          expect(evaluateWorkflowExpression(warmer.jobs.warm["runs-on"], context)).toBe(
            expectedRunner,
          );
          const setupInputs = Object.fromEntries(
            Object.entries(warmerSetup.with).map(([key, value]) => [
              key,
              typeof value === "string" && value.startsWith("${{")
                ? evaluateWorkflowExpression(value, context)
                : value,
            ]),
          );
          expect(setupInputs).toMatchObject({
            "build-all-cache-scope": full ? "full" : "",
            "cache-mode": "read-write",
            "dependency-cache": String(full),
            "install-bun": "false",
            "node-compile-cache": "true",
            "vitest-fs-cache": "true",
            "vitest-worker-cache": String(full),
          });
          for (const step of [buildStep, boundaryCleanupStep]) {
            expect(evaluateWorkflowExpression(step.if, context), step.name).toBe(full);
          }
          for (const step of [boundaryPrepareStep, bunSetup, warmStep]) {
            expect(step.if, step.name).toBeUndefined();
          }
          expect(evaluateWorkflowExpression(warmAssertionStep.if, context)).toBe(true);
          expect(evaluateWorkflowExpression(warmStep.env.CACHE_WARM_PLATFORM, context)).toBe(
            platform,
          );
        }
      }
    }
    expect(bunSetup.uses).toBe("./.github/actions/setup-test-bun");
    expect(warmerSteps.indexOf(bunSetup)).toBeLessThan(warmerSteps.indexOf(warmStep));
    expect(
      warmer.jobs.dependencies.steps.some(
        (step: WorkflowStep) => step.uses === "./.github/actions/setup-test-bun",
      ),
    ).toBe(false);
    for (const platform of ["linux", "linux-hosted"]) {
      const invocation = runWorkflowShellScript(
        `node() { printf '%s\\n' "$*"; return 23; }\n${warmStep.run}`,
        { env: { ...process.env, CACHE_WARM_PLATFORM: platform } },
      );
      expect(invocation.stdout.trim(), invocation.stderr).toBe(
        "--import tsx scripts/ci-warm-vitest-caches.mts",
      );
      expect(invocation.status, invocation.stderr).toBe(23);
    }
    expect(warmer.on).not.toHaveProperty("workflow_run");
    expect(checkoutStep.with).toBeUndefined();
    expect(warmer.on.schedule).toEqual([{ cron: "17 * * * *" }]);
    expect(warmerSource).not.toContain("OPENCLAW_NODE_TEST_CONFIGS_JSON");
    expect(warmStep.id).toBe("warm-caches");
    expect(warmStep["continue-on-error"]).toBe(true);
    expect(warmStep.env).toMatchObject({
      OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: "1",
      OPENCLAW_NODE_COMPILE_CACHE_WRITER: "1",
    });
    expect(warmerSetup["continue-on-error"]).not.toBe(true);
    for (const legacyInput of [
      "save-actions-cache",
      "save-dependency-cache",
      "save-node-compile-cache",
      "save-vitest-fs-cache",
      "use-actions-cache",
    ]) {
      expect(warmerSetup.with).not.toHaveProperty(legacyInput);
    }
    const saveSteps = warmerSteps.filter((step) => step.uses?.startsWith("actions/cache/save@"));
    expect(saveSteps.map((step) => step.name)).toEqual([
      "Save compiled Vitest workers",
      "Save native SDK boundary cache",
      "Save build-all cache",
      "Save dist build cache",
      "Save Vitest transform cache",
      "Save Node compile cache",
    ]);
    for (const saveStep of saveSteps) {
      expect(saveStep.if, saveStep.name).toContain(
        "steps.setup-node-env.outputs.cache-mode == 'read-write'",
      );
      expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeGreaterThan(
        warmerSteps.indexOf(warmerSetup),
      );
      if (saveStep.name === "Save compiled Vitest workers") {
        expect(warmerSteps.indexOf(saveStep)).toBeLessThan(
          warmerSteps.indexOf(boundaryPrepareStep),
        );
        expect(saveStep.if).not.toMatch(/always\(|failure\(|cancelled\(/u);
      } else if (
        saveStep.name === "Save build-all cache" ||
        saveStep.name === "Save dist build cache"
      ) {
        expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeGreaterThan(
          warmerSteps.findIndex((step) => step.name === "Warm build cache"),
        );
        expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeLessThan(
          warmerSteps.indexOf(warmStep),
        );
        expect(saveStep.if).not.toMatch(/always\(|failure\(/u);
      } else if (saveStep.name === "Save native SDK boundary cache") {
        expect(saveStep.if).toContain(
          "steps.extension-package-boundary-cache.outputs.cache-hit != 'true'",
        );
        expect(saveStep.if).not.toMatch(/always\(|failure\(|cancelled\(/u);
      } else {
        expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeGreaterThan(
          warmerSteps.indexOf(warmStep),
        );
      }
      expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeLessThan(
        warmerSteps.indexOf(warmAssertionStep),
      );
    }
    expect(warmAssertionStep.if).toBe("${{ always() }}");
    expect(warmAssertionStep.run).toContain("steps.warm-caches.outcome");
    expect(warmAssertionStep.run).toContain("exit 1");
    expect(warmerSteps.at(-1)).toBe(warmAssertionStep);
    // No close-time cleanup workflow is needed; Actions cache LRU/TTL expires
    // old hosted-writer and warmer generations.
    expect(existsSync(".github/workflows/pr-cache-cleanup.yml")).toBe(false);
    expect(warmStep.if).toBeUndefined();
    const distSave = expectDefined(
      saveSteps.find((step) => step.name === "Save dist build cache"),
      "Linux dist publication",
    );
    expect(distSave.if).toBe(
      "${{ matrix.platform == 'linux' && steps.setup-node-env.outputs.cache-mode == 'read-write' }}",
    );
    expect(boundaryRestoreStep.uses).toBe(CACHE_V5);
    expect(boundarySaveStep.uses).toBe(CACHE_SAVE_V5);
    const boundaryRestoreInputs = expectDefined(
      boundaryRestoreStep.with,
      "native SDK boundary cache inputs",
    );
    expect(boundaryRestoreInputs.key).toBe(
      "${{ runner.os }}-extension-package-boundary-v4-${{ github.sha }}",
    );
    expect(boundarySaveStep.with).toEqual({
      path: boundaryRestoreInputs.path,
      key: boundaryRestoreInputs.key,
    });
    expect(boundaryRestoreInputs["restore-keys"]).toBe(
      "${{ runner.os }}-extension-package-boundary-v4-\n",
    );
    expect(boundaryPrepareStep.run).toBe(
      "node --import ./scripts/tsx.mjs scripts/prepare-extension-package-boundary-artifacts.mts --mode=package-boundary",
    );
    expect(boundaryPrepareStep["continue-on-error"]).not.toBe(true);
    expect(warmerSteps.indexOf(boundaryRestoreStep)).toBeLessThan(warmerSteps.indexOf(buildStep));
    expect(warmerSteps.indexOf(boundaryPrepareStep)).toBeGreaterThan(
      warmerSteps.indexOf(boundaryRestoreStep),
    );
    expect(warmerSteps.indexOf(boundarySaveStep)).toBeGreaterThan(
      warmerSteps.indexOf(boundaryPrepareStep),
    );
    expect(warmerSteps.indexOf(boundarySaveStep)).toBeLessThan(warmerSteps.indexOf(buildStep));
    expect(warmerSteps.indexOf(boundaryCleanupStep)).toBeGreaterThan(
      warmerSteps.indexOf(boundarySaveStep),
    );
    expect(warmerSteps.indexOf(boundaryCleanupStep)).toBeLessThan(warmerSteps.indexOf(buildStep));
    const cleanupRoot = tempDirs.make("openclaw-native-sdk-cleanup-");
    const sdkOutput = path.join(cleanupRoot, "packages/plugin-sdk/dist/native.d.ts");
    const sdkSource = path.join(cleanupRoot, "packages/plugin-sdk/src/core.ts");
    const siblingOutput = path.join(cleanupRoot, "packages/normalization-core/dist/index.js");
    const boundaryReceipt = path.join(
      cleanupRoot,
      ".artifacts/extension-package-boundary/plugin-sdk.json",
    );
    for (const file of [sdkOutput, sdkSource, siblingOutput, boundaryReceipt]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "sentinel\n");
    }
    const cleanupResult = runWorkflowShellScript(
      expectDefined(boundaryCleanupStep.run, "cleanup"),
      {
        cwd: cleanupRoot,
        env: process.env,
      },
    );
    expect(cleanupResult.status, `${cleanupResult.stdout}${cleanupResult.stderr}`).toBe(0);
    expect(existsSync(sdkOutput)).toBe(false);
    expect(existsSync(sdkSource)).toBe(true);
    expect(existsSync(siblingOutput)).toBe(true);
    expect(existsSync(boundaryReceipt)).toBe(true);
    const storeSave = expectDefined(
      warmer.jobs.dependencies.steps.find(
        (step: WorkflowStep) => step.name === "Save pnpm store cache",
      ),
      "platform pnpm store publication",
    );
    expect(storeSave.if).not.toContain("matrix.platform");
    expect(storeSave.if).toContain("steps.setup-node-env.outputs.pnpm-store-cache-hit != 'true'");
    expect(storeSave.if).not.toMatch(/\b(?:always|failure|cancelled)\(/u);
    expect(storeSave.with).toEqual({
      path: "${{ steps.setup-node-env.outputs.pnpm-store-cache-path }}",
      key: "${{ steps.setup-node-env.outputs.pnpm-store-cache-key }}",
    });
  });

  it("publishes a portable release npm seed without hooks or push-time downloads", () => {
    const warmer = parse(readFileSync(".github/workflows/release-npm-cache-warm.yml", "utf8"));
    expect(warmer.on).not.toHaveProperty("push");
    expect(warmer.on).toHaveProperty("schedule");
    expect(warmer.on).toHaveProperty("workflow_dispatch");
    expect(warmer.concurrency.group).not.toBe(
      parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8")).jobs.warm.concurrency
        .group,
    );
    const seed = warmer.jobs["warm-release-npm"];
    for (const repository of ["openclaw/openclaw", "example/fork"]) {
      for (const eventName of [
        "push",
        "pull_request",
        "repository_dispatch",
        "schedule",
        "workflow_dispatch",
      ] as const) {
        expect(evaluateWorkflowExpression(seed.if, { repository, eventName, runAttempt: 1 })).toBe(
          repository === "openclaw/openclaw" &&
            (eventName === "schedule" || eventName === "workflow_dispatch"),
        );
      }
    }
    expect(evaluateWorkflowRunner(seed["runs-on"])).toBe("ubuntu-24.04");
    const steps = seed.steps as WorkflowStep[];
    const install = expectDefined(
      steps.find((entry) => entry.run),
      "npm seed install",
    );
    expect(install.run).toContain("openclaw@latest --ignore-scripts --omit=dev");
    expect(install.env).toEqual({
      NPM_CONFIG_CACHE: "${{ github.workspace }}/.cache/openclaw-cross-os-npm-cache",
    });
    const save = expectDefined(
      steps.find((entry) => entry.uses?.startsWith("actions/cache/save@")),
      "npm seed publication",
    );
    expect(save.with).toMatchObject({
      path: ".cache/openclaw-cross-os-npm-cache/_cacache",
      enableCrossOsArchive: true,
    });
    expect(save.with?.key).toMatch(/^openclaw-cross-os-npm-v1-seed-/u);
    expect(save["continue-on-error"]).toBe(true);
    expect(save.if ?? "").not.toMatch(/always\(|failure\(|cancelled\(/u);
    expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(install));
    expect(steps.some((entry) => entry.uses?.startsWith("actions/cache/restore@"))).toBe(false);
  });

  it("keeps the Gradle sticky disk on O(1) per-task protected keys", () => {
    const workflow = readCiWorkflow();
    const androidSteps = workflow.jobs.android.steps as WorkflowStep[];
    const mountWith = expectDefined(
      androidSteps.find((step) => step.name === "Mount Gradle sticky disk")?.with,
      "Gradle sticky mount step",
    );
    const pointStep = expectDefined(
      androidSteps.find((step) => step.name === "Point Gradle at the sticky disk"),
      "Gradle sticky point step",
    );

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

  it("caches Robolectric SDK artifacts for Android test tasks only", () => {
    const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
    const androidSteps = readCiWorkflow().jobs.android.steps as WorkflowStep[];
    const restoreIndex = androidSteps.findIndex(
      (step) => step.name === "Restore Robolectric Maven cache",
    );
    const configureIndex = androidSteps.findIndex(
      (step) => step.name === "Configure Robolectric Maven cache",
    );
    const runIndex = androidSteps.findIndex(
      (step) => step.name === "Run Android ${{ matrix.task }}",
    );
    const saveIndex = androidSteps.findIndex(
      (step) => step.name === "Save Robolectric Maven cache",
    );
    const restoreStep = expectDefined(androidSteps[restoreIndex], "Robolectric cache restore");
    const configureStep = expectDefined(
      androidSteps[configureIndex],
      "Robolectric cache configuration",
    );
    const runStep = expectDefined(androidSteps[runIndex], "Android task runner");
    const saveStep = expectDefined(androidSteps[saveIndex], "Robolectric cache save");

    expect([restoreIndex, configureIndex, runIndex, saveIndex]).toEqual(
      [restoreIndex, configureIndex, runIndex, saveIndex].toSorted((a, b) => a - b),
    );
    expect(restoreStep).toMatchObject({
      id: "robolectric-cache",
      if: "startsWith(matrix.task, 'test-') && needs.preflight.outputs.cache_mode != 'off'",
      uses: CACHE_V5,
      with: {
        path: "/var/tmp/openclaw-robolectric-m2",
      },
    });
    const cacheKey = String(restoreStep.with?.key);
    expect(cacheKey).toContain("${{ github.repository }}-robolectric-m2-v1-");
    expect(cacheKey).toContain("${{ runner.os }}-${{ runner.arch }}-${{ matrix.task }}-");
    expect(cacheKey).toContain("apps/android/**/*.gradle*");
    expect(cacheKey).toContain("apps/android/**/gradle-wrapper.properties");
    expect(cacheKey).toContain("apps/android/gradle/libs.versions.toml");
    expect(cacheKey).toContain("apps/android/**/src/test*/**");
    for (const forbiddenDimension of [
      "github.run_id",
      "github.sha",
      "github.ref",
      "github.event.pull_request.number",
    ]) {
      expect(cacheKey).not.toContain(forbiddenDimension);
    }
    expect(String(restoreStep.with?.["restore-keys"]).trim()).toBe(
      "${{ github.repository }}-robolectric-m2-v1-${{ runner.os }}-${{ runner.arch }}-${{ matrix.task }}-",
    );

    expect(configureStep.if).toBe("startsWith(matrix.task, 'test-')");
    expect(configureStep.run).toContain("OPENCLAW_ROBOLECTRIC_M2");
    expect(configureStep.run).toContain("OPENCLAW_ROBOLECTRIC_INIT");
    expect(configureStep.run).toContain(
      'systemProperty "maven.repo.local", System.getenv("OPENCLAW_ROBOLECTRIC_M2")',
    );
    expect(workflowSource).not.toContain("robolectric.dependency.repo.url");

    expect(saveStep).toMatchObject({
      if: "success() && startsWith(matrix.task, 'test-') && needs.preflight.outputs.cache_write_allowed == 'true' && steps.robolectric-cache.outputs.cache-hit != 'true'",
      uses: CACHE_SAVE_V5,
      with: {
        key: "${{ steps.robolectric-cache.outputs.cache-primary-key }}",
        path: "/var/tmp/openclaw-robolectric-m2",
      },
    });

    const taskCases = new Map(
      [...String(runStep.run).matchAll(/^\s{2}([a-z-]+)\)\n([\s\S]*?)^\s{4};;$/gmu)].map(
        (match) => [match[1], match[2]],
      ),
    );
    for (const task of ["test-play", "test-play-compat", "test-third-party", "test-wear"]) {
      expect(taskCases.get(task), task).toContain('--init-script "$OPENCLAW_ROBOLECTRIC_INIT"');
    }
    for (const task of ["build-play", "build-wear", "build-play-compat", "ktlint"]) {
      expect(taskCases.get(task), task).not.toContain("--init-script");
    }
    expect(runStep.run).not.toMatch(/\bsleep\b/u);
    expect(runStep.run).not.toMatch(/\bretry\b/iu);
  });

  it("retains Android test XML and JVM diagnostics after failures without collecting caches or canceled jobs", () => {
    const steps = readCiWorkflow().jobs.android.steps as WorkflowStep[];
    const runIndex = steps.findIndex((step) => step.name === "Run Android ${{ matrix.task }}");
    const uploadIndex = steps.findIndex((step) => step.name === "Upload Android test reports");
    const upload = expectDefined(steps[uploadIndex], "Android test reports");
    expect(uploadIndex).toBeGreaterThan(runIndex);
    expect(upload.with?.["retention-days"]).toBe(14);
    // A status function prevents Actions' implicit success() from hiding failed-test evidence.
    expect(upload.if).toMatch(/\b(?:always|cancelled|failure|success)\(\)/u);
    for (const [task, failed, cancelled, expected] of [
      ["test-play", false, false, true],
      ["test-play", true, false, true],
      ["test-play-compat", true, false, true],
      ["test-third-party", true, false, true],
      ["test-wear", false, false, true],
      ["test-wear", true, true, false],
      ["test-play", false, true, false],
      ["build-play", false, false, false],
      ["build-wear", true, false, false],
      ["ktlint", false, false, false],
    ] as const) {
      expect(
        evaluateWorkflowExpression(upload.if, {
          eventName: "push",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          matrix: { task },
          failed,
          cancelled,
        }),
        `${task}: failed=${failed}, cancelled=${cancelled}`,
      ).toBe(expected);
    }
    const root = tempDirs.make("openclaw-android-test-reports-");
    const reports = [
      "apps/android/app/build/test-results/testPlayDebugUnitTest/TEST-Play.xml",
      "apps/android/app/build/test-results/testThirdPartyDebugUnitTest/TEST-ThirdParty.xml",
      "apps/android/wear/build/test-results/testDebugUnitTest/TEST-Wear.xml",
      "apps/android/wear-shared/build/test-results/testDebugUnitTest/TEST-Shared.xml",
      "apps/android/hs_err_pid101.log",
      "apps/android/replay_pid101.log",
      "apps/android/app/hs_err_pid202.log",
      "apps/android/app/replay_pid202.log",
      "apps/android/wear/hs_err_pid303.log",
      "apps/android/wear-shared/replay_pid404.log",
    ];
    const unrelated = [
      "apps/android/app/build/test-results/testPlayDebugUnitTest/binary/results.bin",
      "apps/android/app/build/reports/lint-results-playDebug.xml",
      "apps/android/app/build/outputs/apk/play/debug/app.apk",
      "apps/android/benchmark/build/test-results/testDebugUnitTest/TEST-Benchmark.xml",
      ".gradle/caches/TEST-cached.xml",
      ".gradle/caches/hs_err_pid505.log",
      "hs_err_pid606.log",
      "replay_pid606.log",
      "apps/android/app/core.202",
      "apps/android/app/java_pid202.hprof",
    ];
    for (const file of [...reports, ...unrelated]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "synthetic report fixture");
    }
    const patterns = String(upload.with?.path).trim().split("\n");
    expect(globSync(patterns, { cwd: root }).toSorted()).toEqual(reports.toSorted());
  });

  it("never keys a Blacksmith sticky disk by unbounded run dimensions", () => {
    // Blacksmith caps backing disks per installation; per-PR, per-commit,
    // per-run, or per-hash key segments mint disks until every mount 429s.
    // Snapshot validity belongs in in-job fingerprints/markers, never the key.
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
      const parsed = parse(readFileSync(file, "utf8"));
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
    expect(cleanup.permissions).toEqual({ contents: "read" });
    expect(cleanup.concurrency).toEqual({
      group: "sticky-disk-cleanup",
      "cancel-in-progress": false,
    });
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("inputs.confirm");
    expect(checkoutStep.with.ref).toBe("refs/heads/main");
    expect(job["runs-on"]).toContain("inputs.architecture == 'arm64'");
    expect(validateStep.env.RETIRED_ARCHITECTURE).toBe("${{ inputs.architecture }}");
    expect(validateStep.env.RETIRED_KEY).toBe("${{ inputs.retired_key }}");
    expect(validateStep.env.RETIRED_REGION).toBe("${{ inputs.region }}");
    expect(validateStep.run).toContain('process.env.BLACKSMITH_ENV?.includes("arm")');
    expect(validateStep.run).toContain("requestedRegion !== process.env.BLACKSMITH_REGION");
    expect(validateStep.run).toContain("requestedKey !== requestedKey.trim()");
    expect(validateStep.run).toContain("disk?.key === requestedKey");
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
    const workflowFiles = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml"))
      .map((name) => `.github/workflows/${name}`);
    const actionFiles = readdirSync(".github/actions").map(
      (name) => `.github/actions/${name}/action.yml`,
    );
    const activeKeyPatterns: RegExp[] = [];
    for (const file of [...workflowFiles, ...actionFiles]) {
      if (!existsSync(file)) {
        continue;
      }
      const parsed = parse(readFileSync(file, "utf8"));
      const jobs = parsed?.jobs ? Object.values(parsed.jobs) : [];
      const stepLists = [
        ...jobs.map((candidate) => (candidate as { steps?: WorkflowStep[] }).steps ?? []),
        (parsed?.runs?.steps ?? []) as WorkflowStep[],
      ];
      for (const step of stepLists.flat()) {
        if (typeof step?.uses !== "string" || !step.uses.startsWith("useblacksmith/stickydisk@")) {
          continue;
        }
        const key = step.with?.key;
        if (typeof key !== "string") {
          continue;
        }
        const escapedParts = key
          .split(/\$\{\{[^}]+\}\}/u)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
        activeKeyPatterns.push(new RegExp(`^${escapedParts.join(".+")}$`, "u"));
      }
    }
    for (const retiredDisk of retiredDisks) {
      expect(
        activeKeyPatterns.some((pattern) => pattern.test(retiredDisk.key as string)),
        `${retiredDisk.key as string} is still an active sticky-disk key`,
      ).toBe(false);
    }
  });

  it("runs all source checks serially and preserves individual failures", () => {
    const additionalJob = readCiWorkflow().jobs["check-additional-shard"];
    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    const sessionCommands = [
      "lint:tmp:session-accessor-boundary",
      "lint:tmp:sqlite-transaction-boundary",
      "lint:tmp:session-transcript-reader-boundary",
    ];
    const root = tempDirs.make("openclaw-session-boundary-workflow-");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "pnpm-calls.txt");
    mkdirSync(binDir);
    const pnpmPath = path.join(binDir, "pnpm");
    writeFileSync(
      pnpmPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >> "$PNPM_CALLS"\nif [[ "${2:-}" == "${PNPM_FAIL:-}" ]]; then exit 1; fi\n',
      "utf8",
    );
    chmodSync(pnpmPath, 0o755);
    const exportScript = path.join(root, "scripts/check-export-name-collisions.mts");
    mkdirSync(path.dirname(exportScript));
    for (const [group, commands] of [
      [
        "source-contracts",
        ["lint:tmp:export-name-collisions", ...sessionCommands, "sqlite:sessions-schema:check"],
      ],
      ["session-accessor-boundary", sessionCommands],
      ["export-name-collisions", ["lint:tmp:export-name-collisions"]],
      ["sqlite-session-schema-baseline", ["sqlite:sessions-schema:check"]],
    ] as const) {
      for (const scenario of [
        { failed: "", missing: "", missingFile: false },
        ...commands.map((failed) => ({ failed, missing: "", missingFile: false })),
        ...(group === "source-contracts"
          ? [
              ...commands.map((missing) => ({ failed: "", missing, missingFile: false })),
              { failed: "", missing: "", missingFile: true },
            ]
          : []),
      ]) {
        const present = commands.filter(
          (command) =>
            command !== scenario.missing &&
            !(scenario.missingFile && command === "lint:tmp:export-name-collisions"),
        );
        if (scenario.missingFile) {
          rmSync(exportScript, { force: true });
        } else {
          writeFileSync(exportScript, "");
        }
        writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({
            scripts: Object.fromEntries(
              commands
                .filter((command) => command !== scenario.missing)
                .map((command) => [command, "fixture"]),
            ),
          }),
        );
        writeFileSync(callsPath, "");
        const result = runWorkflowShellScript(runStep.run, {
          cwd: root,
          env: {
            ...process.env,
            ADDITIONAL_CHECK_GROUP: group,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            PNPM_CALLS: callsPath,
            PNPM_FAIL: scenario.failed,
          },
        });
        const context = `${group} ${JSON.stringify(scenario)}\n${result.stdout}${result.stderr}`;
        expect(readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean), context).toEqual(
          present.map((command) => `run ${command}`),
        );
        expect(result.status, context).toBe(scenario.failed ? 1 : 0);
        expect(result.stdout.match(/^::error .+$/gmu) ?? [], context).toEqual(
          scenario.failed
            ? [`::error title=${scenario.failed} failed::${scenario.failed} failed`]
            : [],
        );
        for (const command of present.filter((entry) => entry !== scenario.failed)) {
          expect(result.stdout, context).toContain(`[ok] ${command}`);
        }
        expect(result.stdout.match(/^\[skip\].+$/gmu) ?? [], context).toHaveLength(
          scenario.missing || scenario.missingFile ? 1 : 0,
        );
      }
    }
  });

  it("uses the current SDK diff and preserves the historical baseline check", () => {
    const workflow = readCiWorkflow();
    const runStep = workflow.jobs["check-additional-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    const runCase = (
      scripts: Record<string, string>,
      compatibilityTarget: boolean,
      eventName = "workflow_dispatch",
      fail = false,
    ) => {
      const root = tempDirs.make("openclaw-plugin-sdk-api-workflow-");
      const binDir = path.join(root, "bin");
      const callsPath = path.join(root, "pnpm-calls.txt");
      const summaryPath = path.join(root, "summary.md");
      mkdirSync(binDir);
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
      const pnpmPath = path.join(binDir, "pnpm");
      writeFileSync(
        pnpmPath,
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >> "$PNPM_CALLS"\nexit "$PNPM_RESULT"\n',
        "utf8",
      );
      chmodSync(pnpmPath, 0o755);
      const script = runStep.run
        .replaceAll("${{ needs.preflight.outputs.diff_base_revision }}", "base-sha")
        .replaceAll("${{ needs.preflight.outputs.diff_head_revision }}", "synthetic-head-sha");
      const result = runWorkflowShellScript(script, {
        cwd: root,
        env: {
          ...process.env,
          ADDITIONAL_CHECK_GROUP: "plugin-sdk-api-diff",
          COMPATIBILITY_TARGET: compatibilityTarget ? "true" : "false",
          GITHUB_EVENT_NAME: eventName,
          GITHUB_STEP_SUMMARY: summaryPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          PNPM_CALLS: callsPath,
          PNPM_RESULT: fail ? "1" : "0",
          RUN_PROMPT_SNAPSHOTS: "false",
        },
      });
      return {
        calls: existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [],
        result,
        summaryPath,
      };
    };

    // Pure reporting: pushes and PRs skip the diff; dispatches (including
    // release validation) still produce it.
    for (const eventName of ["push", "pull_request"]) {
      const skipped = runCase({ "plugin-sdk:api:diff": "mock" }, false, eventName);
      expect(skipped.result.status, skipped.result.stderr).toBe(0);
      expect(skipped.calls).toEqual([]);
      expect(skipped.result.stdout).toContain("manual and release dispatches only");
    }

    const current = runCase({ "plugin-sdk:api:diff": "mock" }, false);
    expect(current.result.status, current.result.stderr).toBe(0);
    expect(current.calls).toEqual([
      "run plugin-sdk:api:diff -- --base base-sha --head synthetic-head-sha --json .artifacts/plugin-sdk-api-diff.json --summary " +
        current.summaryPath,
    ]);

    const failed = runCase({ "plugin-sdk:api:diff": "mock" }, false, "workflow_dispatch", true);
    expect(failed.result.status, failed.result.stderr).toBe(1);
    expect(failed.calls).toHaveLength(1);
    expect(failed.result.stdout).toContain(
      "::error title=plugin-sdk:api:diff failed::plugin-sdk:api:diff failed",
    );

    const historical = runCase({ "plugin-sdk:api:check": "mock" }, true);
    expect(historical.result.status, historical.result.stderr).toBe(0);
    expect(historical.calls).toEqual(["run plugin-sdk:api:check"]);

    const missingCurrent = runCase({ "plugin-sdk:api:check": "mock" }, false);
    expect(missingCurrent.result.status).toBe(1);
    expect(missingCurrent.calls).toEqual([]);
    expect(missingCurrent.result.stdout).toContain(
      "Current CI targets must provide plugin-sdk:api:diff.",
    );
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

  it("owns Docs Agent Git without changing cadence, deadlines, or action authority", () => {
    const source = readFileSync(".github/workflows/docs-agent.yml", "utf8");
    const workflow = parse(source);
    const job = workflow.jobs["update-docs"];
    const steps = job.steps as WorkflowStep[];
    expect(steps.map(({ name }) => name)).toEqual([
      "Checkout",
      "Prepare Git owner",
      "Gate trusted main activity and hourly cadence",
      "Setup Node environment",
      "Ensure docs agent key exists",
      "Run Codex docs agent",
      "Enforce existing-docs-only patch",
      "Restore Node 24 path",
      "Check docs",
      "Commit docs updates",
    ]);
    expect(steps[1]).toEqual({
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    });
    expect(steps[0]).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "main",
        "fetch-depth": 0,
        "persist-credentials": false,
        submodules: false,
      },
    });
    expect(job["timeout-minutes"]).toBe(30);
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(job.permissions).toEqual({ actions: "read", contents: "write" });
    expect(workflow.concurrency).toBeUndefined();
    expect(job.concurrency).toEqual({ group: "docs-agent-main", "cancel-in-progress": false });
    expect(steps[5]).toEqual({
      name: "Run Codex docs agent",
      if: "steps.gate.outputs.run_agent == 'true'",
      uses: "openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56",
      env: {
        DOCS_AGENT_BASE_SHA: "${{ steps.gate.outputs.review_base_sha }}",
        DOCS_AGENT_HEAD_SHA: "${{ steps.gate.outputs.review_head_sha }}",
      },
      with: {
        "openai-api-key":
          "${{ secrets.OPENCLAW_DOCS_AGENT_OPENAI_API_KEY || secrets.OPENAI_API_KEY }}",
        "prompt-file": ".github/codex/prompts/docs-agent.md",
        model: "${{ vars.OPENCLAW_CI_OPENAI_MODEL_BARE }}",
        effort: "medium",
        sandbox: "workspace-write",
        "safety-strategy": "drop-sudo",
        "codex-args": '["--full-auto"]',
      },
    });
    const gate = expectDefined(steps[2]?.run, "gate policy");
    const commit = expectDefined(steps[9]?.run, "commit policy");
    const enforce = expectDefined(steps[6]?.run, "enforcement producers");
    expect(gate.match(/python3 -I -S "\$CI_GIT_OWNER" --policy -/gu)).toHaveLength(2);
    expect(gate.indexOf("--policy -")).toBeLessThan(gate.indexOf("gh api"));
    expect(gate.lastIndexOf("--policy -")).toBeGreaterThan(gate.indexOf("gh api"));
    expect(commit).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
    for (const policy of [gate, commit]) {
      expect(policy.match(/for attempt in range\(1, 6\):/gu)).toHaveLength(1);
      expect(policy).toContain("except (GitFailure, FetchTimeout):");
      expect(policy).not.toMatch(
        /except (?:Exception|BaseException)|except:|error\.code|\$\?|\|\| true/u,
      );
    }
    expect(gate).toContain(
      'if attempt == 5:\n            print("Failed to fetch main after retries.", file=sys.stderr)\n            raise SystemExit(1)',
    );
    expect(gate.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(1);
    expect(commit.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(2);
    const calls = [
      ...`${gate}\n${commit}`.matchAll(/(?:run_git|git_output)\(([\s\S]*?)\)(?=\.rstrip|\n|$)/gu),
    ].map((match) => match[1]!);
    const fetches = calls.filter((call) => call.startsWith('workspace, "fetch"'));
    expect(fetches).toEqual([
      'workspace, "fetch", "--no-tags", "origin", "main", timeout=120, reclaim_locks=True',
      'workspace, "fetch", "--no-tags", "origin", target, timeout=120, reclaim_locks=True',
    ]);
    expect(calls.filter((call) => call.includes("timeout="))).toEqual(fetches);
    expect(enforce.match(/--checkout-git 0 (?:ls-files|diff)/gu)).toHaveLength(5);
    expect(`${gate}\n${commit}\n${enforce}`).not.toMatch(
      /\btimeout --|\bgit (?:fetch|rev-parse|cat-file|diff|ls-files|config|add|commit|push)\b/u,
    );
    // The corrected REST cadence contract is deliberately byte-stable across Git migration.
    const cadence = source.slice(
      source.indexOf("          runs_json="),
      source.indexOf('          python3 -I -S "$CI_GIT_OWNER" --policy - "$remote_main"'),
    );
    expect(createHash("sha256").update(cadence).digest("hex")).toBe(
      "f130607e377acff6983fc2efaa015025ae2865d340dfad1fb865ee61e081f83e",
    );
  });

  it("owns docs mirror Git lifecycle without changing transport or stale-source policy", () => {
    const source = readFileSync(".github/workflows/docs-sync-publish.yml", "utf8");
    const workflow = parse(source);
    const steps = workflow.jobs["sync-publish-repo"].steps as WorkflowStep[];
    expect(steps.map(({ name }) => name)).toEqual([
      "Skip publish sync without token",
      "Checkout source repo",
      "Checkout ClawHub docs source",
      "Prepare Git owner",
      "Setup Node",
      "Clone publish repo",
      "Sync docs into publish repo",
      "Cache successful docs validation",
      "Commit publish repo sync",
    ]);
    expect(steps[3]).toEqual({
      name: "Prepare Git owner",
      if: "env.OPENCLAW_DOCS_SYNC_TOKEN != ''",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    });
    expect(steps[1]).toMatchObject({ with: { "fetch-depth": 0 } });
    expect(steps[2]).toMatchObject({
      with: {
        repository: "openclaw/clawhub",
        ref: "main",
        path: "clawhub-source",
        "fetch-depth": 1,
        "persist-credentials": false,
      },
    });
    for (const step of steps.slice(1)) {
      expect(step.if).toBe(
        step.name === "Cache successful docs validation"
          ? "env.OPENCLAW_DOCS_SYNC_TOKEN != '' && github.repository == 'openclaw/openclaw' && github.ref == 'refs/heads/main'"
          : "env.OPENCLAW_DOCS_SYNC_TOKEN != ''",
      );
    }
    expect(source).not.toContain("setup-python");
    expect(workflow.concurrency).toEqual({
      group:
        "docs-sync-publish-${{ github.event_name == 'workflow_dispatch' && format('manual-{0}', github.run_id) || github.ref }}",
      "cancel-in-progress": false,
    });
    const clone = expectDefined(steps[5]?.run, "clone policy");
    const sync = expectDefined(steps[6]?.run, "sync body");
    const publish = expectDefined(steps[8]?.run, "publication policy");
    expect(steps[8]?.["working-directory"]).toBe("publish");
    for (const policy of [clone, publish]) {
      expect(
        policy.startsWith(
          "set -euo pipefail\nexec python3 -I -S \"$CI_GIT_OWNER\" --policy - <<'PYTHON'\n",
        ),
      ).toBe(true);
      expect(policy.match(/for attempt in range\(1, 6\):/gu)).toHaveLength(1);
      expect(policy.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(1);
      expect(policy).toContain("except (GitFailure, FetchTimeout):");
      expect(policy).not.toMatch(
        /except (?:Exception|BaseException)|except:|error\.code|\$\?|\|\| true/u,
      );
    }
    expect(clone).toContain('publish = os.path.join(workspace, "publish")');
    expect(clone).toContain('subprocess.run(["rm", "-rf", publish], check=True)');
    expect(clone).toContain(
      "https://x-access-token:{os.environ['OPENCLAW_DOCS_SYNC_TOKEN']}@github.com/openclaw/docs.git",
    );
    const calls = [...`${clone}\n${publish}`.matchAll(/run_git\(([\s\S]*?)\)(?=\n|$)/gu)].map(
      (match) => match[1]!,
    );
    const transports = calls.filter((call) => /^\w+, "(?:clone|fetch)"/u.test(call));
    expect(transports).toHaveLength(3);
    expect(transports.every((call) => call.includes("timeout=120"))).toBe(true);
    expect(transports.slice(1)).toEqual(
      Array(2).fill(
        'publish, "fetch", "origin", "main:refs/remotes/origin/main", timeout=120, reclaim_locks=True',
      ),
    );
    expect(calls.filter((call) => call.includes("timeout="))).toEqual(transports);
    expect(calls.filter((call) => /^publish, "(?:rebase|push)"/u.test(call))).toHaveLength(3);
    expect(
      calls
        .filter((call) => /^publish, "(?:config|add|commit|rebase|push)"/u.test(call))
        .every((call) => call.includes("reclaim_locks=True")),
    ).toBe(true);
    expect(publish).toContain("if not current_source_sha or current_source_sha == source_sha:");
    expect(publish).toContain(
      'run_git(workspace, "merge-base", "--is-ancestor", source_sha, current_source_sha)',
    );
    expect(publish).toContain("except (GitFailure, json.JSONDecodeError):");
    expect(sync.startsWith("set -euo pipefail\n")).toBe(true);
    expect(sync).toContain(
      'clawhub_sha="$(cd "$GITHUB_WORKSPACE/clawhub-source" && python3 -I -S "$CI_GIT_OWNER" --checkout-git 0 rev-parse HEAD)"\nnode scripts/docs-sync-publish.mjs',
    );
    expect([clone, sync, publish].join("\n")).not.toMatch(
      /\btimeout --|\bgit (?:clone|fetch|show|merge-base|diff|config|add|commit|rebase|push|rev-parse)\b|--depth|--no-tags/u,
    );
  });

  it("pins plugin publication owners before selected checkout and preserves Git deadlines", () => {
    const owner = {
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    };
    const clawhub = parse(readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"));
    const npm = parse(readFileSync(".github/workflows/plugin-npm-release.yml", "utf8"));
    for (const [workflow, jobName, checkoutName] of [
      [clawhub, "preview_plugins_clawhub", "Checkout"],
      [npm, "preview_plugins_npm", "Checkout"],
      [npm, "verify_plugin_npm_preflight", "Checkout trusted npm preflight tooling"],
      [npm, "publish_plugins_npm", "Checkout trusted publication tooling"],
    ] as const) {
      const steps = workflow.jobs[jobName].steps as WorkflowStep[];
      expect(steps[0], jobName).toEqual(owner);
      expect(steps[1]?.name, jobName).toBe(checkoutName);
      const body = steps
        .map(({ run }) => run ?? "")
        .join("\n")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      const calls = [...body.matchAll(/(?:run_git|git_output)\(([\s\S]*?)\)(?=\.|\n|$)/gu)].map(
        (match) => match[1]!,
      );
      const transports = calls.filter((call) => /^\s*workspace,\s*"(?:fetch|show)",/u.test(call));
      expect(transports.length, jobName).toBeGreaterThan(0);
      for (const call of transports) {
        expect(call, jobName).toMatch(/\btimeout\s*=\s*120\b/u);
      }
      expect(body, jobName).not.toMatch(
        /timeout[^\n]*git|(?:^|\s)git (?:fetch|rev-parse|merge-base|for-each-ref|checkout|show)\b/mu,
      );
      expect(body, jobName).not.toMatch(/backoff\(|for attempt in range/u);
    }
    for (const stepName of [
      "Read exact npm preflight source package",
      "Read exact npm publication source package",
    ]) {
      const step = [
        ...npm.jobs.verify_plugin_npm_preflight.steps,
        ...npm.jobs.publish_plugins_npm.steps,
      ].find(({ name }: WorkflowStep) => name === stepName) as WorkflowStep;
      expect(step.run, stepName).toContain("git_output(");
      expect(step.run, stepName).toContain('errors="surrogateescape"');
    }
  });

  it("pins the Mantis Git owner and preserves distinct terminal ref-validation contracts", () => {
    const action = parse(
      readFileSync(".github/actions/mantis-validate-trusted-ref/action.yml", "utf8"),
    );
    const workflow = parse(readFileSync(".github/workflows/mantis-discord-smoke.yml", "utf8"));
    const owner = {
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    };
    const actionSteps = action.runs.steps as WorkflowStep[];
    const discordSteps = workflow.jobs.validate_selected_ref.steps as WorkflowStep[];
    expect(actionSteps.map(({ name }) => name)).toEqual([
      "Prepare Git owner",
      "Validate refs are trusted",
    ]);
    expect(actionSteps[0]).toEqual(owner);
    expect(discordSteps.map(({ name }) => name)).toEqual([
      "Prepare Git owner",
      "Checkout selected ref",
      "Validate selected ref",
    ]);
    expect(discordSteps[0]).toEqual(owner);
    expect(discordSteps[1]).toMatchObject({
      uses: CHECKOUT_V6,
      with: { "persist-credentials": false, ref: "${{ inputs.ref }}", "fetch-depth": 0 },
    });
    expect(Object.keys(action.inputs)).toEqual(["candidate-ref", "baseline-ref"]);
    expect(Object.keys(action.outputs)).toEqual(["candidate-revision", "baseline-revision"]);
    for (const [steps, shared] of [
      [actionSteps, true],
      [discordSteps, false],
    ] as const) {
      const run = expectDefined(steps.at(-1)?.run, "Mantis validation body");
      const revision = shared ? "revision" : "selected_revision";
      const prefix = `python3 -I -S "$CI_GIT_OWNER" --checkout-git ${shared ? 0 : 120} fetch --no-tags origin `;
      expect(run.startsWith("set -euo pipefail\n")).toBe(true);
      expect(
        run
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /\bfetch\b/u.test(line)),
      ).toEqual([
        `${prefix}+refs/heads/main:refs/remotes/origin/main`,
        ...(shared
          ? []
          : [`${prefix}"+refs/heads/\${INPUT_REF}:refs/remotes/origin/\${INPUT_REF}"`]),
      ]);
      expect(run).not.toMatch(/\bgit fetch\b|^\s*(?:timeout|for|while|until)\b|\$\?/mu);
      expect(
        run.match(
          /(?:reason|trusted_reason)="(?:main-ancestor|release-tag|release-branch-head|open-pr-head)"/gu,
        ),
      ).toEqual(
        [
          "main-ancestor",
          "release-tag",
          ...(shared ? [] : ["release-branch-head"]),
          "open-pr-head",
        ].map((reason) => `${shared ? "reason" : "trusted_reason"}="${reason}"`),
      );
      expect(run).toContain(`git tag --points-at "$${revision}" | grep -Eq '^v'`);
      expect(run).toContain("gh api \\\n");
      expect(run).toContain('-H "Accept: application/vnd.github+json"');
      expect(run).toContain(`"repos/\${GITHUB_REPOSITORY}/commits/\${${revision}}/pulls"`);
      expect(run).toContain(
        `select(.state == "open" and .head.repo.full_name == "'"\${GITHUB_REPOSITORY}"'" and .head.sha == "'"\${${revision}}"'")] | length`,
      );
      if (shared) {
        expect(run).toContain('echo "${label}_revision=${revision}" >> "$GITHUB_OUTPUT"');
        expect(run).toContain(
          'validate_ref baseline "$BASELINE_REF"\nfi\nvalidate_ref candidate "$CANDIDATE_REF"',
        );
      } else {
        expect(run).toContain(
          'elif [[ "$INPUT_REF" =~ ^release/[0-9]{4}\\.[0-9]+\\.[0-9]+$ ]]; then',
        );
        expect(run).toContain(
          'release_branch_sha="$(git rev-parse "refs/remotes/origin/${INPUT_REF}")"',
        );
        expect(run).toContain(
          'if [[ "$selected_revision" == "$release_branch_sha" ]]; then\n    trusted_reason="release-branch-head"\n  fi\nelse\n  pr_head_count=',
        );
        expect(run).toContain(
          'echo "selected_revision=$selected_revision" >> "$GITHUB_OUTPUT"\necho "trusted_reason=$trusted_reason" >> "$GITHUB_OUTPUT"',
        );
      }
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
        uses: CREATE_GITHUB_APP_TOKEN_V3,
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

  it.each(MANTIS_MANUAL_ONLY_WORKFLOWS)(
    "keeps legacy Mantis scenarios on manual dispatch in %s",
    (workflowPath) => {
      const workflow = parse(readFileSync(workflowPath, "utf8"));

      expect(workflow.on.workflow_dispatch, workflowPath).toBeDefined();
      expect(workflow.on.issue_comment, workflowPath).toBeUndefined();
    },
  );

  it("bounds release ref validation fetches across checkout auth modes", () => {
    const resolveTargetSteps = readReleaseChecksWorkflow().jobs.resolve_target.steps;

    for (const stepName of [
      "Validate selected ref belongs to this repository",
      "Validate Tideclaw alpha target matches workflow branch",
    ]) {
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
    it.each(["branch", "tag"] as const)("accepts a small valid %s history", (route) => {
      const { result, events } = runReleaseFallbackHistoryFixture({ route });
      expect(result.status, result.stderr).toBe(0);
      expect(events.filter((event) => event.op.startsWith("fetch-"))).toMatchObject([
        { op: "fetch-branches", status: 0, signal: null },
        { op: "fetch-tags", status: 0, signal: null },
      ]);
      expect(events.find((event) => event.op === `${route}-producer`)).toMatchObject({
        status: 0,
        signal: null,
      });
    });

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

  it("checks the generated Git owner in the workflow guard lane", () => {
    const check = spawnSync(process.execPath, ["scripts/generate-ci-git-owner.mts", "--check"], {
      encoding: "utf8",
    });
    expect(check.status, check.stderr).toBe(0);
  });

  it("uses the maintained authenticated checkout for security-fast", () => {
    const workflow = readCiWorkflow();
    const checkoutStep = workflow.jobs["security-fast"].steps.find(
      (step: WorkflowStep) => step.name === "Checkout",
    );
    const manualCheckoutStep = workflow.jobs["security-fast"].steps.find(
      (step: WorkflowStep) => step.name === "Checkout manual target",
    );

    expect(checkoutStep.uses).toBe(CHECKOUT_V6);
    expect(checkoutStep.if).toBe(
      "github.event_name != 'workflow_dispatch' || inputs.target_ref == ''",
    );
    expect(checkoutStep.with["persist-credentials"]).toBe(false);
    expect(checkoutStep.with["fetch-depth"]).toBe(2);
    expect(manualCheckoutStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.target_ref != ''",
    );
    expect(manualCheckoutStep.run).toContain("workflow_dispatch target_ref");
  });

  it("keeps manual candidates separate from trusted cache authority", () => {
    const workflow = readCiWorkflow();
    const preflight = workflow.jobs.preflight;
    const checkoutStep = expectDefined(
      preflight.steps.find((step: WorkflowStep) => step.name === "Checkout"),
      "preflight checkout owner",
    );
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
              repository: "openclaw/openclaw",
              runAttempt: 1,
              steps: { checkout_ref: { outputs: { sha: selectedSha } } },
              workflowSha,
            }),
          ).toBe(selectedSha !== workflowSha);
        }
      }
    }
    const trustStep = expectDefined(
      preflight.steps.find((step: WorkflowStep) => step.name === "Classify candidate cache trust"),
      "candidate cache trust step",
    );
    const nativeCheckout = expectDefined(
      workflow.jobs["native-i18n"].steps.find((step: WorkflowStep) => step.name === "Checkout"),
      "native i18n checkout",
    );

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
    expect(trustStep.run).toContain("trust=untrusted");
    expect(trustStep.run).toContain("cache_mode=off");
    expect(trustStep.run).toContain("cache_write_allowed=false");
    expect(trustStep.run).toContain('elif [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]');
    expect(trustStep.run).toContain('"$RELEASE_GATE" == "true"');
    expect(trustStep.run).toContain('"$CHECKOUT_REVISION" == "$DEFAULT_SHA"');
    expect(trustStep.run).toContain('"$CHECKOUT_REVISION" == "$WORKFLOW_REVISION"');
    expect(trustStep.run).toContain("cache_write_allowed=true");

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

    const goSetup = expectDefined(
      workflow.jobs["checks-node-core-test-nondist-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Setup Go for docs i18n",
      ),
      "docs i18n Go setup",
    );
    expect(goSetup.with?.cache).toBe(false);
  });

  it("uses the maintained checkout across workflow sanity jobs", () => {
    const workflow = readWorkflowSanityWorkflow();

    for (const jobName of ["no-tabs", "actionlint", "generated-doc-baselines"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Checkout",
      );

      expect(checkoutStep.uses, jobName).toBe(CHECKOUT_V6);
      expect(checkoutStep.with, jobName).toEqual({
        "fetch-depth": 1,
        "persist-credentials": false,
      });
    }
  });

  it("selects a supported Node before lightweight checks, release approval, and image wrappers", () => {
    const cases: [file: string, jobId: string, consumerName: string, setupCondition?: string][] = [
      ["workflow-sanity.yml", "actionlint", "Disallow tracked merge conflict markers"],
      ["android-release.yml", "publish_signed_android_apk", "Validate release approval and target"],
      ["docker-channel-promote.yml", "resolve", "Resolve release channel policy"],
      ["linux-app-release.yml", "validate_release", "Verify trusted release tooling identity"],
      [
        "openclaw-live-and-e2e-checks-reusable.yml",
        "prepare_live_test_image",
        "Pack live-test image artifact",
      ],
      [
        "openclaw-live-and-e2e-checks-reusable.yml",
        "validate_live_models_docker",
        "Verify and load live-test image artifact",
      ],
      [
        "openclaw-live-and-e2e-checks-reusable.yml",
        "validate_live_models_docker_targeted",
        "Verify and load live-test image artifact",
      ],
      ["openclaw-release-publish.yml", "publish", "Record postpublish outcome", "${{ always() }}"],
    ];
    for (const [file, jobId, consumerName, setupCondition] of cases) {
      const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
      const job = workflow.jobs[jobId];
      const steps: WorkflowStep[] = job.steps;
      const consumerIndex = steps.findIndex((step) => step.name === consumerName);
      const context = `${file}:${jobId}`;
      expect(consumerIndex, context).toBeGreaterThanOrEqual(0);
      const setup = expectDefined(
        steps.slice(0, consumerIndex).find((step) => step.uses?.startsWith("actions/setup-node@")),
        `${context} must select Node before ${consumerName}`,
      );
      const version = setup.with?.["node-version"];
      const resolved =
        version === "${{ env.NODE_VERSION }}"
          ? (job.env?.NODE_VERSION ?? workflow.env?.NODE_VERSION)
          : version;
      expect(isSupportedOpenClawNodeVersion(resolved), context).toBe(true);
      expect(setup.if, context).toBe(setupCondition);
      expect(setup.with?.["package-manager-cache"], context).toBe(false);
    }
    const ci = readCiWorkflow();
    const manifestRuntime = expectDefined(
      ci.jobs.preflight.steps.find(
        (step: WorkflowStep) => step.name === "Setup manifest TypeScript runtime",
      ),
      "CI manifest runtime",
    );
    expect(manifestRuntime.with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
    expect(isSupportedOpenClawNodeVersion(ci.env.NODE_VERSION), "CI manifest runtime pin").toBe(
      true,
    );
  });

  it("pins workflow sanity's typed Git policy after Python setup", () => {
    const steps: WorkflowStep[] = readWorkflowSanityWorkflow().jobs.actionlint.steps;
    const python = expectDefined(
      steps.find((step) => step.name === "Setup Python"),
      "Python",
    );
    const owner = expectDefined(
      steps.find((step) => step.name === "Prepare Git owner"),
      "owner",
    );
    const policy = expectDefined(
      steps.find((step) => step.name === "Prepare trusted workflow audit configs"),
      "policy",
    );
    expect(python.with).toEqual({ "python-version": "3.12" });
    expect(owner.uses).toBe(
      "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    );
    expect(owner.with).toBeUndefined();
    expect(steps.indexOf(python)).toBeLessThan(steps.indexOf(owner));
    expect(steps.indexOf(owner)).toBeLessThan(steps.indexOf(policy));
    expect(policy.if).toBe("github.event_name == 'pull_request'");
    expect(policy.env).toEqual({
      BASE_REF: "${{ github.event.pull_request.base.ref }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(policy.run).toContain("exec python3 -I -S \"$CI_GIT_OWNER\" --policy - <<'PYTHON'");
    expect(policy.run).not.toMatch(
      /timeout --|fetch_status|fetch_base_ref|sleep 5|subprocess\.PIPE|except (?:Exception|BaseException|SystemExit|RuntimeError)/u,
    );
    expect(policy.run?.match(/timeout=\d+/gu)).toEqual(["timeout=30"]);
    expect(policy.run).toContain("range(1, 4)");
    expect(policy.run).toContain("backoff(5)");
    for (const contract of [
      "--no-tags",
      "--depth=1",
      "reclaim_locks=True",
      "refs/remotes/origin/security-base",
      "refs/heads/",
      ".pre-commit-config.yaml",
      ".github/zizmor.yml",
      "pre-commit-base.yaml",
      "zizmor-base.yml",
      "PRE_COMMIT_CONFIG_PATH=",
    ]) {
      expect(policy.run).toContain(contract);
    }
    const audit = expectDefined(
      steps.find((step) => step.name === "Audit all workflows with zizmor"),
      "audit",
    );
    expect(audit.run).toContain(
      'pre-commit run --config "${PRE_COMMIT_CONFIG_PATH:-.pre-commit-config.yaml}" zizmor',
    );
  });

  it("prepares Testbox checkouts with one maintained owner and scoped history", () => {
    const workflowPaths = [
      [
        ".github/workflows/ci-check-testbox.yml",
        "1",
        "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || 'HEAD' }}",
        "1.27.1",
      ],
      [
        ".github/workflows/ci-check-arm-testbox.yml",
        "0",
        "${{ github.event.pull_request.base.sha || 'refs/remotes/origin/main' }}",
        "1.27.1",
      ],
      [
        ".github/workflows/ci-build-artifacts-testbox.yml",
        "0",
        "${{ github.event.pull_request.base.sha || 'refs/remotes/origin/main' }}",
        undefined,
      ],
    ] as const;

    for (const [workflowPath, dispatchFetchDepth, baseRef, goVersion] of workflowPaths) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const job = Object.values(workflow.jobs)[0] as { steps: WorkflowStep[] };
      const checkoutStep = job.steps.find((step) => step.name === "Checkout");
      const prepareStep = job.steps.find((step) => step.name === "Prepare Testbox shell");

      expect(checkoutStep?.uses, workflowPath).toBe(CHECKOUT_V6);
      expect(checkoutStep?.with?.["persist-credentials"], workflowPath).toBe(false);
      for (const [eventName, expectedDepth] of [
        ["pull_request", "2"],
        ["workflow_dispatch", dispatchFetchDepth],
      ] as const) {
        expect(
          evaluateWorkflowExpression(checkoutStep?.with?.["fetch-depth"], {
            eventName,
            repository: "openclaw/openclaw",
            runAttempt: 1,
          }),
          `${workflowPath} ${eventName}`,
        ).toBe(expectedDepth);
      }
      expect(prepareStep?.uses, workflowPath).toBe("./.github/actions/prepare-testbox-shell");
      expect(prepareStep?.with?.["base-ref"], workflowPath).toBe(baseRef);
      expect(prepareStep?.with?.["go-version"], workflowPath).toBe(goVersion);
      const ensureBaseStep = job.steps.find(
        (step: WorkflowStep) => step.name === "Ensure Testbox base commit",
      );
      expect(ensureBaseStep, workflowPath).toBeUndefined();
      expect(JSON.stringify(job.steps), workflowPath).not.toContain(
        "+refs/heads/main:refs/remotes/origin/main",
      );
    }

    const action = parse(readFileSync(".github/actions/prepare-testbox-shell/action.yml", "utf8"));
    expect(action.inputs["go-version"]).toMatchObject({ required: false });
    const setupGo = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.uses === SETUP_GO_V6),
      "Testbox Go setup",
    );
    expect(setupGo).toMatchObject({
      if: "inputs.go-version != ''",
      with: {
        cache: false,
        "go-version": "${{ inputs.go-version }}",
      },
    });
    const exposeGo = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Expose Go tools"),
      "Testbox Go exposure",
    );
    expect(exposeGo.if).toBe("inputs.go-version != ''");
    expect(exposeGo.run).toContain('test "$(go env GOVERSION)" = "go${TESTBOX_GO_VERSION}"');
    expect(exposeGo.run).toContain('go_root="$(go env GOROOT)"');
    expect(exposeGo.run).toContain("for tool in go gofmt; do");
    expect(exposeGo.run).toContain('"/usr/local/bin/$tool"');
    const prepare = expectDefined(
      action.runs.steps.find(
        (step: WorkflowStep) => step.name === "Pin Testbox base and Node tools",
      ),
      "Testbox base preparation",
    );
    const run = prepare.run as string;
    expect(run).toContain('base_ref="${TESTBOX_BASE_REF:-HEAD}"');
    expect(run).toContain('git rev-parse --verify "${base_ref}^{commit}"');
    expect(run).toContain('git update-ref refs/remotes/origin/main "$base_sha"');
    expect(run).not.toContain("git fetch");
  });

  it("bounds the workflow sanity ShellCheck download", () => {
    const workflow = readWorkflowSanityWorkflow();
    const shellcheckStep = expectDefined(
      workflow.jobs.actionlint.steps.find(
        (step: WorkflowStep) => step.name === "Install ShellCheck",
      ),
      "ShellCheck install step",
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
    const install = expectDefined(
      steps.find((step) => step.name === "Install actionlint"),
      "actionlint install",
    );

    expect(setupGo.with).toEqual({ "go-version": "1.25.0", cache: false });
    expect(steps.indexOf(setupGo)).toBeLessThan(steps.indexOf(install));
    expect(install.run).toContain(`ACTIONLINT_REVISION="${revision}"`);
    expect(install.run).toContain('export GOBIN="$RUNNER_TEMP/actionlint-bin"');
    expect(install.run).toContain(
      'go install "github.com/rhysd/actionlint/cmd/actionlint@${ACTIONLINT_REVISION}"',
    );
    expect(install.run).toContain('"$GOBIN/actionlint" -version');
    expect(install.run).toContain("v1.7.13-0.20260419144658-${ACTIONLINT_REVISION:0:12}");
    expect(install.run).toContain('echo "$GOBIN" >> "$GITHUB_PATH"');
    const preCommit = parse(readFileSync(".pre-commit-config.yaml", "utf8"));
    expect(
      preCommit.repos.find(
        (repo: { repo: string }) => repo.repo === "https://github.com/rhysd/actionlint",
      ).rev,
    ).toBe(revision);
  });

  it("runs committed generated baseline drift checks in workflow sanity", () => {
    const workflow = readWorkflowSanityWorkflow();
    const steps = workflow.jobs["generated-doc-baselines"].steps;
    const stepNames = steps.map((step: WorkflowStep) => step.name);

    expect(stepNames).toContain("Check SQLite sessions/transcripts schema baseline drift");
    expect(stepNames).toContain("Check plugin SDK surface budget");
    expect(
      stepNames.indexOf("Check SQLite sessions/transcripts schema baseline drift"),
    ).toBeLessThan(stepNames.indexOf("Check plugin SDK surface budget"));
    expect(
      steps.find(
        (step: WorkflowStep) =>
          step.name === "Check SQLite sessions/transcripts schema baseline drift",
      ).run,
    ).toBe("pnpm sqlite:sessions-schema:check");
    expect(
      steps.find((step: WorkflowStep) => step.name === "Check plugin SDK surface budget").run,
    ).toBe("pnpm plugin-sdk:surface:check");
  });

  it("shares checkout ownership across Linux and native platforms with their existing budgets", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = readCiWorkflow();

    expect(source.match(/&platform_checkout_step/gu) ?? []).toHaveLength(1);
    expect(source.match(/\*platform_checkout_step/gu) ?? []).toHaveLength(4);
    expect(source.match(/&owned_checkout_run/gu) ?? []).toHaveLength(1);
    const linuxCheckout = workflow.jobs["checks-fast-core"].steps.find(
      (step: WorkflowStep) => step.name === "Checkout",
    );
    for (const runner of ["Linux", "macOS", "Windows"]) {
      const defaults = spawnSync(
        process.platform === "win32" ? "python" : "python3",
        [
          "-I",
          "-S",
          "-c",
          'import json,runpy; owner=runpy.run_path(".github/actions/git-owner/owner.py"); print(json.dumps([owner["fetch_timeout_seconds"], owner["cleanup_seconds"]]))',
        ],
        { encoding: "utf8", env: { ...process.env, RUNNER_OS: runner } },
      );
      expect(defaults.status, defaults.stderr).toBe(0);
      expect(JSON.parse(defaults.stdout)).toEqual([runner === "Linux" ? 120 : 90, 10]);
    }

    for (const jobName of [
      "checks-windows",
      "macos-node",
      "macos-swift",
      "ios-build",
      "ios-screenshot-shard",
    ]) {
      const checkoutStep = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Checkout",
      );

      expect(checkoutStep.run, jobName).toBe(linuxCheckout.run);
      expect(checkoutStep.env, jobName).toEqual(linuxCheckout.env);
      // Bootstrap cannot load Python startup code from the candidate checkout.
      expect(checkoutStep.run, jobName).toContain('exec "$python_command" -I -S -');
    }

    const macosNodeSetup = workflow.jobs["macos-node"].steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    expect(macosNodeSetup.with).toMatchObject({
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "install-bun": "false",
    });
  });

  it("checks native and Node state schema versions in the macOS lane", () => {
    const workflow = readCiWorkflow();
    const schemaVersionStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Native state schema version contract",
    );

    expect(schemaVersionStep.run).toContain("node scripts/check-native-state-schema-version.mjs");
    expect(schemaVersionStep.run).toContain('elif [[ "$HISTORICAL_TARGET" == "true" ]]');
  });

  it("prepares offline Apple assets before CI opens a macOS SwiftPM graph", () => {
    for (const [workflowPath, jobName] of [
      [".github/workflows/ci.yml", "macos-swift"],
      [".github/workflows/macos-periphery.yml", "scan"],
      [".github/workflows/shared-openclawkit-periphery.yml", "scan-macos"],
    ] as const) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const steps = workflow.jobs[jobName].steps as WorkflowStep[];
      const setupIndex = steps.findIndex((step) => step.uses?.endsWith("/setup-node-env"));
      const installIndex = steps.findIndex(
        (step) => step.name === "Install Mermaid renderer dependencies",
      );
      const prepareIndex = steps.findIndex((step) =>
        step.run?.includes("node scripts/prepare-apple-mermaid.mjs"),
      );
      const graphIndex = steps.findIndex((step) =>
        /swift (?:build|package)|periphery scan/u.test(step.run ?? ""),
      );

      const setupStep = expectDefined(steps[setupIndex], `${workflowPath}: dependency setup`);
      const installStep = expectDefined(steps[installIndex], `${workflowPath}: dependency install`);
      expect(setupStep.with?.["install-deps"]).toBe("false");
      expect(installStep.env).toEqual({ CI: "true" });
      expect(installStep.run?.trim().split(/\s+/u)).toEqual([
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--prefer-offline",
        "--optional",
        "--filter",
        "'@openclaw/mermaid-renderer...'",
        "--config.ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
      ]);
      expect(installIndex, `${workflowPath}: filtered dependency install`).toBeGreaterThan(
        setupIndex,
      );
      expect(prepareIndex, `${workflowPath}: resource preparation`).toBeGreaterThan(installIndex);
      expect(graphIndex, `${workflowPath}: SwiftPM graph`).toBeGreaterThan(prepareIndex);
    }
  });

  it.each([
    { historical: false, helperPresent: true, expectedStatus: 0 },
    { historical: true, helperPresent: false, expectedStatus: 0 },
    { historical: false, helperPresent: false, expectedStatus: 1 },
  ])(
    "preserves the Apple asset contract for $historical historical / $helperPresent helper",
    (testCase) => {
      const steps = readCiWorkflow().jobs["macos-swift"].steps as WorkflowStep[];
      const step = expectDefined(
        steps.find((candidate) =>
          candidate.run?.includes("node scripts/prepare-apple-mermaid.mjs"),
        ),
        "Apple asset preparation step",
      );
      const root = tempDirs.make("openclaw-apple-assets-workflow-");
      const marker = path.join(root, "prepared");
      if (testCase.helperPresent) {
        mkdirSync(path.join(root, "scripts"));
        writeFileSync(
          path.join(root, "scripts/prepare-apple-mermaid.mjs"),
          'import { writeFileSync } from "node:fs"; writeFileSync("prepared", "ready");',
        );
      }
      const result = runWorkflowShellScript(expectDefined(step.run, "asset preparation script"), {
        cwd: root,
        env: { ...process.env, HISTORICAL_TARGET: String(testCase.historical) },
      });

      expect(result.status, result.stderr).toBe(testCase.expectedStatus);
      expect(existsSync(marker)).toBe(testCase.helperPresent);
    },
  );

  it.each([
    { historical: false, hasWatchRtc: true, expected: true },
    { historical: false, hasWatchRtc: false, expected: true },
    { historical: true, hasWatchRtc: true, expected: true },
    { historical: true, hasWatchRtc: false, expected: false },
  ])("prepares Watch RTC by source capability: %j", ({ historical, hasWatchRtc, expected }) => {
    const workflow = readCiWorkflow();
    for (const jobName of ["ios-build", "ios-screenshot-shard"]) {
      const install = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Install Watch Rust toolchain",
      );
      const engine = workflow.jobs["ios-build"].steps.find(
        (step: WorkflowStep) => step.name === "Test Watch RTC engine",
      );
      for (const phase of ["smoke", "tests", "release"]) {
        const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          env: { HISTORICAL_TARGET: String(historical) },
          matrix: { phase },
          fileHashes: hasWatchRtc ? { "apps/shared/OpenClawWatchRTC/Cargo.toml": "present" } : {},
        };
        expect(evaluateWorkflowExpression(`\${{ ${install.if} }}`, context)).toBe(expected);
        expect(evaluateWorkflowExpression(`\${{ ${engine.if} }}`, context)).toBe(
          expected && phase === "tests",
        );
      }
    }
  });

  it("retries macOS release builds only when Sparkle metadata is incomplete", () => {
    const workflow = readCiWorkflow();
    const macosInstallStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Install XcodeGen / SwiftLint / SwiftFormat",
    );
    const iosInstallStep = workflow.jobs["ios-build"].steps.find(
      (step: WorkflowStep) => step.name === "Install iOS Swift tooling",
    );
    const macosLintStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Swift lint",
    );
    const iosLintStep = workflow.jobs["ios-build"].steps.find(
      (step: WorkflowStep) => step.name === "Swift lint",
    );
    const buildStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Swift build (release)",
    );
    const validateCacheStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Validate Swift build cache",
    );

    for (const installStep of [macosInstallStep, iosInstallStep]) {
      const currentTargetBranch = installStep.run.split('elif [[ "$HISTORICAL_TARGET"')[0];
      expect(currentTargetBranch).toContain(
        "if [[ -x ./scripts/install-xcodegen.sh && -x ./scripts/install-swift-tools.sh ]]; then",
      );
      expect(currentTargetBranch).toContain('./scripts/install-xcodegen.sh "$swift_tools_dir"');
      expect(currentTargetBranch).toContain('"$swift_tools_dir/xcodegen" --version');
      expect(currentTargetBranch).not.toContain("brew ");
      expect(installStep.run).toContain("brew install xcodegen swiftlint");
      expect(installStep.run).not.toContain("brew install xcodegen swiftlint swiftformat");
      expect(installStep.run).toContain(
        "https://github.com/nicklockwood/SwiftFormat/releases/download/$swiftformat_version/swiftformat.zip",
      );
      expect(installStep.run).toContain("--connect-timeout 10 --max-time 120");
      expect(installStep.run).toContain("--retry 3 --retry-max-time 120");
      expect(installStep.run).toContain(
        'swiftformat_checksum="b990400779aceb7d7020796eb9ba814d4480543f671d38fc0ff48cb72f04c584"',
      );
      expect(installStep.run).toContain(
        'swiftformat_checksum="7cb1cb1fae04932047c7015441c543848e8e60e1572d808d080e0a1f1661114a"',
      );
      expect(installStep.run).toContain(
        '[[ "$("$swift_tools_dir/swiftformat" --version)" == "$swiftformat_version" ]]',
      );
    }
    for (const jobName of ["macos-swift", "ios-build"]) {
      expect(workflow.jobs[jobName].env.HISTORICAL_TARGET).toBe(
        "${{ needs.preflight.outputs.compatibility_target }}",
      );
    }
    expect(iosInstallStep.run).toContain('swiftformat_link="$(brew --prefix)/bin/swiftformat"');
    expect(iosInstallStep.run).toContain(
      'ln -sfn "$swift_tools_dir/swiftformat" "$swiftformat_link"',
    );
    expect(iosInstallStep.run).toContain(
      '[[ "$("$swiftformat_link" --version)" == "$swiftformat_version" ]]',
    );
    for (const lintStep of [macosLintStep, iosLintStep]) {
      expect(lintStep.run).toContain(
        "if [[ -x ./scripts/lint-swift.sh && -x ./scripts/format-swift.sh ]]; then",
      );
    }
    expect(macosLintStep.run).toContain("swiftlint lint --config config/swiftlint.yml");
    expect(macosLintStep.run).toContain("swiftformat --lint apps/macos/Sources");
    expect(iosLintStep.run).toContain("skipping iOS lint for this frozen target");

    const runCacheFixture = (artifactState: "no-build" | "absent" | "incomplete" | "complete") => {
      const root = tempDirs.make(`openclaw-swift-cache-${artifactState}-`);
      const binDir = path.join(root, "bin");
      const buildDir = path.join(root, "apps/macos/.build");
      const frameworkDir = path.join(
        root,
        "apps/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework",
      );
      const callsPath = path.join(root, "swift-calls");
      const outputPath = path.join(root, "github-output");
      mkdirSync(binDir, { recursive: true });
      if (artifactState === "absent") {
        mkdirSync(buildDir, { recursive: true });
      } else if (artifactState === "incomplete" || artifactState === "complete") {
        mkdirSync(frameworkDir, { recursive: true });
      }
      if (artifactState === "complete") {
        writeFileSync(path.join(frameworkDir, "Info.plist"), "complete\n", "utf8");
      }
      writeFileSync(
        path.join(binDir, "swift"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SWIFT_CALLS"
`,
        "utf8",
      );
      chmodSync(path.join(binDir, "swift"), 0o755);
      const result = runWorkflowShellScript(validateCacheStep.run, {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SWIFT_CALLS: callsPath,
        },
      });
      const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [];
      return {
        calls,
        output: readFileSync(outputPath, "utf8").trim(),
        status: result.status,
      };
    };

    for (const artifactState of ["no-build", "complete"] as const) {
      const result = runCacheFixture(artifactState);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.output).toBe("cache-valid=true");
    }
    for (const artifactState of ["absent", "incomplete"] as const) {
      const result = runCacheFixture(artifactState);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["package --package-path apps/macos reset"]);
      expect(result.output).toBe("cache-valid=false");
    }

    const runBuildFixture = (
      artifactState: "absent" | "incomplete" | "complete",
      buildOutcome: "recover" | "fail",
    ) => {
      const root = tempDirs.make(`openclaw-swift-build-${artifactState}-${buildOutcome}-`);
      const binDir = path.join(root, "bin");
      const frameworkDir = path.join(
        root,
        "apps/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework",
      );
      const callsPath = path.join(root, "swift-calls");
      mkdirSync(binDir, { recursive: true });
      if (artifactState === "incomplete" || artifactState === "complete") {
        mkdirSync(frameworkDir, { recursive: true });
      }
      if (artifactState === "complete") {
        writeFileSync(path.join(frameworkDir, "Info.plist"), "complete\n", "utf8");
      }
      writeFileSync(
        path.join(binDir, "swift"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SWIFT_CALLS"
if [[ "\${1:-}" == "package" ]]; then
  exit 0
fi
build_count="$(grep -c '^build ' "$SWIFT_CALLS")"
if [[ "$BUILD_OUTCOME" == "recover" && "$build_count" -eq 2 ]]; then
  exit 0
fi
exit 1
`,
        "utf8",
      );
      chmodSync(path.join(binDir, "swift"), 0o755);
      const result = runWorkflowShellScript(buildStep.run, {
        cwd: root,
        env: {
          ...process.env,
          BUILD_OUTCOME: buildOutcome,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SWIFT_CALLS: callsPath,
        },
      });
      return {
        calls: readFileSync(callsPath, "utf8").trim().split("\n"),
        output: `${result.stdout}${result.stderr}`,
        status: result.status,
      };
    };

    const releaseBuildCommand =
      "build --package-path apps/macos --product OpenClaw --configuration release";
    const packageResetCommand = "package --package-path apps/macos reset";

    const absentFramework = runBuildFixture("absent", "fail");
    expect(absentFramework.status).toBe(1);
    expect(absentFramework.calls).toEqual([releaseBuildCommand]);

    const recovered = runBuildFixture("incomplete", "recover");
    expect(recovered.status).toBe(0);
    expect(recovered.calls).toEqual([
      releaseBuildCommand,
      packageResetCommand,
      releaseBuildCommand,
    ]);
    expect(recovered.output).toContain("did not produce complete Sparkle metadata");

    const completeFramework = runBuildFixture("complete", "fail");
    expect(completeFramework.status).toBe(1);
    expect(completeFramework.calls).toEqual([releaseBuildCommand]);

    const secondFailure = runBuildFixture("incomplete", "fail");
    expect(secondFailure.status).toBe(1);
    expect(secondFailure.calls).toEqual([
      releaseBuildCommand,
      packageResetCommand,
      releaseBuildCommand,
    ]);
  });

  it("uses native macOS Swift tests and preserves the first failure", () => {
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
    expect(recordMetadata.run).toBe("python3 -I -S scripts/swift-build-cache-metadata.py record");
    const saveEligibility = saveBuildCache.if.split(" && (env.HISTORICAL_TARGET")[0];
    expect(recordMetadata.if).toBe(`${saveEligibility} && env.HISTORICAL_TARGET != 'true'`);
    expect(saveBuildCache.if).toBe(
      `${saveEligibility} && (env.HISTORICAL_TARGET == 'true' || steps.record-swift-build-cache-metadata.outcome == 'success')`,
    );
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
            ]
          : []),
      ]);
      const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
      const outputLines = output.split("\n");
      if (buildExitCode === 0) {
        expect(outputLines).toHaveLength(2);
        expect(outputLines[0]).toBe("debug-tests-built=true");
        expect(
          outputLines[1]?.startsWith(`menu-default-artifact-path=${root}/openclaw-menu-default-`),
        ).toBe(true);
      } else {
        expect(output).toBe("");
      }
    }
  });

  it("bounds the Windows Crabbox hydrate main fetch", () => {
    const workflow = readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8");

    expect(workflow).toContain("$fetchInfo = New-Object System.Diagnostics.ProcessStartInfo");
    expect(workflow).toContain('$fetchInfo.FileName = "git"');
    expect(workflow).toContain("$fetchInfo.WorkingDirectory = $repo");
    expect(workflow).toContain("$fetchInfo.UseShellExecute = $false");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardOutput = $true");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardError = $true");
    expect(workflow).toContain(
      "--no-tags --no-progress --prune --no-recurse-submodules --depth=50",
    );
    expect(workflow).toContain("$fetch = New-Object System.Diagnostics.Process");
    expect(workflow).toContain("$fetch.StartInfo = $fetchInfo");
    expect(workflow).toContain("$fetch.WaitForExit(30000)");
    expect(workflow).toContain("$fetch.Kill()");
    expect(workflow).not.toContain("StandardOutput.ReadToEnd()");
    expect(workflow).not.toContain("StandardError.ReadToEnd()");
    expect(workflow).toContain('throw "git fetch failed with exit code $($fetch.ExitCode)"');
    expect(workflow).toContain('throw "git fetch timed out after 30 seconds"');
    expect(workflow).not.toContain(
      'git fetch --no-tags --depth=50 origin "+refs/heads/main:refs/remotes/origin/main"',
    );
  });

  it("bounds Mantis Slack runner IP discovery", () => {
    const workflow = parse(
      readFileSync(".github/workflows/mantis-slack-desktop-smoke.yml", "utf8"),
    ) as { jobs: { run_slack_desktop: { steps: WorkflowStep[] } } };
    const runStep = workflow.jobs.run_slack_desktop.steps.find(
      (step) => step.name === "Run Slack desktop scenario",
    );

    expect(runStep?.run).toContain("for attempt in 1 2 3");
    expect(runStep?.run).toContain(
      "curl -fsS --connect-timeout 5 --max-time 15 https://checkip.amazonaws.com",
    );
    expect(runStep?.run).not.toContain("--retry");
    expect(runStep?.run).toContain('runner_ip=""');
    expect(runStep?.run).toContain('[[ ! "$runner_ip" =~ ^(0|[1-9][0-9]{0,2})\\.');
    expect(runStep?.run).toContain("((10#$octet > 255))");

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
        const invalidResult = spawnSync("bash", ["-c", `set -euo pipefail\n${discoveryBlock}`], {
          encoding: "utf8",
          env: {
            CURL_CALL_COUNT: callCount,
            CURL_SUCCESS_IP: invalidIp,
            PATH: `${fakeBin}:${process.env.PATH}`,
          },
        });
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
    expect(nativeSetup).toContain("WindowsPrincipal");
    expect(nativeSetup).toContain('. "$env:GITHUB_WORKSPACE/scripts/windows-testbox-openssh.ps1"');
    expect(nativeSetup).toContain("$installation = Get-WindowsTestboxOpenSshInstallation");
    expect(nativeSetup).toContain("$sshd = $installation.Sshd");
    expect(
      nativeSetup.indexOf("$installation = Get-WindowsTestboxOpenSshInstallation"),
    ).toBeLessThan(nativeSetup.indexOf("$effectiveConfig = & $sshd"));
    expect(nativeSetup).toContain('-T -C "user=$nativeUser"');
    expect(nativeSetup).toContain(
      "authorizedkeysfile __PROGRAMDATA__/ssh/administrators_authorized_keys",
    );
    expect(nativeSetup).toContain("$keygen = $installation.Keygen");
    expect(nativeSetup).toContain("-E sha256 -lf $env:TESTBOX_PUBLIC_KEY_PATH");
    expect(nativeSetup).toContain("[IO.File]::AppendAllText($authorizedKeys,");
    expect(nativeSetup).toContain("S-1-5-18");
    expect(nativeSetup).toContain("S-1-5-32-544");
    expect(nativeSetup).toContain("SetAccessRuleProtection($true, $false)");
    expect(nativeSetup).toContain('"FullControl", "Allow"');
    expect(nativeSetup).toContain("Set-Acl -LiteralPath $authorizedKeys");
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
    expect(workflow).toContain('echo "phone_home_hydrating_curl=${hydrating_curl_status}"');
    expect(workflow).toContain('echo "phone_home_hydrating_http=${hydrating_http_code}"');
    expect(workflow).toContain('echo "phone_home_${phone_home_status}_curl=${final_curl_status}"');
    expect(workflow).toContain('echo "phone_home_${phone_home_status}_http=${http_code}"');
    expect(workflow).toContain('jq -e \'type == "number"\' <<<"$installation_model_id"');
    expect(workflow).toContain('--arg testbox_id "$TESTBOX_ID"');
    expect(workflow).toContain('--arg testbox_id "$testbox_id"');
    expect(workflow).toContain('--argjson installation_model_id "$installation_model_id"');
    expect(workflow).toContain('--data-binary @"$hydrating_body"');
    expect(workflow).toContain('--data-binary @"$final_body"');
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

  it("runs dependency policy guards in PR CI preflight", () => {
    const parsedWorkflow = readCiWorkflow();
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("npm-lock)"),
    );
    const npmLockGuards = workflow.slice(
      workflow.indexOf("npm-lock)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(workflow).toContain("check-npm-lock");
    expect(preflightGuards).toContain('has_package_script "check:doctor-deprecation-registry"');
    expect(preflightGuards).toContain("pnpm check:doctor-deprecation-registry");
    expect(preflightGuards).toContain(
      "[skip] frozen target predates the wall-clock doctor deprecation registry guard",
    );
    expect(preflightGuards).toContain(
      "Current CI targets must provide the check:doctor-deprecation-registry package script.",
    );
    expect(preflightGuards.indexOf('elif [[ "$FROZEN_TARGET" == "true" ]]')).toBeGreaterThan(
      preflightGuards.indexOf("pnpm check:doctor-deprecation-registry"),
    );
    const checkShard = parsedWorkflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    expect(checkShard.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    expect(parsedWorkflow.jobs.preflight.outputs.frozen_target).toBe(
      "${{ steps.manifest.outputs.frozen_target }}",
    );
    expect(preflightGuards).toContain(
      'if [[ "$FROZEN_TARGET" == "true" ]]; then\n' +
        "                pnpm dup:check:coverage\n" +
        "              else\n" +
        "                pnpm dup:check\n" +
        "              fi",
    );
    expect(npmLockGuards).toContain("pnpm deps:npm-lock:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
    expect(preflightGuards).toContain('has_package_script "check:coercion-helpers"');
    expect(preflightGuards).toContain("pnpm check:coercion-helpers");
    expect(preflightGuards).toContain(
      "[skip] historical target predates the coercion-helper declaration guard",
    );
    expect(preflightGuards).toContain(
      "Current CI targets must provide the check:coercion-helpers package script.",
    );
    expect(parsedWorkflow.jobs.preflight.outputs.diff_base_revision).toBe(
      "${{ steps.diff_base.outputs.sha }}",
    );
    const diffBaseStep = parsedWorkflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Resolve exact diff base",
    );
    expect(diffBaseStep.run).toContain("--prefer-first-parent");
    expect(diffBaseStep.env.DEFAULT_BRANCH).toBe("${{ github.event.repository.default_branch }}");
    expect(diffBaseStep.env.GH_TOKEN).toBe(
      "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && github.token || '' }}",
    );
    expect(diffBaseStep.run).toContain(
      '"repos/${GITHUB_REPOSITORY}/compare/${default_sha}...${head_sha}"',
    );
    expect(diffBaseStep.run).toContain("Could not resolve an exact diff base");
    expect(diffBaseStep.run).toContain(AMBIGUOUS_MAIN_PUSH_GUARD);
    const securityDiffBase = parsedWorkflow.jobs["security-fast"].steps.find(
      (step: WorkflowStep) => step.name === "Resolve security diff base",
    ).run;
    expect(securityDiffBase).toContain("git rev-list --parents -n 1 HEAD");
    expect(securityDiffBase).not.toContain("node scripts/lib/merge-head-diff-base.mjs");
    expect(securityDiffBase).toContain(AMBIGUOUS_MAIN_PUSH_GUARD);
    const checkShardStep = parsedWorkflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    expect(checkShardStep.run).not.toContain("--checkout-git");
    expect(checkShardStep.run).toContain(
      'test "$(git rev-parse refs/remotes/origin/ci-ratchet-base^{commit})" = "$CHECKOUT_BASE_SHA"',
    );
  });

  it.each([
    { job: "check-shard", task: "prod-types", events: [] },
    {
      job: "checks-fast-core",
      task: "startup-corpus",
      events: ["pull_request", "push", "workflow_dispatch"],
    },
    {
      job: "checks-fast-core",
      task: "release-lint-core-1",
      events: ["pull_request", "push", "workflow_dispatch"],
    },
    { job: "checks-fast-core", task: "ci-routing", events: [] },
  ])("prepares the frozen diff base for $job/$task at checkout", ({ job, task, events }) => {
    const expression = readCiWorkflow().jobs[job].env?.CHECKOUT_BASE_SHA;
    const base = "c".repeat(40);
    expect(typeof expression).toBe("string");
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      expect(
        evaluateWorkflowExpression(expression, {
          eventName,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          matrix: { task },
          preflightOutputs: { diff_base_revision: base },
        }),
        eventName,
      ).toBe(events.includes(eventName) ? base : "");
    }
  });

  it.each([false, true])("loads the Node shard planner from its owner (frozen=%s)", (frozen) => {
    const workflow = readCiWorkflow();
    const step = workflow.jobs.preflight.steps.find(
      (entry: WorkflowStep) => entry.name === "Build CI manifest",
    );
    const selection = expectDefined(
      step.run.match(/const nodeTestPlanPath =[\s\S]*?(?=const importTargetPlan)/u)?.[0],
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
         export const createNodeTestShardBundles = () =>
           [${JSON.stringify(owner)}, readFileSync("candidate.txt", "utf8")];`,
      );
    }
    const run = spawnSync(testNodeExecPath, ["--input-type=module"], {
      cwd: root,
      input: `import { existsSync } from "node:fs";
        const frozenTarget = ${frozen};
        const compatibilityTarget = true;
        ${selection}
        console.log(JSON.stringify(createNodeTestPlan()));`,
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
    }
  });

  it("imports the real frozen planner from the declared sparse checkout", () => {
    const checkout = readCiWorkflow().jobs.preflight.steps.find(
      (entry: WorkflowStep) => entry.name === "Checkout trusted CI harness",
    );
    const root = tempDirs.make("ci-planner-sparse-");
    for (const entry of String(checkout.with["sparse-checkout"]).trim().split("\n")) {
      const relative = entry.replace(/^\//u, "");
      const destination = path.join(root, ".ci-harness", relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(relative, destination, { recursive: true });
    }
    const run = spawnSync(testNodeExecPath, ["--input-type=module"], {
      cwd: root,
      input: 'await import("./.ci-harness/scripts/lib/ci-node-test-plan.mts");',
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
  });

  it("keeps the preflight manifest import closure dependency-free", () => {
    const manifestStep = readCiWorkflow().jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const manifestRun = expectDefined(manifestStep?.run, "Build CI manifest script");
    const manifestSource = expectDefined(
      manifestRun.match(/--input-type=module <<'([A-Z][A-Z0-9_]*)'\n([\s\S]*?)\n\1(?=\n|$)/u)?.[2],
      "Build CI manifest Node source",
    );
    const { result, manifest } = runDependencyFreePreflight(
      manifestSource,
      tempDirs.make("ci-preflight-dependencies-"),
      testNodeExecPath,
    );
    expect(
      result.status,
      `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    expect(manifest).toContain("run_node=true\n");
    expect(manifest).toContain("run_windows=true\n");
  });

  it("runs mobile protocol coverage for Node and native-only changes", () => {
    const workflow = readCiWorkflow();
    const coverageStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Check mobile protocol event coverage",
    );
    const checkShardRun = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    ).run;

    // Current-source preflight runs the .mts natively; dispatches selecting
    // another revision retain that target's tsx shim.
    expect(coverageStep.run).toContain("node scripts/check-protocol-event-coverage.mts");
    expect(coverageStep.run).toContain("node scripts/check-protocol-event-coverage.mjs");
    expect(coverageStep.if).toBe("steps.manifest.outputs.run_protocol_event_coverage == 'true'");
    expect(checkShardRun).not.toContain("check:protocol-coverage");
  });

  it("keeps type-aware oxlint within hosted fork-runner resources", () => {
    const workflow = readCiWorkflow();
    const manifestStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const checkShardStep = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    const checkShardRun = checkShardStep.run;
    const hostedCoreLint = workflow.jobs["check-lint-hosted-core-shard"];
    const hostedExtensionLint = workflow.jobs["check-lint-hosted-extension-shard"];
    const hostedCoreTypes = workflow.jobs["check-test-types-hosted-core-shard"];
    expect(manifestStep.env.OPENCLAW_CI_RUNNER_PROFILE).toBe(
      "${{ steps.runner_profile.outputs.runner_profile }}",
    );
    expect(manifestStep.run).toContain("runnerBackend: nodeRunnerBackend");
    expect(checkShardStep.env.RUNNER_PROFILE).toBe("${{ needs.preflight.outputs.runner_profile }}");
    expect(checkShardStep.env.HOSTED_RUNNER_STRIPES).toContain(
      "needs.preflight.outputs.hosted_runner_profile_contract == 'true'",
    );
    expect(checkShardRun).toContain('if [ "$HOSTED_RUNNER_STRIPES" = "true" ]; then');
    expect(checkShardStep.env.RELEASE_GATE).toBe(
      "${{ inputs.release_gate && (needs.preflight.outputs.node_runner_backend != 'runson' && needs.preflight.outputs.ci_qualification != 'true') && 'true' || 'false' }}",
    );
    expect(checkShardRun).toContain("lint_args=(--only=extensions --only=scripts --threads=1)");
    expect(checkShardRun).toContain('if [ "$RELEASE_GATE" = "true" ]; then');
    expect(checkShardRun).toContain("lint_args=(--only=scripts --threads=1)");
    expect(checkShardRun).toContain('elif [ "$(nproc)" -lt 8 ]; then');
    expect(checkShardRun).toContain("lint_args=(--threads=1)");
    expect(checkShardRun).not.toContain("lint_args=(--split-core --threads=1)");
    expect(checkShardRun).toContain('pnpm lint "${lint_args[@]}"');
    expect(checkShardRun).toContain(
      'node --import tsx scripts/run-oxlint-shards.mts "${lint_args[@]}"',
    );
    for (const job of [hostedCoreLint, hostedCoreTypes]) {
      expect(job.if).toContain("needs.preflight.outputs.runner_profile == 'github'");
      expect(job.if).toContain("needs.preflight.outputs.runner_profile == 'hybrid'");
      expect(job.if).toContain("needs.preflight.outputs.hosted_runner_profile_contract == 'true'");
      expect(
        evaluateWorkflowExpression(job.if, {
          eventName: "workflow_dispatch",
          frozenTarget: true,
          hostedRunnerProfileContract: false,
          repository: "openclaw/openclaw",
          runnerProfile: "blacksmith",
          runAttempt: 1,
        }),
      ).toBe(false);
      expect(
        evaluateWorkflowExpression(job.if, {
          eventName: "workflow_dispatch",
          frozenTarget: true,
          hostedRunnerProfileContract: true,
          repository: "openclaw/openclaw",
          runnerProfile: "github",
          runAttempt: 1,
        }),
      ).toBe(true);
      for (const [runnerProfile, expected] of [
        ["blacksmith", false],
        ["github", true],
        ["hybrid", true],
      ] as const) {
        expect(
          evaluateWorkflowExpression(job.if, {
            eventName: "pull_request",
            frozenTarget: false,
            hostedRunnerProfileContract: true,
            repository: "openclaw/openclaw",
            runnerProfile,
            runAttempt: 1,
          }),
        ).toBe(expected);
      }
    }
    expect(evaluateWorkflowRunner(hostedCoreLint["runs-on"])).toBe("ubuntu-24.04");
    expect(hostedCoreLint.strategy["fail-fast"]).toBe(false);
    expect(hostedCoreLint.strategy["max-parallel"]).toBe(5);
    const coreLintStep = hostedCoreLint.steps.find(
      (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
    );
    const extensionLintStep = hostedExtensionLint.steps.find(
      (step: WorkflowStep) => step.name === "Run hosted extension lint stripe",
    );
    expect(coreLintStep.env.CORE_STRIPE).toBe("${{ matrix.stripe }}");
    type GoEnv = Partial<Pick<NodeJS.ProcessEnv, "GOMAXPROCS" | "GOGC" | "GOMEMLIMIT">>;
    const goEnvKeys = ["GOMAXPROCS", "GOGC", "GOMEMLIMIT"] as const;
    const runLintOwner = ({
      capability,
      cpuCount = 32,
      eventName = "workflow_dispatch",
      failStripe,
      frozenTarget = !capability,
      goEnv = {},
      expectedGoEnv = goEnv,
      lane,
      nodeRunnerBackend,
      profile,
      releaseGate = false,
      runAttempt = 1,
      stripe = 1,
    }: {
      capability: boolean;
      cpuCount?: number;
      eventName?: "pull_request" | "push" | "workflow_dispatch";
      failStripe?: number;
      frozenTarget?: boolean;
      goEnv?: GoEnv;
      expectedGoEnv?: GoEnv;
      lane: "check" | "core" | "extensions";
      nodeRunnerBackend?: "runson";
      profile: "blacksmith" | "github" | "hybrid";
      releaseGate?: boolean;
      runAttempt?: number;
      stripe?: number;
    }) => {
      const root = tempDirs.make("openclaw-hosted-lint-owner-");
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
                `if [[ " $* " == *" --core-stripe=${failStripe}/5 "* || " $* " == *" --extension-stripe=${failStripe}/6 "* ]]; then exit 23; fi`,
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
        matrix: { stripe },
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
          FROZEN_TARGET: frozenTarget ? "true" : "false",
          HISTORICAL_TARGET: capability ? "false" : "true",
          HOSTED_RUNNER_STRIPES: profile === "blacksmith" ? "false" : "true",
          LINT_CALLS: callsPath,
          LINT_GO_ENV: goEnvPath,
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

    const coreLintRows = (
      context: Partial<Parameters<typeof evaluateWorkflowExpression>[1]>,
    ): number[] => {
      const stripes = hostedCoreLint.strategy.matrix.stripe;
      return Array.isArray(stripes)
        ? stripes
        : evaluateWorkflowExpression(stripes, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runnerProfile: "hybrid",
            runAttempt: 1,
            ...context,
          });
    };
    for (const eventName of ["pull_request", "push"] as const) {
      const rows = coreLintRows({ eventName });
      expect(rows).toEqual([1, 2]);
      expect(
        rows.map((stripe) =>
          runLintOwner({ capability: true, eventName, lane: "core", profile: "hybrid", stripe }),
        ),
      ).toEqual(
        [
          [1, 2],
          [3, 4, 5],
        ].map((stripes) =>
          stripes.map(
            (stripe) =>
              `node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=${stripe}/5 --threads=1`,
          ),
        ),
      );
    }
    for (const context of [
      { runnerProfile: "github" as const },
      { eventName: "workflow_dispatch" as const },
      { frozenTarget: true },
      { releaseGate: true },
    ]) {
      expect(coreLintRows(context)).toEqual([1, 2, 3, 4, 5]);
    }
    for (const runAttempt of [1, 2]) {
      const rows = coreLintRows({
        eventName: "workflow_dispatch",
        releaseGate: true,
        runAttempt,
        preflightOutputs: { node_runner_backend: "runson" },
      });
      expect(rows).toEqual([1, 2]);
      expect(
        rows.flatMap((stripe) =>
          runLintOwner({
            capability: true,
            eventName: "workflow_dispatch",
            lane: "core",
            nodeRunnerBackend: "runson",
            profile: "hybrid",
            releaseGate: true,
            runAttempt,
            stripe,
          }),
        ),
      ).toEqual(
        [1, 2, 3, 4, 5].map(
          (stripe) =>
            `node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=${stripe}/5 --threads=1`,
        ),
      );
      expect(
        runLintOwner({
          capability: true,
          eventName: "workflow_dispatch",
          lane: "check",
          nodeRunnerBackend: "runson",
          profile: "hybrid",
          releaseGate: true,
          runAttempt,
        }),
      ).toEqual(["node --import tsx scripts/run-oxlint-shards.mts --only=scripts --threads=1"]);
    }
    expect(
      runLintOwner({
        capability: true,
        eventName: "pull_request",
        failStripe: 1,
        lane: "core",
        profile: "hybrid",
      }),
    ).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=1/5 --threads=1",
    ]);
    expect(
      runLintOwner({
        capability: true,
        eventName: "pull_request",
        failStripe: 4,
        lane: "core",
        profile: "hybrid",
        stripe: 2,
      }),
    ).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=3/5 --threads=1",
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=4/5 --threads=1",
    ]);

    expect(runLintOwner({ capability: true, lane: "check", profile: "github" })).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=6/6 --threads=1",
      "node --import tsx scripts/run-oxlint-shards.mts --only=scripts --threads=1",
    ]);
    expect(
      runLintOwner({
        capability: true,
        eventName: "pull_request",
        lane: "core",
        profile: "github",
      }),
    ).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=1/5 --threads=1",
      "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=1/6 --threads=1",
    ]);
    expect(
      runLintOwner({
        capability: false,
        lane: "check",
        profile: "github",
        expectedGoEnv: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" },
      }),
    ).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --only=scripts --threads=1",
    ]);
    expect(runLintOwner({ capability: true, lane: "check", profile: "hybrid" })).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=scripts --threads=1",
    ]);
    expect(hostedExtensionLint.strategy.matrix.stripe).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hostedExtensionLint.strategy["fail-fast"]).toBe(false);
    expect(hostedExtensionLint.strategy["max-parallel"]).toBe(6);
    for (const stripe of hostedExtensionLint.strategy.matrix.stripe) {
      expect(
        runLintOwner({ capability: true, lane: "extensions", profile: "hybrid", stripe }),
      ).toEqual([
        `node --import tsx scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=${stripe}/6 --threads=1`,
      ]);
    }
    runLintOwner({
      capability: true,
      failStripe: 2,
      lane: "extensions",
      profile: "hybrid",
      stripe: 2,
    });
    expect(runLintOwner({ capability: true, lane: "check", profile: "blacksmith" })).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --threads=8",
    ]);
    expect(
      runLintOwner({ capability: true, lane: "check", profile: "github", releaseGate: true }),
    ).toEqual(["node --import tsx scripts/run-oxlint-shards.mts --only=scripts --threads=1"]);
    for (const scenario of [
      {
        capability: false,
        lane: "core" as const,
        profile: "github" as const,
        expectedGoEnv: { GOMAXPROCS: "2" },
      },
      { capability: true, lane: "core" as const, profile: "hybrid" as const },
      {
        capability: true,
        lane: "core" as const,
        profile: "github" as const,
        releaseGate: true,
      },
    ]) {
      expect(runLintOwner(scenario)).toEqual([
        "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=1/5 --threads=1",
      ]);
    }

    for (const lane of ["check", "core"] as const) {
      runLintOwner({ capability: true, cpuCount: 4, lane, profile: "hybrid" });
      runLintOwner({
        capability: true,
        lane,
        profile: "github",
        goEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
      });
    }
    runLintOwner({ capability: true, cpuCount: 4, lane: "check", profile: "blacksmith" });
    for (const [profile, cpuCount] of [
      ["hybrid", 32],
      ["blacksmith", 4],
    ] as const) {
      runLintOwner({
        capability: true,
        cpuCount,
        frozenTarget: true,
        lane: "check",
        profile,
        expectedGoEnv: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" },
      });
    }
    runLintOwner({
      capability: true,
      frozenTarget: true,
      lane: "check",
      profile: "blacksmith",
    });
    expect(coreLintStep.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
  });

  it.skipIf(process.platform === "win32").each(
    (["bundled-protocol", "guards", "npm-lock"] as const).flatMap((task) =>
      (["pull_request", "push", "workflow_dispatch"] as const).map((eventName) => ({
        task,
        eventName,
      })),
    ),
  )(
    "uses prefetched CI base without later network access ($task, $eventName)",
    async ({ task, eventName }) => {
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
        runAttempt: 1,
        matrix: { task },
        preflightOutputs: { diff_base_revision: base },
      });
      const report = await runCiGitStep({
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
          GITHUB_EVENT_NAME: eventName,
          CHECKOUT_KIND: "linux-node",
          CHECKOUT_BASE_SHA: String(checkoutBase),
          CHECKOUT_TOKEN: "fixture-checkout-token",
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
        expect(consumers.map(({ args }) => args)).toEqual([["test:bundled"], ["protocol:check"]]);
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
    55_000,
  );

  it.each([
    {
      label: "current",
      frozenTarget: false,
      compatibilityTarget: false,
      policy: "bun-compatible",
      runtimes: ["node", "bun"],
      shards: [1, 2, 3],
    },
    {
      label: "frozen current",
      frozenTarget: true,
      compatibilityTarget: false,
      policy: "dual",
      runtimes: ["node", "bun"],
      shards: [1, 2, 3],
    },
    {
      label: "frozen legacy",
      frozenTarget: true,
      compatibilityTarget: true,
      policy: "node",
      runtimes: ["node"],
      shards: [1],
    },
  ])("executes the $label standalone UI envelope", async (scenario) => {
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
    const diagnostics = expectDefined(
      ui.steps.find((step: WorkflowStep) => step.name === "Upload Control UI timeout diagnostics"),
      "Control UI timeout diagnostic upload",
    );
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
        ui_test_groups_gzip_base64: encodeNodeTestGroups(uiGroups),
      },
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerBackend: "hybrid",
    } as const;
    // A workflow job without a matrix executes once.
    const shards = ui.strategy
      ? evaluateWorkflowExpression(ui.strategy.matrix.shard, context)
      : [1];
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
        scenario.compatibilityTarget ? "checks-ui" : `checks-ui (${shard}/3)`,
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
        ...(scenario.compatibilityTarget ? [] : [`--shard=${shard}/3`]),
      ];
      const steps = [
        ...(!lint.if || evaluateWorkflowExpression(lint.if, rowContext) ? [lint] : []),
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
        env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON = readFileSync(argsPath, "utf8");
        expect(JSON.parse(env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON)).toEqual(flags);
        const forwarded: string[][] = [];
        const runtimes: Array<string | undefined> = [];
        expect(
          await runShardPlans(resolveShardPlans(env), {
            concurrency: Number(env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY),
            env,
            scratchDir: root,
            runChild: async (args, childEnv) => {
              forwarded.push(args);
              runtimes.push(childEnv.OPENCLAW_VITEST_RUNTIME);
              expect(childEnv.BUN_JSC_useFTLJIT).toBeUndefined();
              if (uiGroups[0]?.includePatterns) {
                expect(
                  JSON.parse(readFileSync(childEnv.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
                ).toEqual(uiGroups[0].includePatterns);
              } else {
                expect(childEnv.OPENCLAW_VITEST_INCLUDE_FILE).toBeUndefined();
              }
              const includeFile = childEnv.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE;
              if (
                childEnv.OPENCLAW_VITEST_RUNTIME === "bun" ||
                scenario.policy === "bun-compatible"
              ) {
                expect(includeFile).toBeTruthy();
                const included = JSON.parse(readFileSync(includeFile!, "utf8"));
                const nodeFiles = [
                  "ui/src/pages/chat/chat-pane-retained-presentation.test.ts",
                  "ui/src/pages/usage/usage-page-details.test.ts",
                ];
                if (childEnv.OPENCLAW_VITEST_RUNTIME === "node") {
                  expect(included.toSorted()).toEqual(nodeFiles);
                } else {
                  expect(included.length).toBeGreaterThan(1000);
                  expect(included.filter((file: string) => nodeFiles.includes(file))).toEqual([]);
                  if (uiGroups[0]?.includePatterns) {
                    expect(included.toSorted()).toEqual(
                      uiGroups[0].includePatterns
                        .filter((file) => !nodeFiles.includes(file))
                        .toSorted(),
                    );
                  }
                }
              } else {
                expect(includeFile).toBeUndefined();
              }
              expect(childEnv.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("1");
              expect(childEnv.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR).toBe(
                resolveValue(test.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR),
              );
              return 0;
            },
          }),
        ).toBe(0);
        expect(runtimes).toEqual(scenario.runtimes);
        expect(forwarded).toEqual(
          scenario.runtimes.map(() => ["ui/vitest.config.ts", "--", ...flags]),
        );
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

  it("retains shared worker limits and local throttling in the bundled UI project", () => {
    const original = sharedVitestConfig.test;
    try {
      for (const [maxWorkers, fileParallelism, expectedWorkers] of [
        [1, false, 1],
        [8, true, 2],
      ] as const) {
        sharedVitestConfig.test = { ...original, maxWorkers, fileParallelism };
        const config = createUiE2eVitestConfig({}, []);
        const projects = config.test?.projects as Array<{
          test: { maxWorkers?: number; fileParallelism: boolean };
        }>;
        expect(config.test?.maxWorkers).toBe(expectedWorkers);
        expect(projects.map((project) => project.test.maxWorkers)).toEqual([
          undefined,
          undefined,
          1,
          1,
        ]);
        expect(projects.map((project) => project.test.fileParallelism)).toEqual([
          fileParallelism,
          fileParallelism,
          false,
          false,
        ]);
      }
    } finally {
      sharedVitestConfig.test = original;
    }
  });

  it.each([
    { failed: false, captured: false },
    { failed: false, captured: true },
    { failed: true, captured: false },
    { failed: true, captured: true },
  ])("uploads only captured synthetic widget failures: %j", ({ failed, captured }) => {
    const artifactRoot = ".artifacts/control-ui-e2e/control-ui-authenticated-widget-sandbox-*";
    const timeline = `${artifactRoot}/widget-prompt-failure.json`;
    for (const job of [
      readCiWorkflow().jobs["checks-ui-e2e"],
      readWorkflow(".github/workflows/openclaw-repo-e2e-reusable.yml").jobs.test,
    ]) {
      const upload = expectDefined(
        job.steps.find(
          (step: WorkflowStep) => step.name === "Upload synthetic widget prompt failure evidence",
        ),
        "synthetic widget upload",
      );
      expect(
        evaluateWorkflowExpression(`\${{ ${upload.if} }}`, {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          failed,
          fileHashes: captured ? { [timeline]: "present" } : {},
        }),
      ).toBe(failed && captured);
      expect(upload.uses).toBe(UPLOAD_ARTIFACT_V7);
      expect(upload.with.path.trim().split("\n")).toEqual([
        timeline,
        `${artifactRoot}/*.png`,
        `${artifactRoot}/*.webm`,
      ]);
      expect(upload.with["retention-days"]).toBe(7);
      expect(upload.with["if-no-files-found"]).toBe("error");
    }
  });

  it.each([
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: false },
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: true },
    { frozen: false, prebuilt: true, childExit: 42, releaseTier: false },
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: false, sharded: false },
    { frozen: true, prebuilt: true, childExit: 0 },
    { frozen: true, prebuilt: false, childExit: 0 },
    { frozen: false, prebuilt: false, childExit: 0 },
    { frozen: true, prebuilt: true, childExit: 42 },
  ])(
    "selects the real-Gateway tier without retrying failures: %j",
    ({ frozen, prebuilt, childExit, releaseTier, sharded }) => {
      const step = expectDefined(
        readCiWorkflow().jobs["checks-ui-e2e-real-gateway"].steps.find(
          (candidate: WorkflowStep) =>
            candidate.name === "Test Control UI suites with a real Gateway",
        ),
        "real-Gateway command",
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
          prebuilt
            ? ["--exclude", desktop]
            : uiE2eRealGatewayTestFiles.filter((file) => file !== desktop).toSorted(),
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
        uiE2eRealGatewayTestFiles
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
        expect(selectedFiles).toHaveLength(uiE2eRealGatewayTestFiles.length - 11);
        expect(selectedFiles).not.toContain(
          "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
        );
        expect(selectedFiles).not.toContain(
          "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
        );
        expect(selectedFiles).not.toContain(
          "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
        );
      }
    },
  );

  it.each([
    { frozen: false, available: true, exit: 0 },
    { frozen: true, available: true, exit: 0 },
    { frozen: false, available: true, exit: 42 },
    { frozen: true, available: false, exit: 0 },
    { frozen: false, available: false, exit: 0 },
  ])(
    "runs available desktop proof and preserves frozen omissions: %j",
    ({ frozen, available, exit }) => {
      const step = expectDefined(
        readCiWorkflow().jobs["checks-ui-e2e-real-gateway"].steps.find(
          (candidate: WorkflowStep) => candidate.name === "Prove desktop resize over node and SSH",
        ),
        "desktop proof command",
      );
      const directory = tempDirs.make("desktop-proof-command-");
      const bin = path.join(directory, "bin");
      const calls = path.join(directory, "calls");
      mkdirSync(bin);
      mkdirSync(path.join(directory, "scripts"));
      if (available) {
        writeFileSync(path.join(directory, "scripts/test-desktop-resize-real.mts"), "");
      }
      writeFileSync(
        path.join(bin, "node"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$DESKTOP_CALLS"\nexit "$DESKTOP_EXIT"\n',
        { mode: 0o755 },
      );
      const result = runWorkflowShellScript(expectDefined(step.run, "desktop proof script"), {
        cwd: directory,
        env: {
          ...process.env,
          FROZEN_TARGET: String(frozen),
          DESKTOP_CALLS: calls,
          DESKTOP_EXIT: String(exit),
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(available ? exit : frozen ? 0 : 1);
      if (available) {
        expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
          "--import",
          "tsx",
          "scripts/test-desktop-resize-real.mts",
        ]);
      } else {
        expect(existsSync(calls)).toBe(false);
        expect(frozen ? result.stdout : result.stderr).toContain(
          frozen ? "no desktop resize proof produced" : "Current target is missing",
        );
      }
    },
  );

  it("builds artifacts once and smoke-tests the built CLI with Node and Bun", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const setupStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const buildDistStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Build dist",
    );
    const nodeHelpSmoke = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Smoke test CLI launcher help",
    );
    const nodeStatusSmoke = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Smoke test CLI launcher status json",
    );
    const bunSmoke = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Smoke test built CLI with Bun",
    );

    expect(
      buildArtifactSteps.some(
        (step: WorkflowStep) =>
          typeof step.uses === "string" && step.uses.endsWith("/ensure-base-commit"),
      ),
    ).toBe(false);
    expect(setupStep.with["install-bun"]).toBe("true");
    expect(buildDistStep.run).toBe("pnpm build:ci-artifacts");
    expect(buildArtifactSteps.map((step: WorkflowStep) => step.name)).not.toContain(
      "Build Control UI",
    );
    expect(buildArtifactSteps.some((step: WorkflowStep) => step.run === "pnpm ui:build")).toBe(
      false,
    );
    expect(nodeHelpSmoke.run).toBe("node openclaw.mjs --help");
    expect(nodeStatusSmoke.run).toBe("node openclaw.mjs status --json --timeout 1");
    expect(bunSmoke.run).toContain("bun openclaw.mjs --help");
    expect(bunSmoke.run).toContain("bun openclaw.mjs status --json --timeout 1");
  });

  it("splits native source verification from generated locale parity", () => {
    const workflow = readCiWorkflow();
    const manifestStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const localeJob = workflow.jobs["native-i18n"];
    const sourceStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify native app i18n source",
    );
    const parityStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Check native app generated locale parity",
    );
    const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    const fullReleaseSource = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    const fullReleaseCiCase = expectDefined(
      fullReleaseSource.match(/case "\$CHILD_WORKFLOW_KIND" in\n\s+ci\)([\s\S]*?)\n\s+;;/u)?.[1],
      "Full Release CI dispatch case",
    );

    expect(packageScripts["native:i18n:baseline"]).toContain("baseline --write");
    expect(packageScripts["native:i18n:verify"]).toContain(" verify");
    expect(workflow.jobs.preflight.outputs.strict_native_i18n).toBe(
      "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.strict_native_i18n }}",
    );
    expect(manifestStep.env.OPENCLAW_CI_RUN_NATIVE_I18N).toBe(
      "${{ github.event_name == 'workflow_dispatch' && (steps.runner_profile.outputs.node_runner_backend != 'runson' && steps.runner_profile.outputs.ci_qualification != 'true') && 'true' || steps.changed_scope.outputs.run_native_i18n || 'false' }}",
    );
    expect(sourceStep.run).toContain("pnpm native:i18n:verify");
    expect(sourceStep.run).toContain("Historical release targets");
    expect(parityStep.if).toBe("${{ needs.preflight.outputs.strict_native_i18n == 'true' }}");
    expect(parityStep.run).toContain("pnpm native:i18n:check");
    expect(parityStep.run).not.toContain("pnpm android:i18n:check");
    expect(parityStep.run).not.toContain("pnpm apple:i18n:check");
    expect(fullReleaseCiCase).toContain(
      'args=(-f target_ref="$TARGET_SHA" -f release_scope="$ci_release_scope" -f include_android="$include_android" -f dispatch_id="$dispatch_id")',
    );
    expect(fullReleaseCiCase).toContain('dispatch_child ci.yml "$dispatch_run_name"');
    expect(fullReleaseCiCase).not.toContain("release_gate");
  });

  it("measures startup memory before the built artifact-check wave", () => {
    const workflow = readCiWorkflow();
    const steps = workflow.jobs["build-artifacts"].steps;
    const verifierStep = steps.find(
      (step: WorkflowStep) => step.name === "Run built artifact checks",
    );

    // The verifiers always run, so the shared step cannot be gated on the
    // selected checks; each check keeps its own RUN_* gate inside the body.
    expect(verifierStep.if).toBeUndefined();
    expect(steps.some((step: WorkflowStep) => step.name === "Verify built runtime artifacts")).toBe(
      false,
    );
    // RSS measures an unloaded command on every runner, including Blacksmith.
    const startupMemory = verifierStep.run.indexOf('run_verifier "startup-memory"');
    const memoryBarrier = verifierStep.run.indexOf("\nwait_checks\n", startupMemory);
    expect(memoryBarrier).toBeGreaterThan(startupMemory);
    expect(memoryBarrier).toBeLessThan(
      verifierStep.run.indexOf('run_verifier "doctor-plugin-index"'),
    );
    expect(verifierStep.env.OPENCLAW_STARTUP_MEMORY_PLUGINS_LIST_MB).toBe(
      "${{ runner.environment == 'github-hosted' && '425' || '400' }}",
    );
    expect(verifierStep.env.PARALLEL_BUILT_VERIFIERS).toBe(
      "${{ runner.environment != 'github-hosted' && 'true' || 'false' }}",
    );
    expect(verifierStep.run).toContain(
      'OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="${RUNNER_TEMP}/vitest-module-cache/${name}"',
    );
    expect(verifierStep.run).toContain(
      "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts",
    );
    expect(verifierStep.run).toContain(
      "env OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=660000 node scripts/run-vitest.mjs run",
    );
    expect(verifierStep.run).toContain("--config test/vitest/vitest.e2e.config.ts");
    expect(verifierStep.run).toContain("Selected target predates");
    expect(verifierStep.run).toContain("pnpm test:build:singleton");
    // The startup asset rebuild must complete before any verifier forks so
    // concurrent readers never observe dist mid-write.
    expect(verifierStep.run).toContain("scripts/ensure-cli-startup-build.mts");
    expect(verifierStep.run).toContain("scripts/check-cli-startup-memory.mjs");
    expect(verifierStep.run).toContain(".artifacts/startup-memory/summary.md");
    expect(verifierStep.env.RUN_CHANNELS).toBe("${{ needs.preflight.outputs.run_checks }}");
    expect(verifierStep.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    const pluginSingleton = verifierStep.run.indexOf(
      'run_verifier "plugin-singleton" pnpm test:build:singleton',
    );
    const pluginWriterBarrier = verifierStep.run.indexOf("\nwait_checks\n", pluginSingleton);
    const parallelGatewayWatch = verifierStep.run.indexOf(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" = "true" ]; then',
    );
    const gatewayWriterBarrier = verifierStep.run.indexOf(
      "\n  wait_checks\n",
      parallelGatewayWatch,
    );
    const firstReader = verifierStep.run.indexOf(
      'run_verifier "doctor-plugin-index" run_doctor_plugin_index',
    );
    const parallelDiscord = verifierStep.run.indexOf(
      'if [ "$RUN_PROCESS_PROOFS" = "true" ] && [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" = "true" ]; then',
    );
    const readerWaveBarrier = verifierStep.run.indexOf("\nwait_checks\n", parallelDiscord);
    const hostedDiscord = verifierStep.run.indexOf(
      'if [ "$RUN_PROCESS_PROOFS" = "true" ] && [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" != "true" ]; then',
    );
    expect(pluginWriterBarrier).toBeGreaterThan(pluginSingleton);
    expect(parallelGatewayWatch).toBeGreaterThan(pluginWriterBarrier);
    expect(gatewayWriterBarrier).toBeGreaterThan(parallelGatewayWatch);
    expect(firstReader).toBeGreaterThan(gatewayWriterBarrier);
    expect(parallelDiscord).toBeGreaterThan(firstReader);
    expect(readerWaveBarrier).toBeGreaterThan(parallelDiscord);
    expect(hostedDiscord).toBeGreaterThan(readerWaveBarrier);
    expect(verifierStep.run.slice(parallelDiscord, readerWaveBarrier)).toContain(
      'start_check "discord-component-attachments" run_discord_component_attachments',
    );
    expect(verifierStep.run.slice(hostedDiscord)).toContain(
      'start_check "discord-component-attachments" run_discord_component_attachments',
    );
    expect(verifierStep.run).toContain('["discord-component-attachments"]="skipped"');
    expect(verifierStep.run).toContain("OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_E2E_WORKERS=1");
    expect(verifierStep.run).toContain("OPENCLAW_E2E_VERBOSE=1 OPENCLAW_VITEST_MAX_WORKERS=1");
    const upload = steps.find(
      (entry: WorkflowStep) => entry.name === "Upload Discord component attachment proof",
    );
    expect(upload.if).toBe(
      "always() && needs.preflight.outputs.run_proof_tier == 'true' && needs.preflight.outputs.run_checks == 'true'",
    );
    expect(upload.with.path).toContain("${{ runner.temp }}/discord-component-attachments.json");
    expect(upload.with.path).toContain("${{ runner.temp }}/discord-component-attachments.log");
    // Every verifier reports through the shared results map so a failure can
    // never be swallowed by the wave.
    for (const name of [
      "doctor-plugin-index",
      "plugin-singleton",
      "sqlite-session-lifecycle",
      "startup-memory",
    ]) {
      expect(verifierStep.run).toContain(`run_verifier "${name}"`);
      expect(verifierStep.run).toContain(`["${name}"]="skipped"`);
    }
    expect(verifierStep.run).toContain(
      "for name in channels core-support-boundary discord-component-attachments doctor-plugin-index gateway-watch plugin-singleton sqlite-session-lifecycle startup-memory tui-pty; do",
    );
  });

  it.each([
    { label: "one passing named case", state: "passed", frozen: false, expected: 0 },
    { label: "a passing frozen case", state: "passed", frozen: true, expected: 0 },
    { label: "a failed named case", state: "failed", frozen: false, expected: 1 },
    { label: "a skipped current case", state: "skipped", frozen: false, expected: 1 },
    { label: "a skipped frozen case", state: "skipped", frozen: true, expected: 1 },
    { label: "a missing current case", state: "absent", frozen: false, expected: 1 },
    { label: "an unavailable historical case", state: "absent", frozen: true, expected: 0 },
    { label: "a failed suite", state: "suite-failed", frozen: false, expected: 1 },
    { label: "malformed JSON", state: "malformed", frozen: true, expected: 1 },
  ])("validates Discord built proof with $label", ({ state, frozen, expected }) => {
    const steps = readCiWorkflow().jobs["build-artifacts"].steps;
    const step = steps.find((entry: WorkflowStep) => entry.name === "Run built artifact checks");
    const validator = expectDefined(
      step.run.match(
        /node --input-type=module <<'DISCORD_PROOF_REPORT'\n([\s\S]*?)\nDISCORD_PROOF_REPORT/u,
      )?.[1],
      "Discord proof report validator",
    );
    const scratch = tempDirs.make("openclaw-discord-proof-report-");
    const fullName =
      "Discord show_widget contextual presenter process proof preserves component attachment filenames through the public Gateway message action";
    const report = {
      success: true,
      numFailedTestSuites: state === "suite-failed" ? 1 : 0,
      numFailedTests: state === "failed" ? 1 : 0,
      numPassedTests: state === "passed" ? 1 : 0,
      testResults: [
        {
          name: path.resolve(
            "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts",
          ),
          status: "passed",
          assertionResults: state === "absent" ? [] : [{ fullName, status: state }],
        },
      ],
    };
    writeFileSync(
      path.join(scratch, "discord-component-attachments.json"),
      state === "malformed" ? "{" : JSON.stringify(report),
    );
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", validator], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: scratch, FROZEN_TARGET: String(frozen) },
    });
    expect(result.status, result.stderr).toBe(expected);
    if (state === "absent" && frozen) {
      expect(result.stdout).toContain("[skip] Frozen target predates the named Discord");
    }
  });

  it.each([
    { frozen: false, present: true, expected: true },
    { frozen: false, present: false, expected: true },
    { frozen: true, present: true, expected: true },
    { frozen: true, present: false, expected: false },
  ])(
    "gates browser native-host proof (frozen=$frozen, present=$present)",
    ({ frozen, present, expected }) => {
      const step = readCiWorkflow().jobs["build-artifacts"].steps.find(
        (entry: WorkflowStep) => entry.name === "Verify built browser native host",
      );
      const file = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
      expect(
        step.if === undefined ||
          evaluateWorkflowExpression(step.if, {
            eventName: "workflow_dispatch",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            frozenTarget: frozen,
            preflightOutputs: { run_proof_tier: "true" },
            fileHashes: present ? { [file]: "fixture-hash" } : {},
          }),
      ).toBe(expected);
    },
  );

  it.each([
    "passed",
    "skipped",
    "pending",
    "todo",
    "absent",
    "wrong-name",
    "wrong-file",
    "failed",
    "suite-failed",
    "duplicate",
    "malformed",
    "missing-report",
  ])("validates browser native-host proof report: %s", (state) => {
    const steps = readCiWorkflow().jobs["build-artifacts"].steps;
    const step = steps.find(
      (entry: WorkflowStep) => entry.name === "Verify built browser native host",
    );
    expect(steps.indexOf(step)).toBeGreaterThan(
      steps.findIndex((entry: WorkflowStep) => entry.name === "Build dist"),
    );
    expect(step["continue-on-error"]).not.toBe(true);
    const root = tempDirs.make("openclaw-browser-proof-report-");
    const file = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
    const names = [
      "does not inspect or migrate configuration before rejecting a malformed native request",
      "rejects an unauthorized bootstrap caller before config, keys or database creation",
      "rejects an unauthorized ensure_relay caller before config, keys or database creation",
      'preserves invalid-config diagnostics for ordinary extension command "status"',
      'preserves invalid-config diagnostics for ordinary extension command "setup"',
      'preserves invalid-config diagnostics for ordinary extension command "pair"',
      "launches launcher with the exact custom installation context when Chrome has no selectors",
      "launches cli with the exact custom installation context when Chrome has no selectors",
    ];
    const assertions = names.map((name, index) => ({
      fullName:
        state === "wrong-name" && index === 0 ? "another test" : `native host registration ${name}`,
      status:
        index === 0 && ["skipped", "pending", "todo", "failed"].includes(state) ? state : "passed",
    }));
    if (state === "absent") {
      assertions.pop();
    } else if (state === "duplicate") {
      assertions[1] = assertions[0]!;
    }
    const report = {
      success: state !== "failed" && state !== "suite-failed",
      numFailedTestSuites: state === "suite-failed" ? 1 : 0,
      numPendingTestSuites: 0,
      numTotalTests: assertions.length,
      numPassedTests: assertions.filter((entry) => entry.status === "passed").length,
      numFailedTests: state === "failed" ? 1 : 0,
      numPendingTests: ["skipped", "pending"].includes(state) ? 1 : 0,
      numTodoTests: state === "todo" ? 1 : 0,
      testResults: [
        {
          name: path.join(root, state === "wrong-file" ? "other.test.ts" : file),
          status: state === "suite-failed" ? "failed" : "passed",
          assertionResults: assertions,
        },
      ],
    };
    mkdirSync(path.join(root, "scripts"));
    // A previous successful report must not satisfy a run that emits no report.
    writeFileSync(path.join(root, "browser-native-host.json"), JSON.stringify(report));
    // Execute the workflow's shell and validator; replace only the expensive
    // Vitest process with a controlled reporter at its external boundary.
    writeFileSync(
      path.join(root, "scripts/run-vitest.mjs"),
      `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.writeFileSync('invocation.json', JSON.stringify({ args, prebuilt: process.env.OPENCLAW_E2E_USE_PREBUILT_DIST }));
      const outputIndex = args.indexOf('--outputFile.json');
      if (outputIndex >= 0 && ${JSON.stringify(state)} !== 'missing-report') {
        fs.writeFileSync(args[outputIndex + 1], ${JSON.stringify(state === "malformed" ? "{" : JSON.stringify(report))});
      }
    `,
    );
    const result = runWorkflowShellScript(step.run, {
      cwd: root,
      env: { ...process.env, ...step.env, RUNNER_TEMP: root },
    });
    expect(result.status, result.stderr).toBe(state === "passed" ? 0 : 1);
    if (state === "passed") {
      expect(JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"))).toEqual({
        prebuilt: "1",
        args: [
          "run",
          "--config",
          "test/vitest/vitest.e2e.config.ts",
          file,
          "--reporter=default",
          "--reporter=json",
          "--outputFile.json",
          path.join(root, "browser-native-host.json"),
        ],
      });
    }
  });

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
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const warmerSteps = warmer.jobs.warm.steps as WorkflowStep[];
    const saveStep = expectDefined(
      warmerSteps.find((step) => step.name === "Save dist build cache"),
      "trusted dist cache save",
    );

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
    const setupStep = expectDefined(
      steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "Testbox Node setup",
    );
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

  it("keeps the full built TUI PTY suite out of the artifact canary gate", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const builtArtifactChecks = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Run built artifact checks",
    );
    const run = builtArtifactChecks.run;

    expect(builtArtifactChecks.env.PARALLEL_GATEWAY_WATCH).toBe(
      "${{ runner.environment != 'github-hosted' && 'true' || 'false' }}",
    );
    expect(run).toContain('start_check "channels"');
    expect(run).toContain('start_check "core-support-boundary"');
    expect(run).toContain('start_check "gateway-watch"');
    expect(run).toContain(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" = "true" ]; then',
    );
    expect(run).toContain(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" != "true" ]; then',
    );
    const firstWait = run.indexOf(
      "\nwait_checks\n",
      run.indexOf('start_check "core-support-boundary"'),
    );
    const hostedGatewayWatch = run.indexOf(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" != "true" ]; then',
    );
    const tuiPty = run.indexOf('if [ "$RUN_TUI_PTY" = "true" ]; then');
    const hostedGatewayWait = run.indexOf("\n  wait_checks\n", hostedGatewayWatch);
    const parallelDiscord = run.indexOf(
      'if [ "$RUN_PROCESS_PROOFS" = "true" ] && [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" = "true" ]; then',
    );
    const hostedDiscord = run.indexOf(
      'if [ "$RUN_PROCESS_PROOFS" = "true" ] && [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" != "true" ]; then',
    );
    const hostedDiscordWait = run.indexOf("\n  wait_checks\n", hostedDiscord);
    const tuiPtyWait = run.indexOf("\n  wait_checks\n", tuiPty);
    expect(firstWait).toBeGreaterThan(run.indexOf('start_check "core-support-boundary"'));
    expect(hostedGatewayWatch).toBeGreaterThan(firstWait);
    expect(hostedGatewayWait).toBeGreaterThan(hostedGatewayWatch);
    expect(parallelDiscord).toBeLessThan(firstWait);
    expect(hostedDiscord).toBeGreaterThan(hostedGatewayWait);
    expect(hostedDiscordWait).toBeGreaterThan(hostedDiscord);
    expect(tuiPty).toBeGreaterThan(hostedDiscordWait);
    expect(tuiPtyWait).toBeGreaterThan(tuiPty);
    expect(run.slice(tuiPty, tuiPtyWait)).toContain("src/tui/tui-pty-local.e2e.test.ts");
    expect(run.slice(tuiPty, tuiPtyWait)).toContain("--testNamePattern");
    expect(run.slice(tuiPty, tuiPtyWait)).toContain(
      "launches openclaw (chat as local mode|tui against a real Gateway) through a real PTY",
    );
    expect(run).toContain("wait_checks()");
    // Startup memory, artifact writers, and TUI retain explicit barriers;
    // hosted runners also serialize the remaining verifiers inside run_verifier.
    expect(run.match(/wait_checks$/gmu)).toHaveLength(8);
  });

  it("fails and retries quiet Node test shard stalls quickly", () => {
    const workflow = readCiWorkflow();
    const preflightJob = workflow.jobs.preflight;
    const manifestStep = preflightJob.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
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

    expect(JSON.stringify(preflightJob.steps)).toContain("timeout_minutes: shard.timeoutMinutes");
    expect(manifestStep.run).toContain("pretest_build_mode: shard.pretestBuildMode");
    expect(manifestStep.run).toContain("requires_ripgrep:");
    expect(manifestStep.run).toContain("src/agents/sessions/tools/index.test.ts");
    expect(nodeTestJob["timeout-minutes"]).toBe("${{ matrix.timeout_minutes || 60 }}");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '660000' || '300000' }}",
    );
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBeUndefined();
    expect(runStep.env.OPENCLAW_NODE_TEST_ENV_JSON).toBe("${{ toJson(matrix.env) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_TARGETS_JSON).toBe("${{ toJson(matrix.targets) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64).toBe(
      "${{ matrix.groups_gzip_base64 || '' }}",
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
      run: expect.stringContaining("apt-get install -y --no-install-recommends ripgrep"),
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
  });

  it("routes admitted RunsOn rows with unique Spot labels and portable cache readers", () => {
    const job = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"];
    const context = {
      eventName: "pull_request",
      repository: "openclaw/openclaw",
      headRepository: "openclaw/openclaw",
      authorAssociation: "CONTRIBUTOR",
      runAttempt: 1,
      runId: 123,
      runnerBackend: "runson",
      runnerProfile: "hybrid",
      runnerEnvironment: "self-hosted",
      preflightOutputs: { node_runner_backend: "runson" },
      matrix: { runner: "runson-c8i-8xlarge", check_name: "cron-1" },
    } as const;
    const label = evaluateWorkflowExpression(job["runs-on"], context);
    expect(label).toBe(
      "runs-on=123-cron-1/family=c8i.8xlarge/cpu=32/ram=64/spot=true/retry=false/image=ubuntu24-full-x64/volume=80gb",
    );
    expect(
      evaluateWorkflowExpression(job["runs-on"], {
        ...context,
        matrix: { ...context.matrix, check_name: "cron-2" },
      }),
    ).not.toBe(label);
    for (const overrides of [
      { runAttempt: 2 },
      { preflightOutputs: { node_runner_backend: "hybrid" } },
      {
        headRepository: "fork/openclaw",
        preflightOutputs: { node_runner_backend: "github" },
      },
    ]) {
      expect(evaluateWorkflowExpression(job["runs-on"], { ...context, ...overrides })).toBe(
        "ubuntu-24.04",
      );
    }
    const dispatch = { ...context, eventName: "workflow_dispatch" as const, releaseGate: true };
    expect(evaluateWorkflowExpression(job["runs-on"], dispatch)).toBe(label);
    expect(
      evaluateWorkflowExpression(job["runs-on"], {
        ...dispatch,
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", check_name: "ordinary-node" },
      }),
    ).toBe("blacksmith-32vcpu-ubuntu-2404");
    for (const [name, matrix, expected, hosted] of [
      ["build-artifacts", {}, "blacksmith-16vcpu-ubuntu-2404", "ubuntu-24.04"],
      ["checks-ui", {}, "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
      ["checks-ui-e2e", { task: "control-ui" }, "blacksmith-16vcpu-ubuntu-2404", "ubuntu-24.04"],
      ["checks-windows", {}, "blacksmith-16vcpu-windows-2025", "windows-2025"],
      [
        "check-shard",
        { task: "test-types", runner: "blacksmith-16vcpu-ubuntu-2404" },
        "blacksmith-16vcpu-ubuntu-2404",
        "ubuntu-24.04",
      ],
      ["check-test-types-hosted-core-shard", {}, "blacksmith-16vcpu-ubuntu-2404", "ubuntu-24.04"],
      [
        "check-additional-shard",
        { group: "extension-package-boundary", runner: "blacksmith-16vcpu-ubuntu-2404" },
        "blacksmith-16vcpu-ubuntu-2404",
        "ubuntu-24.04",
      ],
    ] as const) {
      const expression = readCiWorkflow().jobs[name]["runs-on"];
      expect(evaluateWorkflowExpression(expression, { ...context, matrix }), `${name} PR`).toBe(
        expected,
      );
      expect(evaluateWorkflowExpression(expression, { ...dispatch, matrix }), `${name} proof`).toBe(
        expected,
      );
      for (const overrides of [
        { runAttempt: 2 },
        { preflightOutputs: { node_runner_backend: "hybrid" } },
      ]) {
        expect(
          evaluateWorkflowExpression(expression, { ...dispatch, matrix, ...overrides }),
          `${name} manual/retry fallback`,
        ).toBe(hosted);
      }
    }
    const setup = expectDefined(
      job.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "Node setup",
    );
    expect(evaluateWorkflowExpression(setup.with["dependency-cache"], context)).toBe("false");
    expect(
      evaluateWorkflowExpression(setup.with["dependency-cache"], {
        ...context,
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404" },
      }),
    ).toBe("true");
    for (const [overrides, expected] of [
      [{}, "true"],
      [{ runAttempt: 2 }, "false"],
      [{ preflightOutputs: { node_runner_backend: "hybrid" } }, "false"],
    ] as const) {
      expect(
        evaluateWorkflowExpression(setup.with["dependency-cache"], {
          ...dispatch,
          matrix: { runner: "blacksmith-32vcpu-ubuntu-2404" },
          ...overrides,
        }),
      ).toBe(expected);
    }
    expect(setup.with).toMatchObject({ "vitest-fs-cache": "true", "node-compile-cache": "true" });
    const resources = expectDefined(
      job.steps.find((step: WorkflowStep) => step.name === "Configure Node test resources"),
      "Node resources",
    );
    for (const matrix of [
      context.matrix,
      {
        runner: "blacksmith-32vcpu-ubuntu-2404",
        check_name: "checks-node-runson-cron-blacksmith-control",
      },
      {
        runner: "ubuntu-24.04",
        check_name: "checks-node-runson-cron-github-control",
      },
    ]) {
      const comparison = { ...context, matrix, env: { NODE_VERSION: "24.19.0" } };
      expect(evaluateWorkflowExpression(setup.with["node-version"], comparison)).toBe("24.19.0");
      expect(evaluateWorkflowExpression(resources.env.RUNSON_JOB, comparison)).toBe("true");
    }
    const initialize = expectDefined(
      job.steps.find((step: WorkflowStep) => step.name === "Initialize RunsOn"),
      "RunsOn initialization",
    );
    expect(evaluateWorkflowExpression(`\${{ ${initialize.if} }}`, context)).toBe(true);
    expect(
      evaluateWorkflowExpression(`\${{ ${initialize.if} }}`, {
        ...context,
        runnerEnvironment: "github-hosted",
      }),
    ).toBe(false);
  });

  it("keeps RunsOn Node workers bounded without invoking the Blacksmith scheduler", () => {
    const step = expectDefined(
      readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps.find(
        (candidate: WorkflowStep) => candidate.name === "Configure Node test resources",
      ),
      "Node resources",
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

  it("clamps Node test workers to the detected core count", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const resourceStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Configure Node test resources",
    );

    expect(resourceStep.run).toContain('if [ "$workers" -gt "$cores" ]; then');
    expect(resourceStep.run).toContain('workers="$cores"');
    expect(resourceStep.run.indexOf('workers="$cores"')).toBeLessThan(
      resourceStep.run.indexOf("OPENCLAW_VITEST_MAX_WORKERS"),
    );
    expect(resourceStep.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    expect(resourceStep.env.RUNNER_ENVIRONMENT).toBe("${{ runner.environment }}");
    expect(resourceStep.run).toContain(
      '[[ "$RUNSON_JOB" != "true" && "$RUNNER_ENVIRONMENT" == "self-hosted" && "$FROZEN_TARGET" != "true" && "$SHARD_PLAN_CONCURRENCY" == "1" ]]',
    );
    expect(resourceStep.run).toContain("isConstrainedCiCheckHost({");
    expect(resourceStep.run).toContain(
      "resolveLocalVitestScheduling(process.env, host).maxWorkers",
    );
    expect(nodeTestJob.steps.indexOf(resourceStep)).toBeGreaterThan(
      nodeTestJob.steps.findIndex((step: WorkflowStep) => step.name === "Build Node test runtime"),
    );
    const runStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Run Node test shard",
    );
    expect(runStep.env.FROZEN_TARGET).toBe(resourceStep.env.FROZEN_TARGET);
    expect(runStep.env.RUNNER_ENVIRONMENT).toBe(resourceStep.env.RUNNER_ENVIRONMENT);
  });

  it("uses candidate-owned script interfaces for frozen target CI", () => {
    const workflow = readCiWorkflow();
    const buildChecks = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Run built artifact checks",
    );
    const qaBuild = workflow.jobs["qa-smoke-ci-profile"].steps.find(
      (step: WorkflowStep) => step.name === "Build QA smoke runtime",
    );
    const additionalChecks = workflow.jobs["check-additional-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
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
    expect(additionalChecks.run).toContain(
      "boundary_runner=(node --import tsx scripts/run-additional-boundary-checks.mts)",
    );
    expect(additionalChecks.run).toContain(
      "boundary_runner=(node scripts/run-additional-boundary-checks.mjs)",
    );
    expect(additionalChecks.run).not.toContain(
      "if [ ! -f scripts/check-session-accessor-boundary.mts ]",
    );
    expect(additionalChecks.run).not.toContain(
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

  it.skipIf(process.platform === "win32")(
    "keeps missing performance coverage fatal outside historical targets",
    () => {
      const job = readCiWorkflow().jobs["control-ui-performance"];
      expect(job.needs).toEqual(["preflight"]);
      expect(job.env.CHECKOUT_BASE_SHA).toBe("${{ needs.preflight.outputs.diff_base_revision }}");
      const step = job.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Check Control UI performance against base",
      );
      const root = tempDirs.make("openclaw-performance-workflow-");
      const summary = path.join(root, "summary.md");
      writeFileSync(path.join(root, "package.json"), "{}");
      for (const compatibility of ["true", "false"]) {
        const result = runWorkflowShellScript(step.run, {
          cwd: root,
          env: {
            ...process.env,
            COMPATIBILITY_TARGET: compatibility,
            GITHUB_STEP_SUMMARY: summary,
          },
        });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(
          compatibility === "true" ? 0 : 1,
        );
      }
      expect(readFileSync(summary, "utf8")).toContain(
        "unavailable on the selected compatibility target",
      );
    },
  );

  it("keeps push docs validation ClawHub-backed", () => {
    const workflow = readFileSync(".github/workflows/docs.yml", "utf8");

    expect(workflow).toContain("repository: openclaw/clawhub");
    expect(workflow).toContain("path: clawhub-source");
    expect(workflow).toContain(
      "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: ${{ github.workspace }}/clawhub-source",
    );
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
    const workflow = readCriticalQualityWorkflow();
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
    expect(workflow).toContain("Fast PR network boundary diff scan");
    expect(workflow).toContain(
      '| select(.filename | test("(^|/)[^/]+\\\\.(?:e2e\\\\.)?test\\\\.tsx?$") | not)',
    );
    expect(workflow).toContain("Network runtime boundary-sensitive added lines");
    expect(workflow).toContain(
      'codex_transport="extensions/codex/src/app-server/transport-websocket.ts"',
    );
    expect(workflow).toContain(
      "network_codeql_contract_pattern='^\\.github/codeql/(codeql-network-runtime-boundary-critical-quality\\.yml|openclaw-boundary/queries/(raw-socket-callsite-classification|managed-proxy-runtime-mutation)\\.ql)$'",
    );
    expect(workflow).toContain(
      'if grep -Eq "$network_codeql_contract_pattern" "$changed_files" ||',
    );
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
    const workflow = parse(readFileSync(".github/workflows/pr-crabbox-gate-publisher.yml", "utf8"));
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
          "${{ steps.app-token.outputs.token || steps.app-token-fallback.outputs.token }}",
        GH_TOKEN: "${{ github.token }}",
      },
      run: "node scripts/pr-crabbox-gate-publisher.mjs",
    });
    expect(job.steps[2].run).toContain("crabbox_0.46.0_linux_amd64.tar.gz");
    expect(job.steps[2].run).toContain(
      "6a9341e810307356361dbed4c4b84be28a036b5cc291af1566d2ccd376570d90",
    );
    expect(job.steps.slice(3, 5)).toMatchObject([
      {
        id: "app-token",
        uses: CREATE_GITHUB_APP_TOKEN_V3,
        with: { "app-id": "2729701", "permission-members": "read" },
      },
      {
        id: "app-token-fallback",
        uses: CREATE_GITHUB_APP_TOKEN_V3,
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

it("pins generated publisher and maturity owners before credentials and selected checkout", () => {
  const pinned = {
    name: "Prepare Git owner",
    uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
  };
  const action = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
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
    const workflow = parse(readFileSync(file, "utf8"));
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

describe("Linux App validation routing", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const linuxSteps: WorkflowStep[] = workflow.jobs.build.steps;
  const macosSteps: WorkflowStep[] = workflow.jobs["test-macos"].steps;
  const packagingSteps = [
    "Stage AppImage GStreamer plugins",
    "Prepare pinned AppImage tools",
    "Build Linux companion bundles",
    "Finalize AppImage",
    "Test native first-run setup and failed Gateway startup",
    "Test packaged AppImage runtime",
    "Upload bundles",
  ];

  it.each(["pull_request", "workflow_dispatch"] as const)(
    "keeps native tests required and selects packaging only for manual validation: %s",
    (eventName) => {
      const selected = (steps: WorkflowStep[]) =>
        steps.filter(
          (step) =>
            !step.if ||
            evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
              eventName,
              repository: "openclaw/openclaw",
              runAttempt: 1,
              steps: {
                "inline-browser": { outputs: {}, outcome: "success" },
                "gateway-switch": { outputs: {}, outcome: "success" },
                "desktop-sharing": { outputs: {}, outcome: "success" },
              },
            }),
        );
      const linux = selected(linuxSteps);
      const macos = selected(macosSteps);
      expect(workflow.jobs.build.if).toBeUndefined();
      expect(workflow.jobs["test-macos"].if).toBeUndefined();
      expect(workflow.jobs.build["continue-on-error"]).toBeUndefined();
      expect(workflow.jobs["test-macos"]["continue-on-error"]).toBeUndefined();
      for (const step of [...linuxSteps, ...macosSteps]) {
        expect(step["continue-on-error"], step.name).toBeUndefined();
      }
      expect(linux.map((step) => step.run)).toContain("cargo +stable fmt --check");
      for (const steps of [linux, macos]) {
        expect(steps.map((step) => step.run)).toContain(
          "cargo +stable test --locked --all-targets",
        );
      }
      expect(
        linux.find((step) => step.name === "Test packaged runtime ABI scanner")?.run,
      ).toContain("-s apps/linux/tests -p 'test_packaged_runtime_smoke.py'");
      expect(
        linux.find((step) => step.name === "Test desktop sharing proof report ordering")?.run,
      ).toContain("-s apps/linux/tests -p 'test_desktop_sharing_reports.py'");
      expect(linux.map((step) => step.run)).toContain("cargo +stable build --locked");
      expect(linux.find((step) => step.id === "inline-browser")?.run).toContain("--inline-browser");
      expect(linux.find((step) => step.id === "gateway-switch")?.run).toContain("--gateway-switch");
      expect(linux.find((step) => step.id === "desktop-sharing")?.run).toContain(
        "--desktop-sharing",
      );
      for (const name of packagingSteps) {
        expect(
          linuxSteps.some((step) => step.name === name),
          name,
        ).toBe(true);
        expect(
          linux.some((step) => step.name === name),
          name,
        ).toBe(eventName === "workflow_dispatch");
      }
      if (eventName === "pull_request") {
        expect(
          linux
            .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
            .map((step) => step.with?.name),
        ).toEqual(["linux-inline-browser", "linux-gateway-switch", "linux-desktop-sharing"]);
      }
    },
  );

  it.each(["success", "failure", "cancelled", "skipped"] as const)(
    "uploads native proof after an attempted run: %s",
    (outcome) => {
      for (const [name, id] of [
        ["Upload native inline browser proof", "inline-browser"],
        ["Upload native Gateway switching proof", "gateway-switch"],
        ["Upload native desktop sharing proof", "desktop-sharing"],
      ] as const) {
        const upload = expectDefined(
          linuxSteps.find((step) => step.name === name),
          `${id} proof upload`,
        );
        expect(
          evaluateWorkflowExpression(`\${{ ${upload.if} }}`, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            failed: outcome === "failure",
            cancelled: outcome === "cancelled",
            steps: { [id]: { outputs: {}, outcome } },
          }),
          name,
        ).toBe(outcome !== "skipped");
      }
    },
  );

  it("retains both first-run cases and failure evidence for manual validation", () => {
    const firstRun = linuxSteps.find(
      (step) => step.name === "Test native first-run setup and failed Gateway startup",
    );
    expect(firstRun?.run?.match(/python3 apps\/linux\/tests\/first_run\.py/gu)).toHaveLength(2);
    expect(firstRun?.run).toContain("--local-start-failure");
    for (const [name, id] of [
      ["Upload first-run failure log", "first-run"],
      ["Upload packaged runtime failure evidence", "packaged-runtime"],
    ]) {
      expect(linuxSteps.find((step) => step.name === name)?.if).toBe(
        `github.event_name == 'workflow_dispatch' && failure() && steps.${id}.outcome == 'failure'`,
      );
    }
  });
});

it.each(["publish", "promote"])(
  "requests independent Linux publication after stable %s activation",
  (owner) => {
    const workflow = parse(readFileSync(`.github/workflows/openclaw-release-${owner}.yml`, "utf8"));
    const job = workflow.jobs.publish_linux;
    expect(job, "stable publication must request the Linux release owner").toBeDefined();
    expect(job["continue-on-error"]).toBe(true);
    for (const [tag, channel, activation, expected] of [
      ["v2026.9.4", "latest", "success", true],
      ["v2026.9.4", "beta", "success", true],
      ["v2026.9.4-beta.1", "beta", "success", false],
      ["v2026.9.4-alpha.1", "alpha", "success", false],
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
  const linux = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
  const finalizers = (
    [
      ["openclaw-release-publish.yml", "finalize_github_release"],
      ["openclaw-release-promote.yml", "finalize"],
    ] as const
  ).map(([file, job]) => parse(readFileSync(`.github/workflows/${file}`, "utf8")).jobs[job]);
  for (const job of [...finalizers, linux.jobs.publish, linux.jobs.mirror_legacy]) {
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
  for (const [alreadyPublished, build, signing, expected] of [
    ["true", "skipped", "skipped", true],
    ["false", "success", "success", true],
    ["false", "success", "failure", false],
    ["false", "skipped", "skipped", false],
  ]) {
    expect(
      runInNewContext(linux.jobs.publish.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        always: () => true,
        needs: {
          validate_release: {
            outputs: { already_published: alreadyPublished, desktop_test_bundles: "false" },
          },
          build_linux: { result: build },
          sign_linux: { result: signing },
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
    const condition = expectDefined(steps.find((step) => step.name === name)?.if, name);
    expect(
      runInNewContext(condition.replace(/^\$\{\{|\}\}$/gu, ""), {
        needs: { validate_release: { outputs: { already_published: "true" } } },
      }),
    ).toBe(false);
  }
  const publisher = expectDefined(
    steps.find(
      ({ name }) =>
        name === "Publish immutable bundles, canonical Linux channel, and legacy mirror",
    ),
    "one publisher",
  );
  expect(publisher.if).toBeUndefined();
  expect(publisher.run).toContain("linux-app-channel.mjs publish");
  expect(publisher.run).toContain("input_args=()");
  expect(publisher.run).toContain('"${input_args[@]}"');
  expect(publisher.run).toContain("--request-run-id");
  expect(JSON.stringify(steps)).not.toContain("linux-updater-manifest.mjs publish");
  expect(JSON.stringify(steps)).not.toContain("--clobber");
});

it("detaches Linux mirror-only writers from both completed core finalizers", () => {
  const linux = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
  for (const event_name of ["push", "pull_request", "workflow_run", "workflow_dispatch"]) {
    expect(
      runInNewContext(linux.jobs.mirror_legacy.if.slice(3, -2), {
        github: { repository: "openclaw/openclaw", event_name },
      }),
    ).toBe(event_name === "workflow_dispatch");
  }
  expect(linux.on.push).toBeUndefined();
  expect(linux.on.pull_request).toBeUndefined();
  const mirrorSteps = linux.jobs.mirror_legacy.steps as WorkflowStep[];
  expect(JSON.stringify(mirrorSteps)).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  expect(JSON.stringify(mirrorSteps)).not.toContain("linux-app-channel.mjs publish");
  expect(JSON.stringify(mirrorSteps)).not.toContain("cargo");
  const admission = expectDefined(
    mirrorSteps.find(({ name }) => name === "Verify detached mirror dispatch identity"),
    "mirror admission",
  );
  expect(admission.run).toContain("refs/tags/release-publish/*");
  expect(admission.run).toContain('"$EXPECTED_TOOLING_SHA" == "$WORKFLOW_SHA"');
  expect(admission.run).toContain("--release-publish-parent-state-policy active-or-success");
  for (const [file, finalizer] of [
    ["openclaw-release-publish.yml", "finalize_github_release"],
    ["openclaw-release-promote.yml", "finalize"],
  ] as const) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    const dispatch = workflow.jobs.dispatch_linux_mirror;
    expect(dispatch.needs).toContain(finalizer);
    expect(dispatch["continue-on-error"]).toBe(true);
    expect(dispatch["timeout-minutes"]).toBe(5);
    expect(dispatch.concurrency).toBeUndefined();
    expect(workflow.jobs[finalizer].needs).not.toContain("dispatch_linux_mirror");
    const dispatchStep = expectDefined(
      (dispatch.steps as WorkflowStep[]).find(
        ({ name }) => name === "Dispatch detached Linux mirror",
      ),
      "bounded mirror dispatch",
    );
    expect(dispatchStep.run).toContain("dispatch_linux_mirror");
    expect(dispatchStep.run).not.toMatch(/\b(?:watch|sleep|until|while)\b/u);
  }
  const prepared = parse(readFileSync(".github/workflows/openclaw-release-promote.yml", "utf8"));
  const preparedDispatch = JSON.stringify(prepared.jobs.dispatch_linux_mirror);
  expect(preparedDispatch).toContain(".releaseRunId");
  expect(preparedDispatch).toContain(".releaseRunAttempt");
  expect(preparedDispatch).toContain(".tooling.fullRef");
  expect(preparedDispatch).not.toContain("$GITHUB_RUN_ID");
});

it("reports stale Linux release requests before selected code runs", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
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
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(matching ? 0 : 1);
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

it("pins simple release admission owners before selected checkout and preserves Git contracts", () => {
  const pinned = {
    name: "Prepare Git owner",
    uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
  };
  const workflows = [
    {
      file: ".github/workflows/linux-app-release.yml",
      job: "validate_release",
      checkout: "Checkout selected tag",
      validation: "Ensure tag commit is reachable from its release branch",
    },
    {
      file: ".github/workflows/macos-release.yml",
      job: "validate_macos_release_request",
      checkout: "Checkout selected tag",
      validation: "Validate release tag and package metadata",
    },
    {
      file: ".github/workflows/npm-placeholder-bootstrap.yml",
      job: "plan",
      checkout: "Checkout selected source",
      validation: "Validate trusted workflow and target",
    },
  ] as const;
  for (const entry of workflows) {
    const workflow = parse(readFileSync(entry.file, "utf8"));
    const steps = workflow.jobs[entry.job].steps as WorkflowStep[];
    const checkout = steps.findIndex(({ name }) => name === entry.checkout);
    expect(steps[checkout - 1]).toEqual(pinned);
    const validation = steps.find(({ name }) => name === entry.validation);
    const body = expectDefined(validation?.run, `${entry.file} admission body`);
    expect(body).not.toMatch(/timeout --|(?:^|\s)git (?:fetch|rev-parse|merge-base)\b/mu);
    expect(body).not.toMatch(/backoff\(|for attempt in range/u);
  }

  const request = parse(readFileSync(".github/workflows/linux-app-release-request.yml", "utf8"));
  const linux = parse(readFileSync(workflows[0].file, "utf8"));
  expect(request["run-name"]).toBe(
    "Linux App Release Request [${{ inputs.tag }}] desktop=${{ inputs['desktop-test-bundles'] }}",
  );
  expect(request.permissions).toEqual({});
  expect(Object.keys(request.on.workflow_dispatch.inputs)).toEqual(["tag", "desktop-test-bundles"]);
  expect(request.jobs.validate_request.permissions).toBeUndefined();
  expect(JSON.stringify(request)).not.toContain("${{ secrets.");
  expect(linux.on.workflow_run).toEqual({
    workflows: ["Linux App Release Request"],
    branches: ["main"],
    types: ["completed"],
  });
  expect(Object.keys(linux.on.workflow_dispatch.inputs)).toEqual([
    "release_tag",
    "source_sha",
    "tooling_sha",
    "release_publish_run_id",
    "release_publish_run_attempt",
  ]);
  const releaseDocs = expectDefined(
    readFileSync("apps/linux/README.md", "utf8").split("## Releases\n")[1],
    "Linux release documentation",
  );
  expect(releaseDocs).toMatch(/dispatch `Linux App Release Request` from `main`/u);
  expect(releaseDocs).toContain("stable release tag in `tag`");
  expect(releaseDocs).toMatch(/optional\s+`desktop-test-bundles` input/u);
  expect(releaseDocs).toMatch(/successful request automatically triggers `Linux App Release`/u);
  expect(releaseDocs).not.toContain("release-publish/");
  expect(linux.permissions).toEqual({});
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.repository.full_name == 'openclaw/openclaw'",
  );
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.event == 'workflow_dispatch'",
  );
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.head_branch == 'main'",
  );
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.conclusion == 'success'",
  );
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
  ).toEqual(["mirror_legacy"]);
  expect(linux.jobs.publish.permissions).toEqual({ actions: "read", contents: "read" });
  expect(
    Object.entries(linux.jobs)
      .filter(([, job]) => JSON.stringify(job).includes("${{ secrets.TAURI_SIGNING_PRIVATE_KEY"))
      .map(([name]) => name),
  ).toEqual(["sign_linux", "sign_desktop"]);
  const linuxSteps = linux.jobs.validate_release.steps as WorkflowStep[];
  expect(
    linuxSteps.find(({ name }) => name === "Checkout trusted release tooling")?.with,
  ).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: ".release-tooling",
    "persist-credentials": false,
    "sparse-checkout":
      "apps/linux/src-tauri/tauri.conf.json\nscripts/lib/record-shared.mjs\nscripts/release-tooling-identity.mjs\nscripts/linux-updater-manifest.mjs\nscripts/lib/release-version.mjs\n",
  });
  const tooling = linuxSteps.find(({ name }) => name === "Verify trusted release tooling identity");
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
  expect(linux.jobs.validate_release.outputs).toEqual({
    desktop_test_bundles: "${{ steps.request.outputs.desktop_test_bundles }}",
    release_tag: "${{ steps.request.outputs.release_tag }}",
    tag_sha: "${{ steps.ancestry.outputs.tag_sha }}",
    updater_pubkey: "${{ steps.updater_trust.outputs.updater_pubkey }}",
    already_published: "${{ steps.completion.outputs.already_published }}",
  });
  const releaseRequest = expectDefined(
    linuxSteps.find(({ id }) => id === "request"),
    "trusted release request validation",
  );
  expect(releaseRequest.env).toEqual({
    REQUEST_TITLE: "${{ github.event.workflow_run.display_title }}",
    REQUEST_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  });
  expect(releaseRequest.run).toContain("Release request title does not match");
  expect(releaseRequest.run).toContain('echo "release_tag=${BASH_REMATCH[1]}"');
  expect(releaseRequest.run).toContain('echo "desktop_test_bundles=${BASH_REMATCH[3]}"');
  const requestRoot = tempDirs.make("openclaw-linux-release-request-");
  const requestOutput = path.join(requestRoot, "output");
  const acceptedRequest = spawnSync("bash", ["-c", releaseRequest.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: requestOutput,
      REQUEST_TITLE: "Linux App Release Request [v2026.8.2] desktop=true",
      REQUEST_HEAD_SHA: "a".repeat(40),
      WORKFLOW_SHA: "a".repeat(40),
    },
  });
  expect(acceptedRequest.status, `${acceptedRequest.stdout}${acceptedRequest.stderr}`).toBe(0);
  expect(readFileSync(requestOutput, "utf8")).toBe(
    "release_tag=v2026.8.2\ndesktop_test_bundles=true\n",
  );
  const rejectedRequest = spawnSync("bash", ["-c", releaseRequest.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: requestOutput,
      REQUEST_TITLE: "Linux App Release Request [v2026.8.2] desktop=true extra",
      REQUEST_HEAD_SHA: "a".repeat(40),
      WORKFLOW_SHA: "a".repeat(40),
    },
  });
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
    const install = expectDefined(
      steps.find(({ name }) => name === "Install selected-tag dependencies"),
      `${jobName} dependency install`,
    );
    expect(steps.indexOf(install), `${jobName} install order`).toBeGreaterThan(checkoutIndex);
    expect(install.run).toContain("corepack enable");
    expect(install.run).toContain("pnpm install --frozen-lockfile");
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
  const packagedRuntimeSmoke = "apps/linux/tests/packaged_runtime_smoke.py";
  const firstRunDriver = path.posix.join(path.posix.dirname(packagedRuntimeSmoke), "first_run.py");
  expect(readFileSync(packagedRuntimeSmoke, "utf8")).toContain(
    'Path(__file__).with_name("first_run.py")',
  );
  expect(firstRunDriver).toBe("apps/linux/tests/first_run.py");
  expect(trustedToolingFiles).toContain(firstRunDriver);
  expect(
    path.posix.join(path.posix.dirname(`.release-tooling/${packagedRuntimeSmoke}`), "first_run.py"),
  ).toBe(".release-tooling/apps/linux/tests/first_run.py");
  const buildLinuxBundles = expectDefined(
    linuxBuildSteps.find(({ name }) => name === "Build Linux companion bundles"),
    "Linux bundle build step",
  );
  expect(buildLinuxBundles["working-directory"]).toBe("apps/linux/src-tauri");
  expect(buildLinuxBundles.env?.LDAI_RUNTIME_FILE).toBe(
    "${{ runner.temp }}/openclaw-tauri-cache/tauri/.appimage-runtime-x86_64",
  );
  expect(buildLinuxBundles.run).toContain('\\"createUpdaterArtifacts\\":false');
  expect(buildLinuxBundles.run).toContain('\\"useLocalToolsDir\\":false');
  const stageLinuxBundles = expectDefined(
    linuxBuildSteps.find(({ name }) => name === "Verify and stage unsigned Linux bundles"),
    "Linux unsigned bundle staging",
  );
  expect(stageLinuxBundles.run).toContain(
    'cp "${debs[0]}" "dist/linux-app/release/OpenClaw-${version}-amd64.deb"',
  );
  expect(stageLinuxBundles.run).toContain(
    'cp "${appimages[0]}" "dist/linux-app/unsigned/OpenClaw-${version}-amd64.AppImage"',
  );
  const buildLinuxJson = JSON.stringify(linux.jobs.build_linux);
  expect(buildLinuxJson).not.toContain("${{ secrets.");
  for (const name of tauriSigningEnvNames) {
    expect(buildLinuxJson).not.toContain(name);
  }
  const finalizeAppImage = expectDefined(
    linuxBuildSteps.find(({ name }) => name === "Finalize AppImage"),
    "Linux AppImage finalizer step",
  );
  for (const name of tauriSigningEnvNames) {
    expect(finalizeAppImage.env ?? {}).not.toHaveProperty(name);
  }
  expect(finalizeAppImage.run).not.toContain("signer sign");
  expect(linuxBuildSteps.find(({ name }) => name === "Sign finalized AppImage")).toBeUndefined();
  expect(linux.jobs.build_linux.outputs).toEqual({
    deb_artifact_id: "${{ steps.upload_deb.outputs.artifact-id }}",
    unsigned_appimage_artifact_id: "${{ steps.upload_appimage.outputs.artifact-id }}",
  });
  expect(linuxBuildSteps.find(({ id }) => id === "upload_deb")?.with).toMatchObject({
    name: "linux-app-release-deb",
    path: "dist/linux-app/release/*.deb",
  });
  expect(linuxBuildSteps.find(({ id }) => id === "upload_appimage")?.with).toMatchObject({
    name: "linux-app-release-unsigned-appimage",
    path: "dist/linux-app/unsigned/*.AppImage",
  });
  const signingJob = linux.jobs.sign_linux;
  const signingSteps = signingJob.steps as WorkflowStep[];
  expect(signingJob.needs).toEqual(["validate_release", "build_linux"]);
  expect(signingJob.permissions).toEqual({});
  expect(signingJob.outputs).toEqual({
    signed_appimage_artifact_id: "${{ steps.upload_signed_appimage.outputs.artifact-id }}",
  });
  expect(
    signingSteps.map(({ uses }) => uses).filter((uses): uses is string => uses !== undefined),
  ).toEqual([DOWNLOAD_ARTIFACT_V8, UPLOAD_ARTIFACT_V7]);
  expect(signingSteps.some((step) => step["working-directory"] !== undefined)).toBe(false);
  const signingBodies = signingSteps.map(({ run }) => run ?? "").join("\n");
  expect(signingBodies).not.toMatch(/(?:^|\s)(?:git|cargo)\s|\.release-tooling|apps\/linux\//mu);
  expect(signingBodies).not.toMatch(/\b(?:npm|pnpm|npx|corepack)\b/u);
  expect(
    signingSteps.find(({ name }) => name === "Download finalized unsigned AppImage")?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_linux.outputs.unsigned_appimage_artifact_id }}",
    path: "dist/signing-input",
  });
  const signAppImage = expectDefined(
    signingSteps.find(({ name }) => name === "Sign finalized AppImage"),
    "Linux AppImage signing step",
  );
  expect(signAppImage.env).toMatchObject({
    RELEASE_TAG: "${{ needs.validate_release.outputs.release_tag }}",
    TAG_SHA: "${{ needs.validate_release.outputs.tag_sha }}",
    TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    UPDATER_PUBLIC_KEY: "${{ needs.validate_release.outputs.updater_pubkey }}",
  });
  const signingToolsInstaller = expectDefined(
    signingSteps.find(({ name }) => name === "Install trusted signing tools"),
    "Linux signing tools installer",
  );
  expect(linux.env).toMatchObject({
    MINISIGN_ARCHIVE_SHA256: "9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73",
    MINISIGN_BINARY_SHA256: "2c74dffcc1c9a5ee55957c60971998ace2b89f22585631594ec2152c588af8db",
    MINISIGN_URL:
      "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz",
    TAURI_CLI_ARCHIVE_SHA256: "6864602a34292aa6f2ad40ae019eebe5c1064d6c623fe20696a8a8974067e60b",
    TAURI_CLI_BINARY_SHA256: "23a27f61c50417fe87c92fa958fb56ecc8de7c791f78df3cac046c8579b45897",
    TAURI_CLI_URL:
      "https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v2.11.4/cargo-tauri-x86_64-unknown-linux-gnu.tgz",
  });
  expect(signingToolsInstaller.run?.match(/--proto '=https' --tlsv1\.2/gu)).toHaveLength(2);
  expect(signingToolsInstaller.run?.match(/--connect-timeout 10 --max-time 120/gu)).toHaveLength(2);
  expect(signingToolsInstaller.run).toContain('--output "$minisign_archive" "$MINISIGN_URL"');
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_ARCHIVE_SHA256" "$minisign_archive" | sha256sum --check -',
  );
  expect(signingToolsInstaller.run).toContain(
    'tar -xzf "$minisign_archive" -C "${RUNNER_TEMP}/bin" --strip-components=2 \\\n  minisign-linux/x86_64/minisign',
  );
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign" |',
  );
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_ARCHIVE_SHA256" "$tauri_archive" | sha256sum --check -',
  );
  expect(signingToolsInstaller.run).toContain('--output "$tauri_archive" "$TAURI_CLI_URL"');
  expect(signingToolsInstaller.run).toContain(
    'tar -xzf "$tauri_archive" -C "${RUNNER_TEMP}/bin" cargo-tauri',
  );
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri" |',
  );
  expect(signingToolsInstaller.run).toContain(
    'chmod 0555 "${RUNNER_TEMP}/bin/cargo-tauri" "${RUNNER_TEMP}/bin/minisign"',
  );
  expect(signingToolsInstaller.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" --version');
  expect(signingToolsInstaller.run).toContain('"${RUNNER_TEMP}/bin/minisign" -v');
  expect(signingToolsInstaller.run).not.toMatch(
    /apt-get|GITHUB_PATH|(?:^|\n)\s*(?:export\s+)?PATH=/u,
  );
  expect(signAppImage.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri"',
  );
  expect(signAppImage.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign"',
  );
  expect(signAppImage.run).toContain(
    'appimage="dist/signing-input/OpenClaw-${version}-amd64.AppImage"',
  );
  expect(signAppImage.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$appimage"');
  expect(signAppImage.run).toContain(
    "unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  );
  const signAppImageRun = expectDefined(signAppImage.run, "AppImage signing command");
  expect(signAppImageRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeGreaterThan(
    signAppImageRun.indexOf('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$appimage"'),
  );
  expect(signAppImageRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeLessThan(
    signAppImageRun.indexOf('"${RUNNER_TEMP}/bin/minisign" -Vm "$appimage"'),
  );
  expect(signAppImage.run).toContain('before=$(sha256sum "$appimage")');
  expect(signAppImage.run).toContain('after=$(sha256sum "$appimage")');
  expect(signAppImage.run).toContain('base64 --decode < "${appimage}.sig"');
  expect(signAppImage.run).toContain('"${RUNNER_TEMP}/bin/minisign" -Vm "$appimage"');
  expect(signAppImage.run).not.toMatch(/\b(?:curl|wget|npm|pnpm|npx|corepack)\b|https?:\/\//u);
  expect(signAppImage.run).not.toMatch(/(?:^|\n)\s*(?:export\s+)?PATH=/u);
  expect(signAppImage.run).not.toContain("finalize-appimage.sh");
  expect(signingSteps.find(({ id }) => id === "upload_signed_appimage")?.with).toMatchObject({
    name: "linux-app-release-signed-appimage",
    path: "dist/linux-app",
  });
  for (const [jobName, job] of Object.entries(linux.jobs)) {
    if (jobName === "sign_linux" || jobName === "sign_desktop") {
      continue;
    }
    expect(JSON.stringify(job), `${jobName} must not reference signer binaries`).not.toMatch(
      /\$\{RUNNER_TEMP\}\/bin\/(?:cargo-tauri|minisign)/u,
    );
  }
  const macosBuildSteps = linux.jobs.build_macos.steps as WorkflowStep[];
  const buildMacos = expectDefined(
    macosBuildSteps.find(({ name }) => name === "Build macOS test bundles"),
    "macOS bundle build step",
  );
  expect(buildMacos.run).toContain('\\"createUpdaterArtifacts\\":false');
  const stageMacos = expectDefined(
    macosBuildSteps.find(({ name }) => name === "Verify and stage unsigned macOS bundles"),
    "macOS unsigned staging step",
  );
  expect(stageMacos.run).toContain(
    "archives=(apps/linux/src-tauri/target/release/bundle/macos/*.app.tar.gz)",
  );
  expect(stageMacos.run).toContain(
    "signatures=(apps/linux/src-tauri/target/release/bundle/macos/*.sig)",
  );
  expect(stageMacos.run).toContain(
    'tar -czf "$archive" -C "$(dirname "${apps[0]}")" "$(basename "${apps[0]}")"',
  );
  expect(linux.jobs.build_macos.outputs).toEqual({
    dmg_artifact_id: "${{ steps.upload_dmg.outputs.artifact-id }}",
    unsigned_updater_artifact_id: "${{ steps.upload_updater.outputs.artifact-id }}",
  });
  expect(macosBuildSteps.find(({ id }) => id === "upload_dmg")?.with).toMatchObject({
    name: "macos-app-release-dmg",
    path: "dist/macos-app/release/*.dmg",
  });
  expect(macosBuildSteps.find(({ id }) => id === "upload_updater")?.with).toMatchObject({
    name: "macos-app-release-unsigned-updater",
    path: "dist/macos-app/unsigned/*.app.tar.gz",
  });

  const windowsBuildSteps = linux.jobs.build_windows.steps as WorkflowStep[];
  const buildWindows = expectDefined(
    windowsBuildSteps.find(({ name }) => name === "Build Windows test bundle"),
    "Windows bundle build step",
  );
  expect(buildWindows.run).toContain('\\"createUpdaterArtifacts\\":false');
  const stageWindows = expectDefined(
    windowsBuildSteps.find(({ name }) => name === "Verify and stage unsigned Windows bundle"),
    "Windows unsigned staging step",
  );
  expect(stageWindows.run).toContain(
    'Get-ChildItem "apps/linux/src-tauri/target/release/bundle/nsis/*.sig"',
  );
  expect(linux.jobs.build_windows.outputs).toEqual({
    unsigned_updater_artifact_id: "${{ steps.upload_updater.outputs.artifact-id }}",
  });
  expect(windowsBuildSteps.find(({ id }) => id === "upload_updater")?.with).toMatchObject({
    name: "windows-app-release-unsigned-updater",
    path: "dist/windows-app/unsigned/*.exe",
  });

  const desktopSigningJob = linux.jobs.sign_desktop;
  const desktopSigningSteps = desktopSigningJob.steps as WorkflowStep[];
  expect(desktopSigningJob.needs).toEqual(["validate_release", "build_macos", "build_windows"]);
  expect(desktopSigningJob.permissions).toEqual({});
  expect(desktopSigningJob.outputs).toEqual({
    signed_desktop_artifact_id: "${{ steps.upload_signed_desktop.outputs.artifact-id }}",
  });
  expect(
    desktopSigningSteps
      .map(({ uses }) => uses)
      .filter((uses): uses is string => uses !== undefined),
  ).toEqual([DOWNLOAD_ARTIFACT_V8, DOWNLOAD_ARTIFACT_V8, UPLOAD_ARTIFACT_V7]);
  expect(desktopSigningSteps.some((step) => step["working-directory"] !== undefined)).toBe(false);
  const desktopSigningBodies = desktopSigningSteps.map(({ run }) => run ?? "").join("\n");
  expect(desktopSigningBodies).not.toMatch(
    /(?:^|\s)(?:git|cargo)\s|\.release-tooling|apps\/linux\//mu,
  );
  expect(desktopSigningBodies).not.toMatch(/\b(?:npm|pnpm|npx|corepack)\b/u);
  expect(
    desktopSigningSteps.find(({ name }) => name === "Download finalized macOS updater archive")
      ?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_macos.outputs.unsigned_updater_artifact_id }}",
    path: "dist/signing-input/macos",
  });
  expect(
    desktopSigningSteps.find(({ name }) => name === "Download finalized Windows updater installer")
      ?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_windows.outputs.unsigned_updater_artifact_id }}",
    path: "dist/signing-input/windows",
  });
  const signDesktop = expectDefined(
    desktopSigningSteps.find(({ name }) => name === "Sign finalized desktop updater bundles"),
    "desktop updater signing step",
  );
  expect(signDesktop.env).toMatchObject({
    RELEASE_TAG: "${{ needs.validate_release.outputs.release_tag }}",
    TAG_SHA: "${{ needs.validate_release.outputs.tag_sha }}",
    TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    UPDATER_PUBLIC_KEY: "${{ needs.validate_release.outputs.updater_pubkey }}",
  });
  expect(desktopSigningSteps.find(({ name }) => name === "Install trusted signing tools")).toEqual(
    signingToolsInstaller,
  );
  expect(signDesktop.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri"',
  );
  expect(signDesktop.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign"',
  );
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$macos"');
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$windows"');
  expect(signDesktop.run).toContain(
    "unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  );
  const signDesktopRun = expectDefined(signDesktop.run, "desktop updater signing command");
  expect(signDesktopRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeGreaterThan(
    signDesktopRun.indexOf('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$windows"'),
  );
  expect(signDesktopRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeLessThan(
    signDesktopRun.indexOf('"${RUNNER_TEMP}/bin/minisign" -Vm "$macos"'),
  );
  expect(signDesktop.run).toContain('macos_before=$(sha256sum "$macos")');
  expect(signDesktop.run).toContain('windows_after=$(sha256sum "$windows")');
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/minisign" -Vm "$macos"');
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/minisign" -Vm "$windows"');
  expect(signDesktop.run).not.toMatch(/\b(?:curl|wget|npm|pnpm|npx|corepack)\b|https?:\/\//u);
  expect(signDesktop.run).not.toMatch(/(?:^|\n)\s*(?:export\s+)?PATH=/u);
  expect(desktopSigningSteps.find(({ id }) => id === "upload_signed_desktop")?.with).toMatchObject({
    name: "desktop-test-release-signed-updaters",
    path: "dist/desktop-test",
  });

  expect(linux.jobs.publish.needs).toContain("sign_linux");
  expect(linux.jobs.publish.needs).toContain("sign_desktop");
  expect(linux.jobs.publish.if).toContain("needs.sign_linux.result == 'success'");
  expect(linux.jobs.publish.if).toContain("needs.sign_desktop.result == 'success'");
  expect(linux.jobs.publish.if).not.toContain("inputs.");
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download Debian bundle",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_linux.outputs.deb_artifact_id }}",
    path: "dist/input/linux/release",
  });
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download signed AppImage",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.sign_linux.outputs.signed_appimage_artifact_id }}",
    path: "dist/input/linux",
  });
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download macOS test DMG",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_macos.outputs.dmg_artifact_id }}",
    path: "dist/input/macos/release",
  });
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download signed desktop updater bundles",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.sign_desktop.outputs.signed_desktop_artifact_id }}",
    path: "dist/input",
  });
  const assembleLinuxBundles = expectDefined(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Assemble release assets and updater manifest",
    ),
    "Linux release assembly step",
  );
  expect(assembleLinuxBundles.run).not.toContain('"linux-x86_64"');
  const publishLinuxMetadata = expectDefined(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) =>
        name === "Publish immutable bundles, canonical Linux channel, and legacy mirror",
    ),
    "Linux publication owner",
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
  const appImageToolsManifest = readFileSync(
    "apps/linux/scripts/tauri-appimage-tools-x86_64.tsv",
    "utf8",
  );
  const aarch64AppImageToolsManifest = readFileSync(
    "apps/linux/scripts/tauri-appimage-tools-aarch64.tsv",
    "utf8",
  );
  expect(appImageTools).toContain("prepare)");
  expect(appImageTools).toContain('verify_directory "$tools_dir" "$2"');
  expect(appImageTools).toContain("--proto '=https' --tlsv1.2");
  expect(appImageTools).toContain("--connect-timeout 10 --max-time 120");
  expect(appImageTools).toContain("--retry 3 --retry-all-errors");
  expect(appImageTools).toContain('mv -Tn -- "$staging_dir" "$tools_dir"');
  expect(appImageTools).toContain('fail "refusing existing Tauri tool cache: $tools_dir"');
  expect(appImageTools).toContain('offset=$("$plugin" --appimage-offset)');
  expect(appImageTools).toContain('cmp --silent --bytes="$offset" -- "$plugin" "$runtime"');
  expect(appImageToolsManifest.trim().split("\n")).toEqual([
    [
      "AppRun-x86_64",
      "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64",
      "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f",
      "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-x86_64.AppImage",
      "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage",
      "e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef",
      "20eebde3c18ae2e44279bd624fc72482503aece216d5d77f10932235342f71c1",
      "0755",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gtk.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/b5eb8d05b4c0ed40107fe2158c5d8527f94568ef/linuxdeploy-plugin-gtk.sh",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gstreamer.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-appimage.AppImage",
      "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage",
      "0441769ab38009504d2678c38cd7e526955388dd30a215b4a20afaa5471652f2",
      "0441769ab38009504d2678c38cd7e526955388dd30a215b4a20afaa5471652f2",
      "0555",
    ].join("\t"),
  ]);
  expect(aarch64AppImageToolsManifest.trim().split("\n")).toEqual([
    [
      "AppRun-aarch64",
      "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-aarch64",
      "072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578",
      "072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-aarch64.AppImage",
      "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-aarch64.AppImage",
      "b12b5cc57bd0921e1f98d73f58aa364503bc1a27f54b7a69fd2870bce7fa2f55",
      "a4335edd7c91b99fa9fbb2339d8e5611efbc4fd243ad07b9980ddc961b77d632",
      "0755",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gtk.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/b5eb8d05b4c0ed40107fe2158c5d8527f94568ef/linuxdeploy-plugin-gtk.sh",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gstreamer.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-appimage.AppImage",
      "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-aarch64.AppImage",
      "ce574719bcf9cc1fb12728d60b17e48cc87d9b6c40f6f48b04cff7d273b5eb24",
      "ce574719bcf9cc1fb12728d60b17e48cc87d9b6c40f6f48b04cff7d273b5eb24",
      "0555",
    ].join("\t"),
  ]);
  expect(appImageTools).toMatch(/continuous[\s\S]*digest-pinned/u);

  const prLinux = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  expect(evaluateWorkflowRunner(prLinux.jobs.build["runs-on"])).toBe("ubuntu-22.04");
  expect(prLinux.jobs.build.strategy).toBeUndefined();
  expect(prLinux.on.workflow_dispatch?.inputs).toBeUndefined();
  const abiScannerTest = expectDefined(
    (prLinux.jobs.build.steps as WorkflowStep[]).find(
      ({ name }) => name === "Test packaged runtime ABI scanner",
    ),
    "pull request AppImage ABI scanner test",
  );
  expect(abiScannerTest.run).toContain("python3 -m unittest discover");
  expect(abiScannerTest.run).toContain("-s apps/linux/tests -p 'test_packaged_runtime_smoke.py'");
  const workflowContracts = [
    {
      job: prLinux.jobs.build,
      helper: appImageToolsPath,
      label: "pull request",
    },
    {
      job: linux.jobs.build_linux,
      helper: `.release-tooling/${appImageToolsPath}`,
      label: "release",
    },
  ];
  for (const contract of workflowContracts) {
    const steps = contract.job.steps as WorkflowStep[];
    const prepareIndex = steps.findIndex(({ name }) => name === "Prepare pinned AppImage tools");
    const buildIndex = steps.findIndex(({ name }) => name === "Build Linux companion bundles");
    const finalizeIndex = steps.findIndex(({ name }) => name === "Finalize AppImage");
    expect(prepareIndex, `${contract.label} prepare`).toBeGreaterThan(0);
    expect(buildIndex, `${contract.label} build`).toBe(prepareIndex + 1);
    expect(finalizeIndex, `${contract.label} finalize`).toBe(buildIndex + 1);
    for (const index of [prepareIndex, buildIndex, finalizeIndex]) {
      expect(steps[index]?.env?.XDG_CACHE_HOME, `${contract.label} cache path`).toBe(
        "${{ runner.temp }}/openclaw-tauri-cache",
      );
    }
    expect(steps[prepareIndex]?.run, contract.label).toContain(`${contract.helper} prepare`);
    expect(steps[prepareIndex]?.run, contract.label).toContain(
      `${contract.helper} verify pre-build`,
    );
    expect(steps[buildIndex]?.run, contract.label).toContain("@tauri-apps/cli@2.11.4");
    expect(steps[buildIndex]?.run, contract.label).toMatch(/\\?"useLocalToolsDir\\?":false/u);
    expect(steps[finalizeIndex]?.run, contract.label).toMatch(
      /finalize-appimage\.sh "?\\?\$?bundle_dir"?|finalize-appimage\.sh apps\/linux\/src-tauri\/target\/release\/bundle\/appimage/u,
    );
    expect(JSON.stringify(contract.job), contract.label).not.toContain("${{ secrets.");
  }
  const prPrepare = expectDefined(
    (prLinux.jobs.build.steps as WorkflowStep[]).find(
      ({ name }) => name === "Prepare pinned AppImage tools",
    ),
    "pull request AppImage tool preparation",
  );
  expect(prPrepare.run).toContain(
    "runtime_file=$(apps/linux/scripts/tauri-appimage-tools.sh runtime-path)",
  );
  expect(prPrepare.run).toContain(
    'printf \'LDAI_RUNTIME_FILE=%s\\n\' "$runtime_file" >> "$GITHUB_ENV"',
  );
  expect(
    (prLinux.jobs.build.steps as WorkflowStep[]).find(
      ({ name }) => name === "Build Linux companion bundles",
    )?.env,
  ).not.toHaveProperty("LDAI_RUNTIME_FILE");
  expect(evaluateWorkflowRunner(linux.jobs.build_linux["runs-on"])).toBe("ubuntu-22.04");
  expect(linux.jobs.build_linux.strategy).toBeUndefined();
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
  expect(finalizerSource).toContain('LDAI_RUNTIME_FILE="$runtime"');
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
  for (const [machine, expected] of [
    ["x86_64", "x86_64"],
    ["amd64", "x86_64"],
    ["aarch64", "aarch64"],
    ["arm64", "aarch64"],
  ] as const) {
    const result = spawnSync(path.resolve(appImageToolsPath), ["architecture"], {
      encoding: "utf8",
      env: architectureEnv("Linux", machine),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
    expect(existsSync(architectureCache)).toBe(false);
  }
  const runtimePath = spawnSync(path.resolve(appImageToolsPath), ["runtime-path"], {
    encoding: "utf8",
    env: architectureEnv("Linux", "arm64"),
  });
  expect(runtimePath.status, `${runtimePath.stdout}${runtimePath.stderr}`).toBe(0);
  expect(runtimePath.stdout).toBe(`${architectureCache}/tauri/.appimage-runtime-aarch64\n`);
  expect(existsSync(architectureCache)).toBe(false);
  const relativeRuntimePath = spawnSync(path.resolve(appImageToolsPath), ["runtime-path"], {
    encoding: "utf8",
    env: architectureEnv("Linux", "x86_64", "relative-cache"),
  });
  expect(relativeRuntimePath.status).not.toBe(0);
  for (const [system, machine] of [
    ["Darwin", "arm64"],
    ["Linux", "riscv64"],
  ] as const) {
    const rejectedCache = path.join(architectureRoot, `${system}-${machine}`);
    const result = spawnSync(path.resolve(appImageToolsPath), ["prepare"], {
      encoding: "utf8",
      env: architectureEnv(system, machine, rejectedCache),
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(rejectedCache)).toBe(false);
  }
  if (process.platform === "linux") {
    const selectedTagRoot = tempDirs.make("openclaw-linux-release-v2026.8.2-");
    const trustedTools = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/tauri-appimage-tools.sh",
    );
    const trustedToolsManifest = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/tauri-appimage-tools-x86_64.tsv",
    );
    const trustedArmToolsManifest = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/tauri-appimage-tools-aarch64.tsv",
    );
    const trustedFinalizer = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/finalize-appimage.sh",
    );
    const trustedSmoke = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/tests/packaged_runtime_smoke.py",
    );
    const trustedFirstRun = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/tests/first_run.py",
    );
    const bundleDir = path.join(
      selectedTagRoot,
      "apps/linux/src-tauri/target/release/bundle/appimage",
    );
    const appDir = path.join(bundleDir, "OpenClaw.AppDir");
    const appImage = path.join(bundleDir, "OpenClaw_2026.8.2_amd64.AppImage");
    const cacheRoot = path.join(selectedTagRoot, ".cache");
    const toolSourceDir = path.join(selectedTagRoot, "tool-sources");
    const fakeBin = path.join(selectedTagRoot, "fake-bin");
    const pluginSentinel = path.join(selectedTagRoot, "plugin-executed");
    const toolNames = [
      "AppRun-x86_64",
      "linuxdeploy-x86_64.AppImage",
      "linuxdeploy-plugin-gtk.sh",
      "linuxdeploy-plugin-gstreamer.sh",
      "linuxdeploy-plugin-appimage.AppImage",
    ] as const;
    mkdirSync(path.dirname(trustedFinalizer), { recursive: true });
    mkdirSync(path.dirname(trustedSmoke), { recursive: true });
    mkdirSync(toolSourceDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    copyFileSync("apps/linux/scripts/tauri-appimage-tools.sh", trustedTools);
    copyFileSync("apps/linux/scripts/tauri-appimage-tools-x86_64.tsv", trustedToolsManifest);
    copyFileSync("apps/linux/scripts/finalize-appimage.sh", trustedFinalizer);
    copyFileSync("apps/linux/tests/packaged_runtime_smoke.py", trustedSmoke);
    copyFileSync("apps/linux/tests/first_run.py", trustedFirstRun);
    chmodSync(trustedTools, 0o755);
    chmodSync(trustedFinalizer, 0o755);

    const toolSources = new Map<string, Buffer>();
    for (const toolName of toolNames) {
      const contents =
        toolName === "linuxdeploy-plugin-appimage.AppImage"
          ? Buffer.from(
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
            )
          : Buffer.from(`#!/bin/sh\n# synthetic ${toolName}\nexit 0\n`);
      toolSources.set(toolName, contents);
      writeFileSync(path.join(toolSourceDir, toolName), contents, { mode: 0o755 });
    }
    const preBuildLinuxdeploy = Buffer.from(
      expectDefined(toolSources.get("linuxdeploy-x86_64.AppImage"), "linuxdeploy source"),
    );
    const postBuildLinuxdeploy = Buffer.from(preBuildLinuxdeploy);
    postBuildLinuxdeploy.fill(0, 8, 11);
    const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
    const writeSyntheticManifest = (wrongDigest = false) => {
      writeFileSync(
        trustedToolsManifest,
        toolNames
          .map((toolName, index) => {
            const contents = expectDefined(toolSources.get(toolName), `${toolName} source`);
            const preBuildDigest = wrongDigest && index === 0 ? "0".repeat(64) : digest(contents);
            const postBuildDigest =
              toolName === "linuxdeploy-x86_64.AppImage"
                ? digest(postBuildLinuxdeploy)
                : digest(contents);
            const mode = toolName === "linuxdeploy-x86_64.AppImage" ? "0755" : "0555";
            return [
              toolName,
              `https://example.invalid/${toolName}`,
              preBuildDigest,
              postBuildDigest,
              mode,
            ].join("\t");
          })
          .join("\n") + "\n",
      );
    };
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
    writeSyntheticManifest(true);
    const rejectedPrepare = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(rejectedPrepare.status).not.toBe(0);
    expect(existsSync(path.join(cacheRoot, "tauri"))).toBe(false);

    writeSyntheticManifest();
    const rejectedRacedPrepare = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: {
        ...toolEnv,
        CACHE_RACE_TOOL: "linuxdeploy-plugin-appimage.AppImage",
      },
    });
    expect(
      rejectedRacedPrepare.status,
      `${rejectedRacedPrepare.stdout}${rejectedRacedPrepare.stderr}`,
    ).not.toBe(0);
    expect(readFileSync(path.join(cacheRoot, "tauri/race-marker"), "utf8")).toBe("raced\n");
    expect(globSync(path.join(cacheRoot, ".tauri-tools.*"))).toEqual([]);
    rmSync(path.join(cacheRoot, "tauri"), { recursive: true });

    const prepared = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(prepared.status, `${prepared.stdout}${prepared.stderr}`).toBe(0);
    expect(globSync(path.join(cacheRoot, ".tauri-tools.*"))).toEqual([]);
    const verifiedPreBuild = spawnSync(trustedTools, ["verify", "pre-build"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(verifiedPreBuild.status, `${verifiedPreBuild.stdout}${verifiedPreBuild.stderr}`).toBe(0);
    const toolsDir = path.join(cacheRoot, "tauri");
    const runtime = path.join(toolsDir, ".appimage-runtime-x86_64");
    const appImagePlugin = expectDefined(
      toolSources.get("linuxdeploy-plugin-appimage.AppImage"),
      "AppImage plugin source",
    );
    expect(readFileSync(runtime)).toEqual(appImagePlugin.subarray(0, 16));
    expect(statSync(runtime).mode & 0o777).toBe(0o444);
    const rejectedStaleCache = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(rejectedStaleCache.status).not.toBe(0);

    const linuxdeploy = path.join(toolsDir, "linuxdeploy-x86_64.AppImage");
    writeFileSync(linuxdeploy, postBuildLinuxdeploy);
    chmodSync(linuxdeploy, 0o755);
    const verifiedPostBuild = spawnSync(trustedTools, ["verify", "post-build"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(verifiedPostBuild.status, `${verifiedPostBuild.stdout}${verifiedPostBuild.stderr}`).toBe(
      0,
    );

    const resetBundle = () => {
      rmSync(bundleDir, { force: true, recursive: true });
      mkdirSync(path.join(appDir, "usr/lib"), { recursive: true });
      writeFileSync(path.join(appDir, "usr/lib/libwayland-client.so.0"), "host-incompatible");
      writeFileSync(appImage, "pre-finalized");
      chmodSync(appImage, 0o755);
      writeFileSync(`${appImage}.sig`, "stale-signature");
      rmSync(pluginSentinel, { force: true });
    };
    const runFinalizer = () =>
      spawnSync(trustedFinalizer, [bundleDir], {
        cwd: selectedTagRoot,
        encoding: "utf8",
        env: {
          ...toolEnv,
          PLUGIN_SENTINEL: pluginSentinel,
        },
      });
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
      expect(existsSync(pluginSentinel), `${toolName} plugin execution`).toBe(false);
      expect(existsSync(path.join(appDir, "usr/lib/libwayland-client.so.0")), toolName).toBe(true);
      expect(readFileSync(appImage, "utf8"), toolName).toBe("pre-finalized");
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
    expect(existsSync(pluginSentinel)).toBe(false);
    expect(existsSync(path.join(appDir, "usr/lib/libwayland-client.so.0"))).toBe(true);
    expect(readFileSync(appImage, "utf8")).toBe("pre-finalized");
    writeFileSync(runtime, appImagePlugin.subarray(0, 16), { mode: 0o644 });
    chmodSync(runtime, 0o444);

    resetBundle();
    const finalized = runFinalizer();
    expect(finalized.status, `${finalized.stdout}${finalized.stderr}`).toBe(0);
    expect(readFileSync(appImage).subarray(0, 16)).toEqual(appImagePlugin.subarray(0, 16));
    expect(readFileSync(appImage, "utf8")).toContain("#!/bin/sh");
    expect(existsSync(`${appImage}.sig`)).toBe(false);
    expect(existsSync(path.join(appDir, "usr/lib/libwayland-client.so.0"))).toBe(false);
    expect(readFileSync(pluginSentinel, "utf8")).toBe("executed\n");

    writeFileSync(
      path.join(appDir, "usr/lib/libwayland-client.so.0"),
      "post-finalization-smoke-fixture",
    );
    expect(existsSync(path.join(selectedTagRoot, "apps/linux/scripts/finalize-appimage.sh"))).toBe(
      false,
    );
    const smokeChild = spawnSync(
      "python3",
      [
        "-c",
        [
          "from pathlib import Path",
          "import subprocess",
          "import sys",
          'child = Path(sys.argv[1]).with_name("first_run.py")',
          "assert child.is_file()",
          'subprocess.run([sys.executable, str(child), "--help"], check=True)',
        ].join("; "),
        trustedSmoke,
      ],
      { cwd: selectedTagRoot, encoding: "utf8" },
    );
    expect(smokeChild.status, `${smokeChild.stdout}${smokeChild.stderr}`).toBe(0);

    const armToolNames = [
      "AppRun-aarch64",
      "linuxdeploy-aarch64.AppImage",
      "linuxdeploy-plugin-gtk.sh",
      "linuxdeploy-plugin-gstreamer.sh",
      "linuxdeploy-plugin-appimage.AppImage",
    ] as const;
    const armToolSourceDir = path.join(selectedTagRoot, "arm-tool-sources");
    const armCacheRoot = path.join(selectedTagRoot, ".arm-cache");
    const armBundleDir = path.join(selectedTagRoot, "arm-bundle");
    const armAppDir = path.join(armBundleDir, "OpenClaw.AppDir");
    const armAppImage = path.join(armBundleDir, "OpenClaw_2026.8.2_arm64.AppImage");
    const armPluginSentinel = path.join(selectedTagRoot, "arm-plugin-executed");
    mkdirSync(armToolSourceDir);
    const armToolSources = new Map<string, Buffer>();
    for (const toolName of armToolNames) {
      const contents =
        toolName === "linuxdeploy-plugin-appimage.AppImage"
          ? expectDefined(toolSources.get(toolName), `${toolName} source`)
          : Buffer.from(`#!/bin/sh\n# synthetic ${toolName}\nexit 0\n`);
      armToolSources.set(toolName, contents);
      writeFileSync(path.join(armToolSourceDir, toolName), contents, { mode: 0o755 });
    }
    const armPostBuildLinuxdeploy = Buffer.from(
      expectDefined(armToolSources.get("linuxdeploy-aarch64.AppImage"), "ARM linuxdeploy source"),
    );
    armPostBuildLinuxdeploy.fill(0, 8, 11);
    writeFileSync(
      trustedArmToolsManifest,
      armToolNames
        .map((toolName) => {
          const contents = expectDefined(armToolSources.get(toolName), `${toolName} source`);
          return [
            toolName,
            `https://example.invalid/${toolName}`,
            digest(contents),
            toolName === "linuxdeploy-aarch64.AppImage"
              ? digest(armPostBuildLinuxdeploy)
              : digest(contents),
            toolName === "linuxdeploy-aarch64.AppImage" ? "0755" : "0555",
          ].join("\t");
        })
        .join("\n") + "\n",
    );
    const armToolEnv = {
      ...toolEnv,
      EXPECTED_ARCH: "aarch64",
      SYNTHETIC_UNAME_MACHINE: "arm64",
      TOOL_SOURCE_DIR: armToolSourceDir,
      XDG_CACHE_HOME: armCacheRoot,
    };
    const armPrepared = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: armToolEnv,
    });
    expect(armPrepared.status, `${armPrepared.stdout}${armPrepared.stderr}`).toBe(0);
    const armRuntimePath = spawnSync(trustedTools, ["runtime-path"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: armToolEnv,
    });
    expect(armRuntimePath.status, `${armRuntimePath.stdout}${armRuntimePath.stderr}`).toBe(0);
    expect(armRuntimePath.stdout).toBe(`${armCacheRoot}/tauri/.appimage-runtime-aarch64\n`);
    const armToolsDir = path.join(armCacheRoot, "tauri");
    const armLinuxdeploy = path.join(armToolsDir, "linuxdeploy-aarch64.AppImage");
    writeFileSync(armLinuxdeploy, armPostBuildLinuxdeploy);
    chmodSync(armLinuxdeploy, 0o755);
    mkdirSync(path.join(armAppDir, "usr/lib"), { recursive: true });
    writeFileSync(path.join(armAppDir, "usr/lib/libwayland-client.so.0"), "host-incompatible");
    writeFileSync(armAppImage, "pre-finalized", { mode: 0o755 });
    writeFileSync(`${armAppImage}.sig`, "stale-signature");
    const armFinalized = spawnSync(trustedFinalizer, [armBundleDir], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: {
        ...armToolEnv,
        PLUGIN_SENTINEL: armPluginSentinel,
      },
    });
    expect(armFinalized.status, `${armFinalized.stdout}${armFinalized.stderr}`).toBe(0);
    expect(readFileSync(armAppImage).subarray(0, 16)).toEqual(appImagePlugin.subarray(0, 16));
    expect(existsSync(`${armAppImage}.sig`)).toBe(false);
    expect(existsSync(path.join(armAppDir, "usr/lib/libwayland-client.so.0"))).toBe(false);
    expect(readFileSync(armPluginSentinel, "utf8")).toBe("executed\n");

    const writeSigningToolFixtures = (root: string) => {
      const bin = path.join(root, "bin");
      const poisonBin = path.join(root, "poison-bin");
      const tauri = path.join(bin, "cargo-tauri");
      const tauriLog = path.join(root, "cargo-tauri.log");
      const minisignLog = path.join(root, "minisign.log");
      mkdirSync(bin, { recursive: true });
      mkdirSync(poisonBin, { recursive: true });
      writeFileSync(
        tauri,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          '[[ "$#" -eq 3 && "$1" == "signer" && "$2" == "sign" ]]',
          '[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]',
          '[[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]',
          'printf "%s\\n" "$*" >> "$TAURI_SIGN_LOG"',
          'printf "ephemeral-signature:%s" "$(basename "$3")" | base64 > "$3.sig"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(bin, "minisign"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          '[[ "$#" -eq 6 && "$1" == "-Vm" && "$3" == "-x" && "$5" == "-p" ]]',
          '[[ -z "${TAURI_SIGNING_PRIVATE_KEY+x}" ]]',
          '[[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]',
          '[[ -s "$2" && -s "$4" && -s "$6" ]]',
          '[[ "$(cat "$6")" == "ephemeral-public-key" ]]',
          'printf "%s\\n" "$(basename "$2")" >> "$MINISIGN_LOG"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      for (const command of ["cargo-tauri", "minisign", "npm", "pnpm", "npx", "corepack"]) {
        writeFileSync(path.join(poisonBin, command), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
      }
      return {
        minisignBinarySha256: createHash("sha256")
          .update(readFileSync(path.join(bin, "minisign")))
          .digest("hex"),
        minisignLog,
        path: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}`,
        tauriBinarySha256: createHash("sha256").update(readFileSync(tauri)).digest("hex"),
        tauriLog,
      };
    };

    const signingRoot = tempDirs.make("openclaw-linux-signing-job-");
    const signingInput = path.join(signingRoot, "dist/signing-input");
    const finalizedArtifact = path.join(signingInput, "OpenClaw-2026.8.2-amd64.AppImage");
    mkdirSync(signingInput, { recursive: true });
    writeFileSync(finalizedArtifact, "trusted-finalized-bytes");
    const linuxSigningTools = writeSigningToolFixtures(signingRoot);
    const signed = spawnSync("bash", ["-c", signAppImage.run ?? ""], {
      cwd: signingRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: linuxSigningTools.path,
        RELEASE_TAG: "v2026.8.2",
        RUNNER_TEMP: signingRoot,
        TAG_SHA: "a".repeat(40),
        MINISIGN_BINARY_SHA256: linuxSigningTools.minisignBinarySha256,
        TAURI_CLI_BINARY_SHA256: linuxSigningTools.tauriBinarySha256,
        TAURI_SIGN_LOG: linuxSigningTools.tauriLog,
        TAURI_SIGNING_PRIVATE_KEY: "ephemeral-test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "ephemeral-test-password",
        UPDATER_PUBLIC_KEY: Buffer.from("ephemeral-public-key").toString("base64"),
        MINISIGN_LOG: linuxSigningTools.minisignLog,
      },
    });
    expect(signed.status, `${signed.stdout}${signed.stderr}`).toBe(0);
    expect(readFileSync(finalizedArtifact, "utf8")).toBe("trusted-finalized-bytes");
    expect(
      readFileSync(
        path.join(signingRoot, "dist/linux-app/release/OpenClaw-2026.8.2-amd64.AppImage"),
        "utf8",
      ),
    ).toBe("trusted-finalized-bytes");
    expect(
      readFileSync(
        path.join(signingRoot, "dist/linux-app/signatures/OpenClaw-2026.8.2-amd64.AppImage.sig"),
        "utf8",
      ),
    ).toBe(
      `${Buffer.from("ephemeral-signature:OpenClaw-2026.8.2-amd64.AppImage").toString("base64")}\n`,
    );
    expect(readFileSync(linuxSigningTools.tauriLog, "utf8")).toBe(
      "signer sign dist/signing-input/OpenClaw-2026.8.2-amd64.AppImage\n",
    );
    expect(readFileSync(linuxSigningTools.minisignLog, "utf8")).toBe(
      "OpenClaw-2026.8.2-amd64.AppImage\n",
    );
    expect(existsSync(path.join(signingRoot, ".release-tooling"))).toBe(false);
    expect(existsSync(path.join(signingRoot, "apps"))).toBe(false);

    const desktopSigningRoot = tempDirs.make("openclaw-desktop-signing-job-");
    const macosInput = path.join(
      desktopSigningRoot,
      "dist/signing-input/macos/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz",
    );
    const windowsInput = path.join(
      desktopSigningRoot,
      "dist/signing-input/windows/OpenClaw-2026.8.2-windows-x86_64.exe",
    );
    mkdirSync(path.dirname(macosInput), { recursive: true });
    mkdirSync(path.dirname(windowsInput), { recursive: true });
    writeFileSync(macosInput, "finalized-macos-updater-bytes");
    writeFileSync(windowsInput, "finalized-windows-updater-bytes");
    const desktopSigningTools = writeSigningToolFixtures(desktopSigningRoot);
    const desktopSigned = spawnSync("bash", ["-c", signDesktop.run ?? ""], {
      cwd: desktopSigningRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: desktopSigningTools.path,
        RELEASE_TAG: "v2026.8.2",
        RUNNER_TEMP: desktopSigningRoot,
        TAG_SHA: "a".repeat(40),
        MINISIGN_BINARY_SHA256: desktopSigningTools.minisignBinarySha256,
        TAURI_CLI_BINARY_SHA256: desktopSigningTools.tauriBinarySha256,
        TAURI_SIGN_LOG: desktopSigningTools.tauriLog,
        TAURI_SIGNING_PRIVATE_KEY: "ephemeral-test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "ephemeral-test-password",
        UPDATER_PUBLIC_KEY: Buffer.from("ephemeral-public-key").toString("base64"),
        MINISIGN_LOG: desktopSigningTools.minisignLog,
      },
    });
    expect(desktopSigned.status, `${desktopSigned.stdout}${desktopSigned.stderr}`).toBe(0);
    expect(readFileSync(macosInput, "utf8")).toBe("finalized-macos-updater-bytes");
    expect(readFileSync(windowsInput, "utf8")).toBe("finalized-windows-updater-bytes");
    expect(
      readFileSync(
        path.join(
          desktopSigningRoot,
          "dist/desktop-test/macos/release/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz",
        ),
        "utf8",
      ),
    ).toBe("finalized-macos-updater-bytes");
    expect(
      readFileSync(
        path.join(
          desktopSigningRoot,
          "dist/desktop-test/windows/release/OpenClaw-2026.8.2-windows-x86_64.exe",
        ),
        "utf8",
      ),
    ).toBe("finalized-windows-updater-bytes");
    expect(
      Buffer.from(
        readFileSync(
          path.join(
            desktopSigningRoot,
            "dist/desktop-test/macos/signatures/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz.sig",
          ),
          "utf8",
        ),
        "base64",
      ).toString(),
    ).toContain("OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz");
    expect(
      Buffer.from(
        readFileSync(
          path.join(
            desktopSigningRoot,
            "dist/desktop-test/windows/signatures/OpenClaw-2026.8.2-windows-x86_64.exe.sig",
          ),
          "utf8",
        ),
        "base64",
      ).toString(),
    ).toContain("OpenClaw-2026.8.2-windows-x86_64.exe");
    expect(readFileSync(desktopSigningTools.tauriLog, "utf8")).toBe(
      "signer sign dist/signing-input/macos/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz\n" +
        "signer sign dist/signing-input/windows/OpenClaw-2026.8.2-windows-x86_64.exe\n",
    );
    expect(readFileSync(desktopSigningTools.minisignLog, "utf8")).toBe(
      "OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz\nOpenClaw-2026.8.2-windows-x86_64.exe\n",
    );
    expect(existsSync(path.join(desktopSigningRoot, ".release-tooling"))).toBe(false);
    expect(existsSync(path.join(desktopSigningRoot, "apps"))).toBe(false);
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
  const linuxBody = expectDefined(
    (linux.jobs.validate_release.steps as WorkflowStep[]).find(
      ({ name }) => name === workflows[0].validation,
    )?.run,
    "Linux release admission body",
  );
  expect(linuxBody).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
  expect(linuxBody.match(/timeout=120/gu)).toHaveLength(2);
  expect(linuxBody).toContain('"+refs/heads/main:refs/remotes/origin/main"');
  expect(linuxBody).toContain('run_git(workspace, "merge-base", "--is-ancestor", sha, ref)');

  const macos = parse(readFileSync(workflows[1].file, "utf8"));
  const macosBody = expectDefined(
    (macos.jobs.validate_macos_release_request.steps as WorkflowStep[]).find(
      ({ name }) => name === workflows[1].validation,
    )?.run,
    "macOS release admission body",
  );
  expect(macosBody.match(/--git 0/gu)).toHaveLength(1);
  expect(macosBody.match(/--checkout-git 120/gu)).toHaveLength(1);
  expect(macosBody).toContain(
    '"+refs/heads/${PUBLIC_RELEASE_BRANCH}:refs/remotes/origin/${PUBLIC_RELEASE_BRANCH}"',
  );
  expect(macosBody.indexOf("--checkout-git 120")).toBeLessThan(
    macosBody.indexOf("pnpm release:openclaw:npm:check"),
  );

  const placeholder = parse(readFileSync(workflows[2].file, "utf8"));
  const placeholderBody = expectDefined(
    (placeholder.jobs.plan.steps as WorkflowStep[]).find(
      ({ name }) => name === workflows[2].validation,
    )?.run,
    "placeholder admission body",
  );
  expect(placeholderBody).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
  expect(placeholderBody.match(/timeout=120/gu)).toHaveLength(1);
  expect(placeholderBody.match(/run_git\(workspace, "merge-base"/gu)).toHaveLength(2);
  expect(placeholderBody).toContain('output.write(f"sha={source_ref}\\n")');
});

it("pins every Performance Git owner before checkout and preserves Git deadlines", () => {
  const source = readFileSync(".github/workflows/openclaw-performance.yml", "utf8");
  const workflow = parse(source);
  const targets = [
    ["resolve_target", "Checkout target metadata", undefined, 10],
    ["kova", "Checkout OpenClaw", "Decide lane", 240],
    ["source_performance", "Checkout OpenClaw source target", undefined, 120],
    ["publish", "Checkout performance publisher helper", "Decide report publication lane", 30],
  ] as const;
  for (const [jobId, checkout, decision, timeout] of targets) {
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
    expect(job["timeout-minutes"]).toBe(timeout);
    const bodies = steps.map(({ run }) => run ?? "").join("\n");
    expect(bodies).not.toMatch(/(?:^|[\s(])git\s/mu);
    expect(bodies).not.toMatch(/(?:^|[\s(])timeout\s+[^\n]*\bgit\b/u);
    const ownerDeadlines = [...bodies.matchAll(/--(?:checkout-)?git (\d+)/gu)].map((match) =>
      Number(match[1]),
    );
    expect(ownerDeadlines.every((deadline) => deadline === 0)).toBe(true);
    if (jobId !== "publish") {
      expect(bodies).not.toMatch(/timeout=\d+/u);
    } else {
      expect(bodies.match(/timeout=120/g)).toHaveLength(2);
      expect(bodies).not.toMatch(/timeout=(?!120)\d+/u);
      expect(bodies.match(/for attempt in range\(1, 6\)/gu)).toHaveLength(1);
      expect(bodies.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(1);
      expect(bodies).toContain('"push", "origin", "HEAD:main", timeout=120, reclaim_locks=True');
      expect(
        bodies.match(/"fetch", "--depth=1", "origin", "main", timeout=120, reclaim_locks=True/gu),
      ).toHaveLength(1);
      expect(bodies).toContain('fetch(sys.argv[3], "main", max_attempts=3, retry_failures=True)');
      expect(bodies).toContain("if error.code != 1:");
      expect(bodies).toContain(
        '"ls-tree", "--name-only", "FETCH_HEAD", "--", f"{dest}/report.json"',
      );
    }
  }
  expect(workflow.on.schedule).toEqual([{ cron: "11 5 * * *" }]);
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
    "mode",
    "target_ref",
    "baseline_ref",
    "profile",
    "repeat",
    "deep_profile",
    "live_openai_candidate",
    "fail_on_regression",
    "publish_reports",
    "kova_ref",
    "kova_config_contract",
    "dispatch_id",
  ]);
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
    expect(source).toContain(
      `if: \${{ needs.preflight.outputs.frozen_target != 'true' }}\n        run: |\n          bun openclaw.mjs --help`,
    );
    expect(source).toContain(
      "[skip] ${partId} is not declared by this checkout's legacy smoke plan",
    );
    expect(source).not.toContain('"control-ui-chat-flow-playwright",');
    expect(source).toContain("if (!source.includes(marker)) process.exit(0);");
  });
});
