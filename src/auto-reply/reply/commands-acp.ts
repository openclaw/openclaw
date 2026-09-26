// Implements ACP session commands and runtime status formatting.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
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

const lifecycleHandlersLoader = createLazyImportLoader(() => import("./commands-acp/lifecycle.js"));
const runtimeOptionHandlersLoader = createLazyImportLoader(
  () => import("./commands-acp/runtime-options.js"),
);
const diagnosticHandlersLoader = createLazyImportLoader(
  () => import("./commands-acp/diagnostics.js"),
);

const ACP_ACTION_LOADERS: Readonly<Record<string, () => Promise<AcpActionHandler>>> = {
  spawn: async () => (await lifecycleHandlersLoader.load()).handleAcpSpawnAction,
  cancel: async () => (await lifecycleHandlersLoader.load()).handleAcpCancelAction,
  steer: async () => (await lifecycleHandlersLoader.load()).handleAcpSteerAction,
  close: async () => (await lifecycleHandlersLoader.load()).handleAcpCloseAction,
  status: async () => (await runtimeOptionHandlersLoader.load()).handleAcpStatusAction,
  "set-mode": async () => (await runtimeOptionHandlersLoader.load()).handleAcpSetModeAction,
  set: async () => (await runtimeOptionHandlersLoader.load()).handleAcpSetAction,
  cwd: async () => (await runtimeOptionHandlersLoader.load()).handleAcpCwdAction,
  permissions: async () => (await runtimeOptionHandlersLoader.load()).handleAcpPermissionsAction,
  timeout: async () => (await runtimeOptionHandlersLoader.load()).handleAcpTimeoutAction,
  model: async () => (await runtimeOptionHandlersLoader.load()).handleAcpModelAction,
  "reset-options": async () =>
    (await runtimeOptionHandlersLoader.load()).handleAcpResetOptionsAction,
  doctor: async () => (await diagnosticHandlersLoader.load()).handleAcpDoctorAction,
  install: async () => (await diagnosticHandlersLoader.load()).handleAcpInstallAction,
  sessions: async () => (await diagnosticHandlersLoader.load()).handleAcpSessionsAction,
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
