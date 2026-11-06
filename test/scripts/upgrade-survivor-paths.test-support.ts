import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const UPGRADE_SURVIVOR_PATHS_HELPER = path.resolve(
  "scripts/e2e/lib/upgrade-survivor/paths.sh",
);

/** Read the harness's resolved facts without creating state or choosing a second layout. */
export function readUpgradeSurvivorPaths(root: string, overrides: NodeJS.ProcessEnv = {}) {
  const env = {
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
    OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
    OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(root, "artifacts", "summary.json"),
    ...overrides,
  };
  const values = execFileSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source "$1"
resolve_upgrade_survivor_paths
printf '%s\\0' "$ARTIFACT_ROOT" "$RUNTIME_ROOT" "$npm_config_prefix" "$BASELINE_PACKAGE_ROOT" "$BASELINE_BIN_DIR" "$SUMMARY_JSON" "$BASELINE_INSTALL_LOG" "$UPDATE_JSON" "$UPDATE_ERR"`,
      "survivor-paths",
      UPGRADE_SURVIVOR_PATHS_HELPER,
    ],
    { env: { PATH: process.env.PATH, ...env, BASH_ENV: "", ENV: "" }, encoding: "utf8" },
  ).split("\0");
  assert.equal(values.pop(), "");
  assert.equal(values.length, 9);
  const [
    artifactRoot,
    runtimeRoot,
    npmPrefix,
    packageRoot,
    binDir,
    summaryJson,
    baselineInstallLog,
    updateJson,
    updateErr,
  ] = values;
  assert(
    artifactRoot &&
      runtimeRoot &&
      npmPrefix &&
      packageRoot &&
      binDir &&
      summaryJson &&
      baselineInstallLog &&
      updateJson &&
      updateErr,
  );
  return {
    env,
    artifactRoot,
    runtimeRoot,
    npmPrefix,
    packageRoot,
    binDir,
    summaryJson,
    baselineInstallLog,
    updateJson,
    updateErr,
  };
}
