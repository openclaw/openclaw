import { logVerbose } from "../../globals.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import {
  handleAcpDoctorAction,
  handleAcpInstallAction,
  handleAcpSessionsAction,
} from "./commands-acp/diagnostics.js";
import {
  handleAcpCancelAction,
  handleAcpCloseAction,
  handleAcpSpawnAction,
  handleAcpSteerAction,
} from "./commands-acp/lifecycle.js";
import {
  handleAcpCwdAction,
  handleAcpModelAction,
  handleAcpPermissionsAction,
  handleAcpResetOptionsAction,
  handleAcpSetAction,
  handleAcpSetModeAction,
  handleAcpStatusAction,
  handleAcpTimeoutAction,
} from "./commands-acp/runtime-options.js";
import {
  COMMAND,
  type AcpAction,
  resolveAcpAction,
  resolveAcpHelpText,
  stopWithText,
} from "./commands-acp/shared.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

type AcpActionHandler = (
  params: HandleCommandsParams,
  tokens: string[],
) => Promise<CommandHandlerResult>;

const ACP_ACTION_HANDLERS: Record<Exclude<AcpAction, "help">, AcpActionHandler> = {
  spawn: handleAcpSpawnAction,
  cancel: handleAcpCancelAction,
  steer: handleAcpSteerAction,
  close: handleAcpCloseAction,
  status: handleAcpStatusAction,
  "set-mode": handleAcpSetModeAction,
  set: handleAcpSetAction,
  cwd: handleAcpCwdAction,
  permissions: handleAcpPermissionsAction,
  timeout: handleAcpTimeoutAction,
  model: handleAcpModelAction,
  "reset-options": handleAcpResetOptionsAction,
  doctor: handleAcpDoctorAction,
  install: async (params, tokens) => handleAcpInstallAction(params, tokens),
  sessions: async (params, tokens) => handleAcpSessionsAction(params, tokens),
};

const ACP_MUTATING_ACTIONS = new Set<AcpAction>([
  "spawn",
  "cancel",
  "steer",
  "close",
  "status",
  "set-mode",
  "set",
  "cwd",
  "permissions",
  "timeout",
  "model",
  "reset-options",
]);

export const handleAcpCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  if (!normalized.startsWith(COMMAND)) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /acp from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  const rest = normalized.slice(COMMAND.length).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = resolveAcpAction(tokens);
  if (action === "help") {
    return stopWithText(resolveAcpHelpText());
  }

  if (ACP_MUTATING_ACTIONS.has(action)) {
    const scopeBlock = requireGatewayClientScopeForInternalChannel(params, {
      label: "/acp",
      allowedScopes: ["operator.admin"],
      missingText: "This /acp action requires operator.admin on the internal channel.",
    });
    if (scopeBlock) {
      return scopeBlock;
    }
  }

  const handler = ACP_ACTION_HANDLERS[action];
  return handler ? await handler(params, tokens) : stopWithText(resolveAcpHelpText());
};
