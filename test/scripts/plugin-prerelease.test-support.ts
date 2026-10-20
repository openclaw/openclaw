import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type WorkflowStep = {
  id?: string;
  env?: Record<string, string>;
  name?: string;
  run?: string;
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
    target(prefix: string, files: Record<string, string>, linkType: "dir" | "junction") {
      const root = tempDirs.make(prefix);
      symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), linkType);
      for (const [file, content] of Object.entries(files)) {
        const target = join(root, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      return root;
    },
  };
}
