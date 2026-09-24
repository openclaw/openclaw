import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";

export const CHECKOUT_V6 = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
export const CACHE_V5 = "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
export const CACHE_SAVE_V5 = "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
export const SETUP_GO_V6 = "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e";
export const UPLOAD_ARTIFACT_V7 =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
export const DOWNLOAD_ARTIFACT_V8 =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
export const MANTIS_GITHUB_APP_CLIENT_ID = "Iv23liPJCozR0uHm6P7G";
const SETUP_ANDROID_TOOLCHAIN_ACTION = ".github/actions/setup-android-toolchain/action.yml";
export const MATURITY_SCORECARD_WORKFLOW = ".github/workflows/maturity-scorecard.yml";
export const AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC =
  "::error title=ambiguous main push::github.event.before is zero; refusing to infer a diff base for a created or recreated main branch.";
export const testNodeExecPath = resolveTestNodeExecPath();
export const TSX_IMPORT = import.meta.resolve("tsx");

export type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

export const readCiWorkflow = (() => {
  // The checked-in workflow is fixed for this suite; clones keep fixture mutations local.
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  return () => structuredClone(workflow);
})();

export function evaluateWorkflowExpression(
  expression: unknown,
  context: {
    action?: string;
    actor?: string;
    githubEvent?: Record<string, unknown>;
    maintainerCommands?: string;
    // Runner routing keys off contributor trust, so pull-request cases default
    // to CONTRIBUTOR: same-repo PRs always come from someone with write access.
    authorAssociation?: string;
    cancelled?: boolean;
    dispatchId?: string;
    draft?: boolean;
    eventName:
      | "pull_request"
      | "pull_request_target"
      | "issue_comment"
      | "issues"
      | "push"
      | "workflow_dispatch"
      | "workflow_run"
      | "repository_dispatch"
      | "schedule";
    failed?: boolean;
    env?: Record<string, string>;
    frozenTarget?: boolean;
    fileHashes?: Record<string, string>;
    headRepository?: string;
    headSha?: string;
    hostedRunnerProfileContract?: boolean;
    matrix?: Record<string, unknown>;
    preflightOutputs?: Record<string, string>;
    additionalNeeds?: Record<string, { outputs: Record<string, string> }>;
    jobResults?: Record<string, string>;
    pullRequestNumber?: number;
    ref?: string;
    resolveTargetOutputs?: Record<string, string>;
    releaseGate?: boolean;
    releasePriorityRun?: string;
    releaseScope?: string;
    repository: string;
    runCheck?: boolean;
    runnerBackend?: "" | "blacksmith" | "github" | "hybrid" | "runson";
    requestedRunnerBackend?: "default" | "hybrid" | "runson";
    ciShape?: "default" | "main";
    ciOnPush?: string;
    includeAndroid?: boolean;
    runnerEnvironment?: "" | "github-hosted" | "self-hosted";
    runnerProfile?: "blacksmith" | "github" | "hybrid";
    runAttempt: number;
    runId?: number;
    runNumber?: number;
    sha?: string;
    steps?: Record<
      string,
      { outputs: Record<string, string>; outcome?: "success" | "failure" | "cancelled" | "skipped" }
    >;
    targetContextRef?: string;
    targetRef?: string;
    useGithubHostedRunners?: boolean;
    workflow?: string;
    workflowSha?: string;
    workflowToken?: string;
    workspace?: string;
  },
) {
  if (typeof expression !== "string") {
    throw new TypeError("workflow expression must be a string");
  }
  const match = expression.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u);
  if (!match) {
    throw new Error(`invalid workflow expression: ${expression}`);
  }
  const source = match[1];
  if (source === undefined) {
    throw new Error(`workflow expression has no body: ${expression}`);
  }
  // Actions permits dashes in property names; preserve quoted literals while
  // translating those accesses for the JavaScript fixture evaluator.
  const evaluableSource = source.replace(
    /'(?:[^']|'')*'|\.([A-Za-z_][\w-]*)/gu,
    (token: string, property: string | undefined) =>
      property?.includes("-") ? `[${JSON.stringify(property)}]` : token,
  );
  return runInNewContext(evaluableSource, {
    always: () => true,
    success: () => !context.failed && !context.cancelled,
    failure: () => context.failed ?? false,
    cancelled: () => context.cancelled ?? false,
    // GitHub expression builtins the runner-routing clauses use.
    contains: (haystack: unknown, needle: unknown) =>
      Array.isArray(haystack)
        ? haystack.includes(needle)
        : String(haystack).includes(String(needle)),
    endsWith: (value: unknown, suffix: unknown) =>
      String(value).toLowerCase().endsWith(String(suffix).toLowerCase()),
    fromJSON: (value: string) => JSON.parse(value) as unknown,
    format: (value: string, ...args: unknown[]) =>
      value.replace(/\{(\d+)\}/gu, (_match, index: string) => String(args[Number(index)])),
    hashFiles: (file: string) => context.fileHashes?.[file] ?? "",
    startsWith: (value: unknown, prefix: unknown) => String(value).startsWith(String(prefix)),
    toJson: (value: unknown) => JSON.stringify(value),
    toJSON: (value: unknown) => JSON.stringify(value),
    github: {
      actor: context.actor ?? "",
      event_name: context.eventName,
      repository: context.repository,
      ref: context.ref ?? "refs/heads/main",
      run_attempt: context.runAttempt,
      run_id: context.runId,
      run_number: context.runNumber,
      sha: context.sha,
      workflow: context.workflow,
      workflow_sha: context.workflowSha,
      workspace: context.workspace,
      token: context.workflowToken,
      event:
        context.githubEvent ??
        (context.headRepository || context.eventName === "pull_request"
          ? {
              action: context.action,
              pull_request: {
                author_association: context.authorAssociation ?? "CONTRIBUTOR",
                draft: context.draft ?? false,
                number: context.pullRequestNumber,
                head: {
                  sha: context.headSha,
                  repo: { full_name: context.headRepository ?? context.repository },
                },
              },
            }
          : {}),
    },
    inputs: {
      dispatch_id: context.dispatchId ?? "",
      runner_backend: context.requestedRunnerBackend ?? "default",
      ci_shape: context.ciShape ?? "default",
      include_android: context.includeAndroid ?? false,
      release_gate: context.releaseGate ?? false,
      release_scope: context.releaseScope ?? "full",
      target_context_ref: context.targetContextRef ?? "",
      target_ref: context.targetRef ?? "",
      use_github_hosted_runners: context.useGithubHostedRunners ?? false,
    },
    env: context.env ?? {},
    matrix: context.matrix ?? {},
    runner: { environment: context.runnerEnvironment ?? "" },
    steps: {
      runner_profile: { outputs: { node_runner_backend: "" } },
      qualification_dispatch: { outputs: { eligible: "false" } },
      ...context.steps,
    },
    needs: {
      ...context.additionalNeeds,
      resolve_target: { outputs: context.resolveTargetOutputs ?? {} },
      "checks-baseline-ratchets": {
        result: context.jobResults?.["checks-baseline-ratchets"] ?? "success",
      },
      preflight: {
        result: context.jobResults?.preflight ?? "success",
        outputs: {
          frozen_target: String(context.frozenTarget ?? false),
          hosted_runner_profile_contract: String(context.hostedRunnerProfileContract ?? true),
          run_check: String(context.runCheck ?? true),
          runner_profile: context.runnerProfile ?? context.runnerBackend ?? "blacksmith",
          ...context.preflightOutputs,
        },
      },
    },
    vars: {
      MAINTAINER_COMMAND_REACTIONS: context.maintainerCommands ?? "",
      OPENCLAW_CI_RUNNER_BACKEND: context.runnerBackend ?? "",
      OPENCLAW_CI_ON_PUSH: context.ciOnPush ?? "",
      OPENCLAW_RELEASE_PRIORITY_RUN: context.releasePriorityRun ?? "",
    },
  });
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

let linuxWorkflowBash: string | undefined;

export function runWorkflowShellScript(
  script: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; linuxWorkflow?: boolean; tempDir?: string },
) {
  const { linuxWorkflow, tempDir, ...spawnOptions } = options;
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-workflow-shell-"));
  const childTempDir = tempDir ?? root;
  try {
    let moduleIndex = 0;
    const rewritten = script
      .replace(
        /node (?:(--import tsx |"\$\{manifest_node_args\[@\]\}" ))?--input-type=module <<'([A-Z][A-Z0-9_]*)'\n([\s\S]*?)\n\2(?=\n|$)/gu,
        (_match, nodeOptions: string | undefined, _marker: string, body: string) => {
          // Keep scratch outside the checkout's compiler namespace. File-backed stdin
          // avoids Bash heredoc deadlocks and preserves the workflow's cwd-based imports.
          const modulePath = path.join(root, `module-${moduleIndex}.mjs`);
          moduleIndex += 1;
          writeFileSync(modulePath, `${body}\n`, "utf8");
          const loader =
            nodeOptions === "--import tsx "
              ? `--import ${quoteShell(TSX_IMPORT)} `
              : (nodeOptions ?? "");
          return `${quoteShell(testNodeExecPath)} ${loader}--input-type=module < ${quoteShell(modulePath)}`;
        },
      )
      .replaceAll(
        "manifest_node_args+=(--import tsx)",
        `manifest_node_args+=(--import ${quoteShell(TSX_IMPORT)})`,
      );
    const scriptPath = path.join(root, "run.sh");
    writeFileSync(scriptPath, rewritten.endsWith("\n") ? rewritten : `${rewritten}\n`, "utf8");
    const bash =
      linuxWorkflow && process.platform === "darwin"
        ? (linuxWorkflowBash ??= resolveWorkflowBash())
        : "bash";
    return spawnSync(bash, [scriptPath], {
      ...spawnOptions,
      encoding: "utf8",
      // Child caches and temporary artifacts share the fixture's cleanup owner.
      // Inheriting a huge host tsx cache makes startup depend on unrelated runs.
      env: {
        ...(options.env ?? process.env),
        TMPDIR: childTempDir,
        TMP: childTempDir,
        TEMP: childTempDir,
      },
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

export function readAndroidToolchainAction() {
  return parse(readFileSync(SETUP_ANDROID_TOOLCHAIN_ACTION, "utf8"));
}

export function readBuildArtifactsTestboxWorkflow() {
  return parse(readFileSync(".github/workflows/ci-build-artifacts-testbox.yml", "utf8"));
}

export function readMaturityScorecardWorkflow() {
  return parse(readFileSync(MATURITY_SCORECARD_WORKFLOW, "utf8"));
}

export function readReleaseChecksWorkflow() {
  return parse(readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"));
}

export function readWorkflow(filePath: string) {
  return parse(readFileSync(filePath, "utf8"));
}

export function readTrackedText(relativePath: string): string {
  if (existsSync(relativePath)) {
    return readFileSync(relativePath, "utf8");
  }
  return execFileSync("git", ["show", `:${relativePath}`], { encoding: "utf8" });
}

export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  chmodSync(filePath, 0o755);
}

export function readWorkflowOutputs(outputPath: string): Record<string, string> {
  if (!existsSync(outputPath)) {
    return {};
  }
  const output = readFileSync(outputPath, "utf8").trim();
  return output
    ? Object.fromEntries(
        output.split("\n").map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      )
    : {};
}
