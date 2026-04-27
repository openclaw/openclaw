import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PACKAGE_ACCEPTANCE_WORKFLOW = ".github/workflows/package-acceptance.yml";
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const DOCKER_E2E_PLAN_ACTION = ".github/actions/docker-e2e-plan/action.yml";
const NPM_TELEGRAM_WORKFLOW = ".github/workflows/npm-telegram-beta-e2e.yml";

describe("package acceptance workflow", () => {
  it("resolves candidate package sources before reusing Docker E2E lanes", () => {
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");

    expect(workflow).toContain("name: Package Acceptance");
    expect(workflow).toContain("source:");
    expect(workflow).toContain("- npm");
    expect(workflow).toContain("- ref");
    expect(workflow).toContain("- url");
    expect(workflow).toContain("- artifact");
    expect(workflow).toContain("scripts/resolve-openclaw-package-candidate.mjs");
    expect(workflow).toContain('gh run download "$ARTIFACT_RUN_ID"');
    expect(workflow).toContain("name: ${{ env.PACKAGE_ARTIFACT_NAME }}");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain(
      "uses: ./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
    );
    expect(workflow).toContain(
      "package_artifact_name: ${{ needs.resolve_package.outputs.package_artifact_name }}",
    );
  });

  it("offers bounded product profiles and keeps Telegram published-npm only", () => {
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");

    expect(workflow).toContain("suite_profile:");
    expect(workflow).toContain("npm-onboard-channel-agent gateway-network config-reload");
    expect(workflow).toContain("install-e2e npm-onboard-channel-agent doctor-switch");
    expect(workflow).toContain("include_release_path_suites=true");
    expect(workflow).toContain("telegram_mode requires source=npm");
    expect(workflow).toContain("uses: ./.github/workflows/npm-telegram-beta-e2e.yml");
  });
});

describe("package artifact reuse", () => {
  it("lets reusable Docker E2E consume an already resolved package artifact", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const action = readFileSync(DOCKER_E2E_PLAN_ACTION, "utf8");

    expect(workflow).toContain("package_artifact_name:");
    expect(workflow).toContain("Download provided OpenClaw Docker E2E package");
    expect(workflow).toContain("inputs.package_artifact_name != ''");
    expect(workflow).toContain('image_tag="${PACKAGE_TAG:-$SELECTED_SHA}"');
    expect(workflow).toContain(
      "package-artifact-name: ${{ inputs.package_artifact_name || 'docker-e2e-package' }}",
    );
    expect(action).toContain("package-artifact-name:");
    expect(action).toContain("name: ${{ inputs.package-artifact-name }}");
  });

  it("allows the npm Telegram lane to run from reusable package acceptance", () => {
    const workflow = readFileSync(NPM_TELEGRAM_WORKFLOW, "utf8");

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("provider_mode:");
    expect(workflow).toContain("provider_mode must be mock-openai or live-frontier");
  });
});
