import { describe, expect, it } from "vitest";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";

type ManifestOptions = Parameters<typeof runCiManifestFixture>[0];
const notice = "::notice title=Native Bun qualification staleness::";
const heading = "### Native Bun qualification staleness";
const stale: NonNullable<ManifestOptions["nativeBunInspection"]>["report"] = {
  staleEntries: ["src/<entry>&.test.ts", "src/other.test.ts"],
  changedInputs: [
    { file: "test/<setup>&\n::error::injected.ts", reason: "changed" },
    { file: "test/missing-helper.ts", reason: "unreadable" },
  ],
};

function manifest(options: Partial<ManifestOptions> = {}) {
  return runCiManifestFixture({
    bundledPlanner: true,
    sourceChannelPolicy: true,
    bunTestRuntime: true,
    eventName: "pull_request",
    historicalCompatibility: false,
    changedPaths: ["scripts/lib/ci-test-runtime.mts"],
    nodeTestShards: [1, 2].map((index) => ({
      checkName: `checks-node-fixture-${index}`,
      shardName: `fixture-${index}`,
      configs: ["fixture-bun.config.ts"],
      runner: "blacksmith-4vcpu-ubuntu-2404",
    })),
    scopeEnv: { GITHUB_ACTIONS: "true" },
    ...options,
  });
}

function notices(result: ReturnType<typeof manifest>) {
  return result.manifestStderr.split(/\r?\n/u).filter((line) => line.startsWith(notice));
}

describe("native Bun qualification preflight notice", () => {
  it("reports once across matrix rows without changing outputs or exposing paths as commands", () => {
    const healthy = manifest({
      nativeBunInspection: { report: { staleEntries: [], changedInputs: [] } },
    });
    const reported = manifest({ nativeBunInspection: { report: stale } });
    expect(healthy.status, healthy.output).toBe(0);
    expect(reported.status, reported.output).toBe(0);
    expect(healthy.nativeBunInspectionCalls).toBe(1);
    expect(reported.nativeBunInspectionCalls).toBe(1);
    expect(notices(healthy)).toEqual([]);
    expect(healthy.summary).not.toContain(heading);
    expect(reported.outputs).toEqual(healthy.outputs);
    expect(notices(reported)).toHaveLength(1);
    expect(reported.manifestStdout).not.toContain(notice);
    expect(reported.manifestStderr).not.toContain("::error::");
    expect(reported.summary.split(heading)).toHaveLength(2);
    expect(reported.summary).toContain("src/&lt;entry&gt;&amp;.test.ts");
    expect(reported.summary).toContain("test/&lt;setup&gt;&amp;");
    expect(reported.summary).toContain("test/missing-helper.ts");
    expect(reported.summary).toContain("changed");
    expect(reported.summary).toContain("unreadable");
  });

  it.each([
    {
      name: "local CI-style invocation",
      options: {
        nativeBunInspection: { report: stale },
        scopeEnv: { CI: "true", GITHUB_ACTIONS: "false" },
      },
    },
    {
      name: "historical target without the inspection export",
      options: { eventName: "workflow_dispatch" as const, historicalCompatibility: true },
    },
  ])("stays silent for $name", ({ options }) => {
    const result = manifest(options);
    expect(result.status, result.output).toBe(0);
    expect(result.nativeBunInspectionCalls).toBe(0);
    expect(notices(result)).toEqual([]);
    expect(result.summary).not.toContain(heading);
  });

  it.each(["inspect", "summary"] as const)(
    "keeps CI successful when the optional %s report fails",
    (failure) => {
      const result = manifest({ nativeBunInspection: { report: stale, failure } });
      expect(result.status, result.output).toBe(0);
      expect(result.nativeBunInspectionCalls).toBe(1);
      expect(notices(result)).toHaveLength(1);
      expect(notices(result)[0]).toMatch(
        failure === "summary" ? /summary unavailable/iu : /could not inspect/iu,
      );
      expect(result.manifestStdout).not.toContain(notice);
      expect(result.summary).toContain("### CI release qualification");
      expect(result.outputs.run_node).toBe("true");
    },
  );
});
