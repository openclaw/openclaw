import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name: string; id?: string; if?: string; run?: string };
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"), {
  maxAliasCount: 10000,
}) as { jobs: Record<string, { steps: Step[] }> };

function step(job: string, name: string): Step {
  const selected = workflow.jobs[job]!.steps.find((item) => item.name === name);
  if (!selected) {
    throw new Error(`Missing ${job} step: ${name}`);
  }
  return selected;
}

function runChecks(job: string, name: string, env: Record<string, string> = {}) {
  const script = step(job, name).run!.replaceAll(
    "source .ci-harness/scripts/ci-collect-checks.sh",
    `source '${resolve("scripts/ci-collect-checks.sh")}'`,
  );
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      `${String.raw`
    pnpm() {
      printf 'CHECK %s\n' "$*"
      if [ "$1" = "$FAIL_COMMAND" ]; then return 1; fi
      return 0
    }
    env() {
      while [ "$#" -gt 0 ]; do
        case "$1" in -u) shift 2 ;; *=*) shift ;; *) break ;; esac
      done
      "$@"
    }
    node() {
      if [ "$1" = '--input-type=module' ]; then
        return 1
      elif [ "$1" = '-e' ]; then
        if [ "$FAIL_SCRIPT" != '' ] && [[ "$2" == *"$FAIL_SCRIPT"* ]]; then return 1; fi
      else
        printf 'CHECK node %s\n' "$*"
      fi
    }
    nproc() { printf '8\n'; }
    git() { if [ "$1" = cat-file ]; then return 0; fi; printf 'base\n'; }
  `}\n${script}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FROZEN_TARGET: "false",
        HISTORICAL_TARGET: "false",
        NARROW_CHECK_PATHS_JSON: "",
        CHECKOUT_BASE_SHA: "",
        CI_CORE_TYPE_GRAPHS_JSON: "",
        CI_TYPE_GRAPHS_JSON: "",
        FAIL_COMMAND: "check:max-lines-ratchet",
        FAIL_SCRIPT: "",
        ...env,
      },
    },
  );
}

describe("CI check failure collection", () => {
  it.each([
    ["native-i18n", "Check native app generated locale parity", "node_setup"],
    ["control-ui-i18n", "Check Control UI locale parity", "node_setup"],
    ["checks-ui", "Test Control UI", "ui_chromium"],
    ["checks-ui", "Install Playwright WebKit", "node_setup"],
    ["checks-ui", "Test Control UI WebKit overlays and focus", "ui_webkit"],
    ["checks-ui-e2e-real-gateway", "Prove desktop resize over node and SSH", "real_gateway_build"],
    [
      "checks-ui-e2e-real-gateway",
      "Test Control UI suites with a real Gateway",
      "real_gateway_build",
    ],
    ["check-docs", "Check config docs baseline", "node_setup"],
    ["check-docs", "Check plugin inventory", "node_setup"],
    ["check-docs", "Check docs", "clawhub_docs"],
    ["skills-python", "Test skill Python scripts", "python_tooling"],
    ["security-fast", "Audit changed GitHub workflows with zizmor", "security_scanners"],
    ["security-fast", "Detect committed private keys", "scanner_config"],
  ])("runs %s / %s after sibling failures with its prerequisite", (job, name, prerequisite) => {
    const condition = step(job, name).if;
    expect(condition).toContain("!cancelled()");
    expect(condition).toContain(`steps.${prerequisite}.outcome == 'success'`);
    expect(workflow.jobs[job]!.steps.some((item) => item.id === prerequisite)).toBe(true);
  });

  it.each([
    [
      "guards",
      "pnpm lint:auth:pairing-account-scope",
      {
        FAIL_COMMAND: "check:no-conflict-markers",
        RUN_PR_MADGE_IMPORT_CYCLES: "true",
        RUN_PR_KYSELY_GUARDRAILS: "true",
      },
    ],
    [
      "lint",
      "pnpm format:check",
      {
        FAIL_COMMAND: "lint",
        HOSTED_RUNNER_STRIPES: "false",
        FORMAT_CHECK: "true",
        RUN_UI_TESTS: "true",
        RELEASE_GATE: "false",
        RUN_CONTROL_UI_I18N: "false",
      },
    ],
    [
      "test-types",
      "pnpm tsgo:test:root",
      {
        FAIL_COMMAND: "tsgo:extensions:test",
        HOSTED_RUNNER_STRIPES: "false",
        CHANGED_CORE_TEST_PATHS_JSON: '["src/a.test.ts"]',
      },
    ],
  ] as const)("collects later %s checks and preserves failure", (task, last, env) => {
    const result = runChecks("check-shard", "Run check shard", { TASK: task, ...env });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(last.replace("pnpm ", "CHECK "));
    if (task === "guards") {
      expect(result.stdout).toContain("CHECK check:madge-import-cycles");
      expect(result.stdout).toContain("CHECK lint:kysely");
    }
  });

  it("finishes every baseline ratchet after the first failure", () => {
    const result = runChecks("checks-baseline-ratchets", "Run baseline ratchets", {
      RATCHET_BASE_REF: "base",
      RATCHET_PR_HEAD_SHA: "",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("CHECK check:max-lines-ratchet --base base");
    expect(result.stdout).toContain("CHECK plugins:inventory:check");
    expect(result.stdout.match(/^CHECK /gm)).toHaveLength(8);
  });

  it("runs protocol checks after bundled tests fail", () => {
    const result = runChecks("checks-fast-core", "Run ${{ matrix.task }} (${{ matrix.runtime }})", {
      FAIL_COMMAND: "test:bundled",
      TASK: "bundled-protocol",
      RUN_BUNDLED_TESTS: "true",
      PROTOCOL_SINCE_BASE_SHA: "base",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("CHECK test:bundled");
    expect(result.stdout).toContain("CHECK protocol:check");
  });

  it("finishes main-push security ratchets and protocol checks after a failure", () => {
    const result = runChecks("security-fast", "Check main push ratchets and protocol additions", {
      BASE_SHA: "base",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout.match(/^CHECK /gm)).toHaveLength(7);
    expect(result.stdout).toContain("scripts/check-protocol-since.mts");
  });

  it("finishes legacy native locale checks after a failed native check", () => {
    const result = runChecks("native-i18n", "Verify native app i18n source", {
      FAIL_SCRIPT: "native:i18n:verify",
      FAIL_COMMAND: "native:i18n:check",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout.match(/^CHECK /gm)).toHaveLength(3);
    expect(result.stdout).toContain("CHECK android:i18n:check");
    expect(result.stdout).toContain("CHECK apple:i18n:check");
  });
});
