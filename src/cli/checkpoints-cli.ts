import path from "node:path";
import type { Command } from "commander";
import {
  resolveAgentConfig,
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  formatWorkspaceCheckpointList,
  resolveWorkspaceCheckpointConfig,
  WorkspaceCheckpointManager,
} from "../agents/workspace-checkpoints.js";
import { getRuntimeConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveOptionFromCommand } from "./cli-utils.js";

type CheckpointsCliOpts = {
  agent?: string;
  workspace?: string;
  json?: boolean;
  yes?: boolean;
};

function resolveCheckpointsTarget(opts: CheckpointsCliOpts = {}): {
  workspaceDir: string;
  agentId?: string;
  configuredEnabled: boolean;
  manager: WorkspaceCheckpointManager;
} {
  const config = getRuntimeConfig();
  const checkpointConfig = resolveWorkspaceCheckpointConfig(config);
  const workspaceOverride = normalizeOptionalString(opts.workspace);
  if (workspaceOverride) {
    return {
      workspaceDir: path.resolve(workspaceOverride),
      configuredEnabled: checkpointConfig.enabled,
      manager: new WorkspaceCheckpointManager(checkpointConfig),
    };
  }
  const explicitAgentId = normalizeOptionalString(opts.agent);
  const inferredAgentId = explicitAgentId
    ? undefined
    : resolveAgentIdByWorkspacePath(config, process.cwd());
  const agentId = explicitAgentId ?? inferredAgentId ?? resolveDefaultAgentId(config);
  const agentCheckpointConfig = resolveAgentConfig(config, agentId)?.tools?.checkpoints;
  const mergedCheckpointConfig = resolveWorkspaceCheckpointConfig(config, agentCheckpointConfig);
  return {
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
    agentId,
    configuredEnabled: mergedCheckpointConfig.enabled,
    manager: new WorkspaceCheckpointManager(mergedCheckpointConfig),
  };
}

function resolveOptions(command: Command, opts: CheckpointsCliOpts): CheckpointsCliOpts {
  return {
    ...opts,
    agent: resolveOptionFromCommand<string>(command, "agent") ?? opts.agent,
    workspace: resolveOptionFromCommand<string>(command, "workspace") ?? opts.workspace,
  };
}

function fail(error: unknown): never {
  defaultRuntime.error(error instanceof Error ? error.message : String(error));
  defaultRuntime.exit(1);
  throw error instanceof Error ? error : new Error(String(error));
}

function renderTargetHeader(params: {
  workspaceDir: string;
  agentId?: string;
  configuredEnabled: boolean;
  storeRoot: string;
}): string {
  return [
    `workspace: ${params.workspaceDir}`,
    params.agentId ? `agent: ${params.agentId}` : undefined,
    `auto: ${params.configuredEnabled ? "enabled" : "disabled"}`,
    `store: ${params.storeRoot}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerCheckpointsCli(program: Command) {
  const checkpoints = program
    .command("checkpoints")
    .description("Create, diff, and restore workspace checkpoints")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--workspace <dir>", "Target workspace directory")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/tools/checkpoints",
          "docs.openclaw.ai/tools/checkpoints",
        )}\n`,
    );

  checkpoints
    .command("status")
    .description("Show checkpoint status for the selected workspace")
    .option("--json", "Output JSON", false)
    .action(async (opts: CheckpointsCliOpts, command: Command) => {
      try {
        const target = resolveCheckpointsTarget(resolveOptions(command, opts));
        const checkpointsList = await target.manager.listCheckpoints(target.workspaceDir);
        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir: target.workspaceDir,
            agentId: target.agentId,
            enabled: target.configuredEnabled,
            storeRoot: target.manager.rootDir,
            checkpoints: checkpointsList,
          });
          return;
        }
        defaultRuntime.writeStdout(
          `${renderTargetHeader({
            workspaceDir: target.workspaceDir,
            agentId: target.agentId,
            configuredEnabled: target.configuredEnabled,
            storeRoot: target.manager.rootDir,
          })}\ncount: ${checkpointsList.length}\n`,
        );
      } catch (error) {
        fail(error);
      }
    });

  checkpoints
    .command("create")
    .description("Create a checkpoint now")
    .argument("[reason...]", "Checkpoint reason")
    .option("--json", "Output JSON", false)
    .action(async (reasonParts: string[], opts: CheckpointsCliOpts, command: Command) => {
      try {
        const target = resolveCheckpointsTarget(resolveOptions(command, opts));
        const checkpoint = await target.manager.createCheckpoint(
          target.workspaceDir,
          normalizeOptionalString(reasonParts.join(" ")) ?? "manual",
        );
        if (opts.json) {
          defaultRuntime.writeJson({ checkpoint, workspaceDir: target.workspaceDir });
          return;
        }
        defaultRuntime.writeStdout(
          checkpoint
            ? `checkpoint: ${checkpoint.shortHash}\nreason: ${checkpoint.reason}\nworkspace: ${target.workspaceDir}\n`
            : `checkpoint: skipped\nworkspace: ${target.workspaceDir}\n`,
        );
      } catch (error) {
        fail(error);
      }
    });

  checkpoints
    .command("list")
    .description("List checkpoints")
    .option("--json", "Output JSON", false)
    .action(async (opts: CheckpointsCliOpts, command: Command) => {
      try {
        const target = resolveCheckpointsTarget(resolveOptions(command, opts));
        const checkpointsList = await target.manager.listCheckpoints(target.workspaceDir);
        if (opts.json) {
          defaultRuntime.writeJson({
            checkpoints: checkpointsList,
            workspaceDir: target.workspaceDir,
          });
          return;
        }
        defaultRuntime.writeStdout(formatWorkspaceCheckpointList(checkpointsList));
      } catch (error) {
        fail(error);
      }
    });

  checkpoints
    .command("diff")
    .description("Show changes since a checkpoint")
    .argument("<checkpoint>", "Checkpoint number, hash prefix, or latest")
    .option("--json", "Output JSON", false)
    .action(async (checkpointRef: string, opts: CheckpointsCliOpts, command: Command) => {
      try {
        const target = resolveCheckpointsTarget(resolveOptions(command, opts));
        const result = await target.manager.diff(target.workspaceDir, checkpointRef);
        if (opts.json) {
          defaultRuntime.writeJson({ ...result, workspaceDir: target.workspaceDir });
          return;
        }
        defaultRuntime.writeStdout(
          [result.stat, result.diff].filter(Boolean).join("\n\n") ||
            "No changes since checkpoint.\n",
        );
      } catch (error) {
        fail(error);
      }
    });

  checkpoints
    .command("restore")
    .description("Restore a checkpoint")
    .argument("<checkpoint>", "Checkpoint number, hash prefix, or latest")
    .argument("[path]", "Optional file or directory path to restore")
    .option("--yes", "Confirm restore", false)
    .option("--json", "Output JSON", false)
    .action(
      async (
        checkpointRef: string,
        filePath: string | undefined,
        opts: CheckpointsCliOpts,
        command: Command,
      ) => {
        try {
          if (opts.yes !== true) {
            throw new Error("Pass --yes to restore workspace files.");
          }
          const target = resolveCheckpointsTarget(resolveOptions(command, opts));
          const result = await target.manager.restore(target.workspaceDir, checkpointRef, filePath);
          if (opts.json) {
            defaultRuntime.writeJson({ ...result, workspaceDir: target.workspaceDir });
            return;
          }
          const lines = [
            `restored: ${result.checkpoint?.shortHash ?? checkpointRef}`,
            result.filePath ? `path: ${result.filePath}` : undefined,
            result.preRestoreCheckpoint
              ? `preRestore: ${result.preRestoreCheckpoint.shortHash}`
              : undefined,
            `workspace: ${target.workspaceDir}`,
          ].filter(Boolean);
          defaultRuntime.writeStdout(`${lines.join("\n")}\n`);
        } catch (error) {
          fail(error);
        }
      },
    );
}
