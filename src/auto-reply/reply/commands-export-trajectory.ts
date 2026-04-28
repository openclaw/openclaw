import fs from "node:fs";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { ExecToolDetails } from "../../agents/bash-tools.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import {
  exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary,
  resolveTrajectoryCommandOutputDir,
} from "../../trajectory/command-export.js";
import type { ReplyPayload } from "../types.js";
import {
  isReplyPayload,
  parseExportCommandOutputPath,
  resolveExportCommandSessionTarget,
} from "./commands-export-common.js";
import {
  deliverPrivateCommandReply,
  readCommandMessageThreadId,
  resolvePrivateCommandRouteTargets,
  type PrivateCommandRouteTarget,
} from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";

const EXPORT_TRAJECTORY_DOCS_URL = "https://docs.openclaw.ai/tools/trajectory";
const EXPORT_TRAJECTORY_EXEC_SCOPE_KEY = "chat:export-trajectory";
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner approval route for the trajectory export. Run /export-trajectory from an owner DM so the sensitive trajectory bundle is not posted in this chat.";
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_ACK =
  "Trajectory exports are sensitive. I sent the export request and approval prompt to the owner privately.";

type ExportTrajectoryCommandDeps = {
  createExecTool: typeof createExecTool;
  resolvePrivateTrajectoryTargets: (
    params: HandleCommandsParams,
    command: string,
  ) => Promise<PrivateCommandRouteTarget[]>;
  deliverPrivateTrajectoryReply: (params: {
    commandParams: HandleCommandsParams;
    targets: PrivateCommandRouteTarget[];
    reply: ReplyPayload;
  }) => Promise<boolean>;
};

const defaultExportTrajectoryCommandDeps: ExportTrajectoryCommandDeps = {
  createExecTool,
  resolvePrivateTrajectoryTargets: resolvePrivateTrajectoryTargetsForCommand,
  deliverPrivateTrajectoryReply: deliverPrivateTrajectoryReply,
};

export async function buildExportTrajectoryCommandReply(
  params: HandleCommandsParams,
  deps: Partial<ExportTrajectoryCommandDeps> = {},
): Promise<ReplyPayload> {
  const resolvedDeps: ExportTrajectoryCommandDeps = {
    ...defaultExportTrajectoryCommandDeps,
    ...deps,
  };
  const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, [
    "export-trajectory",
    "trajectory",
  ]);
  const command = buildTrajectoryExportCliCommand(params, args.outputPath);
  if (params.isGroup) {
    const targets = await resolvedDeps.resolvePrivateTrajectoryTargets(params, command);
    if (targets.length === 0) {
      return { text: EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE };
    }
    const privateReply = await buildExportTrajectoryApprovalReply(resolvedDeps, params, command, {
      privateApprovalTarget: targets[0],
    });
    const delivered = await resolvedDeps.deliverPrivateTrajectoryReply({
      commandParams: params,
      targets,
      reply: privateReply,
    });
    return {
      text: delivered
        ? EXPORT_TRAJECTORY_PRIVATE_ROUTE_ACK
        : EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE,
    };
  }
  return await buildExportTrajectoryApprovalReply(resolvedDeps, params, command);
}

async function buildExportTrajectoryApprovalReply(
  deps: ExportTrajectoryCommandDeps,
  params: HandleCommandsParams,
  command: string,
  options: { privateApprovalTarget?: PrivateCommandRouteTarget } = {},
): Promise<ReplyPayload> {
  return {
    text: [
      "Trajectory exports can include prompts, model messages, tool schemas, tool results, runtime events, and local paths.",
      `Treat trajectory bundles like secrets and review them before sharing: ${EXPORT_TRAJECTORY_DOCS_URL}`,
      "",
      await requestTrajectoryExportApproval(deps, params, command, options),
    ].join("\n"),
  };
}

export async function buildExportTrajectoryReply(
  params: HandleCommandsParams,
): Promise<ReplyPayload> {
  const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, [
    "export-trajectory",
    "trajectory",
  ]);
  const sessionTarget = resolveExportCommandSessionTarget(params);
  if (isReplyPayload(sessionTarget)) {
    return sessionTarget;
  }
  const { entry, sessionFile } = sessionTarget;

  if (!fs.existsSync(sessionFile)) {
    return { text: "❌ Session file not found." };
  }

  let outputDir: string;
  try {
    outputDir = resolveTrajectoryCommandOutputDir({
      outputPath: args.outputPath,
      workspaceDir: params.workspaceDir,
      sessionId: entry.sessionId,
    });
  } catch (err) {
    return {
      text: `❌ Failed to resolve output path: ${formatErrorMessage(err)}`,
    };
  }

  let summary: ReturnType<typeof exportTrajectoryForCommand>;
  try {
    summary = exportTrajectoryForCommand({
      outputDir,
      sessionFile,
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
  } catch (err) {
    return {
      text: `❌ Failed to export trajectory: ${formatErrorMessage(err)}`,
    };
  }

  return {
    text: formatTrajectoryCommandExportSummary(summary),
  };
}

async function resolvePrivateTrajectoryTargetsForCommand(
  params: HandleCommandsParams,
  command: string,
): Promise<PrivateCommandRouteTarget[]> {
  return await resolvePrivateCommandRouteTargets({
    commandParams: params,
    request: buildTrajectoryExportApprovalRequest(params, command),
  });
}

async function deliverPrivateTrajectoryReply(params: {
  commandParams: HandleCommandsParams;
  targets: PrivateCommandRouteTarget[];
  reply: ReplyPayload;
}): Promise<boolean> {
  return await deliverPrivateCommandReply(params);
}

function buildTrajectoryExportApprovalRequest(
  params: HandleCommandsParams,
  command: string,
): ExecApprovalRequest {
  const now = Date.now();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  return {
    id: "trajectory-export-private-route",
    request: {
      command,
      agentId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      turnSourceChannel: params.command.channel,
      turnSourceTo: params.command.to ?? params.command.from ?? null,
      turnSourceAccountId: params.ctx.AccountId ?? null,
      turnSourceThreadId: readCommandMessageThreadId(params) ?? null,
    },
    createdAtMs: now,
    expiresAtMs: now + 5 * 60_000,
  };
}

async function requestTrajectoryExportApproval(
  deps: ExportTrajectoryCommandDeps,
  params: HandleCommandsParams,
  command: string,
  options: { privateApprovalTarget?: PrivateCommandRouteTarget } = {},
): Promise<string> {
  const timeoutSec = params.cfg.tools?.exec?.timeoutSec;
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const messageThreadId = readCommandMessageThreadId(params);
  try {
    const execTool = deps.createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "export-trajectory",
      scopeKey: EXPORT_TRAJECTORY_EXEC_SCOPE_KEY,
      allowBackground: true,
      timeoutSec,
      cwd: params.workspaceDir,
      agentId,
      sessionKey: params.sessionKey,
      messageProvider: params.command.channel,
      currentChannelId:
        options.privateApprovalTarget?.to ?? params.command.to ?? params.command.from,
      currentThreadTs: options.privateApprovalTarget
        ? options.privateApprovalTarget.threadId == null
          ? undefined
          : String(options.privateApprovalTarget.threadId)
        : messageThreadId,
      accountId: options.privateApprovalTarget?.accountId ?? params.ctx.AccountId ?? undefined,
      notifyOnExit: params.cfg.tools?.exec?.notifyOnExit,
      notifyOnExitEmptySuccess: params.cfg.tools?.exec?.notifyOnExitEmptySuccess,
    });
    const result = await execTool.execute("chat-export-trajectory", {
      command,
      security: "allowlist",
      ask: "always",
      background: true,
      timeout: timeoutSec,
    });
    return [
      `Trajectory bundle: requested \`${command}\` through exec approval. Approve once to create the bundle; do not use allow-all for trajectory exports.`,
      formatExecToolResultForTrajectory(result),
    ].join("\n");
  } catch (error) {
    return [
      `Trajectory bundle: could not request exec approval for \`${command}\`.`,
      formatExecTrajectoryText(formatErrorMessage(error)),
    ].join("\n");
  }
}

function formatExecToolResultForTrajectory(result: {
  content?: Array<{ type: string; text?: string }>;
  details?: ExecToolDetails;
}): string {
  const text = result.content
    ?.map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) {
    return formatExecTrajectoryText(text);
  }
  const details = result.details;
  if (details?.status === "approval-pending") {
    const decisions = details.allowedDecisions?.join(", ") || "allow-once, deny";
    return formatExecTrajectoryText(
      `Exec approval pending (${details.approvalSlug}). Allowed decisions: ${decisions}.`,
    );
  }
  if (details?.status === "running") {
    return formatExecTrajectoryText(
      `Trajectory export is running (exec session ${details.sessionId}).`,
    );
  }
  if (details?.status === "completed" || details?.status === "failed") {
    return formatExecTrajectoryText(details.aggregated);
  }
  return "(no exec details returned)";
}

function formatExecTrajectoryText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(no exec output)";
  }
  return trimmed;
}

function buildTrajectoryExportCliCommand(
  params: HandleCommandsParams,
  outputPath?: string,
): string {
  const args = [
    "openclaw",
    "sessions",
    "export-trajectory",
    "--session-key",
    params.sessionKey,
    "--workspace",
    params.workspaceDir,
    "--json",
  ];
  if (outputPath) {
    args.push("--output", outputPath);
  }
  if (params.storePath && params.storePath !== "(multiple)") {
    args.push("--store", params.storePath);
  }
  if (params.agentId) {
    args.push("--agent", params.agentId);
  }
  return shellQuoteArgs(args);
}

function shellQuoteArgs(args: readonly string[]): string {
  return args.map(shellQuoteArg).join(" ");
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
