import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

function repoRoot(): string {
  // After bundling, this file lives in dist/ (flat). One level up is the repo root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function runScript(scriptName: string) {
  const root = repoRoot();
  const scriptPath = path.join(root, "scripts", scriptName);
  const result = spawnSync(scriptPath, [], {
    stdio: "inherit",
    shell: false,
    env: process.env,
    cwd: root,
  });
  if (result.error) {
    console.error(`Failed to run ${scriptName}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function registerStagingCommands(program: Command) {
  const staging = program
    .command("staging")
    .description("Manage the openclaw-jhs-staging Fly.io app");

  staging
    .command("up")
    .description("Deploy (or redeploy) the staging server")
    .action(() => runScript("staging-up.sh"));

  staging
    .command("down")
    .description("Destroy all staging machines (stops billing, preserves app config)")
    .action(() => runScript("staging-down.sh"));
}
