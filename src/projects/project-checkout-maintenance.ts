import os from "node:os";
import {
  executeGitCommand,
  gitNullConfigPath,
  requireGitCommandOutput,
} from "../infra/git-exec.js";
import type { GitOperationStarter } from "../infra/git-network-retry.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  readCommandProcessFailure,
  type SpawnResult,
} from "../process/exec-result.js";

export const PROJECT_MAINTENANCE_CONFIG = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["pack.threads", "1"],
  ["pack.windowMemory", "64m"],
] as const;

export function projectCheckoutGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_TEMPLATE_DIR: "",
    GIT_EDITOR: "",
    GIT_SEQUENCE_EDITOR: "",
    GIT_EXTERNAL_DIFF: "",
    GIT_ASKPASS: undefined,
    SSH_ASKPASS: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_EXEC_PATH: undefined,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSL_NO_VERIFY: undefined,
  };
}

export async function runProjectGitCommand<T extends SpawnResult>(
  run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run();
    if (result.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    return result;
  } catch (error) {
    if (
      !hasCommandProcessCleanupError(error) &&
      readCommandProcessFailure(error)?.cleanup === "uncertain"
    ) {
      throw new CommandProcessCleanupError({ cause: error });
    }
    throw error;
  }
}

/** The checkout lifecycle owner adopts existing managed clones before reuse. */
export async function configureProjectCheckoutMaintenance(
  target: string,
  options: {
    assertCurrent?: () => void;
    startRun?: GitOperationStarter;
    env?: NodeJS.ProcessEnv;
    objectDirectory?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<void> {
  for (const [key, value] of PROJECT_MAINTENANCE_CONFIG) {
    requireGitCommandOutput(
      "git config managed maintenance",
      await runProjectGitCommand(() =>
        executeGitCommand(
          target,
          [
            "-c",
            `core.hooksPath=${os.devNull}`,
            "-c",
            "core.fsmonitor=false",
            "config",
            "--local",
            "--replace-all",
            key,
            value,
          ],
          {
            operation: "project.clone",
            timeoutMs: options.timeoutMs ?? 10 * 60_000,
            signal: options.signal,
            killProcessTree: true,
            maxOutputBytes: 256 * 1024,
            beforeRun: options.assertCurrent,
            startRun: options.startRun,
            env: {
              ...projectCheckoutGitEnvironment(options.env ?? process.env),
              ...(options.objectDirectory ? { GIT_OBJECT_DIRECTORY: options.objectDirectory } : {}),
            },
          },
        ),
      ),
    );
  }
}
