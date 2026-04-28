import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findLaneByName } from "../../scripts/lib/docker-e2e-plan.mjs";
import {
  PLUGIN_PRERELEASE_REQUIRED_SURFACES,
  assertPluginPrereleaseTestPlanComplete,
  createPluginPrereleaseTestPlan,
} from "../../scripts/lib/plugin-prerelease-test-plan.mjs";

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

describe("scripts/lib/plugin-prerelease-test-plan.mjs", () => {
  it("covers every pre-release plugin skill surface in normal CI", () => {
    const plan = assertPluginPrereleaseTestPlanComplete();

    expect(plan.surfaces).toEqual(
      [...PLUGIN_PRERELEASE_REQUIRED_SURFACES].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("runs the package and Docker product lanes through the existing scheduler", () => {
    const plan = createPluginPrereleaseTestPlan();

    expect(plan.dockerLanes).toEqual([
      "npm-onboard-channel-agent",
      "doctor-switch",
      "update-channel-switch",
      "bundled-channel-deps-compat",
      "plugins-offline",
      "plugins",
      "plugin-update",
      "config-reload",
      "gateway-network",
      "mcp-channels",
      "cron-mcp-cleanup",
      "bundled-plugin-install-uninstall-0",
      "bundled-plugin-install-uninstall-1",
      "bundled-plugin-install-uninstall-2",
      "bundled-plugin-install-uninstall-3",
      "bundled-plugin-install-uninstall-4",
      "bundled-plugin-install-uninstall-5",
      "bundled-plugin-install-uninstall-6",
      "bundled-plugin-install-uninstall-7",
    ]);

    for (const lane of plan.dockerLanes) {
      expect(findLaneByName(lane), lane).toBeTruthy();
    }
  });

  it("keeps live-ish coverage credential-gated in PR CI", () => {
    const plan = createPluginPrereleaseTestPlan();

    expect(plan.dockerLanes).not.toContain("openai-web-search-minimal");
    expect(plan.dockerLanes.some((lane) => lane.startsWith("live-"))).toBe(false);
    expect(plan.staticChecks).toContainEqual({
      check: "live-ish-availability",
      checkName: "checks-plugin-prerelease-live-ish-availability",
      command: "node scripts/plugin-prerelease-liveish-matrix.mjs",
      surfaces: ["live-ish-availability"],
    });
  });

  it("keeps SDK/package boundary checks inside the plugin prerelease suite", () => {
    const plan = createPluginPrereleaseTestPlan();

    expect(plan.staticChecks.map((check) => check.checkName)).toEqual([
      "checks-plugin-prerelease-package-boundary-compile",
      "checks-plugin-prerelease-package-boundary-canary",
      "checks-plugin-prerelease-live-ish-availability",
    ]);
  });

  it("wires the full plugin prerelease plan into the mega CI workflow", () => {
    const workflow = readCiWorkflow();
    const preflight = workflow.jobs.preflight;
    const staticShard = workflow.jobs["plugin-prerelease-static-shard"];
    const dockerSuite = workflow.jobs["plugin-prerelease-docker-suite"];
    const suite = workflow.jobs["plugin-prerelease-suite"];

    expect(preflight.outputs).toMatchObject({
      plugin_prerelease_docker_lanes:
        "${{ steps.manifest.outputs.plugin_prerelease_docker_lanes }}",
      plugin_prerelease_ref: "${{ steps.manifest.outputs.plugin_prerelease_ref }}",
      plugin_prerelease_static_matrix:
        "${{ steps.manifest.outputs.plugin_prerelease_static_matrix }}",
      run_plugin_prerelease_suite: "${{ steps.manifest.outputs.run_plugin_prerelease_suite }}",
    });
    expect(staticShard).toMatchObject({
      name: "${{ matrix.check_name }}",
      "runs-on": "blacksmith-8vcpu-ubuntu-2404",
    });
    expect(staticShard.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.plugin_prerelease_static_matrix) }}",
    );
    expect(
      staticShard.steps.find((step) => step.name === "Run plugin prerelease static shard").run,
    ).toContain('bash -c "$PLUGIN_PRERELEASE_COMMAND"');
    expect(dockerSuite).toMatchObject({
      if: "needs.preflight.outputs.run_plugin_prerelease_suite == 'true'",
      needs: ["preflight"],
      uses: "./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      with: {
        docker_lanes: "${{ needs.preflight.outputs.plugin_prerelease_docker_lanes }}",
        include_live_suites: false,
        include_openwebui: false,
        include_release_path_suites: false,
        include_repo_e2e: false,
        live_models_only: false,
        ref: "${{ needs.preflight.outputs.plugin_prerelease_ref }}",
      },
    });
    expect(dockerSuite.secrets).toBeUndefined();
    expect(suite.needs).toEqual([
      "preflight",
      "plugin-prerelease-static-shard",
      "plugin-prerelease-docker-suite",
    ]);
  });

  it("keeps the live-ish availability check redacted", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/plugin-prerelease-liveish-matrix.mjs"],
      {
        encoding: "utf8",
        env: {
          DISCORD_TOKEN: "discord-token-should-not-print",
          OPENAI_API_KEY: "openai-token-should-not-print",
        },
      },
    );

    expect(output).toContain("provider-openai: present (OPENAI_API_KEY, OPENAI_BASE_URL)");
    expect(output).toContain("channel-discord: present (DISCORD_TOKEN, OPENCLAW_DISCORD_TOKEN)");
    expect(output).not.toContain("openai-token-should-not-print");
    expect(output).not.toContain("discord-token-should-not-print");
  });
});
