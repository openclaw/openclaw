// Plugin npm publication result tests close extended-stable matrix evidence.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveExtendedStablePluginCandidateTag } from "../../scripts/lib/plugin-npm-release.js";
import { buildExtendedStablePluginPublicationResult } from "../../scripts/plugin-npm-publication-result.js";

const identity = {
  repository: "openclaw/openclaw",
  workflowPath: ".github/workflows/plugin-npm-release.yml",
  workflowRef: "refs/heads/main",
  workflowSha: "b".repeat(40),
  runId: "123",
  runAttempt: "2",
};

function records() {
  const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  return ["slack", "codex", "discord"].map((pluginId) =>
    Object.assign({}, identity, {
      packageName: `@openclaw/${pluginId}`,
      version,
      npmIntegrity: `sha512-${pluginId}`,
      candidateTag: deriveExtendedStablePluginCandidateTag({ pluginId, version }),
      provenanceVerified: true,
      sourceSha: "b".repeat(40),
    }),
  );
}

describe("extended-stable plugin publication result", () => {
  it("sorts and closes exactly one record for every covered package", () => {
    const result = buildExtendedStablePluginPublicationResult({
      records: records(),
      sourceSha: "b".repeat(40),
      identity,
    });

    expect(result.plugins.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/codex",
      "@openclaw/discord",
      "@openclaw/slack",
    ]);
    expect(result.workflow).toEqual(identity);
  });

  it("rejects missing packages, wrong tags, and unverified provenance", () => {
    expect(() =>
      buildExtendedStablePluginPublicationResult({
        records: records().slice(1),
        sourceSha: "b".repeat(40),
        identity,
      }),
    ).toThrow(/must contain exactly/u);

    const wrongTag = records();
    wrongTag[0] = { ...wrongTag[0], candidateTag: "extended-stable" };
    expect(() =>
      buildExtendedStablePluginPublicationResult({
        records: wrongTag,
        sourceSha: "b".repeat(40),
        identity,
      }),
    ).toThrow(/candidate tag must be/u);

    const unverified = records();
    unverified[0] = { ...unverified[0], provenanceVerified: false };
    expect(() =>
      buildExtendedStablePluginPublicationResult({
        records: unverified,
        sourceSha: "b".repeat(40),
        identity,
      }),
    ).toThrow(/provenanceVerified must be true/u);
  });
});
