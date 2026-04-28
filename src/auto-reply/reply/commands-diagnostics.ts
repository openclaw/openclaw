import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { ExecToolDetails } from "../../agents/bash-tools.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalAdapter,
} from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { InteractiveReply } from "../../interactive/payload.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";
import type { PluginCommandDiagnosticsSession, PluginCommandResult } from "../../plugins/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { rejectNonOwnerCommand } from "./command-gates.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { routeReply } from "./route-reply.js";

const DIAGNOSTICS_COMMAND = "/diagnostics";
const CODEX_DIAGNOSTICS_COMMAND = "/codex diagnostics";
const DIAGNOSTICS_DOCS_URL = "https://docs.openclaw.ai/gateway/diagnostics";
const GATEWAY_DIAGNOSTICS_EXPORT_COMMAND = "openclaw gateway diagnostics export";
const GATEWAY_DIAGNOSTICS_EXPORT_JSON_COMMAND = `${GATEWAY_DIAGNOSTICS_EXPORT_COMMAND} --json`;
const DIAGNOSTICS_EXEC_SCOPE_KEY = "chat:diagnostics";
const DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner approval route for diagnostics. Run /diagnostics from an owner DM so the sensitive diagnostics details are not posted in this chat.";
const DIAGNOSTICS_PRIVATE_ROUTE_ACK =
  "Diagnostics are sensitive. I sent the diagnostics details and approval prompts to the owner privately.";

type DiagnosticsCommandDeps = {
  createExecTool: typeof createExecTool;
  resolvePrivateDiagnosticsTargets: (
    params: HandleCommandsParams,
  ) => Promise<PrivateDiagnosticsTarget[]>;
  deliverPrivateDiagnosticsReply: (params: {
    commandParams: HandleCommandsParams;
    targets: PrivateDiagnosticsTarget[];
    reply: ReplyPayload;
  }) => Promise<boolean>;
};

const defaultDiagnosticsCommandDeps: DiagnosticsCommandDeps = {
  createExecTool,
  resolvePrivateDiagnosticsTargets: resolvePrivateDiagnosticsTargetsForCommand,
  deliverPrivateDiagnosticsReply: deliverPrivateDiagnosticsReply,
};

type PrivateDiagnosticsTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

export function createDiagnosticsCommandHandler(
  deps: Partial<DiagnosticsCommandDeps> = {},
): CommandHandler {
  const resolvedDeps: DiagnosticsCommandDeps = {
    ...defaultDiagnosticsCommandDeps,
    ...deps,
  };
  return async (params, allowTextCommands) =>
    await handleDiagnosticsCommandWithDeps(resolvedDeps, params, allowTextCommands);
}

export const handleDiagnosticsCommand: CommandHandler = createDiagnosticsCommandHandler();

async function handleDiagnosticsCommandWithDeps(
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  allowTextCommands: boolean,
) {
  if (!allowTextCommands) {
    return null;
  }
  const args = parseDiagnosticsArgs(params.command.commandBodyNormalized);
  if (args == null) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /diagnostics from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const ownerGate = rejectNonOwnerCommand(params, DIAGNOSTICS_COMMAND);
  if (ownerGate) {
    return ownerGate;
  }

  if (isCodexDiagnosticsConfirmationAction(args)) {
    const codexResult = await executeCodexDiagnosticsAddon(params, args);
    const reply = codexResult
      ? rewriteCodexDiagnosticsResult(codexResult)
      : { text: "No Codex diagnostics confirmation handler is available for this session." };
    if (params.isGroup) {
      return await deliverGroupDiagnosticsReplyPrivately(deps, params, reply);
    }
    return {
      shouldContinue: false,
      reply,
    };
  }

  if (params.isGroup) {
    const targets = await deps.resolvePrivateDiagnosticsTargets(params);
    if (targets.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
      };
    }
    const privateReply = await buildDiagnosticsReply(deps, params, args, {
      diagnosticsPrivateRouted: true,
      privateApprovalTarget: targets[0],
    });
    const delivered = await deps.deliverPrivateDiagnosticsReply({
      commandParams: params,
      targets,
      reply: privateReply,
    });
    return {
      shouldContinue: false,
      reply: {
        text: delivered ? DIAGNOSTICS_PRIVATE_ROUTE_ACK : DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: await buildDiagnosticsReply(deps, params, args),
  };
}

async function buildDiagnosticsReply(
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  args: string,
  options: {
    diagnosticsPrivateRouted?: boolean;
    privateApprovalTarget?: PrivateDiagnosticsTarget;
  } = {},
): Promise<ReplyPayload> {
  const lines = buildDiagnosticsPreamble();
  lines.push("", await requestGatewayDiagnosticsExportApproval(deps, params, options));
  let interactive: InteractiveReply | undefined;
  if (isCodexHarnessSession(params)) {
    const codexResult = await executeCodexDiagnosticsAddon(params, args, options);
    if (codexResult) {
      const rewritten = rewriteCodexDiagnosticsResult(codexResult);
      if (rewritten.text) {
        lines.push("", "OpenAI Codex harness:", rewritten.text);
      }
      interactive = rewritten.interactive;
    } else {
      lines.push(
        "",
        "OpenAI Codex harness: selected for this session, but the bundled Codex diagnostics command is not registered.",
      );
    }
  }

  return {
    text: lines.join("\n"),
    ...(interactive ? { interactive } : {}),
  };
}

async function deliverGroupDiagnosticsReplyPrivately(
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  reply: ReplyPayload,
) {
  const targets = await deps.resolvePrivateDiagnosticsTargets(params);
  if (targets.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE },
    };
  }
  const delivered = await deps.deliverPrivateDiagnosticsReply({
    commandParams: params,
    targets,
    reply,
  });
  return {
    shouldContinue: false,
    reply: {
      text: delivered ? DIAGNOSTICS_PRIVATE_ROUTE_ACK : DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE,
    },
  };
}

function parseDiagnosticsArgs(commandBody: string): string | undefined {
  const trimmed = commandBody.trim();
  if (trimmed === DIAGNOSTICS_COMMAND) {
    return "";
  }
  if (trimmed.startsWith(`${DIAGNOSTICS_COMMAND} `)) {
    return trimmed.slice(DIAGNOSTICS_COMMAND.length + 1).trim();
  }
  if (trimmed.startsWith(`${DIAGNOSTICS_COMMAND}:`)) {
    return trimmed.slice(DIAGNOSTICS_COMMAND.length + 1).trim();
  }
  return undefined;
}

function buildDiagnosticsPreamble(): string[] {
  return [
    "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    `Treat diagnostics bundles like secrets and review what they contain before sharing: ${DIAGNOSTICS_DOCS_URL}`,
  ];
}

async function resolvePrivateDiagnosticsTargetsForCommand(
  params: HandleCommandsParams,
): Promise<PrivateDiagnosticsTarget[]> {
  const adapter = resolveChannelApprovalAdapter(getLoadedChannelPlugin(params.command.channel));
  const native = adapter?.native;
  if (!native?.resolveApproverDmTargets) {
    return [];
  }
  const request = buildDiagnosticsApprovalRequest(params);
  const accountId = params.ctx.AccountId ?? undefined;
  const capabilities = native.describeDeliveryCapabilities({
    cfg: params.cfg,
    accountId,
    approvalKind: "exec",
    request,
  });
  if (!capabilities.enabled || !capabilities.supportsApproverDmSurface) {
    return [];
  }
  const targets = await native.resolveApproverDmTargets({
    cfg: params.cfg,
    accountId,
    approvalKind: "exec",
    request,
  });
  return dedupePrivateDiagnosticsTargets(
    targets.map((target) => ({
      channel: params.command.channel,
      to: target.to,
      accountId,
      threadId: target.threadId,
    })),
  );
}

function buildDiagnosticsApprovalRequest(params: HandleCommandsParams): ExecApprovalRequest {
  const now = Date.now();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  return {
    id: "diagnostics-private-route",
    request: {
      command: GATEWAY_DIAGNOSTICS_EXPORT_JSON_COMMAND,
      agentId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      turnSourceChannel: params.command.channel,
      turnSourceTo: params.command.to ?? params.command.from ?? null,
      turnSourceAccountId: params.ctx.AccountId ?? null,
      turnSourceThreadId: readMessageThreadId(params) ?? null,
    },
    createdAtMs: now,
    expiresAtMs: now + 5 * 60_000,
  };
}

function dedupePrivateDiagnosticsTargets(
  targets: PrivateDiagnosticsTarget[],
): PrivateDiagnosticsTarget[] {
  const seen = new Set<string>();
  const deduped: PrivateDiagnosticsTarget[] = [];
  for (const target of targets) {
    const key = [
      target.channel,
      target.to,
      target.accountId ?? "",
      target.threadId == null ? "" : String(target.threadId),
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

async function deliverPrivateDiagnosticsReply(params: {
  commandParams: HandleCommandsParams;
  targets: PrivateDiagnosticsTarget[];
  reply: ReplyPayload;
}): Promise<boolean> {
  const results = await Promise.allSettled(
    params.targets.map((target) =>
      routeReply({
        payload: params.reply,
        channel: target.channel as OriginatingChannelType,
        to: target.to,
        accountId: target.accountId ?? undefined,
        threadId: target.threadId ?? undefined,
        cfg: params.commandParams.cfg,
        sessionKey: params.commandParams.sessionKey,
        policyConversationType: "direct",
        mirror: false,
        isGroup: false,
      }),
    ),
  );
  return results.some((result) => result.status === "fulfilled" && result.value.ok);
}

function readMessageThreadId(params: HandleCommandsParams): string | undefined {
  return typeof params.ctx.MessageThreadId === "string" ||
    typeof params.ctx.MessageThreadId === "number"
    ? String(params.ctx.MessageThreadId)
    : undefined;
}

async function requestGatewayDiagnosticsExportApproval(
  deps: DiagnosticsCommandDeps,
  params: HandleCommandsParams,
  options: { privateApprovalTarget?: PrivateDiagnosticsTarget } = {},
): Promise<string> {
  const timeoutSec = params.cfg.tools?.exec?.timeoutSec;
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const messageThreadId = readMessageThreadId(params);
  try {
    const execTool = deps.createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "diagnostics",
      scopeKey: DIAGNOSTICS_EXEC_SCOPE_KEY,
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
    const result = await execTool.execute("chat-diagnostics-gateway-export", {
      command: GATEWAY_DIAGNOSTICS_EXPORT_JSON_COMMAND,
      security: "allowlist",
      ask: "always",
      background: true,
      timeout: timeoutSec,
    });
    return [
      `Local Gateway bundle: requested \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_COMMAND}\` through exec approval. Approve once to create the bundle; do not use allow-all for diagnostics.`,
      formatExecToolResultForDiagnostics(result),
    ].join("\n");
  } catch (error) {
    return [
      `Local Gateway bundle: could not request exec approval for \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_COMMAND}\`.`,
      formatExecDiagnosticsText(formatErrorMessage(error)),
    ].join("\n");
  }
}

function isCodexDiagnosticsConfirmationAction(args: string): boolean {
  const [action, token] = args.trim().split(/\s+/, 2);
  const normalized = action?.toLowerCase();
  return Boolean(
    token &&
    (normalized === "confirm" ||
      normalized === "--confirm" ||
      normalized === "cancel" ||
      normalized === "--cancel"),
  );
}

function isCodexHarnessSession(params: HandleCommandsParams): boolean {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  return targetSessionEntry?.agentHarnessId === "codex";
}

async function executeCodexDiagnosticsAddon(
  params: HandleCommandsParams,
  args: string,
  options: { diagnosticsPrivateRouted?: boolean } = {},
): Promise<PluginCommandResult | undefined> {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const commandBody = args ? `${CODEX_DIAGNOSTICS_COMMAND} ${args}` : CODEX_DIAGNOSTICS_COMMAND;
  const match = matchPluginCommand(commandBody);
  if (!match || match.command.pluginId !== "codex") {
    return undefined;
  }
  return await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: params.command.senderId,
    channel: params.command.channel,
    channelId: params.command.channelId,
    isAuthorizedSender: params.command.isAuthorizedSender,
    senderIsOwner: params.command.senderIsOwner,
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    sessionFile: targetSessionEntry?.sessionFile,
    commandBody,
    config: params.cfg,
    from: params.command.from,
    to: params.command.to,
    accountId: params.ctx.AccountId ?? undefined,
    messageThreadId:
      typeof params.ctx.MessageThreadId === "string" ||
      typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : undefined,
    threadParentId: normalizeOptionalString(params.ctx.ThreadParentId),
    diagnosticsSessions: buildCodexDiagnosticsSessions(params),
    ...(options.diagnosticsPrivateRouted === undefined
      ? {}
      : { diagnosticsPrivateRouted: options.diagnosticsPrivateRouted }),
  });
}

function buildCodexDiagnosticsSessions(
  params: HandleCommandsParams,
): PluginCommandDiagnosticsSession[] {
  const sessions = new Map<string, SessionEntry>();
  const activeEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (activeEntry) {
    sessions.set(params.sessionKey, activeEntry);
  }
  for (const [sessionKey, entry] of Object.entries(params.sessionStore ?? {})) {
    if (entry) {
      sessions.set(sessionKey, entry);
    }
  }
  return Array.from(sessions.entries())
    .filter(([, entry]) => entry.agentHarnessId === "codex")
    .map(([sessionKey, entry]) => ({
      sessionKey,
      sessionId: entry.sessionId,
      sessionFile: entry.sessionFile,
      agentHarnessId: entry.agentHarnessId,
      channel: resolveDiagnosticsSessionChannel(entry, params, sessionKey),
      channelId: resolveDiagnosticsSessionChannelId(entry, params, sessionKey),
      accountId:
        normalizeOptionalString(entry.deliveryContext?.accountId) ??
        normalizeOptionalString(entry.origin?.accountId) ??
        normalizeOptionalString(entry.lastAccountId) ??
        (sessionKey === params.sessionKey ? (params.ctx.AccountId ?? undefined) : undefined),
      messageThreadId:
        entry.deliveryContext?.threadId ??
        entry.origin?.threadId ??
        entry.lastThreadId ??
        (sessionKey === params.sessionKey &&
        (typeof params.ctx.MessageThreadId === "string" ||
          typeof params.ctx.MessageThreadId === "number")
          ? params.ctx.MessageThreadId
          : undefined),
      threadParentId:
        sessionKey === params.sessionKey
          ? normalizeOptionalString(params.ctx.ThreadParentId)
          : undefined,
    }));
}

function resolveDiagnosticsSessionChannel(
  entry: SessionEntry,
  params: HandleCommandsParams,
  sessionKey: string,
): string | undefined {
  return (
    normalizeOptionalString(entry.deliveryContext?.channel) ??
    normalizeOptionalString(entry.origin?.provider) ??
    normalizeOptionalString(entry.channel) ??
    normalizeOptionalString(entry.lastChannel) ??
    (sessionKey === params.sessionKey ? params.command.channel : undefined)
  );
}

function resolveDiagnosticsSessionChannelId(
  entry: SessionEntry,
  params: HandleCommandsParams,
  sessionKey: string,
) {
  return (
    normalizeOptionalString(entry.origin?.nativeChannelId) ??
    (sessionKey === params.sessionKey ? params.command.channelId : undefined)
  );
}

function formatExecToolResultForDiagnostics(result: {
  content?: Array<{ type: string; text?: string }>;
  details?: ExecToolDetails;
}): string {
  const text = result.content
    ?.map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) {
    return formatExecDiagnosticsText(text);
  }
  const details = result.details;
  if (details?.status === "approval-pending") {
    const decisions = details.allowedDecisions?.join(", ") || "allow-once, deny";
    return formatExecDiagnosticsText(
      `Exec approval pending (${details.approvalSlug}). Allowed decisions: ${decisions}.`,
    );
  }
  if (details?.status === "running") {
    return formatExecDiagnosticsText(
      `Gateway diagnostics export is running (exec session ${details.sessionId}).`,
    );
  }
  if (details?.status === "completed" || details?.status === "failed") {
    return formatExecDiagnosticsText(details.aggregated);
  }
  return "(no exec details returned)";
}

function formatExecDiagnosticsText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(no exec output)";
  }
  return trimmed;
}

function rewriteCodexDiagnosticsResult(result: PluginCommandResult): PluginCommandResult {
  const { continueAgent: _continueAgent, ...reply } = result;
  void _continueAgent;
  return {
    ...reply,
    ...(reply.text ? { text: rewriteCodexDiagnosticsCommandPrefix(reply.text) } : {}),
    ...(reply.interactive ? { interactive: rewriteInteractive(reply.interactive) } : {}),
  };
}

function rewriteInteractive(interactive: InteractiveReply): InteractiveReply {
  return {
    blocks: interactive.blocks.map((block) => {
      if (block.type === "buttons") {
        return {
          ...block,
          buttons: block.buttons.map((button) => ({
            ...button,
            ...(button.value ? { value: rewriteCodexDiagnosticsCommandPrefix(button.value) } : {}),
          })),
        };
      }
      if (block.type === "select") {
        return {
          ...block,
          options: block.options.map((option) => ({
            ...option,
            value: rewriteCodexDiagnosticsCommandPrefix(option.value),
          })),
        };
      }
      return block;
    }),
  };
}

function rewriteCodexDiagnosticsCommandPrefix(value: string): string {
  return value
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} confirm`, `${DIAGNOSTICS_COMMAND} confirm`)
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} cancel`, `${DIAGNOSTICS_COMMAND} cancel`);
}
