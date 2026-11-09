import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps first-party generated Swift findings while removing dependency-only findings", () => {
  const workflow = parse(
    readFileSync(".github/workflows/codeql-macos-critical-security.yml", "utf8"),
  ) as { jobs: { macos: { steps: { name: string; run?: string }[] } } };
  const script = workflow.jobs.macos.steps.find(
    (step) => step.name === "Remove dependency build results",
  )?.run;
  if (!script) {
    throw new Error("Missing macOS CodeQL SARIF filter");
  }

  const dependency = "apps/macos/.build/checkouts/dependency/Sources/Example.swift";
  const generated =
    "apps/macos/.build/plugins/outputs/openclawkit/OpenClawProtocol/destination/GenerateGatewayProtocol/GatewayModels.swift";
  const handwritten = "apps/macos/Sources/OpenClaw/GatewayConnection.swift";
  const finding = (ruleId: string, ...locations: string[]) => ({
    ruleId,
    locations: locations.map((uri) => ({ physicalLocation: { artifactLocation: { uri } } })),
  });
  const root = tempDirs.make("codeql-macos-sarif-");
  const input = path.join(root, "sarif-results");
  mkdirSync(input);
  writeFileSync(
    path.join(input, "swift.sarif"),
    JSON.stringify({
      runs: [
        {
          results: [
            finding("dependency", dependency),
            finding("generated", generated),
            finding("handwritten", handwritten),
            finding("mixed", dependency, generated),
            finding("unknown"),
          ],
        },
      ],
    }),
  );

  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, SARIF_OUTPUT: input },
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const filtered = JSON.parse(
    readFileSync(path.join(root, "sarif-results-filtered", "swift.sarif"), "utf8"),
  ) as { runs: { results: { ruleId: string }[] }[] };
  expect(filtered.runs[0]?.results.map((entry) => entry.ruleId)).toEqual([
    "generated",
    "handwritten",
    "mixed",
    "unknown",
  ]);
});
