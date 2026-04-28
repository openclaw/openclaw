import { logVerbose } from "../../globals.js";
import type { InteractiveReply } from "../../interactive/payload.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";
import type { PluginCommandResult } from "../../plugins/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { rejectNonOwnerCommand } from "./command-gates.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const DIAGNOSTICS_COMMAND = "/diagnostics";
const CODEX_DIAGNOSTICS_COMMAND = "/codex diagnostics";
const DIAGNOSTICS_DOCS_URL = "https://docs.openclaw.ai/gateway/diagnostics";
const GATEWAY_DIAGNOSTICS_EXPORT_COMMAND = "openclaw gateway diagnostics export";

export const handleDiagnosticsCommand: CommandHandler = async (params, allowTextCommands) => {
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
    return {
      shouldContinue: false,
      reply: codexResult
        ? rewriteCodexDiagnosticsResult(codexResult)
        : { text: "No Codex diagnostics confirmation handler is available for this session." },
    };
  }

  const lines = buildDiagnosticsPreamble();
  let interactive: InteractiveReply | undefined;
  if (isCodexHarnessSession(params)) {
    const codexResult = await executeCodexDiagnosticsAddon(params, args);
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
    shouldContinue: false,
    reply: {
      text: lines.join("\n"),
      ...(interactive ? { interactive } : {}),
    },
  };
};

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
    `Local Gateway bundle: run \`${GATEWAY_DIAGNOSTICS_EXPORT_COMMAND}\` through an explicit exec approval each time. Do not approve diagnostics with an allow-all rule.`,
  ];
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
