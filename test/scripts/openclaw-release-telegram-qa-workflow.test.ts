import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/openclaw-release-telegram-qa.yml";

type WorkflowJob = {
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  steps?: Array<{
    env?: Record<string, unknown>;
    name?: string;
    run?: string;
  }>;
};

describe("release Telegram QA workflow", () => {
  it("keeps the isolated SUT lifetime below the credential lease TTL", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const job = workflow.jobs?.run_telegram;
    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.["timeout-minutes"]).toBe(60);

    const validateStep = job?.steps?.find(
      (step) => step.name === "Validate required QA credential env",
    );
    expect(validateStep?.env?.RUNNER_ENVIRONMENT).toBe("${{ runner.environment }}");
    expect(validateStep?.env?.JOB_TIMEOUT_MINUTES).toBe("60");
    expect(validateStep?.env?.LEASE_TTL_MS).toBe("7200000");
    expect(validateStep?.run).toContain('[[ "$RUNNER_ENVIRONMENT" == "github-hosted" ]]');
    expect(validateStep?.run).toContain("JOB_TIMEOUT_MINUTES * 60 * 1000 < LEASE_TTL_MS");

    const runStep = job?.steps?.find((step) => step.name === "Run Telegram live lane");
    expect(runStep?.env?.OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS).toBe("7200000");
    expect(runStep?.env?.OPENCLAW_QA_TELEGRAM_SUT_CLEANUP_TIMEOUT_MS).toBe("60000");
    expect(runStep?.run).toContain("trap terminate_sut_uid_on_exit EXIT");
    expect(runStep?.run).toContain('"$OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND" --terminate-uid');
  });

  it("serializes stderr behind the workflow-command pause", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const runStep = workflow.jobs?.run_telegram?.steps?.find(
      (step) => step.name === "Run Telegram live lane",
    );
    expect(runStep?.run).toMatch(
      /run_qa_attempt\(\) \(\n\s+set -euo pipefail\n\s+exec 2>&1\n\s+attempt=/u,
    );
    expect(runStep?.run).toContain("::stop-commands::%s");
  });

  it("derives SUT-writable paths from the verified runtime root after sudo", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    expect(source).toContain('temp_root="$(realpath -e "${OPENCLAW_QA_TEMP_ROOT:?}")"');
    expect(source).toContain('proc_stat="$(cat "/proc/${pid}/stat")"');
    expect(source).not.toContain('proc_stat="$(cat /proc/self/stat)"');
    expect(source).toContain('if [[ "${1:-}" == "--root-verify" ]]');
    expect(source).toContain("signal.pidfd_send_signal(pidfd, signal_value)");
    expect(source).toContain('actual_executable="$(realpath -e "/proc/${pid}/exe")"');
    expect(source).toContain("cmdlineSha256: $cmdlineSha256");
    expect(source).toContain('export HOME="${temp_root}/home"');
    expect(source).toContain('export XDG_CONFIG_HOME="${temp_root}/xdg-config"');
    expect(source).toContain('if [[ "${1:-}" == "--root-terminate-uid" ]]');
  });
});
