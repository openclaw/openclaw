import { danger } from "../globals.js";
import { logDebug, logError } from "../logger.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { getJiraCliConfig } from "./jira-cli-config.js";

export interface JiraCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runJiraCli(
  args: string[],
  options?: { timeoutMs?: number; input?: string },
): Promise<JiraCliResult> {
  const cfg = getJiraCliConfig();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const input = options?.input;

  const argv = ["docker", "exec", cfg.containerName, "jira", ...args];

  if (process.env.OPENCLAW_DEBUG_JIRA_CLI === "1") {
    logDebug(`jira-cli: running ${argv.join(" ")}`);
  }

  try {
    const { stdout, stderr, code } = await runCommandWithTimeout(argv, {
      timeoutMs,
      ...(input !== undefined && { input }),
    });

    if (code !== 0) {
      const noSuchContainer = /No such container/i.test(stderr);
      const message = noSuchContainer
        ? `jira-cli: container "${cfg.containerName}" not found. Set JIRA_CLI_CONTAINER_NAME to your running container name (e.g. export JIRA_CLI_CONTAINER_NAME=<your-container-name>) or run the jira-cli container with --name jira-cli.`
        : `jira-cli: command failed with exit code ${code}: ${argv.join(" ")}`;
      logError(danger(message));
      if (stderr.trim() && !noSuchContainer) {
        logError(stderr.trim());
      }
      if (noSuchContainer) {
        throw new Error(message);
      }
    }

    return {
      stdout,
      stderr,
      exitCode: code ?? 0,
    };
  } catch (err) {
    const errStr = String(err);
    const noSuchContainer = /No such container/i.test(errStr);
    const message = noSuchContainer
      ? `jira-cli: container "${cfg.containerName}" not found. Set JIRA_CLI_CONTAINER_NAME to your running container name (e.g. export JIRA_CLI_CONTAINER_NAME=goofy_bose) or run the jira-cli container with --name jira-cli. Original: ${errStr}`
      : `jira-cli: failed to run command: ${argv.join(" ")} - ${errStr}`;
    logError(danger(message));
    if (noSuchContainer) {
      throw new Error(message);
    }
    throw err;
  }
}
