import { resolveConfigWriteTargetFromPath } from "../../channels/plugins/config-writes.js";
import { normalizeChannelId } from "../../channels/registry.js";
import {
  readExperimentalConfigFlagStatesFromFile,
  writeExperimentalConfigFlagToFile,
} from "../../config/experimental-config-file.js";
import {
  formatExperimentalConfigFlagStates,
  resolveExperimentalConfigFlag,
} from "../../config/experimental-flags.js";
import { resolveChannelAccountId } from "./channel-context.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";
import { parseExperimentalCommand } from "./experimental-commands.js";

export const handleExperimentalCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const experimentalCommand = parseExperimentalCommand(params.command.commandBodyNormalized);
  if (!experimentalCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/experimental");
  if (unauthorized) {
    return unauthorized;
  }
  const nonOwner = rejectNonOwnerCommand(params, "/experimental");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/experimental",
    configKey: "experimental",
  });
  if (disabled) {
    return disabled;
  }
  if (experimentalCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${experimentalCommand.message}` },
    };
  }

  if (experimentalCommand.action === "list") {
    try {
      return {
        shouldContinue: false,
        reply: {
          text: formatExperimentalConfigFlagStates(
            await readExperimentalConfigFlagStatesFromFile(),
          ),
        },
      };
    } catch (err) {
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ ${String(err instanceof Error ? err.message : err)}`,
        },
      };
    }
  }

  const flag = resolveExperimentalConfigFlag(experimentalCommand.selector);
  if (!flag) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Unknown experimental flag: ${experimentalCommand.selector}` },
    };
  }
  const missingAdminScope = requireGatewayClientScope(params, {
    label: "/experimental write",
    allowedScopes: ["operator.admin"],
    missingText: "❌ /experimental write requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }
  const channelId = params.command.channelId ?? normalizeChannelId(params.command.channel);
  const deniedText = resolveConfigWriteDeniedText({
    cfg: params.cfg,
    channel: params.command.channel,
    originChannelId: channelId,
    originAccountId: resolveChannelAccountId({
      cfg: params.cfg,
      ctx: params.ctx,
      command: params.command,
    }),
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    target: resolveConfigWriteTargetFromPath(flag.path.split(".")),
  });
  if (deniedText) {
    return {
      shouldContinue: false,
      reply: { text: deniedText },
    };
  }

  try {
    const result = await writeExperimentalConfigFlagToFile({
      path: flag.path,
      value: experimentalCommand.value,
      afterWrite: { mode: "auto" },
    });
    if (!result.changed) {
      return {
        shouldContinue: false,
        reply: {
          text: `Experimental flag already ${experimentalCommand.value ? "enabled" : "disabled"}: ${flag.path}`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: `Config updated: ${result.path}=${result.value ? "true" : "false"}`,
      },
    };
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ ${String(err instanceof Error ? err.message : err)}`,
      },
    };
  }
};
