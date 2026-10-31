import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readWorkflow,
  readWorkflowOutputs,
  requiredWorkflowStep,
  runWorkflowShellScript,
} from "./ci-workflow.test-support.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

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

export function parseExtensionMatrix(matrix: string | undefined): ExtensionMatrixRow[] {
  return JSON.parse(expectDefined(matrix, "extension matrix")).include;
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
        requiredWorkflowStep(
          readWorkflow(".github/workflows/plugin-prerelease.yml").jobs.preflight.steps,
          "Build plugin prerelease manifest",
        ).run,
        "plugin prerelease manifest script",
      );
      const result = runWorkflowShellScript(run, {
        cwd,
        linuxWorkflow: true,
        env: {
          PATH: process.env.PATH,
          FULL_RELEASE_VALIDATION: String(fullReleaseValidation),
          GITHUB_EVENT_NAME: eventName,
          GITHUB_OUTPUT: outputPath,
          PHASE: phase,
          OPENCLAW_CI_TEST_RUNTIME_POLICY: runtimePolicy,
        },
      });
      return { result, output: readWorkflowOutputs(outputPath) };
    },
    target(prefix: string, files: Record<string, string>, linkType: "dir" | "junction") {
      const root = tempDirs.make(prefix);
      symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), linkType);
      writeFixtureFiles(root, files);
      return root;
    },
  };
}
