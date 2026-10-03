import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { getChannelPlugin } from "../../../channels/plugins/index.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../../channels/plugins/types.public.js";
import { resolveMessageSecretScope } from "../../../cli/message-secret-scope.js";
import { parseAccountSelector } from "../../../commands/channels/account-selector.js";
import { parseChannelSelector } from "../../../commands/channels/channel-selector.js";
import type { messageCommand } from "../../../commands/message.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { danger, setVerbose } from "../../../globals.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import { resolveMessageActionOutcome } from "../../../infra/outbound/message-action-contracts.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { withActivatedPluginIds } from "../../../plugins/activation-context.js";
import {
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../../plugins/channel-plugin-ids.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  ABSOLUTE_DEADLINE_EXPIRED,
  awaitWithinDeadline,
} from "../../../utils/absolute-deadline.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { measureCliCommandStartup } from "../../command-startup-timing.js";
import { requestExitAfterOneShotOutput } from "../../one-shot-exit.js";

export type MessageCliHelpers = ReturnType<typeof createMessageCliHelpers>;

const GATEWAY_STOP_TIMEOUT_MS = 2500;
const CHANNEL_MESSAGE_ACTION_NAME_SET = new Set<string>(CHANNEL_MESSAGE_ACTION_NAMES);
const STRICT_POSITIVE_INTEGER_OPTIONS = new Map([
  ["pollDurationHours", "--poll-duration-hours"],
  ["pollDurationSeconds", "--poll-duration-seconds"],
  ["limit", "--limit"],
  ["autoArchiveMin", "--auto-archive-min"],
]);
const STRICT_NON_NEGATIVE_INTEGER_OPTIONS = new Map([
  ["durationMin", "--duration-min"],
  ["deleteDays", "--delete-days"],
]);

function normalizeMessageOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const { account, ...rest } = opts;
  return {
    ...rest,
    accountId: typeof account === "string" ? account : rest.accountId,
  };
}

function validateMessageNumericOptions(opts: Record<string, unknown>): void {
  for (const [key, flag] of STRICT_POSITIVE_INTEGER_OPTIONS) {
    if (opts[key] === undefined) {
      continue;
    }
    if (parseStrictPositiveInteger(opts[key]) === undefined) {
      throw new Error(`${flag} must be a positive integer.`);
    }
  }
  for (const [key, flag] of STRICT_NON_NEGATIVE_INTEGER_OPTIONS) {
    if (opts[key] === undefined) {
      continue;
    }
    if (parseStrictNonNegativeInteger(opts[key]) === undefined) {
      throw new Error(`${flag} must be a non-negative integer.`);
    }
  }
}

async function runPluginStopHooks(registry: PluginRegistry): Promise<void> {
  const { createHookRunner } = await import("../../../plugins/hooks.js");
  const runner = createHookRunner(registry, { logger: createSubsystemLogger("plugins") });
  const result = await awaitWithinDeadline(
    () =>
      withPluginRuntimeRegistryScope(registry, () =>
        runner.runGatewayStop({ reason: "cli message action complete" }, {}),
      ),
    Date.now() + GATEWAY_STOP_TIMEOUT_MS,
  );
  if (result === ABSOLUTE_DEADLINE_EXPIRED) {
    defaultRuntime.error(
      danger(`gateway_stop hook exceeded ${GATEWAY_STOP_TIMEOUT_MS}ms; continuing`),
    );
  }
}

function asChannelMessageActionName(action: string): ChannelMessageActionName | undefined {
  return CHANNEL_MESSAGE_ACTION_NAME_SET.has(action)
    ? (action as ChannelMessageActionName)
    : undefined;
}

function isGatewayOwnedMessageAction(action: string, scopedChannel: string | undefined): boolean {
  const messageAction = asChannelMessageActionName(action);
  if (!messageAction || !scopedChannel) {
    return false;
  }
  const plugin = getChannelPlugin(scopedChannel);
  const executionMode = plugin?.actions?.resolveExecutionMode?.({
    action: messageAction,
  });
  return executionMode === "gateway";
}

/** Create shared option decorators and the common message action runner. */
export function createMessageCliHelpers(messageChannelOptions: string) {
  return {
    withMessageBase: (command: Command, target?: "required") => {
      if (target === "required") {
        command.requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);
      }
      return command
        .option("--channel <channel>", `Channel: ${messageChannelOptions}`, parseChannelSelector)
        .option("--account <id>", "Channel account id (accountId)", parseAccountSelector)
        .option("--json", "Output result as JSON", false)
        .option("--dry-run", "Print payload and skip sending", false)
        .option("--verbose", "Verbose logging", false);
    },

    runMessageAction: async (action: string, opts: Record<string, unknown>) => {
      setVerbose(Boolean(opts.verbose));
      let failed = false;
      let result: Awaited<ReturnType<typeof messageCommand>> | undefined;
      let pluginRegistry: PluginRegistry | undefined;
      try {
        await runCommandWithRuntime(
          defaultRuntime,
          async () => {
            validateMessageNumericOptions(opts);
            if (action === "poll" && opts.pollAnonymous === true && opts.pollPublic === true) {
              throw new Error("--poll-anonymous and --poll-public are mutually exclusive.");
            }
            const { channel: scopedChannel } = resolveMessageSecretScope({
              channel: opts.channel,
              target: opts.target,
              targets: opts.targets,
            });
            // Gateway-owned actions need no local plugin runtime; previews and broadcasts do.
            const preloadPlugins =
              opts.dryRun === true ||
              action === "broadcast" ||
              !isGatewayOwnedMessageAction(action, scopedChannel);
            await measureCliCommandStartup("config-ready", async () => {
              const { ensureConfigReady } = await import("../config-guard.js");
              await ensureConfigReady({
                runtime: defaultRuntime,
                commandPath: ["message", action],
                suppressDoctorStdout: opts.json === true,
                validateConfigOnly: !preloadPlugins,
                measure: (stage, run) => measureCliCommandStartup(stage, run),
              });
            });
            if (preloadPlugins) {
              const config = getRuntimeConfig();
              const pluginIds = scopedChannel
                ? resolveDiscoverableScopedChannelPluginIds({
                    config,
                    activationSourceConfig: config,
                    channelIds: [scopedChannel],
                    env: process.env,
                  })
                : resolveConfiguredChannelPluginIds({
                    config,
                    activationSourceConfig: config,
                    env: process.env,
                  });
              const activatedConfig = withActivatedPluginIds({ config, pluginIds }) ?? config;
              const { loadPluginRegistryHandle } = await import("../../../plugins/loader.js");
              pluginRegistry = loadPluginRegistryHandle({
                config: activatedConfig,
                activationSourceConfig: activatedConfig,
                onlyPluginIds: pluginIds,
                throwOnLoadError: true,
              });
            }
            const [{ messageCommand }, { createDefaultDeps }] = await Promise.all([
              import("../../../commands/message.js"),
              import("../../deps.js"),
            ]);
            const deps = createDefaultDeps();
            const run = () =>
              messageCommand(
                {
                  ...normalizeMessageOptions(opts),
                  action,
                },
                deps,
                defaultRuntime,
              );
            result = await withPluginRuntimeRegistryScope(pluginRegistry, run);
          },
          (err) => {
            failed = true;
            defaultRuntime.error(danger(formatErrorMessage(err)));
          },
        );
      } finally {
        // Finalize only this command's registry, including JSON/expected errors that rethrow.
        if (pluginRegistry && action !== "read") {
          await runPluginStopHooks(pluginRegistry);
        }
      }
      failed ||= result !== undefined && !resolveMessageActionOutcome(result).ok;
      requestExitAfterOneShotOutput(defaultRuntime, failed ? 1 : 0);
    },
  };
}
