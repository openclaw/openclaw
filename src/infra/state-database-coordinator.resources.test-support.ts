import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveStateLifecycleRuntimeDirectory } from "./state-database-coordinator.js";
import { createVitestResourceOwner } from "./vitest-resource-ownership.js";

const testNodeExecPath = resolveTestNodeExecPath();
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resourceContextPreload = pathToFileURL(
  path.join(repositoryRoot, "src/infra/vitest-resource-context-preload.test-support.mjs"),
).href;

export function withResourceContextPreload(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, NODE_OPTIONS: `--import=${resourceContextPreload}` };
}

export function createCoordinatorResourceTestHarness() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  function createStandaloneOwner(prefix: string) {
    const globalRuntime = resolveStateLifecycleRuntimeDirectory();
    fs.mkdirSync(globalRuntime, { recursive: true });
    const outerRoot = tempDirs.make(prefix, fs.realpathSync(globalRuntime));
    const ownedRoot = path.join(outerRoot, "owned");
    fs.mkdirSync(ownedRoot);
    return { ownedRoot, owner: createVitestResourceOwner(ownedRoot) };
  }
  return { tempDirs, createStandaloneOwner };
}

export function resolveCoordinatorModuleUrl(): string {
  return pathToFileURL(path.join(import.meta.dirname, "state-database-coordinator.ts")).href;
}

export function runCoordinatorSource(
  source: string,
  envOverrides: NodeJS.ProcessEnv,
  removedEnvKeys: string[] = [],
) {
  const env = withResourceContextPreload({ ...process.env, ...envOverrides });
  for (const key of removedEnvKeys) {
    delete env[key];
  }
  const child = spawnSync(
    testNodeExecPath,
    ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    },
  );
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}
