// Openclaw Performance Workflow tests cover openclaw performance workflow script behavior.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateWorkloadDefinition } from "../../scripts/lib/node-cache-workload-inputs.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflow,
  evaluateWorkflowRunner,
  runWorkflowCommand,
} from "./ci-workflow.test-support.js";

const WORKFLOW = ".github/workflows/openclaw-performance.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Actual Ubuntu workflow bodies need POSIX paths; native Windows ownership is
// exercised by ci-platform-checkout, while static workflow contracts run everywhere.
const posixIt = it.skipIf(process.platform === "win32");

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
  "continue-on-error"?: boolean | string;
  "timeout-minutes"?: number;
};

type WorkflowJob = {
  concurrency?: { group: string; "cancel-in-progress": boolean; queue: string };
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  "timeout-minutes"?: number | string;
  steps?: WorkflowStep[];
  strategy?: {
    matrix?: {
      include?: Array<Record<string, string>>;
    };
  };
};

type Workflow = {
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<
        string,
        {
          default?: boolean | string;
          options?: string[];
          required?: boolean;
          type?: string;
        }
      >;
    };
  };
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function findStep(name: string, job = "kova"): WorkflowStep {
  const steps = readWorkflow().jobs?.[job]?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

function kovaMatrixEntries(): Array<Record<string, string>> {
  return readWorkflow().jobs?.kova?.strategy?.matrix?.include ?? [];
}

function runTargetMetadataResolution({
  schema,
  baseSchema,
  version = "2026.9.4",
  kovaRef = "",
  contract = "",
  mode = "",
}: {
  schema?: string;
  baseSchema?: string;
  version?: string;
  kovaRef?: string;
  contract?: string;
  mode?: string;
}) {
  const root = tempDirs.make("openclaw-kova-target-metadata-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  mkdirSync(join(root, "src/config"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "unselected.ts"), 'throw new Error("unselected source executed");\n');
  for (const [name, content] of [
    ["agent-defaults", schema],
    ["agent-defaults-base", baseSchema],
  ] as const) {
    if (content !== undefined) {
      writeFileSync(
        join(root, `src/config/zod-schema.${name}.ts`),
        `throw new Error("target metadata executed");\n${content}`,
      );
    }
  }
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "target metadata",
  );
  const sha = git("rev-parse", "HEAD");
  const checkout = findStep("Checkout target metadata", "resolve_target");
  execFileSync("git", ["sparse-checkout", "set", "--no-cone", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: checkout.with?.["sparse-checkout"],
  });
  expect(existsSync(join(root, "unselected.ts"))).toBe(false);
  expect(existsSync(join(root, "node_modules"))).toBe(false);
  const output = join(root, "output");
  const step = findStep("Resolve OpenClaw target ref", "resolve_target");
  const result = runWorkflowCommand("bash", ["-c", step.run ?? ""], {
    cwd: root,
    env: {
      ...process.env,
      ...readWorkflow().env,
      CI_GIT_OWNER: resolvePath(".github/actions/git-owner/owner.py"),
      GITHUB_OUTPUT: output,
      GITHUB_REF_NAME: "main",
      KOVA_REF_INPUT: kovaRef,
      KOVA_CONFIG_CONTRACT_INPUT: contract,
      PERFORMANCE_MODE: mode,
      TARGET_CHECKOUT_DIR: root,
      TARGET_REF_INPUT: "fixture-target",
    },
  });
  const outputs = Object.fromEntries(
    existsSync(output)
      ? readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2))
      : [],
  );
  return { outputs, result, sha };
}

function runCandidateTrustClassification({
  candidateSha,
  eventName,
  ref,
  workflowSha,
}: {
  candidateSha: string;
  eventName: "schedule" | "workflow_dispatch";
  ref: string;
  workflowSha: string;
}) {
  const step = findStep("Classify performance candidate trust", "resolve_target");
  const root = tempDirs.make("openclaw-performance-candidate-trust-");
  const output = join(root, "output");
  const result = runWorkflowCommand("bash", ["-c", step.run ?? ""], {
    env: {
      ...process.env,
      CANDIDATE_SHA: candidateSha,
      DEFAULT_BRANCH: "main",
      GITHUB_EVENT_NAME: eventName,
      GITHUB_OUTPUT: output,
      GITHUB_REF: ref,
      WORKFLOW_SHA: workflowSha,
    },
  });
  const outputs = Object.fromEntries(
    existsSync(output)
      ? readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          })
      : [],
  );
  return { outputs, result };
}

describe("OpenClaw performance workflow", () => {
  it("routes memory-cap dispatches to the delegated mock Gateway benchmark", () => {
    const job = "gateway_concurrency";
    const workflow = readWorkflow();
    expect(workflow.jobs?.[job]?.if).toContain("inputs.mode == 'gateway-memory-caps'");
    expect(workflow.jobs?.kova?.if).toContain("inputs.mode == 'kova'");
    expect(findStep("Set up Gateway concurrency environment", job).with?.["semantic-checks"]).toBe(
      "${{ inputs.mode == 'gateway-memory-caps' }}",
    );
    const caps = findStep("Run Gateway under 2 and 4 GiB caps", job);
    expect(caps.if).toBe("${{ inputs.mode == 'gateway-memory-caps' }}");
    expect(caps.run).toContain("for cap in 2 4");
    expect(caps.run).toContain("--property='Delegate=cpu memory'");
    expect(caps.run).toContain('--gateway-memory-gib "$cap"');
    expect(caps.run).not.toContain("--provider");
    expect(findStep("Run live Gateway concurrency", job).if).toContain(
      "inputs.mode == 'gateway-concurrency'",
    );
  });

  posixIt("admits only the mock lane for Gateway cold-turn calibration", () => {
    const root = tempDirs.make("openclaw-kova-calibration-");
    const mode = "gateway-cold-turn-calibration";
    const workflow = readWorkflow();
    const run = findStep("Calibrate Gateway cold-turn resources");
    const decide = (findStep("Decide lane").run ?? "")
      .replaceAll("${{ github.event_name }}", "workflow_dispatch")
      .replaceAll("${{ inputs.deep_profile || 'false' }}", "true")
      .replaceAll("${{ inputs.live_openai_candidate || 'false' }}", "true");

    for (const entry of kovaMatrixEntries()) {
      const lane = expectDefined(entry.lane, "Kova lane");
      const output = join(root, lane);
      const result = runWorkflowCommand("bash", ["-c", decide], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          LANE_ID: lane,
          PERFORMANCE_MODE: mode,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8").trim()).toBe(`run=${lane === "mock-provider"}`);
    }

    const context = {
      eventName: "workflow_dispatch",
      inputs: { mode, dispatch_id: "full-release-validation-calibration", publish_reports: true },
      releaseRunnerGroup: "release-only",
    } as const;
    for (const name of ["resolve_target", "kova"]) {
      expect(evaluateWorkflowRunner(workflow.jobs?.[name]?.["runs-on"], context)).toBe(
        "ubuntu-24.04",
      );
    }
    for (const name of ["publish", "source_performance", "seal_release_child_evidence"]) {
      expect(evaluateWorkflow(workflow.jobs?.[name]?.if, context)).toBe(false);
    }
    const { result, outputs, sha } = runTargetMetadataResolution({
      schema: "    imageGenerationModel: AgentToolModelSchema.optional(),",
      mode,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(outputs).toMatchObject({
      kova_ref: workflow.env?.KOVA_COLD_TURN_CALIBRATION_REF,
      kova_config_contract: "legacy-list",
      tested_sha: sha,
    });
    expect(outputs.kova_ref).toMatch(/^[0-9a-f]{40}$/u);
    expect(findStep("Run Kova").if).toContain(`inputs.mode != '${mode}'`);
    expect(run.if).toContain(`inputs.mode == '${mode}'`);
    expect(run.run).toContain('--target "local-build:$GITHUB_WORKSPACE"');
    expect(run.run).toContain(`--scenario ${mode} --state mock-openai-provider --auth mock`);
    expect(run.run).toContain("read-gateway-cold-turn-calibration.mjs");
  });

  it("keeps Vitest pair benchmarking opt-in and exact-head bound", () => {
    const workflow = readWorkflow();
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    const benchmark = workflow.jobs?.vitest_pair;
    const validation = findStep("Validate Vitest pair request", "vitest_pair");
    const helper = findStep("Checkout Vitest pair helper", "vitest_pair");
    const candidate = findStep("Checkout Vitest pair candidate", "vitest_pair");
    const baseline = findStep("Checkout Vitest pair baseline", "vitest_pair");
    const run = findStep("Run Vitest pair benchmark", "vitest_pair");
    const finalize = findStep("Finalize Vitest pair artifact", "vitest_pair");
    const upload = findStep("Upload Vitest pair artifact", "vitest_pair");

    expect(inputs?.mode).toMatchObject({
      default: "kova",
      required: false,
      type: "choice",
      options: [
        "kova",
        "vitest-pair",
        "node-cache-diagnostics",
        "node-cache-workload-qualification",
        "node-cache-qualified-measurement",
        "gateway-concurrency",
        "gateway-memory-caps",
        "gateway-cold-turn-calibration",
      ],
    });
    expect(inputs?.baseline_ref).toMatchObject({
      default: "",
      required: false,
      type: "string",
    });
    expect(benchmark?.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'vitest-pair' }}",
    );
    expect(evaluateWorkflowRunner(benchmark?.["runs-on"])).toBe("ubuntu-24.04");
    expect(benchmark?.["timeout-minutes"]).toBe(180);
    expect(benchmark?.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(benchmark)).not.toContain("secrets.");
    expect(JSON.stringify(benchmark)).not.toContain("cache-mode");
    expect(validation.run).toContain('[[ "$RUN_ATTEMPT" == "1" ]]');
    expect(validation.run).toContain('[[ "$BASELINE_REF" =~ ^[0-9a-f]{40}$ ]]');
    expect(validation.run).toContain('[[ "$TARGET_REF" =~ ^[0-9a-f]{40}$ ]]');
    expect(validation.run).toContain('[[ "$TARGET_REF" == "$WORKFLOW_SHA" ]]');
    for (const checkout of [helper, candidate, baseline]) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
      expect(checkout.with?.["fetch-depth"]).toBe(1);
    }
    expect(helper.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(candidate.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(baseline.with?.ref).toBe("${{ inputs.baseline_ref }}");
    expect(run.run).toContain("scripts/vitest-pair-benchmark.mts");
    expect(run.run).toContain("--baseline-sha");
    expect(run.run).toContain("--candidate-sha");
    expect(run.run).toContain('--scratch "$VITEST_PAIR_ROOT/scratch"');
    expect(finalize.if).toBe("${{ always() }}");
    expect(upload.if).toBe("${{ always() }}");
    expect(upload.with?.name).toBe("vitest-pair-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(upload.with?.name).not.toContain("inputs.");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.["retention-days"]).toBe(30);
  });

  it("isolates native cache diagnostics from live, publishing, and release jobs", () => {
    const workflow = readWorkflow();
    const context = {
      eventName: "workflow_dispatch",
      inputs: {
        mode: "node-cache-diagnostics",
        dispatch_id: "full-release-validation-cache-diagnostics",
        publish_reports: true,
        live_openai_candidate: true,
        deep_profile: true,
      },
      releaseRunnerGroup: "release-only",
    } as const;
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      expect(evaluateWorkflow(job.if, context), name).toBe(name === "node_cache_diagnostics");
    }
    const job = workflow.jobs?.node_cache_diagnostics;
    expect(job?.needs).toBeUndefined();
    expect(job?.env).toBeUndefined();
    expect(evaluateWorkflowRunner(job?.["runs-on"], context)).toBe("ubuntu-24.04");
    expect(job?.["timeout-minutes"]).toBe(5);
    expect(job?.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|pnpm|npm install|cache\/restore/u);
    const checkout = findStep("Checkout diagnostic helper", "node_cache_diagnostics");
    expect(checkout.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    const setup = findStep("Set up diagnostic Node", "node_cache_diagnostics");
    expect(setup.with).toEqual({
      "node-version": "24.22.1",
      "check-latest": false,
      "package-manager-cache": false,
    });
    const run = findStep("Qualify native Node cache diagnostics", "node_cache_diagnostics");
    expect(run.env).toEqual({
      NODE_CACHE_DIAGNOSTIC_OUTPUT: "${{ runner.temp }}/node-cache-diagnostics",
      TARGET_REF: "${{ inputs.target_ref }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(run.run).toContain('"$TARGET_REF" != "$WORKFLOW_SHA"');
    expect(run.run).toContain('"$(git rev-parse HEAD)" != "$WORKFLOW_SHA"');
    expect(run.run).toContain("--mode node-cache-diagnostics");
    const finalize = findStep("Finalize diagnostic artifact", "node_cache_diagnostics");
    const upload = findStep("Upload diagnostic artifact", "node_cache_diagnostics");
    expect(finalize.env?.NODE_CACHE_DIAGNOSTIC_OUTPUT).toBe(
      "${{ runner.temp }}/node-cache-diagnostics",
    );
    expect(finalize.if).toBe("${{ always() }}");
    expect(upload.if).toBe("${{ always() }}");
    expect(upload.with?.name).toBe(
      "node-cache-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.path).toBe("${{ runner.temp }}/node-cache-diagnostics");
    expect(upload.with?.["retention-days"]).toBe(30);
  });

  it.each(["node-cache-workload-qualification", "node-cache-qualified-measurement"])(
    "isolates %s from live, publishing, and release jobs",
    (mode) => {
      const workflow = readWorkflow();
      const context = {
        eventName: "workflow_dispatch",
        inputs: {
          mode,
          profile: "release",
          dispatch_id: "full-release-validation-workload-controls",
          publish_reports: true,
          live_openai_candidate: true,
          deep_profile: true,
        },
      } as const;
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        expect(evaluateWorkflow(job.if, context), name).toBe(name === "node_cache_workload");
      }
      const job = workflow.jobs?.node_cache_workload;
      expect(JSON.stringify(job?.env)).not.toMatch(/\brunner(?:\.|\[)/u);
      expect(evaluateWorkflow(job?.if, { eventName: "schedule" })).toBe(false);
      expect(job?.needs).toBeUndefined();
      expect(job?.permissions).toEqual({ contents: "read" });
      expect(job?.["runs-on"]).toBe("ubuntu-24.04");
      expect(evaluateWorkflow(job?.["timeout-minutes"], context)).toBe(
        mode === "node-cache-qualified-measurement" ? 240 : 75,
      );
      expect(JSON.stringify(job)).not.toMatch(/secrets\.|cache\/restore/u);
      for (const [name, minutes] of [
        ["Validate workload control request", 1],
        ["Checkout workload control harness", 5],
        ["Checkout fixed Node cache workload", 5],
        ["Set up workload control Node", 5],
        ["Record and verify workload control runtime", 2],
        ["Set up fixed workload pnpm", 5],
      ] as const) {
        expect(findStep(name, "node_cache_workload")["timeout-minutes"]).toBe(minutes);
      }
      for (const [name, ref] of [
        ["Checkout workload control harness", "${{ github.sha }}"],
        ["Checkout fixed Node cache workload", "8cfbac51a27a1195176a3564f6d7cfd7d6994c85"],
      ] as const) {
        expect(findStep(name, "node_cache_workload").with).toMatchObject({
          ref,
          "fetch-depth": 1,
          "persist-credentials": false,
        });
      }
      expect(findStep("Set up workload control Node", "node_cache_workload").with).toEqual({
        "node-version": "24.22.1",
        "check-latest": false,
        "package-manager-cache": false,
      });
      expect(
        findStep("Set up fixed workload pnpm", "node_cache_workload").with?.["cache-mode"],
      ).toBe("off");
      const run = findStep("Qualify prepared workload Node cache controls", "node_cache_workload");
      expect(run.run).toContain("--mode node-cache-workload-qualification");
      expect(run.run).toContain('--harness-sha "$NODE_CACHE_HARNESS_SHA"');
      expect(run.run).toContain('--timeout-ms "$timeout_ms" --run-attempt "$GITHUB_RUN_ATTEMPT"');
      const upload = findStep("Upload workload control artifact", "node_cache_workload");
      expect(upload.if).toBe("${{ always() }}");
      expect(upload.with?.path).toBe("${{ runner.temp }}/node-cache-workload-results");
    },
  );

  it("measures only successful controls before either artifact is finalized", () => {
    const steps = readWorkflow().jobs?.node_cache_workload?.steps ?? [];
    const measure = findStep("Measure qualified workload Node cache pairs", "node_cache_workload");
    const context = { inputs: { mode: "node-cache-qualified-measurement" } };
    expect(evaluateWorkflow(measure.if, context)).toBe(true);
    expect(evaluateWorkflow(measure.if, { ...context, failed: true })).toBe(false);
    expect(evaluateWorkflow(measure.if, { ...context, cancelled: true })).toBe(false);
    expect(
      evaluateWorkflow(measure.if, { inputs: { mode: "node-cache-workload-qualification" } }),
    ).toBe(false);
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    expect(index("Qualify prepared workload Node cache controls")).toBeLessThan(
      index("Measure qualified workload Node cache pairs"),
    );
    for (const kind of ["control", "measurement"]) {
      const finalize = findStep(`Finalize workload ${kind} artifact`, "node_cache_workload");
      const upload = findStep(`Upload workload ${kind} artifact`, "node_cache_workload");
      expect(index("Measure qualified workload Node cache pairs")).toBeLessThan(
        index(`Finalize workload ${kind} artifact`),
      );
      expect(evaluateWorkflow(finalize.if, { ...context, failed: true })).toBe(true);
      expect(evaluateWorkflow(upload.if, { ...context, failed: true })).toBe(true);
      expect(evaluateWorkflow(upload.if, { ...context, cancelled: true })).toBe(true);
    }
    const upload = findStep("Upload workload measurement artifact", "node_cache_workload");
    expect(upload.with).toMatchObject({
      name: "node-cache-measurement-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/node-cache-measurement-results",
      "if-no-files-found": "error",
      "include-hidden-files": true,
    });
    expect(
      evaluateWorkflow(upload.if, { inputs: { mode: "node-cache-workload-qualification" } }),
    ).toBe(false);
  });

  posixIt(
    "anchors preparation and work ceilings before checkout without creating measurement paths",
    () => {
      const root = tempDirs.make("node-cache-clock-");
      const githubEnv = join(root, "github-env");
      const validation = findStep("Validate workload control request", "node_cache_workload");
      const result = runWorkflowCommand(
        "bash",
        ["-c", `date() { printf '1000\n'; }\n${validation.run}`],
        {
          env: {
            ...process.env,
            GITHUB_RUN_ATTEMPT: "1",
            NODE_CACHE_HARNESS_SHA: "a".repeat(40),
            NODE_CACHE_MODE: "node-cache-qualified-measurement",
            TARGET_REF: "",
            GITHUB_ENV: githubEnv,
            RUNNER_TEMP: root,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const clock = JSON.parse(
        readFileSync(join(root, "node-cache-preparation/workflow-clock.json"), "utf8"),
      );
      expect(clock).toEqual({
        anchor: "first-owned-step",
        startedAtEpochSeconds: 1000,
        preparationDeadlineEpochSeconds: 3400,
        workDeadlineEpochSeconds: 14800,
      });
      const env = Object.fromEntries(
        readFileSync(githubEnv, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      expect(env.NODE_CACHE_PREPARATION_DEADLINE).toBe("3400");
      expect(env.NODE_CACHE_WORK_DEADLINE).toBe("14800");
      expect(env.NODE_CACHE_MEASUREMENT_OUTPUT).toBe(join(root, "node-cache-measurement-results"));
      expect(env.NODE_CACHE_MEASUREMENT_SCRATCH).toBe(join(root, "node-cache-measurement-scratch"));
      expect(existsSync(env.NODE_CACHE_MEASUREMENT_OUTPUT)).toBe(false);
      expect(existsSync(env.NODE_CACHE_MEASUREMENT_SCRATCH)).toBe(false);
    },
  );

  posixIt.each([
    [
      "Qualify prepared workload Node cache controls",
      "node-cache-workload-qualification",
      1000,
      1800000,
    ],
    [
      "Qualify prepared workload Node cache controls",
      "node-cache-qualified-measurement",
      2200,
      1199000,
    ],
    [
      "Measure qualified workload Node cache pairs",
      "node-cache-qualified-measurement",
      13000,
      9000000,
    ],
    [
      "Measure qualified workload Node cache pairs",
      "node-cache-qualified-measurement",
      2200,
      1199000,
    ],
  ] as const)(
    "caps %s for %s at the remaining work budget (%s)",
    (name, mode, deadline, expectedTimeout) => {
      const root = tempDirs.make("node-cache-phase-");
      const capture = join(root, "argv");
      const step = findStep(name, "node_cache_workload");
      const result = runWorkflowCommand(
        "bash",
        [
          "-c",
          `date() { printf '1000\n'; }\nnode() { printf '%s\n' "$@" > "$CAPTURE"; }\n${step.run}`,
        ],
        {
          env: {
            ...process.env,
            NODE_CACHE_MODE: mode,
            NODE_CACHE_WORK_DEADLINE: String(deadline),
            NODE_CACHE_HARNESS: join(root, "harness"),
            NODE_CACHE_WORKLOAD: join(root, "workload"),
            NODE_CACHE_HARNESS_SHA: "a".repeat(40),
            NODE_CACHE_PNPM: join(root, "pnpm"),
            NODE_CACHE_OUTPUT: join(root, "controls"),
            NODE_CACHE_SCRATCH: join(root, "control-scratch"),
            NODE_CACHE_MEASUREMENT_OUTPUT: join(root, "measurements"),
            NODE_CACHE_MEASUREMENT_SCRATCH: join(root, "measurement-scratch"),
            GITHUB_RUN_ATTEMPT: "1",
            CAPTURE: capture,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const argv = readFileSync(capture, "utf8").trim().split("\n");
      expect(argv[0]).toBe(join(root, "harness/scripts/vitest-pair-benchmark.mts"));
      const args = Object.fromEntries(
        Array.from({ length: (argv.length - 1) / 2 }, (_, i) => [argv[1 + i * 2], argv[2 + i * 2]]),
      );
      expect(args).toMatchObject({
        "--definition": join(root, "harness/scripts/node-cache-workload-definition.json"),
        "--workload": join(root, "workload"),
        "--harness-sha": "a".repeat(40),
        "--pnpm-bin": join(root, "pnpm"),
        "--timeout-ms": String(expectedTimeout),
        "--run-attempt": "1",
      });
      if (name.startsWith("Measure")) {
        expect(args).toMatchObject({
          "--mode": "node-cache-qualified-measurement",
          "--qualification": join(root, "controls"),
          "--output": join(root, "measurements"),
          "--scratch": join(root, "measurement-scratch"),
        });
        expect(args).not.toHaveProperty("--seed");
        expect(args).not.toHaveProperty("--manifest");
      } else {
        expect(args).toMatchObject({
          "--mode": "node-cache-workload-qualification",
          "--output": join(root, "controls"),
          "--scratch": join(root, "control-scratch"),
        });
      }
    },
  );

  posixIt.each([
    "Prepare fixed workload dependencies and generated types",
    "Qualify prepared workload Node cache controls",
    "Measure qualified workload Node cache pairs",
  ])("rejects exhausted %s before starting a command", (name) => {
    const step = findStep(name, "node_cache_workload");
    const result = runWorkflowCommand(
      "bash",
      [
        "-c",
        `date() { printf '1000\n'; }\nnode() { echo unexpected-command; }\ngit() { echo unexpected-command; }\n${step.run}`,
      ],
      {
        env: {
          ...process.env,
          NODE_CACHE_MODE: "node-cache-qualified-measurement",
          NODE_CACHE_WORK_DEADLINE: "1000",
          NODE_CACHE_PREPARATION_DEADLINE: "1000",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("budget exhausted");
    expect(result.stdout).not.toContain("unexpected-command");
  });

  posixIt.each([
    [0, 1000, 0],
    [7, 1000, 7],
    [0, 1600, 1],
  ] as const)(
    "bounds installer and Kysely together with exit %s and finish time %s",
    (installExit, finishedAt, expectedExit) => {
      const root = tempDirs.make("node-cache-preparation-");
      const clock = join(root, "clock");
      writeFileSync(clock, "1000\n");
      const bin = join(root, "bin");
      const workload = join(root, "workload");
      const corepack = join(root, "corepack");
      const native = join(corepack, "v1/pnpm/12.15.0/node_modules/@pnpm/exe.linux-x64");
      mkdirSync(bin);
      mkdirSync(native, { recursive: true });
      mkdirSync(join(workload, ".github/actions/setup-node-env"), { recursive: true });
      const executable = (file: string, body: string) => {
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
      };
      executable(join(native, "pnpm"), "exit 99");
      executable(
        join(bin, "git"),
        `case "$2" in *workload) echo 8cfbac51a27a1195176a3564f6d7cfd7d6994c85;; *) echo ${"a".repeat(40)};; esac`,
      );
      executable(
        join(bin, "node"),
        `test -f '${root}/timeout-active' || exit 43\nprintf 'kysely\n' >> '${root}/events'`,
      );
      executable(
        join(bin, "timeout"),
        `printf '%s\n' "$1" "$2" "$3" > '${root}/timeout-args'\nshift 3\ntouch '${root}/timeout-active'\n"$@"\nstatus=$?\nprintf '${finishedAt}\n' > '${clock}'\nrm '${root}/timeout-active'\nexit "$status"`,
      );
      writeFileSync(
        join(workload, ".github/actions/setup-node-env/install-dependencies.sh"),
        `printf 'install\n' >> '${root}/events'\nexit ${installExit}\n`,
      );
      const step = findStep(
        "Prepare fixed workload dependencies and generated types",
        "node_cache_workload",
      );
      const result = runWorkflowCommand("bash", ["-c", `date() { cat '${clock}'; }\n${step.run}`], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          COREPACK_HOME: corepack,
          NODE_CACHE_MODE: "node-cache-qualified-measurement",
          NODE_CACHE_PREPARATION_DEADLINE: "1600",
          NODE_CACHE_WORK_DEADLINE: "14800",
          NODE_CACHE_HARNESS: join(root, "harness"),
          NODE_CACHE_HARNESS_SHA: "a".repeat(40),
          NODE_CACHE_WORKLOAD: workload,
          NODE_CACHE_PREPARATION: join(root, "preparation"),
          PNPM_CONFIG_STORE_DIR: join(root, "store"),
          PNPM_CONFIG_CACHE_DIR: join(root, "cache"),
          GITHUB_ENV: join(root, "github-env"),
        },
      });
      expect(result.status, result.stderr).toBe(expectedExit);
      expect(existsSync(join(root, "github-env"))).toBe(expectedExit === 0);
      expect(readFileSync(join(root, "timeout-args"), "utf8")).toBe(
        "--signal=TERM\n--kill-after=30s\n570s\n",
      );
      expect(readFileSync(join(root, "events"), "utf8")).toBe(
        installExit === 0 ? "install\nkysely\n" : "install\n",
      );
    },
  );

  posixIt.each([true, false])(
    "preserves measurement terminal evidence when present=%s",
    (present) => {
      const root = tempDirs.make("node-cache-measurement-finalize-");
      const output = join(root, "measurements");
      mkdirSync(output);
      const terminal = '{"status":"failure","error":"original measurement failure"}\n';
      if (present) {
        writeFileSync(join(output, "terminal-manifest.json"), terminal);
      }
      const finalize = findStep("Finalize workload measurement artifact", "node_cache_workload");
      const result = runWorkflowCommand("bash", ["-c", finalize.run ?? ""], {
        env: { ...process.env, NODE_CACHE_MEASUREMENT_OUTPUT: output, JOB_STATUS: "failure" },
      });
      expect(result.status, result.stderr).toBe(0);
      const retained = readFileSync(join(output, "terminal-manifest.json"), "utf8");
      if (present) {
        expect(retained).toBe(terminal);
      } else {
        expect(JSON.parse(retained)).toEqual({
          version: 1,
          status: "failure",
          phase: "workflow",
          jobStatus: "failure",
        });
      }
    },
  );

  it("keeps the fixed workload definition public and independently pinned", () => {
    const raw = JSON.parse(readFileSync("scripts/node-cache-workload-definition.json", "utf8"));
    expect(raw).toEqual(validateWorkloadDefinition(raw));
    expect(raw.workloadSha).toBe("8cfbac51a27a1195176a3564f6d7cfd7d6994c85");
    expect(raw.workloadTree).toBe("d2ac3496b32ec041292ec25b188b670e6f0cf460");
    expect(raw.expected).toHaveLength(20);
    expect(raw.sourceIdentities).toHaveLength(5);
    expect(raw).not.toHaveProperty("oracleProvenance");
  });

  posixIt.each(["2", "1"])(
    "rejects an invalid workload request before setup (attempt %s)",
    (attempt) => {
      const validation = findStep("Validate workload control request", "node_cache_workload");
      const root = tempDirs.make("node-cache-request-");
      const githubEnv = join(root, "github-env");
      const result = runWorkflowCommand("bash", ["-c", validation.run ?? ""], {
        env: {
          ...process.env,
          GITHUB_RUN_ATTEMPT: attempt,
          NODE_CACHE_HARNESS_SHA: "a".repeat(40),
          TARGET_REF: "b".repeat(40),
          GITHUB_ENV: githubEnv,
          RUNNER_TEMP: root,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(attempt === "2" ? "fresh run" : "target_ref");
      expect(existsSync(githubEnv)).toBe(false);
    },
  );

  posixIt(
    "retains the observed runtime fingerprint before rejecting a fixed-runtime mismatch",
    () => {
      const root = tempDirs.make("node-cache-runtime-");
      mkdirSync(join(root, "scripts"));
      writeFileSync(
        join(root, "scripts/node-cache-workload-definition.json"),
        JSON.stringify({ runtime: { node: "v0.0.0" } }),
      );
      const prep = join(root, "preparation");
      const record = findStep("Record and verify workload control runtime", "node_cache_workload");
      const result = runWorkflowCommand("bash", ["-c", record.run ?? ""], {
        env: { ...process.env, NODE_CACHE_HARNESS: root, NODE_CACHE_PREPARATION: prep },
      });
      expect(result.status).toBe(1);
      const actual = JSON.parse(readFileSync(join(prep, "runtime.json"), "utf8"));
      expect(actual).toMatchObject({
        node: expect.stringMatching(/^v\d+/u),
        v8: expect.any(String),
        platform: expect.any(String),
        architecture: expect.any(String),
        executableSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      const log = readFileSync(join(prep, "runtime.log"), "utf8");
      expect(log).toContain(JSON.stringify(actual));
      expect(log).toContain("Hosted Node runtime differs from the fixed workload definition");
    },
  );

  posixIt.each([true, false])("preserves workload terminal evidence when present=%s", (present) => {
    const root = tempDirs.make("node-cache-workflow-finalize-");
    const output = join(root, "results");
    const prep = join(root, "preparation");
    mkdirSync(output);
    mkdirSync(prep);
    const terminal = '{"status":"failure","error":"original control failure"}\n';
    if (present) {
      writeFileSync(join(output, "terminal-manifest.json"), terminal);
    }
    writeFileSync(join(prep, "install.log"), "preparation evidence\n");
    writeFileSync(join(prep, "runtime.json"), '{"node":"observed-runtime"}\n');
    const finalize = findStep("Finalize workload control artifact", "node_cache_workload");
    expect(finalize.if).toBe("${{ always() }}");
    expect(finalize.env).toMatchObject({
      NODE_CACHE_PREPARATION: "${{ runner.temp }}/node-cache-preparation",
      NODE_CACHE_OUTPUT: "${{ runner.temp }}/node-cache-workload-results",
    });
    const result = runWorkflowCommand("bash", ["-c", finalize.run ?? ""], {
      env: {
        ...process.env,
        NODE_CACHE_OUTPUT: output,
        NODE_CACHE_PREPARATION: prep,
        JOB_STATUS: "failure",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const retained = readFileSync(join(output, "terminal-manifest.json"), "utf8");
    if (present) {
      expect(retained).toBe(terminal);
    } else {
      expect(JSON.parse(retained)).toMatchObject({
        status: "failure",
        phase: "workflow",
        jobStatus: "failure",
      });
    }
    expect(readFileSync(join(output, "preparation.log"), "utf8")).toBe("preparation evidence\n");
    expect(readFileSync(join(output, "runtime.json"), "utf8")).toBe(
      '{"node":"observed-runtime"}\n',
    );
  });

  posixIt("refuses a mismatched diagnostic target before running Node", () => {
    const root = tempDirs.make("node-cache-diagnostic-target-");
    const marker = join(root, "node-ran");
    writeFileSync(join(root, "node"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(root, "node"), 0o755);
    const run = findStep("Qualify native Node cache diagnostics", "node_cache_diagnostics");
    const result = runWorkflowCommand("bash", ["-c", run.run ?? ""], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        TARGET_REF: "a".repeat(40),
        WORKFLOW_SHA: "b".repeat(40),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("requires the exact workflow checkout and target_ref");
    expect(existsSync(marker)).toBe(false);
  });

  posixIt("retains a terminal manifest when slash-containing refs fail validation", () => {
    const validation = findStep("Validate Vitest pair request", "vitest_pair");
    const root = tempDirs.make("vitest-pair-invalid-ref-");
    const output = join(root, "results");
    mkdirSync(output);
    const target = "a".repeat(40);
    const result = runWorkflowCommand("bash", ["-c", validation.run ?? ""], {
      env: {
        ...process.env,
        BASELINE_REF: "refs/heads/main",
        RUN_ATTEMPT: "1",
        TARGET_REF: target,
        VITEST_PAIR_OUTPUT: output,
        WORKFLOW_SHA: target,
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(join(output, "terminal-manifest.json"), "utf8"))).toMatchObject({
      status: "failure",
      phase: "input-validation",
      error: "baseline_ref must be an exact lowercase 40-character SHA",
    });
  });

  it("fully isolates Vitest pair mode from Kova and publication", () => {
    const jobs = readWorkflow().jobs;
    const guard = jobs?.vitest_pair_guard;
    const verify = findStep("Verify isolated Vitest pair result", "vitest_pair_guard");

    expect(jobs?.resolve_target?.if).toContain("inputs.mode != 'vitest-pair'");
    for (const name of ["kova", "source_performance", "publish", "artifact_only_guard"] as const) {
      expect(jobs?.[name]?.if).toContain("inputs.mode == 'kova'");
    }
    expect(guard?.needs).toEqual([
      "resolve_target",
      "kova",
      "source_performance",
      "publish",
      "artifact_only_guard",
      "vitest_pair",
    ]);
    expect(guard?.permissions).toEqual({ contents: "read" });
    expect(verify.run).toContain('"$result" != "skipped"');
    expect(verify.run).toContain('"$VITEST_PAIR_RESULT" != "success"');
  });

  it("pins the Kova evaluator with release validation contracts", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const canonicalKovaRef = "5f1ac692af2058217c793aa06af9e28dbf46c1bd";
    const legacyKovaRef = "d69b2209905195bea06980721a92ad8b70808c5d";
    const trustedLiveKovaRef = "5f1ac692af2058217c793aa06af9e28dbf46c1bd";
    const install = findStep("Install OCM and Kova");
    const installRun = install.run ?? "";
    const targetCheckout = findStep("Checkout target metadata", "resolve_target");
    const resolveTarget = findStep("Resolve OpenClaw target ref", "resolve_target");

    expect(workflow).toContain(`KOVA_CANONICAL_CONFIG_REF: ${canonicalKovaRef}`);
    expect(workflow).toContain(`KOVA_LEGACY_LIST_CONFIG_REF: ${legacyKovaRef}`);
    expect(workflow).toContain(`KOVA_TRUSTED_LIVE_REF: ${trustedLiveKovaRef}`);
    expect(workflow).toContain("kova_config_contract:");
    expect(workflow).toContain("Optional fixture-contract override for a custom Kova ref");
    expect(readWorkflow().jobs?.resolve_target?.outputs?.kova_ref).toBe(
      "${{ steps.resolve.outputs.kova_ref }}",
    );
    expect(readWorkflow().jobs?.resolve_target?.outputs?.kova_config_contract).toBe(
      "${{ steps.resolve.outputs.kova_config_contract }}",
    );
    expect(readWorkflow().jobs?.resolve_target?.outputs?.kova_ref_trusted_for_live).toBe(
      "${{ steps.resolve.outputs.kova_ref_trusted_for_live }}",
    );
    expect(resolveTarget.env?.KOVA_REF_INPUT).toBe("${{ inputs.kova_ref }}");
    expect(resolveTarget.env?.KOVA_CONFIG_CONTRACT_INPUT).toBe(
      "${{ inputs.kova_config_contract }}",
    );
    expect(targetCheckout.with?.["sparse-checkout"]).toBe(
      "package.json\nsrc/config/zod-schema.agent-defaults.ts\nsrc/config/zod-schema.agent-defaults-base.ts\n",
    );
    expect(readWorkflow().jobs?.kova?.env?.KOVA_REF).toBe(
      "${{ needs.resolve_target.outputs.kova_ref }}",
    );
    expect(readWorkflow().jobs?.kova?.env?.KOVA_OPENCLAW_CONFIG_CONTRACT).toBe(
      "${{ needs.resolve_target.outputs.kova_config_contract }}",
    );
    expect(readWorkflow().jobs?.kova?.env?.KOVA_REF_TRUSTED_FOR_LIVE).toBe(
      "${{ needs.resolve_target.outputs.kova_ref_trusted_for_live }}",
    );
    expect(installRun).toContain(
      'npm --prefix "$KOVA_SRC" ci --ignore-scripts --no-audit --no-fund',
    );
    expect(installRun).toContain('require.resolve("mock-ai-provider/package.json", {');
    expect(installRun).toContain('packageJson.bin?.["mock-ai-provider"]');
    expect(installRun).toContain('path.join(root, "node_modules", ".bin", "mock-ai-provider")');
    expect(installRun).toContain("fs.constants.X_OK");
    expect(installRun).toContain('require.resolve("zod", { paths: [root] })');
    expect(installRun).not.toContain('require.resolve("mock-ai-provider",');
    expect(
      installRun.indexOf('npm --prefix "$KOVA_SRC" ci --ignore-scripts --no-audit --no-fund'),
    ).toBeLessThan(installRun.indexOf('cat > "$HOME/.local/bin/kova"'));
    expect(workflow).toContain("PERFORMANCE_MODEL_ID: gpt-5.6");
    expect(workflow).toContain(
      "KOVA_SCENARIO_TIMEOUT_MS: ${{ inputs.profile == 'release' && '900000' || '300000' }}",
    );
    expect(workflow).toContain("Kova live OpenAI GPT 5.6 agent turn");
  });

  describe("target metadata layouts", () => {
    const canonical = "    mediaModels: z\n";
    const legacy = "    imageGenerationModel: AgentToolModelSchema.optional(),\n";
    const linked = [
      'import { AgentDefaultsBaseSchema } from "./zod-schema.agent-defaults-base.js";',
      "export const AgentDefaultsSchema = AgentDefaultsBaseSchema.safeExtend({",
      "});",
      "",
    ].join("\n");
    const unknown = "export const AgentDefaultsSchema = z.object({});\n";
    const cases = [
      { name: "inline canonical", schema: canonical, expectedContract: "canonical" },
      { name: "inline legacy", schema: legacy, expectedContract: "legacy-list" },
      {
        name: "linked split canonical",
        schema: linked,
        baseSchema: canonical,
        expectedContract: "canonical",
      },
      {
        name: "legacy wrapper before conflicting canonical base",
        schema: linked + legacy,
        baseSchema: canonical,
        expectedContract: "legacy-list",
      },
      {
        name: "canonical wrapper before conflicting legacy base",
        schema: linked + canonical,
        baseSchema: legacy,
        expectedContract: "canonical",
      },
      { name: "missing wrapper", baseSchema: canonical, error: "Unable to inspect" },
      { name: "missing linked base", schema: linked, error: "Unable to inspect" },
      {
        name: "unrecognized linked base",
        schema: linked,
        baseSchema: unknown,
        error: "no recognized",
      },
      {
        name: "dormant base beside unknown wrapper",
        schema: unknown,
        baseSchema: canonical,
        error: "no recognized",
      },
      {
        name: "imported but unused base",
        schema: linked.split("\n")[0] + "\n" + unknown,
        baseSchema: canonical,
        error: "no recognized",
      },
      {
        name: "different imported base",
        schema: linked.replace("./zod-schema.agent-defaults-base.js", "./other.js"),
        baseSchema: canonical,
        error: "no recognized",
      },
      {
        name: "custom ref with missing linked base",
        schema: linked,
        kovaRef: "custom-producer",
        expectedContract: "",
      },
      {
        name: "custom ref and contract without metadata",
        kovaRef: "custom-producer",
        contract: "custom-contract",
        expectedContract: "custom-contract",
      },
      {
        name: "explicit contract with default ref",
        schema: linked,
        baseSchema: canonical,
        contract: "custom-contract",
        expectedContract: "custom-contract",
      },
    ];
    posixIt.each(cases)("resolves $name without executing target metadata", (fixture) => {
      const { outputs, result, sha } = runTargetMetadataResolution(fixture);
      if (fixture.error) {
        expect(result.status, result.stderr + result.stdout).toBe(1);
        expect(result.stdout).toContain(fixture.error);
        expect(result.stdout).toContain("Kova config-fixture contract");
        expect(outputs).toEqual({});
        return;
      }
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const defaultRef =
        fixture.expectedContract === "legacy-list"
          ? readWorkflow().env?.KOVA_LEGACY_LIST_CONFIG_REF
          : readWorkflow().env?.KOVA_CANONICAL_CONFIG_REF;
      const expectedRef = fixture.kovaRef ?? defaultRef;
      expect(outputs).toEqual({
        checkout_ref: sha,
        tested_ref: "fixture-target",
        tested_sha: sha,
        kova_ref: expectedRef,
        kova_config_contract: fixture.expectedContract,
        kova_ref_trusted_for_live: String(
          expectedRef === readWorkflow().env?.KOVA_TRUSTED_LIVE_REF,
        ),
      });
    });

    posixIt("resolves the checked-in schema from sparse committed metadata", () => {
      const { outputs, result, sha } = runTargetMetadataResolution({
        schema: readFileSync("src/config/zod-schema.agent-defaults.ts", "utf8"),
        baseSchema: readFileSync("src/config/zod-schema.agent-defaults-base.ts", "utf8"),
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(outputs).toMatchObject({
        checkout_ref: sha,
        tested_sha: sha,
        kova_ref: "5f1ac692af2058217c793aa06af9e28dbf46c1bd",
        kova_config_contract: "canonical",
      });
    });
  });

  it("keeps live credentials away from custom Kova refs", () => {
    const resolveTarget = findStep("Resolve OpenClaw target ref", "resolve_target");
    const decideLane = findStep("Decide lane");
    const configureLiveAuth = findStep("Configure live OpenAI auth");
    const runKova = findStep("Run Kova");
    const root = mkdtempSync(join(realpathSync(tmpdir()), "openclaw-kova-live-ref-"));
    const trustedRef = "1fe2f4081877bb12b7f7ed355349f98b8a0a6882";
    const compatibleUntrustedRef = "0f9e678e239b45db46d2bd930b7983203580df78";
    const decideLaneRun = (decideLane.run ?? "")
      .replaceAll("${{ github.event_name }}", "workflow_dispatch")
      .replaceAll("${{ inputs.deep_profile || 'false' }}", "false")
      .replaceAll("${{ inputs.live_openai_candidate || 'false' }}", "true");

    const runBoundary = (kovaRef: string, name: string) => {
      const resolveOutput = join(root, `${name}-resolve-output`);
      const laneOutput = join(root, `${name}-lane-output`);
      const resolve = runWorkflowCommand("bash", ["-c", resolveTarget.run ?? ""], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: resolveOutput,
          GITHUB_REF_NAME: "fix/kova-runtime-major-baseline",
          KOVA_CANONICAL_CONFIG_REF: compatibleUntrustedRef,
          KOVA_CONFIG_CONTRACT_INPUT: "canonical",
          KOVA_LEGACY_LIST_CONFIG_REF: compatibleUntrustedRef,
          KOVA_REF_INPUT: kovaRef,
          KOVA_TRUSTED_LIVE_REF: trustedRef,
          TARGET_CHECKOUT_DIR: process.cwd(),
          CI_GIT_OWNER: resolvePath(".github/actions/git-owner/owner.py"),
          TARGET_REF_INPUT: "test-head",
        },
      });
      expect(resolve.status, resolve.stderr).toBe(0);
      const resolved = Object.fromEntries(
        readFileSync(resolveOutput, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2)),
      );
      const lane = runWorkflowCommand("bash", ["-c", decideLaneRun], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: laneOutput,
          GITHUB_STEP_SUMMARY: join(root, `${name}-summary`),
          KOVA_REF_TRUSTED_FOR_LIVE: resolved.kova_ref_trusted_for_live,
          LANE_ID: "live-openai-candidate",
          SECRET_ELIGIBLE: "true",
        },
      });
      return { lane, laneOutput, resolved };
    };

    expect(configureLiveAuth.if).toBe(
      "${{ steps.lane.outputs.run == 'true' && matrix.live == 'true' && needs.resolve_target.outputs.secret_eligible == 'true' }}",
    );
    expect(runKova.env?.OPENAI_API_KEY).toBe(
      "${{ matrix.live == 'true' && needs.resolve_target.outputs.secret_eligible == 'true' && secrets.OPENAI_API_KEY || '' }}",
    );
    expect(runKova.env?.OPENAI_BASE_URL).toBe(
      "${{ matrix.live == 'true' && needs.resolve_target.outputs.secret_eligible == 'true' && secrets.OPENAI_BASE_URL || '' }}",
    );

    try {
      const rejected = runBoundary(compatibleUntrustedRef, "untrusted");
      expect(rejected.resolved.kova_ref_trusted_for_live).toBe("false");
      expect(rejected.lane.status).toBe(1);
      expect(rejected.lane.stdout).toContain(
        "The live OpenAI lane only executes a reviewed immutable Kova default.",
      );
      expect(existsSync(rejected.laneOutput)).toBe(false);

      const accepted = runBoundary(trustedRef, "trusted");
      expect(accepted.resolved.kova_ref_trusted_for_live).toBe("true");
      expect(accepted.lane.status).toBe(0);
      expect(readFileSync(accepted.laneOutput, "utf8")).toContain("run=true\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps arbitrary performance candidates secretless and cacheless", () => {
    const workflow = readWorkflow();
    const trust = findStep("Classify performance candidate trust", "resolve_target");
    const decideLane = findStep("Decide lane");
    const kovaHarness = findStep("Checkout performance workflow helpers");
    const kovaStage = findStep("Stage trusted setup action graph");
    const kovaSetup = findStep("Set up Node environment");
    const sourceHarness = findStep("Checkout source performance helpers", "source_performance");
    const sourceStage = findStep("Stage trusted source setup action graph", "source_performance");
    const sourceSetup = findStep("Set up source performance environment", "source_performance");
    const publisherHarness = findStep("Checkout performance publisher helper", "publish");

    expect(workflow.jobs?.resolve_target?.outputs).toMatchObject({
      secret_eligible: "${{ steps.candidate_trust.outputs.secret_eligible }}",
      cache_write_allowed: "${{ steps.candidate_trust.outputs.cache_write_allowed }}",
    });
    expect(trust.env).toMatchObject({
      CANDIDATE_SHA: "${{ steps.resolve.outputs.tested_sha }}",
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });

    for (const harness of [kovaHarness, sourceHarness, publisherHarness]) {
      expect(harness.with?.ref).toBe("${{ github.workflow_sha }}");
      expect(harness.with?.["persist-credentials"]).toBe(false);
    }
    for (const setup of [kovaSetup, sourceSetup]) {
      expect(setup.uses).toBe("./.artifacts/performance-workflow/.github/actions/setup-node-env");
      expect(setup.with?.["cache-mode"]).toBe(
        "${{ needs.resolve_target.outputs.cache_write_allowed == 'true' && 'restore' || 'off' }}",
      );
    }
    const kovaSteps = workflow.jobs?.kova?.steps ?? [];
    const sourceSteps = workflow.jobs?.source_performance?.steps ?? [];
    expect(kovaSteps.findIndex((step) => step.name === kovaStage.name)).toBeLessThan(
      kovaSteps.findIndex((step) => step.name === kovaSetup.name),
    );
    expect(sourceSteps.findIndex((step) => step.name === sourceStage.name)).toBeLessThan(
      sourceSteps.findIndex((step) => step.name === sourceSetup.name),
    );
    expect(decideLane.run).toContain(
      'if [[ "$LANE_ID" == "live-openai-candidate" && "$run_lane" == "true" && "$SECRET_ELIGIBLE" != "true" ]]; then',
    );
    expect(decideLane.run).toContain('reason="candidate is not eligible for live credentials"');

    const trustedSha = "a".repeat(40);
    for (const eventName of ["schedule", "workflow_dispatch"] as const) {
      const trusted = runCandidateTrustClassification({
        candidateSha: trustedSha,
        eventName,
        ref: "refs/heads/main",
        workflowSha: trustedSha,
      });
      expect(trusted.result.status, trusted.result.stderr).toBe(0);
      expect(trusted.outputs).toEqual({
        secret_eligible: "true",
        cache_write_allowed: "true",
      });
    }

    for (const candidate of [
      {
        candidateSha: "b".repeat(40),
        eventName: "workflow_dispatch" as const,
        ref: "refs/heads/main",
        workflowSha: trustedSha,
      },
      {
        candidateSha: trustedSha,
        eventName: "workflow_dispatch" as const,
        ref: "refs/heads/release/2026.8.1",
        workflowSha: trustedSha,
      },
    ]) {
      const untrusted = runCandidateTrustClassification(candidate);
      expect(untrusted.result.status, untrusted.result.stderr).toBe(0);
      expect(untrusted.outputs).toEqual({
        secret_eligible: "false",
        cache_write_allowed: "false",
      });
    }
  });

  it("replaces candidate-owned nested setup actions with the trusted workflow copy", () => {
    const stages = [
      findStep("Stage trusted setup action graph"),
      findStep("Stage trusted source setup action graph", "source_performance"),
    ];

    for (const stage of stages) {
      const root = tempDirs.make("openclaw-performance-action-graph-");
      const workspace = join(root, "candidate");
      const helper = join(root, "workflow");
      const candidateAction = join(workspace, ".github/actions/setup-pnpm-store-cache/action.yml");
      const candidateEnsureNode = join(
        workspace,
        ".github/actions/setup-pnpm-store-cache/ensure-node.sh",
      );
      const trustedAction = join(helper, ".github/actions/setup-pnpm-store-cache/action.yml");
      const trustedEnsureNode = join(
        helper,
        ".github/actions/setup-pnpm-store-cache/ensure-node.sh",
      );
      mkdirSync(join(workspace, ".github/actions/setup-pnpm-store-cache"), {
        recursive: true,
      });
      mkdirSync(join(helper, ".github/actions/setup-pnpm-store-cache"), {
        recursive: true,
      });
      writeFileSync(candidateAction, "candidate action\n");
      writeFileSync(candidateEnsureNode, "candidate script\n");
      writeFileSync(trustedAction, "trusted action\n");
      writeFileSync(trustedEnsureNode, "trusted script\n");

      const result = runWorkflowCommand("bash", ["-c", stage.run ?? ""], {
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          PERFORMANCE_HELPER_DIR: helper,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(candidateAction, "utf8")).toBe("trusted action\n");
      expect(readFileSync(candidateEnsureNode, "utf8")).toBe("trusted script\n");
    }
  });

  it("pins the OCM release archive and checksum", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const installRun = findStep("Install OCM and Kova").run ?? "";

    expect(workflow).toContain("OCM_VERSION: v0.3.10");
    expect(workflow).toContain(
      "OCM_LINUX_X64_SHA256: 78700755a592aeaf74915ad31addff60fd4a606d767d38b7ddc90411444c3479",
    );
    expect(installRun).toContain(
      '"https://github.com/openclaw/ocm/releases/download/${OCM_VERSION}/ocm-x86_64-unknown-linux-gnu.tar.gz"',
    );
    expect(installRun).toContain("--max-time 180");
    expect(installRun).toContain(
      "--retry 8 --retry-max-time 180 --retry-all-errors --retry-connrefused",
    );
    expect(installRun).toContain('echo "${OCM_LINUX_X64_SHA256}  ${ocm_archive}" | sha256sum -c -');
  });

  it("resolves each target once before benchmark and publication fan out", () => {
    const workflow = readWorkflow();
    const targetCheckout = findStep("Checkout target metadata", "resolve_target");
    const resolveTarget = findStep("Resolve OpenClaw target ref", "resolve_target");
    const checkout = findStep("Checkout OpenClaw");
    const record = findStep("Record tested revision");
    const sourceCheckout = findStep("Checkout OpenClaw source target", "source_performance");
    const sourceRecord = findStep("Record source performance revision", "source_performance");

    expect(workflow.jobs?.kova?.needs).toBe("resolve_target");
    expect(workflow.jobs?.source_performance?.needs).toBe("resolve_target");
    expect(targetCheckout.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(targetCheckout.with?.ref).toBe("${{ inputs.target_ref || github.sha }}");
    expect(targetCheckout.with?.path).toBe(".artifacts/performance-target");
    expect(targetCheckout.with?.["sparse-checkout-cone-mode"]).toBe(false);
    expect(targetCheckout.with?.["persist-credentials"]).toBe(false);
    expect(resolveTarget.id).toBe("resolve");
    expect(resolveTarget.env?.GH_TOKEN).toBeUndefined();
    expect(resolveTarget.env?.TARGET_REF_INPUT).toBe("${{ inputs.target_ref }}");
    expect(resolveTarget.env?.TARGET_CHECKOUT_DIR).toBe(
      "${{ github.workspace }}/.artifacts/performance-target",
    );
    expect(resolveTarget.run).not.toContain("gh api");
    expect(checkout.with?.ref).toBe("${{ needs.resolve_target.outputs.checkout_ref }}");
    expect(record.run).toContain('[[ "$tested_sha" != "$EXPECTED_TESTED_SHA" ]]');
    expect(sourceCheckout.with?.ref).toBe("${{ needs.resolve_target.outputs.checkout_ref }}");
    expect(sourceRecord.run).toContain('[[ "$tested_sha" != "$EXPECTED_TESTED_SHA" ]]');
    expect(
      Object.values(workflow.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.name === "Resolve OpenClaw target ref"),
    ).toHaveLength(1);
  });

  it("passes the requested model through Kova live auth without rewriting Kova source", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const run = findStep("Run Kova").run ?? "";

    expect(workflow).not.toContain("Pin Kova OpenAI model to GPT 5.6");
    expect(run).toContain('if [[ "$AUTH_MODE" == "live" ]]; then');
    expect(run).toContain('args+=(--model "$PERFORMANCE_MODEL_ID")');
    expect(run.indexOf('if [[ "$AUTH_MODE" == "live" ]]; then')).toBeLessThan(
      run.indexOf('args+=(--model "$PERFORMANCE_MODEL_ID")'),
    );
  });

  it("sparse-fetches only the public source baseline without publisher credentials", () => {
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const baseline = findStep("Fetch previous source performance baseline", "source_performance");
    const run = baseline.run ?? "";

    expect(baseline.if).toBeUndefined();
    expect(baseline.env?.CLAWGRIT_REPORTS_TOKEN).toBeUndefined();
    expect(baseline.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(baseline.env?.QUALIFICATION_DISPATCH).toBe(
      "${{ startsWith(inputs.dispatch_id, 'full-release-validation-') }}",
    );
    expect(run).toContain("advisory-not-compared");
    expect(run.indexOf('os.environ.get("QUALIFICATION_DISPATCH")')).toBeLessThan(
      run.indexOf('fetch(reports, "main"'),
    );
    expect(run).toContain('remote = "https://github.com/openclaw/clawgrit-reports.git"');
    expect(run).toContain(
      'fetch(reports, "main", blobless=True, max_attempts=3, retry_failures=True)',
    );
    expect(run).toContain('"ls-tree", "--name-only", "FETCH_HEAD", "--", pointer');
    expect(run).toContain('"show", f"FETCH_HEAD:{pointer}"');
    expect(run).toContain('"sparse-checkout", "init", "--no-cone"');
    expect(run).toContain('"sparse-checkout", "set", f"/{latest_path}/source/"');
    expect(run).toContain('"checkout", "--detach", "FETCH_HEAD"');
    expect(run).not.toContain("checkout -B main FETCH_HEAD");
    expect(workflowText).not.toContain("https://x-access-token:");
  });

  it("builds only the QA and startup artifacts required by source probes", () => {
    const run = findStep("Run OpenClaw source performance probes", "source_performance").run ?? "";
    const typedBuild =
      "OPENCLAW_BUILD_PRIVATE_QA=1 node --import tsx scripts/build-all.mts sourcePerformance";
    const nativeBuild = "OPENCLAW_BUILD_PRIVATE_QA=1 node scripts/build-all.mjs sourcePerformance";

    expect(run).toContain("scripts/profile-extension-memory.{mts,mjs}");
    expect(run).toContain("scripts/build-all.mts --help");
    expect(run).toContain("scripts/build-all.mjs --help");
    expect(run).toContain("sourcePerformance");
    expect(run).toContain(typedBuild);
    expect(run).toContain(nativeBuild);
    expect(run).toContain("pnpm build");
    expect(run.indexOf(typedBuild)).toBeLessThan(run.indexOf("pnpm test:gateway:cpu-scenarios"));
    expect(run.indexOf(nativeBuild)).toBeLessThan(run.indexOf("pnpm test:gateway:cpu-scenarios"));
    expect(run.indexOf("pnpm build")).toBeLessThan(run.indexOf("pnpm test:gateway:cpu-scenarios"));
  });

  it("runs only gateway startup cases advertised by the frozen target", () => {
    const run = findStep("Run OpenClaw source performance probes", "source_performance").run ?? "";

    expect(run).toContain("scripts/bench-gateway-startup.ts --help");
    expect(run).toContain('grep -Fxq "$startup_case"');
    expect(run).toContain('"${startup_case_args[@]}"');
    expect(run).toContain("required default case");
  });

  it("keeps source gateway health waits within one startup budget", () => {
    const run = findStep("Run OpenClaw source performance probes", "source_performance").run ?? "";
    const deadline = "gateway_ready_deadline=$((SECONDS + gateway_ready_timeout_seconds))";
    const remaining = "gateway_ready_remaining=$((gateway_ready_deadline - SECONDS))";
    const deadlineFailure = [
      "  if (( gateway_ready_remaining <= 0 )); then",
      '    cat "$gateway_log" >&2',
      '    echo "Timed out after ${gateway_ready_timeout_seconds}s waiting for gateway health." >&2',
      "    exit 1",
      "  fi",
    ].join("\n");
    const probeCap = [
      '  gateway_probe_timeout="$gateway_ready_remaining"',
      "  if (( gateway_probe_timeout > gateway_probe_timeout_seconds )); then",
      '    gateway_probe_timeout="$gateway_probe_timeout_seconds"',
      "  fi",
    ].join("\n");
    const boundedProbe =
      'curl -fsS --connect-timeout 2 --max-time "$gateway_probe_timeout" "http://127.0.0.1:${gateway_port}/healthz"';
    const websocketTimeout = "gateway_ready_remaining_ms=$((gateway_ready_remaining * 1000))";
    const websocketProbe = "node dist/entry.js gateway health \\";
    const websocketRetryDelay = [
      "  gateway_ready_remaining=$((gateway_ready_deadline - SECONDS))",
      "  if (( gateway_ready_remaining > 0 )); then",
      "    sleep 1",
      "  fi",
    ].join("\n");
    const benchmark = 'node --import tsx "$PERFORMANCE_HELPER_DIR/scripts/bench-cli-startup.ts" \\';

    expect(run).toContain("gateway_ready_timeout_seconds=120");
    expect(run).toContain("gateway_probe_timeout_seconds=5");
    expect(run).toContain(deadline);
    expect(run).toContain(remaining);
    expect(run).toContain(deadlineFailure);
    expect(run).toContain(probeCap);
    expect(run).toContain(boundedProbe);
    expect(run).toContain(websocketTimeout);
    expect(run).toContain(websocketProbe);
    expect(run).toContain('--port "$gateway_port" \\');
    expect(run).toContain('--timeout "$gateway_ready_remaining_ms" \\');
    expect(run).toContain('--json >"$gateway_readiness_log" 2>&1; then');
    expect(run).toContain(websocketRetryDelay);
    expect(run).toContain(
      "Timed out after ${gateway_ready_timeout_seconds}s waiting for gateway WebSocket health.",
    );
    expect(run.split("/healthz")).toHaveLength(2);
    expect(run.indexOf(deadline)).toBeLessThan(run.indexOf(remaining));
    expect(run.indexOf(remaining)).toBeLessThan(run.indexOf(deadlineFailure));
    expect(run.indexOf(deadlineFailure)).toBeLessThan(run.indexOf(probeCap));
    expect(run.indexOf(probeCap)).toBeLessThan(run.indexOf(boundedProbe));
    expect(run.indexOf(boundedProbe)).toBeLessThan(run.indexOf(websocketTimeout));
    expect(run.indexOf(websocketTimeout)).toBeLessThan(run.indexOf(websocketProbe));
    const websocketRetryDelayIndex = run.indexOf(websocketRetryDelay, run.indexOf(websocketProbe));
    expect(websocketRetryDelayIndex).toBeGreaterThan(run.indexOf(websocketProbe));
    expect(websocketRetryDelayIndex).toBeLessThan(run.indexOf(benchmark));
  });

  it("isolates required publication in a fresh artifact-consuming job", () => {
    const workflow = readWorkflow();
    const publisher = workflow.jobs?.publish;
    const kovaSteps = workflow.jobs?.kova?.steps ?? [];
    const publishSteps = publisher?.steps ?? [];
    const artifactIndex = publishSteps.findIndex((step) => step.name === "Resolve Kova artifact");
    const downloadIndex = publishSteps.findIndex((step) => step.name === "Download Kova artifacts");
    const prepareIndex = publishSteps.findIndex(
      (step) => step.name === "Prepare clawgrit report commit",
    );
    const pushIndex = publishSteps.findIndex((step) => step.name === "Publish to clawgrit reports");

    expect(publisher?.needs).toEqual(["resolve_target", "kova", "source_performance"]);
    expect(publisher?.if).toBe(
      "${{ always() && (github.event_name == 'schedule' || inputs.mode == 'kova') && needs.resolve_target.outputs.secret_eligible == 'true' && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.publish_reports == true)) && needs.resolve_target.result == 'success' && needs.kova.result != 'cancelled' && needs.source_performance.result != 'cancelled' }}",
    );
    expect(evaluateWorkflowRunner(publisher?.["runs-on"])).toBe("ubuntu-24.04");
    expect(publisher?.permissions?.actions).toBe("read");
    expect(publisher?.env?.REPORT_PUBLISH_REQUIRED).toBe(
      "${{ github.event_name == 'schedule' || inputs.profile == 'release' }}",
    );
    expect(kovaSteps.some((step) => step.name === "Upload Kova artifacts")).toBe(true);
    expect(kovaSteps.some((step) => step.name === "Run OpenClaw source performance probes")).toBe(
      false,
    );
    expect(
      workflow.jobs?.source_performance?.steps?.some(
        (step) => step.name === "Run OpenClaw source performance probes",
      ),
    ).toBe(true);
    expect(JSON.stringify(kovaSteps)).not.toContain("CLAWSWEEPER_APP_PRIVATE_KEY");
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(downloadIndex).toBeGreaterThan(artifactIndex);
    expect(prepareIndex).toBeGreaterThan(downloadIndex);
    expect(pushIndex).toBeGreaterThan(prepareIndex);
  });

  it("keeps report publication opt-out artifact-only for final release validation", () => {
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const fullReleaseText = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    const publisher = readWorkflow().jobs?.publish;

    expect(workflowText).toContain("publish_reports:");
    expect(workflowText).toContain("default: true");
    expect(publisher?.if).toContain("inputs.publish_reports == true");
    expect(fullReleaseText).toContain("-f publish_reports=false");
    expect(fullReleaseText).toContain("Report publication: disabled (artifacts only)");
  });

  it("fails closed when artifact-only mode does not keep the publisher skipped", () => {
    const guard = readWorkflow().jobs?.artifact_only_guard;
    const verify = findStep("Verify report publisher stayed disabled", "artifact_only_guard");

    expect(guard?.needs).toEqual(["resolve_target", "kova", "publish"]);
    expect(guard?.if).toBe(
      "${{ always() && github.event_name == 'workflow_dispatch' && inputs.mode == 'kova' && inputs.publish_reports != true }}",
    );
    expect(guard?.permissions?.contents).toBe("read");
    expect(verify.env?.PUBLISH_RESULT).toBe("${{ needs.publish.result }}");
    expect(verify.run).toContain('[[ "$PUBLISH_RESULT" != "skipped" ]]');
    expect(verify.run).toContain("Artifact-only performance mode requires");
  });

  it("serializes report publishers across runs without blocking other lanes", () => {
    const concurrency = expectDefined(
      readWorkflow().jobs?.publish?.concurrency,
      "publisher concurrency",
    );
    const group = (runId: number, lane: string) =>
      evaluateWorkflow(concurrency.group, { runId, matrix: { lane } });
    expect(group(1, "mock-provider")).toBe(group(2, "mock-provider"));
    expect(group(1, "mock-provider")).not.toBe(group(1, "mock-deep-profile"));
    expect(concurrency["cancel-in-progress"]).toBe(false);
    expect(concurrency.queue).toBe("max");
  });

  it("publishes reports through repository-scoped pull requests", () => {
    const publish = findStep("Publish to clawgrit reports", "publish");
    expect(publish.uses).toBe("./.github/actions/publish-generated-pr");
    expect(publish.with).toMatchObject({
      repository: "clawgrit-reports",
      "contents-client-id": "Iv23liOECG0slfuhz093",
      "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
      "pull-request-client-id": "Iv23liOECG0slfuhz093",
      "pull-request-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
      "working-directory": "${{ steps.prepare.outputs.reports_root }}",
      "base-branch": "main",
      "head-branch":
        "perf/openclaw-${{ github.run_id }}-${{ steps.artifact.outputs.producer_attempt }}-${{ matrix.lane }}",
      "generated-paths":
        "${{ steps.prepare.outputs.dest_rel }}\n${{ steps.prepare.outputs.latest_rel }}\n",
      "overlap-policy": "fail",
      "auto-merge": "true",
    });
    expect(publish.if).toContain("steps.prepare.outputs.already_published != 'true'");
  });

  it("keeps manual non-release publication advisory", () => {
    const continuation = "${{ env.REPORT_PUBLISH_REQUIRED != 'true' }}";
    const steps = [
      findStep("Resolve Kova artifact", "publish"),
      findStep("Download Kova artifacts", "publish"),
      findStep("Prepare clawgrit report commit", "publish"),
      findStep("Publish to clawgrit reports", "publish"),
    ];

    for (const step of steps) {
      expect(step["continue-on-error"]).toBe(continuation);
    }
    for (const step of steps.filter(
      (candidate) => candidate.run && candidate.name !== "Publish to clawgrit reports",
    )) {
      expect(step.run).toContain(
        'annotation="$([[ "$REPORT_PUBLISH_REQUIRED" == "true" ]] && printf error || printf warning)"',
      );
    }
  });

  it("keeps app credentials out of artifact processing and scopes them to report Git operations", () => {
    const workflow = readWorkflow();
    const kovaJob = workflow.jobs?.kova;
    const artifact = findStep("Resolve Kova artifact", "publish");
    const paths = findStep("Create isolated publisher paths", "publish");
    const download = findStep("Download Kova artifacts", "publish");
    const prepare = findStep("Prepare clawgrit report commit", "publish");
    const publish = findStep("Publish to clawgrit reports", "publish");

    expect(JSON.stringify(kovaJob)).not.toContain("CLAWSWEEPER_APP_PRIVATE_KEY");
    expect(artifact.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(artifact.run).toContain("gh api --paginate");
    expect(paths.run).toContain('mktemp -d "${RUNNER_TEMP}/clawgrit-input.XXXXXX"');
    expect(paths.run).toContain('mktemp -d "${RUNNER_TEMP}/clawgrit-reports.XXXXXX"');
    expect(download.uses).toBe(
      "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
    );
    expect(download.with?.["artifact-ids"]).toBe("${{ steps.artifact.outputs.ids }}");
    expect(download.with?.name).toBeUndefined();
    expect(download.with?.path).toBe("${{ steps.paths.outputs.input_root }}");
    expect(JSON.stringify(artifact.env ?? {})).not.toContain("clawgrit_app_token.outputs.token");
    expect(JSON.stringify(download.env ?? {})).not.toContain("clawgrit_app_token.outputs.token");
    expect(JSON.stringify(prepare.env ?? {})).not.toContain("clawgrit_app_token.outputs.token");
    expect(prepare.env?.TESTED_SHA).toBe("${{ needs.resolve_target.outputs.tested_sha }}");
    expect(prepare.env?.PRODUCER_ATTEMPT).toBe("${{ steps.artifact.outputs.producer_attempt }}");
    expect(prepare.env?.SOURCE_PRODUCER_ATTEMPT).toBe(
      "${{ steps.artifact.outputs.source_producer_attempt }}",
    );
    expect(prepare.run).toContain('find "$input_root" -type d -path "*/reports/${LANE_ID}"');
    expect(prepare.run).toContain(
      'source_path="${input_root}/openclaw-performance-source-${GITHUB_RUN_ID}-${SOURCE_PRODUCER_ATTEMPT}/${LANE_ID}"',
    );
    expect(prepare.run).toContain('run_slug="${GITHUB_RUN_ID}-${PRODUCER_ATTEMPT}"');
    expect(prepare.run).toContain('ls-tree --name-only HEAD -- "${dest_rel}/report.json"');
    expect(prepare.run).toContain('echo "already_published=true"');
    expect(prepare.run).toContain('input_root="$(realpath "$INPUT_ROOT")"');
    expect(prepare.run).toContain('find "$input_root" -type f -path');
    expect(prepare.run).toContain("contains a symlink or special file");
    expect(prepare.run).toContain("config core.hooksPath /dev/null");
    expect(prepare.run).toContain(
      'remote add origin "https://github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.if).toContain("steps.prepare.outputs.already_published != 'true'");
    expect(readFileSync(WORKFLOW, "utf8")).not.toContain("https://x-access-token:");
  });

  it("publishes bounded bundle metadata while retaining full diagnostics as an artifact", () => {
    const workflow = readWorkflow();
    const publisher = workflow.jobs?.publish;
    const helper = findStep("Checkout performance publisher helper", "publish");
    const prepare = findStep("Prepare clawgrit report commit", "publish");
    const upload = findStep("Upload Kova artifacts");
    const sourceUpload = findStep("Upload source performance artifacts", "source_performance");

    expect(publisher?.env?.PUBLISHED_REPORT_MAX_FILE_BYTES).toBe("50000000");
    expect(publisher?.env?.PERFORMANCE_PUBLISHER_HELPER).toContain(
      "scripts/lib/kova-report-publish-files.mjs",
    );
    expect(publisher?.env?.PERFORMANCE_REPORT_SELECTOR).toContain(
      "scripts/lib/kova-report-selector.mjs",
    );
    expect(helper.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "sparse-checkout":
        "scripts/lib/kova-report-publish-files.mjs\nscripts/lib/kova-report-selector.mjs\n.github/actions/publish-generated-pr\n.github/actions/create-generated-pr-tokens\n",
      "sparse-checkout-cone-mode": false,
      "persist-credentials": false,
    });
    expect(upload.with?.path).toContain(".artifacts/kova/bundles/${{ matrix.lane }}");
    expect(upload.with?.path).not.toContain(".artifacts/openclaw-performance/source");
    expect(sourceUpload.with).toMatchObject({
      name: "openclaw-performance-source-${{ github.run_id }}-${{ github.run_attempt }}",
      path: ".artifacts/openclaw-performance/source",
      "if-no-files-found": "error",
    });
    expect(prepare.env?.ARTIFACT_ID).toBe("${{ steps.artifact.outputs.id }}");
    expect(prepare.run).toContain('node "$PERFORMANCE_PUBLISHER_HELPER"');
    expect(prepare.run).toContain('--bundle-destination "$dest/bundles"');
    expect(prepare.run).toContain('--max-file-bytes "$PUBLISHED_REPORT_MAX_FILE_BYTES"');
    expect(prepare.run).toContain("The complete Kova bundle remains in [Actions artifact");
    expect(prepare.run).not.toContain('cp -R "$bundle"/. "$dest/bundles/"');
  });

  it("reuses the producing artifact when only publisher jobs rerun", () => {
    const artifact = findStep("Resolve Kova artifact", "publish");
    const root = mkdtempSync(join(realpathSync(tmpdir()), "openclaw-artifact-resolver-"));
    const bin = join(root, "bin");
    const output = join(root, "output");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' \
  '101	openclaw-performance-mock-provider-9001-1' \
  '202	openclaw-performance-source-9001-2' \
  '303	openclaw-performance-mock-provider-9001-3'
`,
    );
    chmodSync(join(bin, "gh"), 0o755);

    try {
      const result = runWorkflowCommand("bash", ["-c", artifact.run ?? ""], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_RUN_ID: "9001",
          LANE_ID: "mock-provider",
          REPORT_PUBLISH_REQUIRED: "true",
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        "id=101\nids=101,202\nproducer_attempt=2\nsource_producer_attempt=2\n",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves required PARTIAL failures and clears only advisory PARTIAL failures", () => {
    const run = findStep("Run Kova").run ?? "";
    const startMarker = 'effective_status="$status"';
    const endMarker = 'echo "effective_status=$effective_status" >> "$GITHUB_OUTPUT"';
    const start = run.indexOf(startMarker);
    const end = run.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const gateScript = run.slice(start, end + endMarker.length);
    const root = tempDirs.make("openclaw-kova-partial-gate-");
    const binDir = join(root, "bin");
    const fakeNode = join(binDir, "node");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeNode,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$GATE_INVOCATIONS"',
        '[ "$PARTIAL_POLICY" = "advisory" ]',
        "",
      ].join("\n"),
    );
    chmodSync(fakeNode, 0o755);

    for (const [partialPolicy, expectedStatus] of [
      ["required", "17"],
      ["advisory", "0"],
    ] as const) {
      const output = join(root, `${partialPolicy}.output`);
      const summary = join(root, `${partialPolicy}.summary`);
      const invocations = join(root, `${partialPolicy}.invocations`);
      const result = runWorkflowCommand("bash", ["-c", gateScript], {
        env: {
          ...process.env,
          evidence_status: "0",
          FAIL_ON_REGRESSION: "true",
          GATE_INVOCATIONS: invocations,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          KOVA_CANONICAL_CONFIG_REF: "trusted",
          KOVA_LEGACY_LIST_CONFIG_REF: "trusted",
          KOVA_REF: "trusted",
          PARTIAL_POLICY: partialPolicy,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          PERFORMANCE_HELPER_DIR: root,
          report_json: join(root, `${partialPolicy}.json`),
          status: "17",
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`effective_status=${expectedStatus}\n`);
      expect(readFileSync(invocations, "utf8")).toContain(
        "--require-instrumented-performance-contract",
      );
      if (partialPolicy === "advisory") {
        expect(readFileSync(summary, "utf8")).toContain(
          "trusted report adapter found only filtered coverage",
        );
      } else {
        expect(existsSync(summary)).toBe(false);
      }
    }
  });

  it("passes one comma-delimited include set to the lane plan and run", () => {
    const plan = findStep("Kova version and plan sanity");
    const runKova = findStep("Run Kova");
    const matrixEntries = kovaMatrixEntries();
    const includeFilters = matrixEntries.map((entry, index) =>
      expectDefined(entry.include_filters, `Kova matrix include filters ${index}`),
    );
    const expectedReleaseEntries = matrixEntries.map((entry) => entry.expected_release_entries);

    expect(includeFilters).toEqual([
      "scenario:fresh-install,scenario:gateway-performance,scenario:bundled-plugin-startup,scenario:agent-cold-warm-message",
      "scenario:fresh-install,scenario:gateway-performance,scenario:agent-cold-warm-message",
      "scenario:agent-cold-warm-message",
    ]);
    expect(includeFilters.every((filters) => !filters.includes(" "))).toBe(true);
    expect(plan.run).toContain('plan_dir="${RUNNER_TEMP}/kova-plans"');
    expect(plan.run).toContain('--include "$INCLUDE_FILTERS"');
    expect(plan.run).toContain('--repeat "$repeat"');
    expect(plan.run).toContain('echo "KOVA_PLAN_JSON=$plan_json" >> "$GITHUB_ENV"');
    expect(plan.run).not.toContain("$REPORT_DIR");
    expect(runKova.run).toContain('--include "$INCLUDE_FILTERS"');
    expect(runKova.run).not.toContain("for filter in $INCLUDE_FILTERS");
    expect(expectedReleaseEntries).toEqual([
      "fresh-install:fresh,fresh-install:onboarded-user,bundled-plugin-startup:fresh,agent-cold-warm-message:mock-openai-provider,gateway-performance:many-bundled-plugins",
      "fresh-install:fresh,fresh-install:onboarded-user,agent-cold-warm-message:mock-openai-provider,gateway-performance:many-bundled-plugins",
      "agent-cold-warm-message:mock-openai-provider",
    ]);
  });

  it("prepares a fail-closed systemd user session for OCM", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs?.kova?.steps ?? [];
    const managedServiceLanes = workflow.jobs?.kova?.strategy?.matrix?.include?.map(
      (lane) => lane.managed_service,
    );
    const prepare = findStep("Set up Node environment");
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const provisionEntry = action.runs.steps.find((step: WorkflowStep) =>
      step.run?.includes("loginctl enable-linger"),
    )?.run;
    const provision = readFileSync(".github/actions/setup-node-env/semantic-memory.sh", "utf8");
    const stepNames = steps.map((step) => step.name);

    expect(managedServiceLanes).toEqual(["true", "true", "false"]);
    expect(prepare.if).toBe("steps.lane.outputs.run == 'true'");
    expect(prepare.with?.["semantic-checks"]).toBe("${{ matrix.managed_service }}");
    expect(provisionEntry).toBe(provision.split("\n").slice(1).join("\n"));
    expect(provision).toContain("set -euo pipefail");
    expect(provision).toContain('test "$(ps -p 1 -o comm= | xargs)" = systemd');
    expect(provision).toContain("sudo -n systemctl is-active --quiet systemd-logind.service");
    expect(provision).toContain('sudo -n loginctl enable-linger "$user"');
    expect(provision).toContain('sudo -n systemctl start "user@${uid}.service"');
    expect(provision).toContain(
      'runtime_dir="$(loginctl show-user "$user" --property=RuntimePath --value)"',
    );
    expect(provision).toContain('test -S "$XDG_RUNTIME_DIR/systemd/private"');
    expect(provision).toContain('echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >> "$GITHUB_ENV"');
    expect(provision).toContain('if [[ -S "$runtime_dir/bus" ]]; then');
    expect(provision).toContain(
      'echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"',
    );
    expect(provision).toContain("systemctl --user show-environment >/dev/null");
    expect(provision).not.toContain("|| true");
    expect(stepNames.indexOf("Set up Node environment")).toBeLessThan(
      stepNames.indexOf("Install OCM and Kova"),
    );
  });

  it("validates exact Kova release-plan coverage before execution", () => {
    const sanity = findStep("Kova version and plan sanity");

    expect(sanity.run).toContain('--include "$INCLUDE_FILTERS"');
    expect(sanity.run).toContain("plan.controls?.include");
    expect(sanity.run).toContain("process.env.EXPECTED_RELEASE_ENTRIES.split");
    expect(sanity.run).toContain('entry.status !== "SELECTED"');
    expect(sanity.run).toContain("Kova release plan entries did not match");
    expect(sanity.run).not.toContain("--include scenario:fresh-install");
  });

  it("finalizes Kova artifacts before failing evidence integrity", () => {
    const run = findStep("Run Kova").run ?? "";
    const evidence = run.indexOf("scripts/lib/kova-workflow-evidence.mts");
    const bundle = run.indexOf('kova report bundle "$report_json"');
    const summary = run.indexOf("scripts/kova-ci-summary.mts");
    const integrityExit = run.indexOf(
      'if [[ "$evidence_status" != "0" || "$bundle_status" != "0" || "$summary_status" != "0" ]]',
    );

    expect(evidence).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(evidence);
    expect(summary).toBeGreaterThan(bundle);
    expect(integrityExit).toBeGreaterThan(summary);
    expect(run).toContain("evidence_status=$?");
    expect(run).toContain("bundle_status=${PIPESTATUS[0]}");
    expect(run).toContain("summary_status=$?");
    expect(run).toContain("Summary generation failed with status ${summary_status}");
  });

  it("runs the trusted lane evidence validator before tolerating gate failures", () => {
    const runKova = findStep("Run Kova");
    const run = runKova.run ?? "";
    const evidenceValidator = run.indexOf("scripts/lib/kova-workflow-evidence.mts");
    const trustedGateAdapter = run.indexOf("scripts/lib/kova-report-gate.mts");

    expect(evidenceValidator).toBeGreaterThan(-1);
    expect(trustedGateAdapter).toBeGreaterThan(evidenceValidator);
    expect(run).toContain('--plan "$KOVA_PLAN_JSON"');
    expect(run).toContain('--report "$report_json"');
    expect(run).toContain('--profile "$PROFILE"');
    expect(run).toContain('--target "local-build:${GITHUB_WORKSPACE}"');
    expect(run).toContain('--repeat "$repeat"');
    expect(run).toContain('--include "$INCLUDE_FILTERS"');
    expect(run).toContain('--auth "$AUTH_MODE"');
    expect(run).toContain('--model "$PERFORMANCE_MODEL_ID"');
    expect(run).toContain('gate_args=("$report_json")');
    expect(run).toContain(
      'if [[ "$KOVA_REF" == "$KOVA_CANONICAL_CONFIG_REF" || "$KOVA_REF" == "$KOVA_LEGACY_LIST_CONFIG_REF" ]]; then',
    );
    expect(run).toContain("gate_args+=(--require-instrumented-performance-contract)");
    expect(run).toContain(
      'node --import tsx "$PERFORMANCE_HELPER_DIR/scripts/lib/kova-report-gate.mts" "${gate_args[@]}"',
    );
    expect(run.indexOf('gate_args=("$report_json")')).toBeLessThan(
      run.indexOf("gate_args+=(--require-instrumented-performance-contract)"),
    );
    expect(run.indexOf("gate_args+=(--require-instrumented-performance-contract)")).toBeLessThan(
      run.indexOf(
        'node --import tsx "$PERFORMANCE_HELPER_DIR/scripts/lib/kova-report-gate.mts" "${gate_args[@]}"',
      ),
    );
  });

  it("selects exactly one full Kova report across producer and publisher paths", () => {
    const runKova = findStep("Run Kova");
    const validate = findStep("Validate Kova evidence");
    const publish = findStep("Prepare clawgrit report commit", "publish");

    expect(runKova.run).toContain('kova-report-selector.mjs" --report-dir "$REPORT_DIR"');
    expect(validate.run).toContain('kova-report-selector.mjs" --report-dir "$REPORT_DIR"');
    expect(publish.run).toContain(
      'node "$PERFORMANCE_REPORT_SELECTOR" --report-dir "${report_dirs[0]}"',
    );
    expect(runKova.run).not.toContain("tail -n 1");
    expect(publish.run).not.toContain("report_jsons");
  });

  it("lets OCM discover its native workspace dependency adapter", () => {
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const steps = readWorkflow().jobs?.kova?.steps ?? [];
    const installIndex = steps.findIndex((step) => step.name === "Install OCM and Kova");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(steps.map((step) => step.name)).not.toContain(
      "Configure OCM local workspace dependencies",
    );
    expect(workflowText).not.toContain("OCM_INTERNAL_NPM_BIN");
    expect(workflowText).not.toContain("OPENCLAW_OCM_NPM_WRAPPER");
    expect(workflowText).not.toContain("OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS");
    expect(steps[installIndex + 1]?.name).toBe("Kova version and plan sanity");
  });

  it("fails selected live Kova lanes when live auth is missing", () => {
    const configureAuth = findStep("Configure live OpenAI auth");
    const runKova = findStep("Run Kova");

    expect(configureAuth.if).toContain("matrix.live == 'true'");
    expect(configureAuth.if).toContain("needs.resolve_target.outputs.secret_eligible == 'true'");
    expect(configureAuth.env?.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(configureAuth.run).toContain('if [[ -z "${OPENAI_API_KEY:-}" ]]; then');
    expect(configureAuth.run).toContain("cannot run without live evidence");
    expect(configureAuth.run).toContain("exit 1");
    expect(configureAuth.run).not.toContain("will be skipped");
    expect(runKova.env?.OPENAI_API_KEY).toBe(
      "${{ matrix.live == 'true' && needs.resolve_target.outputs.secret_eligible == 'true' && secrets.OPENAI_API_KEY || '' }}",
    );
    expect(runKova.env?.OPENAI_BASE_URL).toBe(
      "${{ matrix.live == 'true' && needs.resolve_target.outputs.secret_eligible == 'true' && secrets.OPENAI_BASE_URL || '' }}",
    );
    expect(runKova.run).not.toContain('echo "skipped=true" >> "$GITHUB_OUTPUT"');
  });

  it("requires Kova evidence before uploading selected lane artifacts", () => {
    const validateEvidence = findStep("Validate Kova evidence");
    const upload = findStep("Upload Kova artifacts");
    const retryUpload = findStep("Retry Kova artifact upload");
    const sourceUpload = findStep("Upload source performance artifacts", "source_performance");
    const retrySourceUpload = findStep(
      "Retry source performance artifact upload",
      "source_performance",
    );

    expect(validateEvidence.if).toContain("always()");
    expect(validateEvidence.if).toContain("steps.lane.outputs.run == 'true'");
    expect(validateEvidence.run).toContain('kova-report-selector.mjs" --report-dir "$REPORT_DIR"');
    expect(validateEvidence.run).toContain('"$BUNDLE_DIR/bundle.json"');
    expect(validateEvidence.run).toContain('"$SUMMARY_DIR/${LANE_ID}.md"');
    expect(validateEvidence.run).toContain("exit 1");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.id).toBe("upload_kova_artifacts");
    expect(upload["continue-on-error"]).toBe(true);
    expect(retryUpload.if).toContain("steps.upload_kova_artifacts.outcome == 'failure'");
    expect(retryUpload.with?.overwrite).toBe(true);
    expect(sourceUpload.id).toBe("upload_source_performance_artifacts");
    expect(sourceUpload["continue-on-error"]).toBe(true);
    expect(retrySourceUpload.if).toContain(
      "steps.upload_source_performance_artifacts.outcome == 'failure'",
    );
    expect(retrySourceUpload.with?.overwrite).toBe(true);
  });
});
