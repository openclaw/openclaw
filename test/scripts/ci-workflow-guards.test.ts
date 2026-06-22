// Ci Workflow Guards tests cover ci workflow guards script behavior.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const CHECKOUT_V6 = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const CACHE_V5 = "actions/cache/restore@27d5ce7f107fe9357f9df03efb73ab90386fccae";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

function readWorkflowSanityWorkflow() {
  return parse(readFileSync(".github/workflows/workflow-sanity.yml", "utf8"));
}

function readCriticalQualityWorkflow() {
  return readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
}

function findYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return findYamlFiles(path);
    }
    return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [path] : [];
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

describe("ci workflow guards", () => {
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
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "run-name: ${{ github.event_name == 'workflow_dispatch' && inputs.release_gate && format('CI release gate {0}', inputs.target_ref) || 'CI' }}",
    );
    const preflightSteps = workflow.jobs.preflight.steps;
    const validationStep = preflightSteps.find(
      (step) => step.name === "Validate release-gate dispatch",
    );
    expect(validationStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(validationStep.run).toContain(
      "release_gate requires target_ref to be a full commit SHA",
    );
    expect(validationStep.run).toContain("release_gate must run from the branch at target_ref");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "OPENCLAW_CI_RUN_ANDROID: ${{ github.event_name == 'workflow_dispatch' && (inputs.release_gate || inputs.include_android) && 'true' || (steps.head_scope.outputs.empty_head_commit != 'true' && (steps.changed_scope.outputs.run_android || 'false')) }}",
    );
  });

  it("pins every external GitHub Action reference to a full commit SHA", () => {
    expect(findUnpinnedExternalActions()).toEqual([]);
  });

  it("keeps docs-change detection fail-safe and fixture-aware", () => {
    const action = readFileSync(".github/actions/detect-docs-changes/action.yml", "utf8");

    expect(action).toContain("docs_only:");
    expect(action).toContain("docs_changed:");
    expect(action).toContain('BASE="${{ github.event.before }}"');
    expect(action).toContain('BASE="${{ github.event.pull_request.base.sha }}"');
    expect(action).toContain(
      'CHANGED=$(git diff --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")',
    );
    expect(action).toContain('if [ "$CHANGED" = "UNKNOWN" ] || [ -z "$CHANGED" ]; then');
    expect(action).toContain("docs_only=false");
    expect(action).toContain("docs_changed=false");
    expect(action).toContain("test/fixtures/*)");
    expect(action).toContain("docs/* | *.md | *.mdx)");
  });

  it("skips the matrix for empty pull-request head commits", () => {
    const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = readCiWorkflow();
    const preflightSteps = workflow.jobs.preflight.steps;
    const headScope = preflightSteps.find((step) => step.name === "Detect empty head commit");

    expect(headScope.if).toBe("github.event_name == 'pull_request'");
    expect(headScope.env.PR_NUMBER).toBe("${{ github.event.pull_request.number }}");
    expect(headScope.run).toContain("refs/pull/${PR_NUMBER}/head");
    expect(headScope.run).toContain('git diff --quiet "${PR_HEAD}^" "$PR_HEAD"');
    expect(headScope.run).toContain("empty_head_commit=true");
    expect(workflowSource).toContain("OPENCLAW_CI_EMPTY_HEAD_COMMIT");
    expect(workflowSource).toContain("!emptyHeadCommit && parseBoolean");
  });

  it("bounds matrix fan-out for runner-registration pressure", () => {
    const workflow = readCiWorkflow();

    expect(workflow.jobs["checks-node-core-test-nondist-shard"].strategy.max-parallel).toBe(6);
    expect(workflow.jobs["checks-fast-plugin-contracts-shard"].strategy.max-parallel).toBe(4);
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].strategy.max-parallel).toBe(4);
    expect(workflow.jobs["check-shard"].strategy.max-parallel).toBe(4);
    expect(workflow.jobs["check-additional-shard"].strategy.max-parallel).toBe(4);
    expect(workflow.jobs["checks-windows"].strategy.max-parallel).toBe(2);
    expect(workflow.jobs.android.strategy.max-parallel).toBe(2);
  });

  it("runs the session accessor ratchet as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
    });

    const runStep = additionalJob.steps.find((step) => step.name === "Run additional check shard");
    expect(runStep.run).toContain("session-accessor-boundary)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:session-accessor-boundary" pnpm run lint:tmp:session-accessor-boundary',
    );
  });

  it("runs the transcript reader ratchet as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-session-transcript-reader-boundary",
      group: "session-transcript-reader-boundary",
    });

    const runStep = additionalJob.steps.find((step) => step.name === "Run additional check shard");
    expect(runStep.run).toContain("session-transcript-reader-boundary)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:session-transcript-reader-boundary" pnpm run lint:tmp:session-transcript-reader-boundary',
    );
  });

  it("kills timed manual checkout fetches after the grace period", () => {
    const workflowPaths = [
      [".github/workflows/ci.yml", "120s"],
      [".github/workflows/workflow-sanity.yml", "30s"],
      [".github/workflows/ci-check-testbox.yml", "120s"],
      [".github/workflows/ci-check-arm-testbox.yml", "120s"],
      [".github/workflows/ci-build-artifacts-testbox.yml", "120s"],
      [".github/workflows/crabbox-hydrate.yml", "30s"],
    ];

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

  it("bounds shared base commit fetches", () => {
    const action = readFileSync(".github/actions/ensure-base-commit/action.yml", "utf8");

    expect(action).toContain("fetch_base_ref()");
    expect(action).toContain("timeout --signal=TERM --kill-after=10s 30s git");
    expect(action).toContain("-c protocol.version=2");
    expect(action).not.toContain("if ! git fetch --no-tags");
  });

  it("bounds early unauthenticated checkout fetches", () => {
    const workflow = readCiWorkflow();

    for (const jobName of ["preflight", "security-fast", "skills-python"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain(
        'timeout --signal=TERM --kill-after=10s 120s git -C "$GITHUB_WORKSPACE"',
      );
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).not.toContain("if timeout --signal=TERM");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      const expectedDepth = jobName === "preflight" ? 2 : 1;
      expect(checkoutStep.run, jobName).toContain(
        `fetch --no-tags --prune --no-recurse-submodules --depth=${expectedDepth} origin`,
      );
      if (jobName !== "skills-python") {
        expect(checkoutStep.run, jobName).toContain('if [ "$fetch_status" = "124" ]');
        expect(checkoutStep.run, jobName).toContain("timed out");
      }
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("retries workflow sanity checkout fetch timeouts", () => {
    const workflow = readWorkflowSanityWorkflow();

    for (const jobName of ["no-tabs", "actionlint", "generated-doc-baselines"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref()");
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain(
        'timeout --signal=TERM --kill-after=10s 30s git -C "$GITHUB_WORKSPACE"',
      );
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$fetch_status" != "124" ] && [ "$fetch_status" != "137" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
    }
  });

  it("runs plugin SDK API and surface drift checks in workflow sanity", () => {
    const workflow = readWorkflowSanityWorkflow();
    const steps = workflow.jobs["generated-doc-baselines"].steps;
    const stepNames = steps.map((step) => step.name);

    expect(stepNames).toContain("Check plugin SDK API baseline drift");
    expect(stepNames).toContain("Check plugin SDK surface budget");
    expect(stepNames.indexOf("Check plugin SDK API baseline drift")).toBeLessThan(
      stepNames.indexOf("Check plugin SDK surface budget"),
    );
    expect(steps.find((step) => step.name === "Check plugin SDK surface budget").run).toBe(
      "pnpm plugin-sdk:surface:check",
    );
  });

  it("bounds platform checkout fetches without GNU timeout", () => {
    const workflow = readCiWorkflow();

    for (const jobName of ["checks-windows", "macos-node", "macos-swift"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref()");
      expect(checkoutStep.run, jobName).toContain("fetch_timeout_seconds=90");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$elapsed" -ge "$fetch_timeout_seconds" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain('kill -TERM "$fetch_pid"');
      expect(checkoutStep.run, jobName).toContain('kill -KILL "$fetch_pid"');
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
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

  it("fails Windows Testbox setup when Blacksmith phone-home is not accepted", () => {
    const workflow = readFileSync(".github/workflows/windows-blacksmith-testbox.yml", "utf8");

    expect(workflow).toContain('echo "phone_home_hydrating_http=${hydrating_http_code}"');
    expect(workflow).toContain('echo "phone_home_ready_http=${http_code}"');
    expect(workflow).toContain('jq -e \'type == "number"\' <<<"$installation_model_id"');
    expect(workflow).toContain('--arg testbox_id "$TESTBOX_ID"');
    expect(workflow).toContain('--arg testbox_id "$testbox_id"');
    expect(workflow).toContain('--argjson installation_model_id "$installation_model_id"');
    expect(workflow).toContain('--data-binary @"$hydrating_body"');
    expect(workflow).toContain('--data-binary @"$ready_body"');
    const hydratingFailureBlock = workflow.slice(
      workflow.indexOf('if [[ ! "$hydrating_http_code" =~ ^2 ]]; then'),
      workflow.indexOf('response="$(cat "$hydrating_response")"'),
    );
    const missingSshKeyFailureBlock = workflow.slice(
      workflow.indexOf('if [ -z "$ssh_public_key" ]; then'),
      workflow.indexOf("mkdir -p ~/.ssh"),
    );
    const readyFailureBlock = workflow.slice(
      workflow.indexOf('if [[ ! "$http_code" =~ ^2 ]]; then'),
      workflow.indexOf('echo "============================================"'),
    );

    expect(hydratingFailureBlock).toContain("exit 1");
    expect(missingSshKeyFailureBlock).toContain("exit 1");
    expect(readyFailureBlock).toContain("exit 1");
    expect(workflow).toContain(
      "Blacksmith phone-home did not return an SSH public key; testbox cannot accept CLI connections.",
    );
    expect(workflow).not.toContain(
      'phone_home_ready_http=${http_code}"\n\n          echo "============================================"',
    );
    expect(workflow).not.toContain('\\"testbox_id\\": \\"${TESTBOX_ID}\\"');
    expect(workflow).not.toContain('cat > "$ready_body" <<JSON');
    expect(workflow).not.toContain('"testbox_id": "${testbox_id}"');
  });

  it("runs dependency policy guards in PR CI preflight", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("shrinkwrap)"),
    );
    const shrinkwrapGuards = workflow.slice(
      workflow.indexOf("shrinkwrap)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(workflow).toContain("check-shrinkwrap");
    expect(shrinkwrapGuards).toContain("pnpm deps:shrinkwrap:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
  });

  it("does not rebuild Control UI after build:ci-artifacts", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const buildDistStep = buildArtifactSteps.find((step) => step.name === "Build dist");

    expect(buildDistStep.run).toBe("pnpm build:ci-artifacts");
    expect(buildArtifactSteps.map((step) => step.name)).not.toContain("Build Control UI");
    expect(buildArtifactSteps.some((step) => step.run === "pnpm ui:build")).toBe(false);
  });

  it("restores the dist build cache before building and saves only cache misses", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const stepNames = buildArtifactSteps.map((step) => step.name);
    const restoreStep = buildArtifactSteps.find((step) => step.name === "Restore dist build cache");
    const buildDistStep = buildArtifactSteps.find((step) => step.name === "Build dist");
    const saveStep = buildArtifactSteps.find((step) => step.name === "Save dist build cache");

    expect(stepNames.indexOf("Restore dist build cache")).toBeLessThan(
      stepNames.indexOf("Build dist"),
    );
    expect(stepNames.indexOf("Build dist")).toBeLessThan(
      stepNames.indexOf("Pack built runtime artifacts"),
    );
    expect(stepNames.indexOf("Run built artifact checks")).toBeLessThan(
      stepNames.indexOf("Save dist build cache"),
    );
    expect(restoreStep.uses).toBe(CACHE_V5);
    expect(buildDistStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.uses).toBe("actions/cache/save@27d5ce7f107fe9357f9df03efb73ab90386fccae");
    expect(saveStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.with.key).toBe("${{ steps.dist_build_cache.outputs.cache-primary-key }}");
    expect(restoreStep.with.path).toContain("dist/");
    expect(restoreStep.with.path).toContain("dist-runtime/");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/.bundle.hash");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/*.bundle.js");
    expect(buildArtifactSteps.map((step) => step.name)).not.toContain("Cache dist build");
  });

  it("runs gateway watch after parallel built artifact checks", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const builtArtifactChecks = buildArtifactSteps.find(
      (step) => step.name === "Run built artifact checks",
    );
    const run = builtArtifactChecks.run;

    expect(run).toContain('start_check "channels"');
    expect(run).toContain('start_check "core-support-boundary"');
    expect(run).not.toContain('start_check "gateway-watch"');
    expect(run.indexOf('for index in "${!pids[@]}"')).toBeLessThan(
      run.indexOf('if [ "$RUN_GATEWAY_WATCH" = "true" ]; then'),
    );
    expect(run).toContain(
      'node scripts/check-gateway-watch-regression.mjs --skip-build >"$log" 2>&1',
    );
  });

  it("fails and retries quiet Node test shard stalls quickly", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const runStep = nodeTestJob.steps.find((step) => step.name === "Run Node test shard");

    expect(nodeTestJob["timeout-minutes"]).toBe(60);
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("300000");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBe("1");
    expect(runStep.env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("2");
  });

  it("uploads a CI timing summary after the run lanes finish", () => {
    const workflow = readCiWorkflow();
    const timingJob = workflow.jobs["ci-timings-summary"];

    expect(timingJob.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(timingJob.needs).toEqual([
      "preflight",
      "security-fast",
      "pnpm-store-warmup",
      "build-artifacts",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-additional-shard",
      "check-docs",
      "skills-python",
      "checks-windows",
      "macos-node",
      "macos-swift",
      "android",
    ]);
    expect(timingJob.if).toContain("always()");
    expect(timingJob.if).toContain("!cancelled()");

    const checkoutStep = timingJob.steps.find(
      (step) => step.name === "Checkout timing summary helper",
    );
    expect(checkoutStep.uses).toBe(CHECKOUT_V6);
    expect(checkoutStep.with.ref).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || needs.preflight.outputs.checkout_revision || github.sha }}",
    );
    expect(checkoutStep.with["persist-credentials"]).toBe(false);

    const writeStep = timingJob.steps.find((step) => step.name === "Write CI timing summary");
    expect(writeStep.env).toMatchObject({ GH_TOKEN: "${{ github.token }}" });
    expect(writeStep.run).toContain(
      'node scripts/ci-run-timings.mjs "$GITHUB_RUN_ID" --limit 25 > ci-timings-summary.txt',
    );
    expect(writeStep.run).toContain('cat ci-timings-summary.txt >> "$GITHUB_STEP_SUMMARY"');

    const uploadStep = timingJob.steps.find((step) => step.name === "Upload CI timing summary");
    expect(uploadStep.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(uploadStep.with).toMatchObject({
      name: "ci-timings-summary",
      path: "ci-timings-summary.txt",
      "retention-days": 14,
    });
  });

  it("keeps workflow guards in fast CI-routing checks", () => {
    const workflow = readCiWorkflow();
    const fastCoreJob = workflow.jobs["checks-fast-core"];
    const runStep = fastCoreJob.steps.find(
      (step) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );

    expect(runStep.run).toContain("contracts-plugins-ci-routing)");
    expect(runStep.run).toContain("ci-routing)");
    expect(runStep.run.match(/test\/scripts\/ci-workflow-guards\.test\.ts/g)?.length).toBe(2);
  });

  it("keeps push docs validation ClawHub-backed", () => {
    const workflow = readFileSync(".github/workflows/docs.yml", "utf8");

    expect(workflow).toContain("repository: openclaw/clawhub");
    expect(workflow).toContain("path: clawhub-source");
    expect(workflow).toContain(
      "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: ${{ github.workspace }}/clawhub-source",
    );
  });

  it("keeps network CodeQL off unrelated source-only refactors", () => {
    const workflow = readCriticalQualityWorkflow();
    const networkConfig = readFileSync(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
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
    expect(workflow).toContain("Network runtime boundary-sensitive added lines");
    expect(workflow).toContain("if: ${{ github.event_name != 'pull_request' }}");
  });
});
