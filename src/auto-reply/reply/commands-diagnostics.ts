/** Handles diagnostics commands and private owner routing for sensitive diagnostics output. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { createExecTool } from "../../agents/bash-tools.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  LegacyInteractiveReply,
  MessagePresentationAction,
} from "../../interactive/payload.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";
import type { PluginCommandDiagnosticsSession, PluginCommandResult } from "../../plugins/types.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import type { ReplyPayload } from "../types.js";
import { formatCommandExecResult, formatCommandExecText } from "./command-exec-result.js";
import { commandReply, matchCommandPrefix, rejectNonOwnerCommand } from "./command-gates.js";
import { buildPluginCommandContext } from "./commands-context.js";
import { buildCurrentOpenClawCliExecRequest } from "./commands-openclaw-cli.js";
import {
  buildCommandExecApprovalDefaults,
  deliverPrivateCommandReply,
  resolvePrivateCommandRouteTargets,
  type PrivateCommandRouteTarget,
} from "./commands-private-route.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const DIAGNOSTICS_COMMAND = "/diagnostics";
const CODEX_DIAGNOSTICS_COMMAND = "/codex diagnostics";
const DIAGNOSTICS_DOCS_URL = "https://docs.openclaw.ai/gateway/diagnostics";
const GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL = "openclaw gateway diagnostics export --json";
const DIAGNOSTICS_EXEC_SCOPE_KEY = "chat:diagnostics";
const DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner approval route for diagnostics. Run /diagnostics from an owner DM so the sensitive diagnostics details are not posted in this chat.";
const DIAGNOSTICS_PRIVATE_ROUTE_REPLIES = {
  delivered: "Diagnostics are sensitive. I sent the diagnostics details to the owner privately.",
  pending: "Diagnostics are sensitive. Private delivery is pending; I can't confirm receipt yet.",
  suppressed:
    "Diagnostics are sensitive. Private delivery of the diagnostics details was suppressed.",
  failed: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE,
};

type CodexDiagnosticsApprovalIntegration = {
  approvalText?: string;
  approvalFollowup?: () => Promise<string | undefined>;
};

export const handleDiagnosticsCommand: CommandHandler = async (input, allowTextCommands) => {
  const params = { ...input, command: { ...input.command } };
  if (!allowTextCommands) {
    return null;
  }
  const args = matchCommandPrefix(
    params.command.commandBodyNormalized.trim(),
    DIAGNOSTICS_COMMAND,
    {
      allowColon: true,
    },
  );
  if (args == null) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /diagnostics from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const nonOwner = rejectNonOwnerCommand(params, DIAGNOSTICS_COMMAND);
  if (nonOwner) {
    return nonOwner;
  }
  const source = captureIncognitoSessionSource(params);
  if (!source) {
    return await runDiagnosticsCommand(params, args);
  }
  if ("kind" in source) {
    return commandReply(`Session not found: ${params.sessionKey}`);
  }
  return await source.actor.sessions.withSharedState(async () => {
    const claim = source.actor.sessions.captureCurrent(params.sessionKey);
    const assertOwnerCurrent = params.command.assertOwnerCurrent;
    let active = true;
    const assertCurrent = () => {
      params.commandInvocationSignal?.throwIfAborted();
      params.opts?.abortSignal?.throwIfAborted();
      source.admissionSignal?.throwIfAborted();
      source.actor.assertReadable();
      claim.assertCurrent();
      assertOwnerCurrent?.();
      if (!active) {
        throw new Error("Diagnostics command source has been released");
      }
    };
    try {
      assertCurrent();
      if (!source.actor.sessions.readSharing(params.sessionKey)?.entry) {
        return commandReply(`Session not found: ${params.sessionKey}`);
      }
      return await withGatewayToolCallerIdentity(
        {
          agentId: source.actor.agentId,
          sessionKey: params.sessionKey,
          receiptAuthority: assertCurrent,
        },
        async () => {
          const result = await runDiagnosticsCommand(
            {
              ...params,
              agentId: source.actor.agentId,
              storePath: source.actor.path,
              command: { ...params.command, assertOwnerCurrent: assertCurrent },
            },
            args,
            assertCurrent,
          );
          assertCurrent();
          return result;
        },
      );
    } finally {
      active = false;
    }
  });
};

async function runDiagnosticsCommand(
  params: HandleCommandsParams,
  args: string,
  assertCurrent?: () => void,
) {
  // Inventory belongs to this command; a selected actor never merges stale host rows.
  const entries = params.storePath
    ? assertCurrent
      ? await readSessionEntrySummariesInWorker({
          agentId: params.agentId,
          storePath: params.storePath,
        })
      : listSessionEntriesReadOnly({
          agentId: params.agentId,
          storePath: params.storePath,
          projection: "list",
        })
    : undefined;
  assertCurrent?.();
  const commandParams = entries
    ? {
        ...params,
        sessionStore: {
          ...Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
          ...(assertCurrent ? {} : params.sessionStore),
        },
        ...(assertCurrent
          ? {
              sessionEntry: entries.find(({ sessionKey }) => sessionKey === params.sessionKey)
                ?.entry,
            }
          : {}),
      }
    : params;
  if (isCodexDiagnosticsConfirmationAction(args)) {
    const codexResult = await executeCodexDiagnosticsAddon(commandParams, args);
    const reply = codexResult
      ? rewriteCodexDiagnosticsResult(codexResult)
      : { text: "No Codex diagnostics confirmation handler is available for this session." };
    if (commandParams.isGroup) {
      return await deliverGroupDiagnosticsReplyPrivately(
        commandParams,
        reply,
        undefined,
        assertCurrent,
      );
    }
    assertCurrent?.();
    return commandReply(reply);
  }

  if (commandParams.isGroup) {
    const privateTarget = (await resolvePrivateDiagnosticsTargetsForCommand(commandParams))[0];
    assertCurrent?.();
    if (!privateTarget) {
      return commandReply(DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE);
    }
    const privateReply = await buildDiagnosticsReply(commandParams, args, {
      diagnosticsPrivateRouted: true,
      privateApprovalTarget: privateTarget,
    });
    assertCurrent?.();
    if (!privateReply) {
      return commandReply(
        "Diagnostics are sensitive. Owner approval is pending on the private route.",
      );
    }
    return await deliverGroupDiagnosticsReplyPrivately(
      commandParams,
      privateReply,
      privateTarget,
      assertCurrent,
    );
  }

  const reply = await buildDiagnosticsReply(commandParams, args);
  assertCurrent?.();
  return reply ? commandReply(reply) : { shouldContinue: false };
}

async function deliverGroupDiagnosticsReplyPrivately(
  params: HandleCommandsParams,
  reply: ReplyPayload,
  privateTarget?: PrivateCommandRouteTarget,
  assertCurrent?: () => void,
) {
  const target = privateTarget ?? (await resolvePrivateDiagnosticsTargetsForCommand(params))[0];
  assertCurrent?.();
  if (!target) {
    return commandReply(DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE);
  }
  const outcome = await deliverPrivateCommandReply({
    commandParams: params,
    targets: [target],
    reply,
    assertCurrent,
  });
  assertCurrent?.();
  return commandReply(DIAGNOSTICS_PRIVATE_ROUTE_REPLIES[outcome]);
}

function buildDiagnosticsPreamble(): string[] {
  return [
    "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    `Treat diagnostics bundles like secrets and review what they contain before sharing: ${DIAGNOSTICS_DOCS_URL}`,
  ];
}

function buildDiagnosticsApprovalWarning(codexApprovalText?: string): string {
  const lines = buildDiagnosticsPreamble();
  if (codexApprovalText) {
    lines.push("", codexApprovalText);
  }
  return lines.join("\n");
}

async function resolvePrivateDiagnosticsTargetsForCommand(
  params: HandleCommandsParams,
): Promise<PrivateCommandRouteTarget[]> {
  return await resolvePrivateCommandRouteTargets({
    commandParams: params,
    id: "diagnostics-private-route",
    command: buildGatewayDiagnosticsExportJsonRequest().command,
  });
}

function buildGatewayDiagnosticsExportJsonRequest() {
  return buildCurrentOpenClawCliExecRequest(["gateway", "diagnostics", "export", "--json"]);
}

async function buildDiagnosticsReply(
  params: HandleCommandsParams,
  args: string,
  options: {
    diagnosticsPrivateRouted?: boolean;
    privateApprovalTarget?: PrivateCommandRouteTarget;
  } = {},
): Promise<ReplyPayload | undefined> {
  const codexDiagnostics =
    (await buildCodexDiagnosticsApprovalIntegration(params, args, options)) ?? {};
  params.command.assertOwnerCurrent?.();
  const timeoutSec = params.cfg.tools?.exec?.timeoutSeconds;
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const { command, env } = buildGatewayDiagnosticsExportJsonRequest();
  try {
    const execTool = createExecTool({
      ...buildCommandExecApprovalDefaults(params, options.privateApprovalTarget),
      trigger: "diagnostics",
      scopeKey: DIAGNOSTICS_EXEC_SCOPE_KEY,
      approvalWarningText: buildDiagnosticsApprovalWarning(codexDiagnostics.approvalText),
      approvalFollowup: codexDiagnostics.approvalFollowup,
      approvalFollowupMode: "direct",
      timeoutSec,
      agentId,
    });
    params.command.assertOwnerCurrent?.();
    const result = await execTool.execute("chat-diagnostics-gateway-export", {
      command,
      env,
      ask: "always",
      background: true,
      timeoutSeconds: timeoutSec,
    });
    params.command.assertOwnerCurrent?.();
    if (result.details?.status === "approval-pending") {
      return undefined;
    }
    const codexFollowupText =
      result.details?.status === "completed" || result.details?.status === "failed"
        ? await codexDiagnostics.approvalFollowup?.()
        : undefined;
    params.command.assertOwnerCurrent?.();
    const lines = buildDiagnosticsPreamble();
    lines.push(
      "",
      `Local Gateway bundle: requested \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL}\` through exec approval. Approve once to create the bundle; do not use allow-all for diagnostics.`,
      formatCommandExecResult(result, "Gateway diagnostics export"),
    );
    if (codexFollowupText) {
      lines.push("", codexFollowupText);
    }
    return { text: lines.join("\n") };
  } catch (error) {
    rethrowIncognitoSessionError(error);
    params.command.assertOwnerCurrent?.();
    const lines = buildDiagnosticsPreamble();
    lines.push(
      "",
      `Local Gateway bundle: could not request exec approval for \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL}\`.`,
      formatCommandExecText(formatErrorMessage(error)),
    );
    return { text: lines.join("\n") };
  }
}

async function buildCodexDiagnosticsApprovalIntegration(
  params: HandleCommandsParams,
  args: string,
  options: { diagnosticsPrivateRouted?: boolean } = {},
): Promise<CodexDiagnosticsApprovalIntegration | undefined> {
  const hasHarnessMetadata = hasCodexHarnessMetadata(params);
  const renderSection = (result: PluginCommandResult | undefined) => {
    if (!result) {
      return hasHarnessMetadata
        ? {
            approvalText:
              "OpenAI Codex harness: selected for this session, but the bundled Codex diagnostics command is not registered.",
          }
        : undefined;
    }
    const reply = rewriteCodexDiagnosticsResult(result);
    if (!hasHarnessMetadata && isCodexDiagnosticsUnavailableText(reply.text)) {
      return undefined;
    }
    return {
      approvalText: reply.text ? ["OpenAI Codex harness:", reply.text].join("\n") : undefined,
    };
  };
  const previewResult = await executeCodexDiagnosticsAddon(params, args, {
    ...options,
    diagnosticsPreviewOnly: true,
  });
  const preview = renderSection(previewResult);
  if (!preview || !previewResult) {
    return preview;
  }
  return {
    ...preview,
    approvalFollowup: async () =>
      renderSection(
        await executeCodexDiagnosticsAddon(params, args, {
          ...options,
          diagnosticsUploadApproved: true,
        }),
      )?.approvalText,
  };
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

function hasCodexHarnessMetadata(params: HandleCommandsParams): boolean {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (targetSessionEntry?.agentHarnessId === "codex") {
    return true;
  }
  return Object.values(params.sessionStore ?? {}).some(
    (entry) => entry?.agentHarnessId === "codex",
  );
}

function isCodexDiagnosticsUnavailableText(text: string | undefined): boolean {
  return (
    text?.startsWith("No Codex thread is attached to this OpenClaw session yet.") === true ||
    text?.startsWith(
      "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.",
    ) === true
  );
}

async function executeCodexDiagnosticsAddon(
  params: HandleCommandsParams,
  args: string,
  options: {
    diagnosticsPrivateRouted?: boolean;
    diagnosticsUploadApproved?: boolean;
    diagnosticsPreviewOnly?: boolean;
  } = {},
): Promise<PluginCommandResult | undefined> {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const commandBody = args ? `${CODEX_DIAGNOSTICS_COMMAND} ${args}` : CODEX_DIAGNOSTICS_COMMAND;
  const match = matchPluginCommand(commandBody);
  if (!match || match.command.pluginId !== "codex") {
    return undefined;
  }
  params.command.assertOwnerCurrent?.();
  return await executePluginCommand({
    command: match.command,
    args: match.args,
    ...buildPluginCommandContext(params),
    sessionId: targetSessionEntry?.sessionId,
    sessionFile: targetSessionEntry ? params.sessionKey : undefined,
    authProfileId: targetSessionEntry?.authProfileOverride,
    commandBody,
    diagnosticsSessions: buildCodexDiagnosticsSessions(params),
    ...(options.diagnosticsUploadApproved === undefined
      ? {}
      : { diagnosticsUploadApproved: options.diagnosticsUploadApproved }),
    ...(options.diagnosticsPreviewOnly === undefined
      ? {}
      : { diagnosticsPreviewOnly: options.diagnosticsPreviewOnly }),
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
    .filter(([, entry]) => Boolean(entry.sessionId?.trim()))
    .map(([sessionKey, entry]) => {
      const delivery = deliveryContextFromSession(entry);
      const origin = sessionDeliveryOrigin(entry);
      const isCurrent = sessionKey === params.sessionKey;
      return {
        sessionKey,
        sessionId: entry.sessionId,
        sessionFile: sessionKey,
        agentHarnessId: entry.agentHarnessId,
        channel:
          normalizeOptionalString(delivery?.channel) ??
          normalizeOptionalString(origin?.provider) ??
          (isCurrent ? params.command.channel : undefined),
        channelId:
          normalizeOptionalString(origin?.nativeChannelId) ??
          (isCurrent ? params.command.channelId : undefined),
        accountId:
          normalizeOptionalString(delivery?.accountId) ??
          normalizeOptionalString(origin?.accountId) ??
          (isCurrent ? (params.ctx.AccountId ?? undefined) : undefined),
        messageThreadId:
          delivery?.threadId ??
          origin?.threadId ??
          (isCurrent &&
          (typeof params.ctx.MessageThreadId === "string" ||
            typeof params.ctx.MessageThreadId === "number")
            ? params.ctx.MessageThreadId
            : undefined),
        threadParentId: isCurrent ? normalizeOptionalString(params.ctx.ThreadParentId) : undefined,
      };
    });
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

function rewriteInteractive(interactive: LegacyInteractiveReply): LegacyInteractiveReply {
  return {
    blocks: interactive.blocks.map((block) => {
      if (block.type === "buttons") {
        return {
          ...block,
          buttons: block.buttons.map((button) => ({
            ...button,
            ...(button.action ? { action: rewritePresentationAction(button.action) } : {}),
            ...(button.value ? { value: rewriteCodexDiagnosticsCommandPrefix(button.value) } : {}),
          })),
        };
      }
      if (block.type === "select") {
        return {
          ...block,
          options: block.options.map((option) => ({
            ...option,
            ...(option.action ? { action: rewritePresentationAction(option.action) } : {}),
            ...(option.value ? { value: rewriteCodexDiagnosticsCommandPrefix(option.value) } : {}),
          })),
        };
      }
      return block;
    }),
  };
}

function rewritePresentationAction(
  action: Extract<MessagePresentationAction, { type: "command" | "callback" | "model-picker" }>,
): Extract<MessagePresentationAction, { type: "command" | "callback" | "model-picker" }>;
function rewritePresentationAction(action: MessagePresentationAction): MessagePresentationAction;
function rewritePresentationAction(action: MessagePresentationAction): MessagePresentationAction {
  if (action.type === "command") {
    return {
      type: "command",
      command: rewriteCodexDiagnosticsCommandPrefix(action.command),
    };
  }
  if (action.type === "callback") {
    return {
      type: "callback",
      value: rewriteCodexDiagnosticsCommandPrefix(action.value),
    };
  }
  return action;
}

function rewriteCodexDiagnosticsCommandPrefix(value: string): string {
  return value
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} confirm`, `${DIAGNOSTICS_COMMAND} confirm`)
    .replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} cancel`, `${DIAGNOSTICS_COMMAND} cancel`);
}
