import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  resolvePackagedUpgradeTimeouts,
  resolveRunnerMatrix,
} from "../../scripts/lib/cross-os-release-checks/config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function expectContains(text: string | undefined, fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

const WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const RELEASE_CHECKS_PATH = ".github/workflows/openclaw-release-checks.yml";
const WRAPPER_PATH = "scripts/github/run-openclaw-cross-os-release-checks.sh";
const SCRIPT_PATH = "scripts/openclaw-cross-os-release-checks.ts";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

type WorkflowStep = {
  "continue-on-error"?: boolean | string;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  "timeout-minutes"?: number | string;
  "continue-on-error"?: boolean | string;
  if?: string;
  steps?: WorkflowStep[];
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const found = workflow.jobs[name];
  expect(found, name).toBeDefined();
  return found!;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const found = workflowJob.steps?.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

function expectBefore(workflowJob: WorkflowJob, ...names: string[]) {
  const indices = names.map((name) => workflowJob.steps!.indexOf(step(workflowJob, name)));
  for (let index = 1; index < indices.length; index++) {
    expect(indices[index - 1]!, names.join(" → ")).toBeLessThan(indices[index]!);
  }
}

function runWrapper(args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = {}) {
  return spawnSync(BASH_BIN, [WRAPPER_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_RELEASE_CHECKS_SCRIPT: SCRIPT_PATH, ...env },
  });
}

describe("cross-OS release checks workflow", () => {
  const workflow = readWorkflow(WORKFLOW_PATH);
  const release = readWorkflow(RELEASE_CHECKS_PATH);
  const prepare = job(workflow, "prepare");
  const consumer = job(workflow, "cross_os_release_checks");
  it("lets Windows packaged-upgrade finish its bounded timeout recovery within the job", () => {
    const expression = String(consumer["timeout-minutes"]).replace(/^\$\{\{(.*)\}\}$/u, "$1");
    for (const osId of ["ubuntu", "windows", "macos"]) {
      for (const suite of ["packaged-fresh", "packaged-upgrade", "dev-update", "installer-fresh"]) {
        const minutes = runInNewContext(expression, { matrix: { os_id: osId, suite } });
        if (osId === "windows" && suite === "packaged-upgrade") {
          const installCeilingMs = 45 * 60_000;
          const { wrapperTimeoutMs } = resolvePackagedUpgradeTimeouts(installCeilingMs, "win32");
          expect(minutes * 60_000).toBeGreaterThanOrEqual(
            2 * installCeilingMs + wrapperTimeoutMs + 20 * 60_000,
          );
          expect(minutes).toBeLessThanOrEqual(180);
        } else {
          expect(minutes).toBe(60);
        }
      }
    }
  });

  it("gives every lane unique proof identities and both packaged runtimes", () => {
    const { include } = resolveRunnerMatrix({ mode: "both", ref: "main" });
    expect(new Set(include.map((entry) => `${entry.display_name}/${entry.suite_label}`)).size).toBe(
      include.length,
    );
    expect(new Set(include.map((entry) => `${entry.artifact_name}/${entry.suite}`)).size).toBe(
      include.length,
    );
    for (const [suite, versions] of [
      ["packaged-fresh", ["24.22.1", "26.12.1"]],
      ["packaged-upgrade", ["24.22.1", "26.12.1"]],
      ["installer-fresh", ["24.22.1"]],
      ["dev-update", ["24.22.1"]],
    ] as const) {
      expect([
        ...new Set(
          include.filter((entry) => entry.suite === suite).map((entry) => entry.node_version),
        ),
      ]).toEqual(versions);
    }
  });

  it.each(["windows/packaged-upgrade", "packaged-fresh"])(
    "filters the cross-OS runner matrix by %s",
    (suiteFilter) => {
      const matrix = resolveRunnerMatrix({ mode: "both", ref: "main", suiteFilter });
      if (suiteFilter === "windows/packaged-upgrade") {
        expect(matrix.include).toEqual([
          expect.objectContaining({
            os_id: "windows",
            suite: "packaged-upgrade",
            node_version: "24.22.1",
          }),
          expect.objectContaining({
            os_id: "windows",
            suite: "packaged-upgrade",
            node_version: "26.12.1",
          }),
        ]);
      } else {
        expect(matrix.include).toHaveLength(6);
        expect([...new Set(matrix.include.map((entry) => entry.os_id))].toSorted()).toEqual([
          "macos",
          "ubuntu",
          "windows",
        ]);
        expect(matrix.include.every((entry) => entry.suite === "packaged-fresh")).toBe(true);
      }
    },
  );

  it("preserves failed preparation and cross-OS test job conclusions", () => {
    for (const target of [prepare, consumer, step(consumer, "Run cross-OS release checks")]) {
      expect(target["continue-on-error"]).toBeUndefined();
    }
  });

  it.each([
    ["candidate", "download_candidate"],
    ["baseline", "download_baseline"],
    ["prerelease plugin registry", "download_prepublish_plugin_registry"],
  ])("retries only failed %s artifact acquisition once before tests", (artifact, downloadId) => {
    const first = step(consumer, `Download ${artifact} artifact`);
    const warning = step(consumer, `Warn about ${artifact} artifact acquisition retry`);
    const retry = step(consumer, `Retry ${artifact} artifact download`);

    expect(first.id).toBe(downloadId);
    expect(first["continue-on-error"]).toBe(true);
    expect(first.uses).toMatch(/^actions\/download-artifact@/u);
    expect(retry.uses).toBe(first.uses);
    expect(retry.with).toEqual(first.with);
    expect(retry["continue-on-error"]).toBeUndefined();
    expect(warning.if).toBe(retry.if);
    expect(warning.run).toContain("::warning::");
    expect(warning.run).toContain("retrying infrastructure acquisition once before tests");
    for (const outcome of ["success", "failure", "skipped", "cancelled"]) {
      const retryEnabled = runInNewContext(retry.if!.replace(/^\$\{\{(.*)\}\}$/u, "$1"), {
        steps: { [downloadId]: { outcome } },
      });
      expect(retryEnabled, outcome).toBe(outcome === "failure");
    }
    expectBefore(consumer, first.name!, warning.name!, retry.name!, "Verify release-check inputs");
  });

  it("uses the matrix runtime consistently for both consumer setup steps", () => {
    for (const setupName of ["Setup Node.js", "Setup pnpm"]) {
      expect(step(prepare, setupName).with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
      const expression = String(step(consumer, setupName).with?.["node-version"]);
      for (const [osId, suite, nodeVersion, expected] of [
        ["windows", "packaged-fresh", "26.12.1", "26.12.1"],
        // The public workflow_ref input can select a pre-field tooling revision.
        ["windows", "packaged-fresh", undefined, "24.22.1"],
      ]) {
        expect(
          runInNewContext(expression.replace(/^\$\{\{(.*)\}\}$/u, "$1"), {
            matrix: { os_id: osId, suite, node_version: nodeVersion },
            env: { NODE_VERSION: "24.22.1" },
          }),
          `${setupName}: ${osId}/${suite}/${nodeVersion ?? "legacy"}`,
        ).toBe(expected);
      }
    }
  });

  it("caches only npm download bytes, not installed state", () => {
    const restore = step(consumer, "Restore npm downloads");
    const save = step(consumer, "Save npm downloads");
    expect(restore.with?.path).toMatch(/\/_cacache$/u);
    expect(save.with?.path).toBe(restore.with?.path);
    expectBefore(consumer, restore.name!, "Run cross-OS release checks", save.name!);
  });

  it("fails the Windows lane on its first interrupted dashboard probe", () => {
    const run = step(consumer, "Run cross-OS release checks");
    const root = tempDirs.make("cross-os-first-failure-");
    const harness = join(root, "workflow/scripts/github");
    const outputDir = join(root, "output");
    mkdirSync(harness, { recursive: true });
    mkdirSync(join(outputDir, "logs"), { recursive: true });
    writeFileSync(
      join(outputDir, "logs/fresh-dashboard.log"),
      "attempt=1 url=http://127.0.0.1:1/\n",
    );
    writeFileSync(
      join(harness, "run-openclaw-cross-os-release-checks.sh"),
      [
        'if [[ -f "$OUTPUT_DIR/attempt" ]]; then exit 0; fi',
        'printf "first\\n" > "$OUTPUT_DIR/attempt"',
        "exit 127",
      ].join("\n"),
    );
    const result = spawnSync(BASH_BIN, ["-e", "-o", "pipefail", "-c", run.run!], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(Object.keys(run.env ?? {}).map((key) => [key, ""])),
        MODE: "fresh",
        OPENCLAW_RELEASE_CHECK_OS: "windows",
        OUTPUT_DIR: outputDir,
      },
    });

    expect(result.status, result.stdout + result.stderr).toBe(127);
    expect(readFileSync(join(outputDir, "attempt"), "utf8")).toBe("first\n");
  });

  it("bounds npm baseline packing and suppresses lifecycle scripts", () => {
    expect(readFileSync(WORKFLOW_PATH, "utf8")).toContain(
      "timeout --preserve-status 300s npm pack --ignore-scripts",
    );
  });

  it("installs workflow dependencies without lifecycle scripts", () => {
    expect(step(prepare, "Install workflow validation dependencies").run).toContain(
      "--ignore-scripts",
    );
  });

  it("keeps release artifact tarball filenames local before upload paths use them", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");

    expectContains(source, [
      "fileName !== path.basename(fileName)",
      "fileName !== path.win32.basename(fileName)",
    ]);
  });

  it("keeps artifact downloads immutable and checkouts credential-free", () => {
    for (const workflowJob of Object.values(workflow.jobs)) {
      for (const candidate of workflowJob.steps ?? []) {
        if (candidate.uses?.startsWith("actions/checkout@")) {
          expect(candidate.with?.["persist-credentials"], candidate.name).toBe(false);
        }
        if (candidate.uses?.startsWith("actions/download-artifact@")) {
          expect(candidate.with?.["artifact-ids"], candidate.name).toMatch(/artifact.*id/iu);
          expect(candidate.with?.["run-id"], candidate.name).toMatch(/run.*id/iu);
          expect(candidate.with?.name, candidate.name).toBeUndefined();
        }
      }
    }
    const binding = step(prepare, "Validate provided candidate artifact binding");
    expectBefore(prepare, binding.name!, "Download provided candidate artifact");
    expectContains(binding.run, [
      'verify-upload "Candidate"',
      '"$CANDIDATE_SOURCE_SHA" != "$INPUT_REF"',
    ]);
    const producer = job(release, "prepare_release_package");
    expect(step(producer, "Checkout trusted workflow ref").with).toMatchObject({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });
    expect(step(producer, "Validate release package artifact binding").run).toContain(
      'verify-upload "Release package"',
    );
    const verify = step(consumer, "Verify release-check inputs");
    expectContains(verify.run, [
      '"$actual_sha256" != "$EXPECTED_CANDIDATE_SHA256"',
      '"$actual_baseline_sha256" != "$EXPECTED_BASELINE_SHA256"',
    ]);
  });

  it("requires a closed companion registry tuple and verifies its uploaded bytes", () => {
    expectContains(step(prepare, "Normalize companion registry contract").run, [
      "(keys | sort) == ([",
      'all(.[]; type == "string")',
      "The selected provider requires a complete immutable companion registry tuple.",
      "Source-built candidates produce their own companion registry and reject a second tuple.",
    ]);
    expect(step(prepare, "Verify provided prerelease plugin registry upload").run).toContain(
      'verify-upload "Prerelease plugin registry"',
    );
    expect(step(consumer, "Run cross-OS release checks").run).toContain(
      `"$(jq -r '.prepublishPluginRegistryManifestSha256' <<< "$PLUGIN_REGISTRY_JSON")"`,
    );
  });

  it.each([
    ["openai", ["@openclaw/codex"]],
    ["anthropic", []],
  ])("resolves provider-owned companions for %s", (provider, expected) => {
    const result = runWrapper([
      "--resolve-provider-required-companion-packages",
      "--provider",
      provider,
    ]);
    expect(result).toMatchObject({ stderr: "", status: 0 });
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });

  it("executes the release harness directly with Node without installed packages", () => {
    // Lane tooling has no installed packages. Keep the fixture outside the checkout
    // so a developer's node_modules cannot satisfy an accidental runtime import.
    const fixture = tempDirs.make("cross-os-no-packages-");
    for (const source of ["package.json", "scripts", "packages/normalization-core"]) {
      const target = join(fixture, source);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
    const result = runWrapper(
      [
        "--resolve-matrix",
        "--ref",
        "test/native-node",
        "--mode",
        "fresh",
        "--suite-filter",
        "windows/packaged-fresh",
        "--windows-runner",
        "windows-2025",
      ],
      fixture,
      { NODE_OPTIONS: "", NODE_PATH: "" },
    );

    expect(result).toMatchObject({ stderr: "", status: 0 });
    expect(JSON.parse(result.stdout).include).toEqual([
      expect.objectContaining({
        os_id: "windows",
        runner: "windows-2025",
        node_version: "24.22.1",
      }),
      expect.objectContaining({
        os_id: "windows",
        runner: "windows-2025",
        node_version: "26.12.1",
      }),
    ]);
  });
});
