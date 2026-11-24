import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import type { NodeWorkerWorkspaceLaunchReference } from "./node-worker-workspace-identity.js";

/** Node-owned policy; it is never accepted from workspace RPC input. */
export type NodeWorkerCommandIsolation = {
  bundleRoot: string;
  placement?: NodeWorkerWorkspaceLaunchReference;
  /** The node's already-sanitized worker environment, not the host process environment. */
  env: NodeJS.ProcessEnv;
};

type CommandFilesystemInput = {
  isolation?: NodeWorkerCommandIsolation;
  workspaceDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  outputDirectories?: readonly string[];
  temporaryHome?: true;
};

/** Reuse the worker launch boundary for a command owned by the node. */
export async function prepareNodeWorkerFilesystemCommand(
  params: CommandFilesystemInput & { argv: string[] },
) {
  if (!params.isolation) {
    return undefined;
  }
  const executable = resolveExecutablePath(params.argv[0] ?? "", {
    cwd: params.workspaceDir,
    env: params.env,
    useCache: false,
  });
  if (!executable) {
    throw new Error("Filesystem-isolated workspace command executable is unavailable");
  }
  const { prepareNodeWorkerFilesystem } = await import("./node-worker-filesystem.js");
  return await prepareNodeWorkerFilesystem({
    ...params.isolation,
    workspaceDir: params.workspaceDir,
    homeDir: params.homeDir,
    env: params.env,
    entry: process.execPath,
    executable: fs.realpathSync.native(executable),
    args: params.argv.slice(1),
    commandWorkspace: true,
    temporaryHome: params.temporaryHome,
    outputDirectories: params.outputDirectories,
  });
}

/** Generic Git owners retain their APIs, while every subprocess shares this admitted boundary. */
export async function withNodeWorkerFilesystemCommands<T>(
  params: CommandFilesystemInput & { signal?: AbortSignal },
  run: () => Promise<T>,
): Promise<T> {
  const { isolation } = params;
  if (!isolation) {
    return await run();
  }
  const launch = await prepareNodeWorkerFilesystemCommand({
    ...params,
    isolation,
    env: isolation.env,
    temporaryHome: true,
    argv: [process.execPath],
  });
  if (!launch) {
    return await run();
  }
  const separator = launch.args.lastIndexOf("--");
  if (separator < 0) {
    await launch.cleanup();
    throw new Error("Filesystem launcher did not provide an executable boundary");
  }
  const prefix = launch.args.slice(0, separator);
  const workspace = fs.realpathSync.native(params.workspaceDir);
  let cleanupUncertain = false;
  try {
    return await withCommandProcessScope(run, params.signal, undefined, ({ argv, cwd, env }) => {
      const directory = cwd instanceof URL ? fileURLToPath(cwd) : cwd;
      if (directory && fs.realpathSync.native(path.resolve(directory)) !== workspace) {
        throw new Error("Workspace command changed its admitted working directory");
      }
      const commandEnv: NodeJS.ProcessEnv = { ...isolation.env };
      for (const [key, value] of Object.entries(env)) {
        if (/^GIT_(?:INDEX_FILE|(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE))$/u.test(key)) {
          commandEnv[key] = value;
        }
      }
      Object.assign(commandEnv, gitMaintenanceEnvironment(), {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_DIR: path.join(workspace, ".git"),
        GIT_WORK_TREE: workspace,
      });
      const executable = resolveExecutablePath(argv[0] ?? "", {
        cwd: workspace,
        env: commandEnv,
        useCache: false,
      });
      if (!executable) {
        throw new Error("Filesystem-isolated workspace command executable is unavailable");
      }
      const args =
        path.basename(executable) === "git"
          ? ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...argv.slice(1)]
          : argv.slice(1);
      return {
        argv: [launch.command, ...prefix, "--", fs.realpathSync.native(executable), ...args],
        env: commandEnv,
      };
    });
  } catch (error) {
    cleanupUncertain = hasCommandProcessCleanupError(error);
    throw error;
  } finally {
    // An uncertain process owner must retain the storage an admitted child may still use.
    if (!cleanupUncertain) {
      await launch.cleanup();
    }
  }
}
