import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import {
  commandReply,
  matchCommandPrefix,
  rejectNonOwnerCommand,
  requireGatewayClientScope,
} from "./command-gates.js";
import { COMMAND, resolveAcpHelpText } from "./commands-acp/shared.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

type AcpActionHandler = (
  params: HandleCommandsParams,
  tokens: string[],
) => Promise<CommandHandlerResult> | CommandHandlerResult;

const ACP_ACTION_LOADERS: Readonly<Record<string, () => Promise<AcpActionHandler>>> = {
  spawn: async () => (await import("./commands-acp/lifecycle.js")).handleAcpSpawnAction,
  cancel: async () => (await import("./commands-acp/lifecycle.js")).handleAcpCancelAction,
  steer: async () => (await import("./commands-acp/lifecycle.js")).handleAcpSteerAction,
  close: async () => (await import("./commands-acp/lifecycle.js")).handleAcpCloseAction,
  status: async () => (await import("./commands-acp/runtime-options.js")).handleAcpStatusAction,
  "set-mode": async () =>
    (await import("./commands-acp/runtime-options.js")).handleAcpSetModeAction,
  set: async () => (await import("./commands-acp/runtime-options.js")).handleAcpSetAction,
  cwd: async () => (await import("./commands-acp/runtime-options.js")).handleAcpCwdAction,
  permissions: async () =>
    (await import("./commands-acp/runtime-options.js")).handleAcpPermissionsAction,
  timeout: async () => (await import("./commands-acp/runtime-options.js")).handleAcpTimeoutAction,
  model: async () => (await import("./commands-acp/runtime-options.js")).handleAcpModelAction,
  "reset-options": async () =>
    (await import("./commands-acp/runtime-options.js")).handleAcpResetOptionsAction,
  doctor: async () => (await import("./commands-acp/diagnostics.js")).handleAcpDoctorAction,
  install: async () => (await import("./commands-acp/diagnostics.js")).handleAcpInstallAction,
  sessions: async () => (await import("./commands-acp/diagnostics.js")).handleAcpSessionsAction,
};

const ACP_PUBLIC_ACTIONS = new Set(["doctor", "install", "sessions"]);

export const handleAcpCommand: CommandHandler = async (params, _allowTextCommands) => {
  const rest = matchCommandPrefix(params.command.commandBodyNormalized, COMMAND);
  if (rest === null) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /acp from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = normalizeOptionalLowercaseString(tokens[0]) ?? "";
  const loadHandler = Object.hasOwn(ACP_ACTION_LOADERS, action)
    ? ACP_ACTION_LOADERS[action]
    : undefined;
  if (!loadHandler) {
    return commandReply(resolveAcpHelpText());
  }

  tokens.shift();
  if (!ACP_PUBLIC_ACTIONS.has(action)) {
    const scopeBlock = requireGatewayClientScope(params, {
      label: "/acp",
      allowedScopes: ["operator.admin"],
      missingText: "This /acp action requires operator.admin on the internal channel.",
    });
    if (scopeBlock) {
      return scopeBlock;
    }
    // Command auth maps internal operator.admin scope to owner identity, so this
    // second gate rejects external non-owners without blocking Gateway admins.
    const nonOwner = rejectNonOwnerCommand(params, "/acp");
    if (nonOwner) {
      return nonOwner;
    }
  }

  const handler = await loadHandler();
  return await handler(params, tokens);
};
