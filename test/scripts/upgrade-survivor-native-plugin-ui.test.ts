import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  backupRollbackProof,
  readJson,
  successSummary,
  writeJson,
} from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function proof(policy: string, eligible: boolean, baselineVersion = "2026.10.5") {
  return {
    status: "passed",
    stage: "candidate",
    policy,
    servingVersion: "2026.10.20",
    eligible,
    pluginSettingsPreserved: true,
    operatorDataPreserved: true,
    installed: {
      archiveSha256: "b".repeat(64),
      files: { "index.mjs": "c".repeat(64) },
      packageRoot: "/private/native-ui-fixture/package",
    },
    plugin: { config: { label: "private-native-ui-fixture-setting" } },
    assets: eligible
      ? [
          { status: 200, authenticated: true, sha256: "d".repeat(64) },
          { status: 200, authenticated: true, sha256: "e".repeat(64) },
          { status: 401, authenticated: false },
        ]
      : [
          { status: 404, authenticated: true },
          { status: 404, authenticated: true },
        ],
    baseline: {
      status: "passed",
      stage: "baseline",
      policy,
      servingVersion: baselineVersion,
      eligible: false,
      pluginSettingsPreserved: true,
      operatorDataPreserved: true,
    },
  };
}
function publish(overrides: Record<string, unknown>, baselineVersion = "2026.10.5") {
  const root = dirs.make("native-ui-upgrade-publication-");
  const output = path.join(root, "public");
  writeJson(
    path.join(root, "summary.json"),
    successSummary(baselineVersion, "2026.10.20", {
      backupRollback: backupRollbackProof(baselineVersion, "2026.10.20"),
      phases: [
        {
          phase: "prepare-native-plugin-ui-upgrade",
          status: "passed",
          at: "2026-10-20T18:00:00.000Z",
        },
      ],
      ...overrides,
    }),
  );
  publishDiagnostics(root, output, (value: string) => value, "passed");
  return readJson(path.join(output, "summary.json"));
}

it.each(["2026.10.5", "2026.10.7", "2026.10.8"])(
  "projects %s policy receipts without publishing raw plugin state",
  (baselineVersion) => {
    const result = publish(
      {
        nativePluginUi: proof("omitted", true, baselineVersion),
        nativePluginUiOptOut: proof("false", false, baselineVersion),
      },
      baselineVersion,
    );
    expect(result.nativePluginUi).toEqual({
      status: "passed",
      baselineVersion,
      candidateVersion: "2026.10.20",
      fixtureArchiveSha256: "b".repeat(64),
      omittedBecameEligible: true,
      explicitFalsePreserved: true,
      authenticatedAssetsServed: true,
      unauthenticatedAssetsDenied: true,
      optedOutAssetsDenied: true,
      pluginSettingsPreserved: true,
      operatorDataPreserved: true,
    });
    expect(JSON.stringify(result)).not.toContain("private-native-ui-fixture");
  },
);

it("cannot publish a generic green or an unqualified opt-out as feature upgrade proof", () => {
  expect(() => publish({})).toThrow("native plugin UI upgrade evidence");
  const optOut = proof("false", false);
  optOut.baseline.policy = "omitted";
  expect(() =>
    publish({ nativePluginUi: proof("omitted", true), nativePluginUiOptOut: optOut }),
  ).toThrow("native plugin UI upgrade evidence");
  optOut.baseline.policy = "false";
  optOut.assets[0]!.status = 200;
  expect(() =>
    publish({ nativePluginUi: proof("omitted", true), nativePluginUiOptOut: optOut }),
  ).toThrow("native plugin UI upgrade evidence");
});
