import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  acceptanceScenarioIds,
  parseExtendedStablePluginAcceptanceResult,
} from "../../scripts/lib/extended-stable-plugin-acceptance.js";
import { verifySelectorHandoff } from "../../scripts/verify-extended-stable-selector-handoff.js";

const ACCEPTANCE_WORKFLOW = ".github/workflows/extended-stable-plugin-acceptance.yml";
const RELEASE_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";

function validAcceptanceResult() {
  return {
    schemaVersion: 1,
    inputs: {
      releaseVersion: "2026.6.33",
      pluginPackageName: "@openclaw/slack",
    },
    resolved: {
      coreVersion: "2026.6.33",
      coreIntegrity: `sha512-${"A".repeat(86)}==`,
      pluginIntegrity: `sha512-${"B".repeat(86)}==`,
      acceptanceProfile: "slack-channel-v1",
    },
    workflow: {
      repository: "openclaw/openclaw",
      path: ACCEPTANCE_WORKFLOW,
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      runId: 123,
      runAttempt: 1,
      event: "workflow_dispatch",
    },
    scenarios: acceptanceScenarioIds("slack-channel-v1").map((id) => ({
      id,
      status: "passed",
    })),
    conclusion: "succeeded",
  };
}

function validSelectorHandoff() {
  const packageNames = ["@openclaw/codex", "@openclaw/discord", "@openclaw/slack"];
  const selectorState = Object.fromEntries(
    ["openclaw", ...packageNames].map((packageName) => [
      packageName,
      { latest: "2026.7.2", extendedStable: "2026.6.32" },
    ]),
  );
  return {
    schemaVersion: 1,
    handoffId: "openclaw/openclaw:123:2026.6.33",
    releaseVersion: "2026.6.33",
    sourceSha: "a".repeat(40),
    core: {
      publicationRunId: "100",
      publicationRunAttempt: "1",
      publicationArtifactDigest: `sha256:${"1".repeat(64)}`,
      version: "2026.6.33",
      npmIntegrity: "sha512-core",
      candidateTag: "extended-stable-candidate-2026-6-33",
    },
    pluginPublication: {
      sourceSha: "a".repeat(40),
      publicationRunId: "101",
      publicationRunAttempt: "1",
      publicationArtifactDigest: `sha256:${"2".repeat(64)}`,
      publicationResultSha256: "3".repeat(64),
      plugins: packageNames.map((packageName) => {
        const pluginId = packageName.slice("@openclaw/".length);
        return {
          packageName,
          version: "2026.6.33",
          npmIntegrity: `sha512-${pluginId}`,
          candidateTag: `extended-stable-plugin-candidate-${pluginId}-2026-6-33`,
        };
      }),
    },
    acceptances: packageNames.map((packageName, index) => ({
      packageName,
      npmIntegrity: `sha512-${packageName.slice("@openclaw/".length)}`,
      workflowSha: "b".repeat(40),
      acceptanceRunId: 200 + index,
      acceptanceRunAttempt: 1,
      acceptanceArtifactDigest: `sha256:${String(index + 4).repeat(64)}`,
      acceptanceResultSha256: String(index + 7).repeat(64),
    })),
    selectorsBefore: selectorState,
    selectorsAfter: structuredClone(selectorState),
    selectorOrder: ["plugins", "core"],
    conclusion: "ready_for_protected_selector_promotion",
  };
}

describe("extended-stable plugin release artifacts", () => {
  it("accepts the closed successful acceptance schema", () => {
    expect(parseExtendedStablePluginAcceptanceResult(validAcceptanceResult())).toEqual(
      validAcceptanceResult(),
    );
  });

  it("rejects extra fields and incomplete scenario results", () => {
    expect(() =>
      parseExtendedStablePluginAcceptanceResult({ ...validAcceptanceResult(), proof: true }),
    ).toThrow("must contain exactly");

    const incomplete = validAcceptanceResult();
    incomplete.scenarios.pop();
    expect(() => parseExtendedStablePluginAcceptanceResult(incomplete)).toThrow("canonical order");
  });

  it("binds candidate tags, package integrities, and unchanged shared selectors", () => {
    const handoff = validSelectorHandoff();
    expect(() => verifySelectorHandoff(handoff)).not.toThrow();

    const mismatched = validSelectorHandoff();
    mismatched.acceptances[0]!.npmIntegrity = "sha512-wrong";
    expect(() => verifySelectorHandoff(mismatched)).toThrow(/integrity does not match/u);

    const moved = validSelectorHandoff();
    moved.selectorsAfter.openclaw!.extendedStable = "2026.6.33";
    expect(() => verifySelectorHandoff(moved)).toThrow(/shared selectors changed/u);
  });

  it("keeps acceptance on protected main with two closed inputs and immutable evidence", () => {
    const source = readFileSync(ACCEPTANCE_WORKFLOW, "utf8");
    const workflow = parse(source) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      jobs?: Record<
        string,
        {
          if?: string;
          steps?: Array<{
            name?: string;
            if?: string;
            env?: Record<string, string>;
            run?: string;
          }>;
        }
      >;
    };
    expect(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {}).toSorted()).toEqual([
      "plugin_package_name",
      "release_version",
    ]);
    expect(workflow.jobs?.accept?.if).toBeUndefined();
    expect(source).toContain("ref: ${{ github.sha }}");
    expect(source).toContain('${GITHUB_REF}" != "refs/heads/main"');
    expect(source).toContain("scripts/run-extended-stable-plugin-acceptance.ts");
    const upload = workflow.jobs?.accept?.steps?.find(
      (step) => step.name === "Upload immutable acceptance result",
    );
    expect(upload?.if).toContain("always()");
    const acceptanceStep = workflow.jobs?.accept?.steps?.find(
      (step) => step.name === "Run exact package acceptance",
    );
    expect(acceptanceStep?.env).toMatchObject({
      PLUGIN_PACKAGE_NAME: "${{ inputs.plugin_package_name }}",
      RELEASE_VERSION: "${{ inputs.release_version }}",
    });
    expect(acceptanceStep?.run).not.toContain("${{ inputs.");
  });

  it("routes extended-stable through candidate publication and a closed selector handoff", () => {
    const source = readFileSync(RELEASE_WORKFLOW, "utf8");
    expect(source).toContain("- extended-stable");
    expect(source).toContain("plugin_publish_scope=extended-stable");
    expect(source).toContain("scripts/orchestrate-extended-stable-plugin-release.ts");
    expect(source).toContain("extended-stable-selector-handoff-${{ github.run_id }}");
    expect(source).toContain("inputs.npm_dist_tag != 'extended-stable'");
    expect(source).toContain("inputs.npm_dist_tag == 'extended-stable'");

    const orchestrator = readFileSync(
      "scripts/orchestrate-extended-stable-plugin-release.ts",
      "utf8",
    );
    expect(orchestrator).toContain('"plugin-npm-release.yml"');
    expect(orchestrator).toContain('"openclaw-npm-release.yml"');
    expect(orchestrator).toContain('"extended-stable-plugin-acceptance.yml"');
    expect(orchestrator).toContain('selectorOrder: ["plugins", "core"]');
    expect(orchestrator).toContain('conclusion: "ready_for_protected_selector_promotion"');
    expect(orchestrator).toContain("verifySelectorHandoff(handoff, rootDir)");
    expect(orchestrator).toContain('extendedStable: read("extended-stable")');
    expect(orchestrator).toContain("Candidate publication moved one or more shared selectors");
    expect(orchestrator).toContain("actions/workflows/${workflow}/runs");
    expect(orchestrator).toContain("matched multiple new runs; refusing to guess");
    expect(orchestrator).not.toContain("run.actor?.login");
    expect(orchestrator).not.toContain("dispatch did not return an Actions run URL");
    expect(orchestrator).not.toContain("plugin-clawhub-release.yml");
    expect(orchestrator).not.toContain("windows-node-release.yml");

    expect(source).toContain("10#${extended_stable_patch} < 33");
    expect(source).not.toContain("[3-9][0-9]|[1-9][0-9]{2,}");
  });

  it("allows the exact extended-stable branch in the plugin publisher", () => {
    const source = readFileSync(".github/workflows/plugin-npm-release.yml", "utf8");
    expect(source).toContain("+refs/heads/extended-stable/*:refs/remotes/origin/extended-stable/*");
    expect(source).toContain("^refs/heads/extended-stable/");
  });
});
