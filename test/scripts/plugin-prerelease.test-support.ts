import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

type WorkflowStep = Partial<Record<"id" | "name" | "run", string>> & {
  env?: Record<string, string>;
};

type ExtensionMatrixRow = {
  check_name: string;
  extensions_csv: string;
  includePatterns: string[];
  requires_bun?: boolean;
  task: string;
  test_runtime_policy?: string;
  vitest_config: string;
  exclusion_configs: { config: string; includePatterns: string[] }[];
};

export function parseManifestOutputs(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function parseExtensionMatrix(matrix: string | undefined): ExtensionMatrixRow[] {
  return JSON.parse(expectDefined(matrix, "extension matrix")).include;
}

export function readWorkflow(name = "plugin-prerelease") {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
}

export function findStep(job: { steps: WorkflowStep[] }, name: string) {
  return expectDefined(
    job.steps.find((step) => step.name === name || step.id === name),
    name,
  );
}

export function createPrereleaseFixtures() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  return {
    make: tempDirs.make.bind(tempDirs),
    manifest(
      eventName = "workflow_dispatch",
      runtimePolicy = "",
      cwd?: string,
      fullReleaseValidation = eventName !== "schedule",
      phase = "independent",
    ) {
      const outputPath = join(tempDirs.make("plugin-prerelease-manifest-"), "github-output");
      const run = expectDefined(
        findStep(readWorkflow().jobs.preflight, "Build plugin prerelease manifest").run,
        "plugin prerelease manifest script",
      );
      const result = spawnSync("bash", ["-c", run], {
        cwd,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          FULL_RELEASE_VALIDATION: String(fullReleaseValidation),
          GITHUB_EVENT_NAME: eventName,
          GITHUB_OUTPUT: outputPath,
          PHASE: phase,
          OPENCLAW_CI_TEST_RUNTIME_POLICY: runtimePolicy,
        },
      });
      return { result, output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "" };
    },
    target(prefix: string, files: Record<string, string>, linkType: "dir" | "junction") {
      const root = tempDirs.make(prefix);
      symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), linkType);
      writeFixtureFiles(root, files);
      return root;
    },
  };
}
