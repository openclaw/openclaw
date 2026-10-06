import { resolveAcpSessionIdentifierLinesFromIdentity } from "@openclaw/acp-core/runtime/session-identifiers";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import type { AcpSessionTarget } from "../../../acp/control-plane/manager.types.js";
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
  parseSingleValueCommandInput,
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

function defineSingleRuntimeOptionAction<T>(action: {
  usage: string;
  optionLabel: string;
  parseValue: (value: string) => T;
  formatValue?: (value: T) => string;
  update: (
    params: HandleCommandsParams,
    target: AcpSessionTarget,
    value: T,
  ) => Promise<AcpSessionRuntimeOptions>;
}) {
  return async (
    commandParams: HandleCommandsParams,
    restTokens: string[],
  ): Promise<CommandHandlerResult> => {
    const parsed = parseSingleValueCommandInput(restTokens, action.usage);
    if (!parsed.ok) {
      return commandReply(`⚠️ ${parsed.error}`);
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
        const parsedValue = action.parseValue(parsed.value.value);
        const options = await action.update(commandParams, target, parsedValue);
        const valueText = action.formatValue?.(parsedValue) ?? String(parsedValue);
        return commandReply(
          `✅ Updated ACP ${action.optionLabel} for ${target.sessionKey}: ${valueText}. Effective options: ${formatRuntimeOptionsText(options)}`,
        );
      },
      fallbackMessage: `Could not update ACP ${action.optionLabel}.`,
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

export const handleAcpSetModeAction = defineSingleRuntimeOptionAction({
  usage: ACP_SET_MODE_USAGE,
  optionLabel: "runtime mode",
  parseValue: validateRuntimeModeInput,
  update: async (params, target, value) =>
    await getAcpSessionManager().setSessionRuntimeMode({
      assertActive: params.command.assertOwnerCurrent,
      cfg: params.cfg,
      ...target,
      runtimeMode: value,
    }),
});

export async function handleAcpSetAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSetCommandInput(restTokens);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
  }
  const key = parsed.value.key.trim();
  const value = parsed.value.value.trim();

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const lowerKey = normalizeLowercaseStringOrEmpty(key);
      if (lowerKey === "cwd") {
        const cwd = validateRuntimeCwdInput(value);
        const options = await getAcpSessionManager().updateSessionRuntimeOptions({
          assertActive: params.command.assertOwnerCurrent,
          cfg: params.cfg,
          ...target,
          patch: { cwd },
        });
        return commandReply(
          `✅ Updated ACP cwd for ${target.sessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
        );
      }
      const validated = validateRuntimeConfigOptionInput(key, value);
      const options = await getAcpSessionManager().setSessionConfigOption({
        assertActive: params.command.assertOwnerCurrent,
        cfg: params.cfg,
        ...target,
        key: validated.key,
        value: validated.value,
      });
      return commandReply(
        `✅ Updated ACP config option for ${target.sessionKey}: ${validated.key}=${validated.value}. Effective options: ${formatRuntimeOptionsText(options)}`,
      );
    },
    fallbackMessage: "Could not update ACP config option.",
  });
}

export const handleAcpCwdAction = defineSingleRuntimeOptionAction({
  usage: ACP_CWD_USAGE,
  optionLabel: "cwd",
  parseValue: validateRuntimeCwdInput,
  update: async (params, target, value) =>
    await getAcpSessionManager().updateSessionRuntimeOptions({
      assertActive: params.command.assertOwnerCurrent,
      cfg: params.cfg,
      ...target,
      patch: { cwd: value },
    }),
});

export const handleAcpPermissionsAction = defineSingleRuntimeOptionAction({
  usage: ACP_PERMISSIONS_USAGE,
  optionLabel: "permissions profile",
  parseValue: validateRuntimePermissionProfileInput,
  update: async (params, target, value) =>
    await getAcpSessionManager().setSessionConfigOption({
      assertActive: params.command.assertOwnerCurrent,
      cfg: params.cfg,
      ...target,
      key: "approval_policy",
      value,
    }),
});

export const handleAcpTimeoutAction = defineSingleRuntimeOptionAction({
  usage: ACP_TIMEOUT_USAGE,
  optionLabel: "timeout",
  parseValue: parseRuntimeTimeoutSecondsInput,
  formatValue: (value) => `${value}s`,
  update: async (params, target, value) =>
    await getAcpSessionManager().setSessionConfigOption({
      assertActive: params.command.assertOwnerCurrent,
      cfg: params.cfg,
      ...target,
      key: "timeout",
      value: String(value),
    }),
});

export const handleAcpModelAction = defineSingleRuntimeOptionAction({
  usage: ACP_MODEL_USAGE,
  optionLabel: "model",
  parseValue: validateRuntimeModelInput,
  update: async (params, target, value) =>
    await getAcpSessionManager().setSessionConfigOption({
      assertActive: params.command.assertOwnerCurrent,
      cfg: params.cfg,
      ...target,
      key: "model",
      value,
    }),
});

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
