import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { Option, type Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../channels/plugins/types.public.js";
import { parseAccountSelector } from "../../commands/channels/account-selector.js";
import { parseChannelSelector } from "../../commands/channels/channel-selector.js";
import type { messageCommand } from "../../commands/message.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { danger, setVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  CHANNEL_TARGET_DESCRIPTION,
  CHANNEL_TARGETS_DESCRIPTION,
} from "../../infra/outbound/channel-target.js";
import { resolveMessageActionOutcome } from "../../infra/outbound/message-action-contracts.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import {
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../runtime.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../../utils/absolute-deadline.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { measureCliCommandStartup } from "../command-startup-timing.js";
import { formatHelpExamples } from "../help-format.js";
import { resolveMessageSecretScope } from "../message-secret-scope.js";
import { requestExitAfterOneShotOutput } from "../one-shot-exit.js";
import type { ProgramContext } from "./context.js";
import { collectOption } from "./helpers.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

const requiredOptions = {
  guild: ["--guild-id <id>", "Guild id"],
  user: ["--user-id <id>", "User id"],
  role: ["--role-id <id>", "Role id"],
  eventName: ["--event-name <name>", "Event name"],
  startTime: ["--start-time <iso>", "Event start time"],
  target: ["-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION],
  messageId: ["--message-id <id>", "Message id"],
  message: ["-m, --message <text>", "Message body"],
} as const;

const GATEWAY_STOP_TIMEOUT_MS = 2500;
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

function validateMessageNumericOptions(opts: Record<string, unknown>): void {
  for (const [options, parse, kind] of [
    [STRICT_POSITIVE_INTEGER_OPTIONS, parseStrictPositiveInteger, "positive"],
    [STRICT_NON_NEGATIVE_INTEGER_OPTIONS, parseStrictNonNegativeInteger, "non-negative"],
  ] as const) {
    for (const [key, flag] of options) {
      if (opts[key] !== undefined && parse(opts[key]) === undefined) {
        throw new Error(`${flag} must be a ${kind} integer.`);
      }
    }
  }
}

async function runPluginStopHooks(registry: PluginRegistry): Promise<void> {
  const { createHookRunner } = await import("../../plugins/hooks.js");
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

/** Gateway-owned via the cheap plugin, or deferred to manifest metadata when none is local. */
function resolveMessageActionOwnership(
  action: string,
  scopedChannel: string | undefined,
): "gateway" | "local" | { channel: string; action: ChannelMessageActionName } {
  const messageAction = CHANNEL_MESSAGE_ACTION_NAMES.find((name) => name === action);
  if (!messageAction || !scopedChannel) {
    return "local";
  }
  const plugin = getChannelPlugin(scopedChannel);
  if (!plugin) {
    return { channel: scopedChannel, action: messageAction };
  }
  return plugin.actions?.resolveExecutionMode?.({ action: messageAction }) === "gateway"
    ? "gateway"
    : "local";
}

// External channel plugins are neither bundled nor loaded here. Their manifest can name the
// actions the plugin sends to the Gateway, so the route runs against a runtime-free adapter.
async function resolveGatewayDelegatedRegistry(params: {
  channel: string;
  action: ChannelMessageActionName;
}): Promise<PluginRegistry | undefined> {
  const config = await captureRuntimeConfigAsyncReader()();
  const { resolveGatewayDelegatedChannelPlugin } =
    await import("../../channels/plugins/read-only.js");
  const plugin = resolveGatewayDelegatedChannelPlugin({
    channelId: params.channel,
    action: params.action,
    config,
    env: process.env,
  });
  if (!plugin) {
    return undefined;
  }
  const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
  const registry = createEmptyPluginRegistry();
  registry.channels.push({ pluginId: plugin.id, source: "manifest", plugin });
  return registry;
}

function resolveThreadCreateRequest(opts: Record<string, unknown>) {
  const { channel } = resolveMessageSecretScope(opts);
  if (channel) {
    const request = getChannelPlugin(channel)?.actions?.resolveCliActionRequest?.({
      action: "thread-create",
      args: opts,
    });
    if (request) {
      return request;
    }
  }
  return {
    action: "thread-create" as const,
    args: opts,
  };
}

export function registerMessageCommands(program: Command, ctx: ProgramContext) {
  const message = program
    .command("message")
    .description("Send, read, and manage messages and channel actions")
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  ['openclaw message send --target +15555550123 --message "Hi"', "Send a text message."],
  [
    'openclaw message send --target +15555550123 --message "Hi" --media photo.jpg',
    "Send a message with media.",
  ],
  [
    'openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi',
    "Create a Discord poll.",
  ],
  [
    'openclaw message react --channel discord --target 123 --message-id 456 --emoji "✅"',
    "React to a message.",
  ],
])}

${theme.muted("Docs:")} ${formatDocsLink("/cli/message", "docs.openclaw.ai/cli/message")}`,
    );

  const helpers = {
    withMessageBase: (command: Command, target?: "required") => {
      if (target === "required") {
        command.requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);
      }
      return command
        .option(
          "--channel <channel>",
          `Channel: ${ctx.messageChannelOptions}`,
          parseChannelSelector,
        )
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
            const ownership =
              opts.dryRun === true || action === "broadcast"
                ? "local"
                : resolveMessageActionOwnership(action, scopedChannel);
            const ensureConfigReadyFor = (validateConfigOnly: boolean) =>
              measureCliCommandStartup("config-ready", async () => {
                const { ensureConfigReady } = await import("./config-guard.js");
                await ensureConfigReady({
                  runtime: defaultRuntime,
                  commandPath: ["message", action],
                  suppressDoctorStdout: opts.json === true,
                  validateConfigOnly,
                  measure: (stage, run) => measureCliCommandStartup(stage, run),
                });
              });
            await ensureConfigReadyFor(ownership !== "local");
            let preloadPlugins = ownership === "local";
            let delegatedRegistry: PluginRegistry | undefined;
            if (typeof ownership === "object") {
              delegatedRegistry = await resolveGatewayDelegatedRegistry(ownership);
              if (!delegatedRegistry) {
                // Undeclared actions keep local preparation, including state migrations.
                preloadPlugins = true;
                await ensureConfigReadyFor(false);
              }
            }
            if (preloadPlugins) {
              const config = await captureRuntimeConfigAsyncReader()();
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
              const { loadPluginRegistryHandle } = await import("../../plugins/loader.js");
              pluginRegistry = loadPluginRegistryHandle({
                config: activatedConfig,
                activationSourceConfig: activatedConfig,
                onlyPluginIds: pluginIds,
                throwOnLoadError: true,
              });
            }
            const [{ messageCommand }, { createDefaultDeps }] = await Promise.all([
              import("../../commands/message.js"),
              import("../deps.js"),
            ]);
            const deps = createDefaultDeps();
            const { account, ...rest } = opts;
            result = await withPluginRuntimeRegistryScope(pluginRegistry ?? delegatedRegistry, () =>
              messageCommand(
                {
                  ...rest,
                  accountId: typeof account === "string" ? account : rest.accountId,
                  action,
                },
                deps,
                defaultRuntime,
              ),
            );
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
  helpers
    .withMessageBase(
      message
        .command("send")
        .description("Send a message")
        .option(
          "-m, --message <text>",
          "Message body (required unless --media or --presentation is set)",
        )
        .requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION)
        .option(
          "--media <path-or-url>",
          "Attach media (image/audio/video/document). Accepts local paths or URLs. Repeat to attach multiple files.",
          collectOption,
        )
        .option(
          "--presentation <json>",
          "Shared presentation payload as JSON (text, context, dividers, charts, tables, buttons, selects)",
        )
        .option("--delivery <json>", "Shared delivery preferences as JSON")
        .option("--pin", "Request that the delivered message be pinned when supported", false)
        .option("--reply-to <id>", "Reply-to message id")
        .option("--thread-id <id>", "Thread id (Telegram forum thread)")
        .option("--gif-playback", "Treat video media as GIF playback (WhatsApp only).", false)
        .option(
          "--force-document",
          "Preserve original image bytes on Slack, or send images, GIFs, and videos as documents on Telegram and WhatsApp, to avoid channel compression.",
          false,
        )
        .option(
          "--silent",
          "Send message silently without notification (Telegram + Discord)",
          false,
        ),
    )
    .action(({ media, ...opts }) =>
      helpers.runMessageAction("send", { ...opts, mediaUrls: media }),
    );
  helpers
    .withMessageBase(
      message.command("broadcast").description("Broadcast a message to multiple targets"),
    )
    .requiredOption("--targets <target...>", CHANNEL_TARGETS_DESCRIPTION)
    .option("--message <text>", "Message to send")
    .option("--media <url>", "Media URL")
    .action((options: Record<string, unknown>) => helpers.runMessageAction("broadcast", options));
  helpers
    .withMessageBase(message.command("poll").description("Send a poll"), "required")
    .requiredOption("--poll-question <text>", "Poll question")
    .option("--poll-option <choice>", "Poll option (repeat 2-12 times)", collectOption, [])
    .option("--poll-multi", "Allow multiple selections", false)
    .option("--poll-duration-hours <n>", "Poll duration in hours (Discord)")
    .option("--poll-duration-seconds <n>", "Poll duration in seconds (Telegram; 5-604800)")
    .option("--poll-anonymous", "Send an anonymous poll (Telegram)", false)
    .option("--poll-public", "Send a non-anonymous poll (Telegram)", false)
    .option("-m, --message <text>", "Optional message body")
    .option(
      "--silent",
      "Send poll silently without notification (Telegram + Discord where supported)",
      false,
    )
    .option("--thread-id <id>", "Thread id (Telegram forum topic / Slack thread ts)")
    .action((opts) => helpers.runMessageAction("poll", opts));
  helpers
    .withMessageBase(message.command("react").description("Add or remove a reaction"), "required")
    .requiredOption("--message-id <id>", "Message id")
    .option("--emoji <emoji>", "Emoji for reactions")
    .option("--remove", "Remove reaction", false)
    .option("--participant <id>", "WhatsApp reaction participant")
    .option("--from-me", "WhatsApp reaction fromMe", false)
    .option("--target-author <id>", "Signal reaction target author (uuid or phone)")
    .option("--target-author-uuid <uuid>", "Signal reaction target author uuid")
    .action((opts) => helpers.runMessageAction("react", opts));

  helpers
    .withMessageBase(
      message.command("reactions").description("List reactions on a message"),
      "required",
    )
    .requiredOption("--message-id <id>", "Message id")
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("reactions", opts));
  helpers
    .withMessageBase(message.command("read").description("Read recent messages"), "required")
    .option("--limit <n>", "Result limit")
    .option("--message-id <id>", "Read a specific message id")
    .option(
      "--before <id>",
      "Read/search before id (Matrix: nextBatch/prevBatch token from a previous read)",
    )
    .option(
      "--after <id>",
      "Read/search after id (Matrix: nextBatch/prevBatch token from a previous read)",
    )
    .option("--around <id>", "Read around id")
    .option("--thread-id <id>", "Thread id (Slack thread timestamp)")
    .addOption(new Option("--include-thread").hideHelp())
    .action((opts) => helpers.runMessageAction("read", opts));

  register(message, "edit", "Edit a message", "edit", ["messageId", "message", "target"]).option(
    "--thread-id <id>",
    "Thread id (Telegram forum thread)",
  );

  register(message, "delete", "Delete a message", "delete", ["messageId", "target"]);
  helpers
    .withMessageBase(message.command("pin").description("Pin a message"), "required")
    .requiredOption("--message-id <id>", "Message id")
    .action((opts) => helpers.runMessageAction("pin", opts));

  helpers
    .withMessageBase(message.command("unpin").description("Unpin a message"), "required")
    .requiredOption("--message-id <id>", "Message id (or pinned message resource id for MSTeams)")
    .option(
      "--pinned-message-id <id>",
      "Pinned message resource id (MSTeams: from pin or list-pins, not the chat message id)",
    )
    .action((opts) => helpers.runMessageAction("unpin", opts));

  helpers
    .withMessageBase(message.command("pins").description("List pinned messages"), "required")
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("list-pins", opts));
  helpers
    .withMessageBase(
      message.command("permissions").description("Fetch channel permissions"),
      "required",
    )
    .action((opts) => helpers.runMessageAction("permissions", opts));
  helpers
    .withMessageBase(message.command("search").description("Search messages"))
    .requiredOption("--query <text>", "Search query")
    .option("--guild-id <id>", "Guild id (Discord)")
    .option(
      "--channel-id <id>",
      "Channel id (Discord) or Graph team-id/channel-id (Microsoft Teams)",
    )
    .option("--channel-ids <id>", "Channel id (repeat)", collectOption, [])
    .option("--author-id <id>", "Author id")
    .option("--author-ids <id>", "Author id (repeat)", collectOption, [])
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("search", opts));
  const thread = message.command("thread").description("Thread actions");

  helpers
    .withMessageBase(
      thread
        .command("create")
        .description("Create a thread")
        .requiredOption("--thread-name <name>", "Thread name"),
      "required",
    )
    .option("--message-id <id>", "Message id (optional)")
    .option("-m, --message <text>", "Initial thread message text")
    .option("--auto-archive-min <n>", "Thread auto-archive minutes")
    .action(async (opts) => {
      const request = resolveThreadCreateRequest(opts);
      await helpers.runMessageAction(request.action, request.args);
    });

  register(thread, "list", "List threads", "thread-list", ["guild"])
    .option("--channel-id <id>", "Channel id")
    .option("--include-archived", "Include archived threads", false)
    .option("--before <id>", "Read/search before id")
    .option("--limit <n>", "Result limit");

  register(thread, "reply", "Reply in a thread", "thread-reply", ["message", "target"])
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option("--reply-to <id>", "Reply-to message id");
  const emoji = message.command("emoji").description("Emoji actions");

  helpers
    .withMessageBase(emoji.command("list").description("List emojis"))
    .option("--guild-id <id>", "Guild id (Discord)")
    .action((opts) => helpers.runMessageAction("emoji-list", opts));

  register(emoji, "upload", "Upload an emoji", "emoji-upload", ["guild"])
    .requiredOption("--emoji-name <name>", "Emoji name")
    .requiredOption("--media <path-or-url>", "Emoji media (path or URL)")
    .option("--role-ids <id>", "Role id (repeat)", collectOption, []);
  const sticker = message.command("sticker").description("Sticker actions");

  helpers
    .withMessageBase(sticker.command("send").description("Send stickers"), "required")
    .requiredOption("--sticker-id <id>", "Sticker id (repeat)", collectOption)
    .option("-m, --message <text>", "Optional message body")
    .action((opts) => helpers.runMessageAction("sticker", opts));

  register(sticker, "upload", "Upload a sticker", "sticker-upload", ["guild"])
    .requiredOption("--sticker-name <name>", "Sticker name")
    .requiredOption("--sticker-desc <text>", "Sticker description")
    .requiredOption("--sticker-tags <tags>", "Sticker tags")
    .requiredOption("--media <path-or-url>", "Sticker media (path or URL)");
  function register(
    parent: Command,
    name: string,
    description: string,
    action: string,
    required: readonly (keyof typeof requiredOptions)[],
  ) {
    const command = parent.command(name).description(description);
    // Required identifiers precede shared flags; leaf-specific options follow them.
    for (const key of required) {
      const [flags, optionDescription] = requiredOptions[key];
      command.requiredOption(flags, optionDescription);
    }
    return helpers
      .withMessageBase(command)
      .action((opts) => helpers.runMessageAction(action, opts));
  }

  const role = message.command("role").description("Role actions");
  register(role, "info", "List roles", "role-info", ["guild"]);
  register(role, "add", "Add role to a member", "role-add", ["guild", "user", "role"]);
  register(role, "remove", "Remove role from a member", "role-remove", ["guild", "user", "role"]);

  const channel = message.command("channel").description("Channel actions");
  helpers
    .withMessageBase(channel.command("info").description("Fetch channel info"), "required")
    .action((opts) => helpers.runMessageAction("channel-info", opts));
  register(channel, "list", "List channels", "channel-list", ["guild"]);

  const member = message.command("member").description("Member actions");
  register(member, "info", "Fetch member info", "member-info", ["user"])
    .option("--guild-id <id>", "Guild id (Discord)")
    .option("--channel-id <id>", "Room id (Matrix) or Graph team-id/channel-id (Microsoft Teams)");

  const voice = message.command("voice").description("Voice actions");
  register(voice, "status", "Fetch voice status", "voice-status", ["guild", "user"]);

  const event = message.command("event").description("Event actions");
  register(event, "list", "List scheduled events", "event-list", ["guild"]);
  register(event, "create", "Create a scheduled event", "event-create", [
    "guild",
    "eventName",
    "startTime",
  ])
    .option("--end-time <iso>", "Event end time")
    .option("--desc <text>", "Event description")
    .option("--channel-id <id>", "Channel id")
    .option("--location <text>", "Event location")
    .option("--event-type <stage|external|voice>", "Event type")
    .option("--image <url>", "Cover image URL or local file path");

  register(message, "timeout", "Timeout a member", "timeout", ["guild", "user"])
    .option("--duration-min <n>", "Timeout duration minutes")
    .option("--until <iso>", "Timeout until")
    .option("--reason <text>", "Moderation reason");

  register(message, "kick", "Kick a member", "kick", ["guild", "user"]).option(
    "--reason <text>",
    "Moderation reason",
  );

  register(message, "ban", "Ban a member", "ban", ["guild", "user"])
    .option("--reason <text>", "Moderation reason")
    .option("--delete-days <n>", "Ban delete message days");

  for (const command of message.commands) {
    if (command.commands.length > 0) {
      applyParentDefaultHelpAction(command);
    }
  }
  applyParentDefaultHelpAction(message);
}
