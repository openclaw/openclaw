// This run-owned PATH entry retains its transport and guard even when a native
// fixture clears its environment. Never resolve through the fixture's PATH again.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [configPath, command, ...args] = process.argv.slice(2);
const { guardSource, executables, defaults } = JSON.parse(readFileSync(configPath, "utf8"));
for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
const { installGitHubNetworkGuard, blockGitHubTestCommand } = await import(
  pathToFileURL(guardSource).href
);
installGitHubNetworkGuard();
const executable = executables[command];
if (!executable) blockGitHubTestCommand("unresolved-command");
const child = spawnSync(executable, args, { stdio: "inherit" });
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
else process.exitCode = child.status ?? 1;
