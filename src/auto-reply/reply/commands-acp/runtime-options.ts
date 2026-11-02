import { resolveAcpSessionIdentifierLinesFromIdentity } from "@openclaw/acp-core/runtime/session-identifiers";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import {
  parseRuntimeTimeoutSecondsInput,
  validateRuntimeConfigOptionInput,
  validateRuntimeCwdInput,
  validateRuntimeModeInput,
  validateRuntimeModelInput,
  validateRuntimePermissionProfileInput,
} from "../../../acp/control-plane/runtime-options.js";
import { sanitizeRunStatusText } from "../../../agents/run-status-text.js";
import type { AcpSessionRuntimeOptions } from "../../../config/sessions/types.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  ACP_CWD_USAGE,
  ACP_MODEL_USAGE,
  ACP_PERMISSIONS_USAGE,
  ACP_RESET_OPTIONS_USAGE,
  ACP_SET_MODE_USAGE,
  ACP_STATUS_USAGE,
  ACP_TIMEOUT_USAGE,
  formatAcpCapabilitiesText,
  formatRuntimeOptionsText,
  parseOptionalSingleTarget,
  parseSetCommandInput,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

async function resolveOptionalSingleTarget(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
}): ReturnType<typeof resolveAcpTargetSessionKey> {
  const parsed = parseOptionalSingleTarget(params.restTokens, params.usage);
  if (!parsed.ok) {
    return parsed;
  }
  return resolveAcpTargetSessionKey({
    commandParams: params.commandParams,
    token: parsed.sessionToken,
  });
}

const SINGLE_RUNTIME_OPTIONS = {
  "set-mode": {
    usage: ACP_SET_MODE_USAGE,
    label: "runtime mode",
    key: "runtimeMode",
    parseValue: validateRuntimeModeInput,
  },
  cwd: {
    usage: ACP_CWD_USAGE,
    label: "cwd",
    key: "cwd",
    parseValue: validateRuntimeCwdInput,
  },
  permissions: {
    usage: ACP_PERMISSIONS_USAGE,
    label: "permissions profile",
    key: "approval_policy",
    parseValue: validateRuntimePermissionProfileInput,
  },
  timeout: {
    usage: ACP_TIMEOUT_USAGE,
    label: "timeout",
    key: "timeout",
    parseValue: parseRuntimeTimeoutSecondsInput,
  },
  model: {
    usage: ACP_MODEL_USAGE,
    label: "model",
    key: "model",
    parseValue: validateRuntimeModelInput,
  },
};

function defineRuntimeOptionAction(action: keyof typeof SINGLE_RUNTIME_OPTIONS | "set") {
  return async (
    commandParams: HandleCommandsParams,
    restTokens: string[],
  ): Promise<CommandHandlerResult> => {
    const single = action === "set" ? undefined : SINGLE_RUNTIME_OPTIONS[action];
    const parsed = parseSetCommandInput(single ? [single.key, ...restTokens] : restTokens);
    if (!parsed.ok) {
      return commandReply(`⚠️ ${single?.usage ?? parsed.error}`);
    }
    const target = await resolveAcpTargetSessionKey({
      commandParams,
      token: parsed.value.sessionToken,
    });
    if (!target.ok) {
      return commandReply(`⚠️ ${target.error}`);
    }
    return await withAcpCommandErrorBoundary({
      run: async () => {
        let label = single?.label ?? "config option";
        let key = parsed.value.key;
        let value = single ? String(single.parseValue(parsed.value.value)) : parsed.value.value;
        const input = {
          assertActive: commandParams.command.assertOwnerCurrent,
          cfg: commandParams.cfg,
          ...target,
        };
        let options: AcpSessionRuntimeOptions;
        if (action === "set-mode") {
          options = await getAcpSessionManager().setSessionRuntimeMode({
            ...input,
            runtimeMode: value,
          });
        } else if (normalizeLowercaseStringOrEmpty(key) === "cwd") {
          value = single ? value : validateRuntimeCwdInput(value);
          label = "cwd";
          options = await getAcpSessionManager().updateSessionRuntimeOptions({
            ...input,
            patch: { cwd: value },
          });
        } else {
          if (!single) {
            ({ key, value } = validateRuntimeConfigOptionInput(key, value));
          }
          options = await getAcpSessionManager().setSessionConfigOption({ ...input, key, value });
        }
        const valueText =
          label === "config option"
            ? `${key}=${value}`
            : action === "timeout"
              ? `${value}s`
              : value;
        return commandReply(
          `✅ Updated ACP ${label} for ${target.sessionKey}: ${valueText}. Effective options: ${formatRuntimeOptionsText(options)}`,
        );
      },
      fallbackMessage: `Could not update ACP ${single?.label ?? "config option"}.`,
    });
  };
}

export async function handleAcpStatusAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const target = await resolveOptionalSingleTarget({
    commandParams: params,
    restTokens,
    usage: ACP_STATUS_USAGE,
  });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
  }

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const status = await getAcpSessionManager().getSessionStatus({
        assertActive: params.command.assertOwnerCurrent,
        cfg: params.cfg,
        ...target,
      });
      const sessionIdentifierLines = resolveAcpSessionIdentifierLinesFromIdentity({
        backend: status.backend,
        identity: status.identity,
      });
      const lastError = sanitizeRunStatusText(status.lastError, { errorContext: true });
      const runtimeSummary = sanitizeRunStatusText(status.runtimeStatus?.summary, {
        errorContext: true,
      });
      const runtimeDetails = sanitizeRunStatusText(status.runtimeStatus?.details, {
        errorContext: true,
      });
      const lastActivityAt = timestampMsToIsoString(status.lastActivityAt) ?? "n/a";
      const lines = [
        "ACP status:",
        "-----",
        `session: ${status.sessionKey}`,
        `owner: ${target.agentId}`,
        `backend: ${status.backend}`,
        `agent: ${status.agent}`,
        ...sessionIdentifierLines,
        `sessionMode: ${status.mode}`,
        `state: ${status.state}`,
        `runtimeOptions: ${formatRuntimeOptionsText(status.runtimeOptions)}`,
        `capabilities: ${formatAcpCapabilitiesText(status.capabilities.controls)}`,
        `lastActivityAt: ${lastActivityAt}`,
        ...(lastError ? [`lastError: ${lastError}`] : []),
        ...(runtimeSummary ? [`runtime: ${runtimeSummary}`] : []),
        ...(runtimeDetails ? [`runtimeDetails: ${runtimeDetails}`] : []),
      ];
      return commandReply(lines.join("\n"));
    },
    fallbackMessage: "Could not read ACP session status.",
  });
}

export const handleAcpSetModeAction = defineRuntimeOptionAction("set-mode");
export const handleAcpSetAction = defineRuntimeOptionAction("set");
export const handleAcpCwdAction = defineRuntimeOptionAction("cwd");
export const handleAcpPermissionsAction = defineRuntimeOptionAction("permissions");
export const handleAcpTimeoutAction = defineRuntimeOptionAction("timeout");
export const handleAcpModelAction = defineRuntimeOptionAction("model");

export async function handleAcpResetOptionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const target = await resolveOptionalSingleTarget({
    commandParams: params,
    restTokens,
    usage: ACP_RESET_OPTIONS_USAGE,
  });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
  }

  return await withAcpCommandErrorBoundary({
    run: async () => {
      await getAcpSessionManager().resetSessionRuntimeOptions({
        assertActive: params.command.assertOwnerCurrent,
        cfg: params.cfg,
        ...target,
      });
      return commandReply(`✅ Reset ACP runtime options for ${target.sessionKey}.`);
    },
    fallbackMessage: "Could not reset ACP runtime options.",
  });
}
