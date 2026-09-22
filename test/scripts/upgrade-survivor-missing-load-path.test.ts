import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { parseUpgradeSurvivorScenarios } from "../../scripts/lib/upgrade-survivor-policy.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readUpgradeSurvivorPaths } from "./upgrade-survivor-paths.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const assertionsPath = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

it("plans the named missing-load-path row without adding aggregate coverage", () => {
  const { plan } = resolveDockerE2ePlan({
    includeOpenWebUI: false,
    liveMode: "all",
    liveRetries: 0,
    orderLanes: (lanes) => lanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames: ["published-upgrade-survivor"],
    timingStore: undefined,
    upgradeSurvivorBaselines: "2026.9.3",
    upgradeSurvivorScenarios: "missing-load-path",
  });
  expect(plan.lanes).toHaveLength(1);
  expect(plan.lanes[0]).toMatchObject({
    name: "published-upgrade-survivor-2026.9.3-missing-load-path",
    command: expect.stringContaining("OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='missing-load-path'"),
  });
  for (const aggregate of ["reported-issues", "far-reaching"]) {
    expect(parseUpgradeSurvivorScenarios(aggregate)).not.toContain("missing-load-path");
  }
});

it("dispatches missing-load-path fixture stages through the assertion entrypoint", () => {
  const root = tempDirs.make("openclaw-missing-load-path-dispatch-");
  const configPath = path.join(root, "openclaw.json");
  const paths = readUpgradeSurvivorPaths(root, {
    OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "missing-load-path",
  });
  const artifactRoot = paths.artifactRoot;
  const pluginRoot = path.join(root, "custom-plugins", "survivor-unavailable-path");
  writeFileSync(configPath, JSON.stringify({ plugins: { allow: [], entries: {} } }));
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    ...paths.env,
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifactRoot,
  };
  const run = (stage: string) =>
    execFileSync(resolveTestNodeExecPath(), [assertionsPath, "missing-load-path", stage], {
      env,
      encoding: "utf8",
    });

  run("seed");
  expect(existsSync(path.join(pluginRoot, "openclaw.plugin.json"))).toBe(true);
  const seededConfig = readFileSync(configPath, "utf8");
  writeFileSync(
    path.join(artifactRoot, "missing-load-path", "baseline-registration.json"),
    JSON.stringify({ source: pathToFileURL(path.join(pluginRoot, "index.mjs")).href }),
  );

  expect(run("unavailable")).toContain("Removed loaded baseline plugin source before update:");
  expect(existsSync(pluginRoot)).toBe(false);
  expect(readFileSync(configPath, "utf8")).toBe(seededConfig);
});
