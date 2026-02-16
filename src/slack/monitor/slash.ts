import type { SlackActionMiddlewareArgs, SlackCommandMiddlewareArgs } from "@slack/bolt";
import type { ChatCommandDefinition, CommandArgs } from "../../auto-reply/commands-registry.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
import { formatAllowlistMatchMeta } from "../../channels/allowlist-match.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { resolveNativeCommandsEnabled, resolveNativeSkillsEnabled } from "../../config/commands.js";
import { danger, logVerbose } from "../../globals.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { chunkItems } from "../../utils/chunk-items.js";
import {
  normalizeAllowList,
  normalizeAllowListLower,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowed,
} from "./allow-list.js";
import { resolveSlackChannelConfig, type SlackChannelConfigResolved } from "./channel-config.js";
import { buildSlackSlashCommandMatcher, resolveSlackSlashCommandConfig } from "./commands.js";
import { normalizeSlackChannelType } from "./context.js";
import { isSlackChannelAllowedByPolicy } from "./policy.js";
import { resolveSlackRoomContextHints } from "./room-context.js";

type SlackBlock = { type: string; [key: string]: unknown };

const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 75;

type CommandsRegistry = typeof import("../../auto-reply/commands-registry.js");
let commandsRegistry: CommandsRegistry | undefined;
async function getCommandsRegistry(): Promise<CommandsRegistry> {
  if (!commandsRegistry) {
    commandsRegistry = await import("../../auto-reply/commands-registry.js");
  }
  return commandsRegistry;
}

function encodeSlackCommandArgValue(parts: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}) {
  return [
    SLACK_COMMAND_ARG_VALUE_PREFIX,
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function parseSlackCommandArgValue(raw?: string | null): {
  command: string;
  arg: string;
  value: string;
  userId: string;
} | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) {
    return null;
  }
  const [, command, arg, value, userId] = parts;
  if (!command || !arg || !value || !userId) {
    return null;
  }
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return null;
    }
  };
  const decodedCommand = decode(command);
  const decodedArg = decode(arg);
  const decodedValue = decode(value);
  const decodedUserId = decode(userId);
  if (!decodedCommand || !decodedArg || !decodedValue || !decodedUserId) {
    return null;
  }
  return {
    command: decodedCommand,
    arg: decodedArg,
    value: decodedValue,
    userId: decodedUserId,
  };
}

function buildSlackCommandArgMenuBlocks(params: {
  title: string;
  command: string;
  arg: string;
  choices: Array<{ value: string; label: string }>;
  userId: string;
}) {
  const encodedChoices = params.choices.map((choice) => ({
    label: choice.label,
    value: encodeSlackCommandArgValue({
      command: params.command,
      arg: params.arg,
      value: choice.value,
      userId: params.userId,
    }),
  }));
  const canUseStaticSelect = encodedChoices.every(
    (choice) => choice.value.length <= SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX,
  );
  const rows =
    encodedChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE || !canUseStaticSelect
      ? chunkItems(encodedChoices, SLACK_COMMAND_ARG_BUTTON_ROW_SIZE).map((choices) => ({
          type: "actions",
          elements: choices.map((choice) => ({
            type: "button",
            action_id: SLACK_COMMAND_ARG_ACTION_ID,
            text: { type: "plain_text", text: choice.label },
            value: choice.value,
          })),
        }))
      : chunkItems(encodedChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map((choices, index) => ({
          type: "actions",
          elements: [
            {
              type: "static_select",
              action_id: SLACK_COMMAND_ARG_ACTION_ID,
              placeholder: {
                type: "plain_text",
                text: index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`,
              },
              options: choices.map((choice) => ({
                text: { type: "plain_text", text: choice.label.slice(0, 75) },
                value: choice.value,
              })),
            },
          ],
        }));
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: params.title },
    },
    ...rows,
  ];
}

export async function registerSlackMonitorSlashCommands(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
}): Promise<void> {
  const { ctx, account } = params;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  const supportsInteractiveArgMenus =
    typeof (ctx.app as { action?: unknown }).action === "function";

  const slashCommand = resolveSlackSlashCommandConfig(
    ctx.slashCommand ?? account.config.slashCommand,
  );

  const handleSlashCommand = async (p: {
    command: SlackCommandMiddlewareArgs["command"];
    ack: SlackCommandMiddlewareArgs["ack"];
    respond: SlackCommandMiddlewareArgs["respond"];
    prompt: string;
    commandArgs?: CommandArgs;
    commandDefinition?: ChatCommandDefinition;
  }) => {
    const { command, ack, respond, prompt, commandArgs, commandDefinition } = p;
    try {
      if (!prompt.trim()) {
        await ack({
          text: "Message required.",
          response_type: "ephemeral",
        });
        return;
      }
      await ack();

      if (ctx.botUserId && command.user_id === ctx.botUserId) {
        return;
      }

      const channelInfo = await ctx.resolveChannelName(command.channel_id);
      const rawChannelType =
        channelInfo?.type ?? (command.channel_name === "directmessage" ? "im" : undefined);
      const channelType = normalizeSlackChannelType(rawChannelType, command.channel_id);
      const isDirectMessage = channelType === "im";
      const isGroupDm = channelType === "mpim";
      const isRoom = channelType === "channel" || channelType === "group";
      const isRoomish = isRoom || isGroupDm;

      if (
        !ctx.isChannelAllowed({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channelType,
        })
      ) {
        await respond({
          text: "This channel is not allowed.",
          response_type: "ephemeral",
        });
        return;
      }

      const storeAllowFrom = await readChannelAllowFromStore("slack").catch(() => []);
      const effectiveAllowFrom = normalizeAllowList([...ctx.allowFrom, ...storeAllowFrom]);
      const effectiveAllowFromLower = normalizeAllowListLower(effectiveAllowFrom);

      // Privileged command surface: compute CommandAuthorized, don't assume true.
      // Keep this aligned with the Slack message path (message-handler/prepare.ts).
      let commandAuthorized = false;
      let channelConfig: SlackChannelConfigResolved | null = null;
      if (isDirectMessage) {
        if (!ctx.dmEnabled || ctx.dmPolicy === "disabled") {
          await respond({
            text: "Slack DMs are disabled.",
            response_type: "ephemeral",
          });
          return;
        }
        if (ctx.dmPolicy !== "open") {
          const sender = await ctx.resolveUserName(command.user_id);
          const senderName = sender?.name ?? undefined;
          const allowMatch = resolveSlackAllowListMatch({
            allowList: effectiveAllowFromLower,
            id: command.user_id,
            name: senderName,
          });
          const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
          if (!allowMatch.allowed) {
            if (ctx.dmPolicy === "pairing") {
              const { code, created } = await upsertChannelPairingRequest({
                channel: "slack",
                id: command.user_id,
                meta: { name: senderName },
              });
              if (created) {
                logVerbose(
                  `slack pairing request sender=${command.user_id} name=${
                    senderName ?? "unknown"
                  } (${allowMatchMeta})`,
                );
                await respond({
                  text: buildPairingReply({
                    channel: "slack",
                    idLine: `Your Slack user id: ${command.user_id}`,
                    code,
                  }),
                  response_type: "ephemeral",
                });
              }
            } else {
              logVerbose(
                `slack: blocked slash sender ${command.user_id} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
              );
              await respond({
                text: "You are not authorized to use this command.",
                response_type: "ephemeral",
              });
            }
            return;
          }
        }
      }

      if (isRoom) {
        channelConfig = resolveSlackChannelConfig({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channels: ctx.channelsConfig,
          defaultRequireMention: ctx.defaultRequireMention,
        });
        if (ctx.useAccessGroups) {
          const channelAllowlistConfigured =
            Boolean(ctx.channelsConfig) && Object.keys(ctx.channelsConfig ?? {}).length > 0;
          const channelAllowed = channelConfig?.allowed !== false;
          if (
            !isSlackChannelAllowedByPolicy({
              groupPolicy: ctx.groupPolicy,
              channelAllowlistConfigured,
              channelAllowed,
            })
          ) {
            await respond({
              text: "This channel is not allowed.",
              response_type: "ephemeral",
            });
            return;
          }
          // When groupPolicy is "open", only block channels that are EXPLICITLY denied
          // (i.e., have a matching config entry with allow:false). Channels not in the
          // config (matchSource undefined) should be allowed under open policy.
          const hasExplicitConfig = Boolean(channelConfig?.matchSource);
          if (!channelAllowed && (ctx.groupPolicy !== "open" || hasExplicitConfig)) {
            await respond({
              text: "This channel is not allowed.",
              response_type: "ephemeral",
            });
            return;
          }
        }
      }

      const sender = await ctx.resolveUserName(command.user_id);
      const senderName = sender?.name ?? command.user_name ?? command.user_id;
      const channelUsersAllowlistConfigured =
        isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
      const channelUserAllowed = channelUsersAllowlistConfigured
        ? resolveSlackUserAllowed({
            allowList: channelConfig?.users,
            userId: command.user_id,
            userName: senderName,
          })
        : false;
      if (channelUsersAllowlistConfigured && !channelUserAllowed) {
        await respond({
          text: "You are not authorized to use this command here.",
          response_type: "ephemeral",
        });
        return;
      }

      const ownerAllowed = resolveSlackAllowListMatch({
        allowList: effectiveAllowFromLower,
        id: command.user_id,
        name: senderName,
      }).allowed;
      // DMs: allow chatting in dmPolicy=open, but keep privileged command gating intact by setting
      // CommandAuthorized based on allowlists/access-groups (downstream decides which commands need it).
      commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: ctx.useAccessGroups,
        authorizers: [{ configured: effectiveAllowFromLower.length > 0, allowed: ownerAllowed }],
        modeWhenAccessGroupsOff: "configured",
      });
      if (isRoomish) {
        commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups: ctx.useAccessGroups,
          authorizers: [
            { configured: effectiveAllowFromLower.length > 0, allowed: ownerAllowed },
            { configured: channelUsersAllowlistConfigured, allowed: channelUserAllowed },
          ],
          modeWhenAccessGroupsOff: "configured",
        });
        if (ctx.useAccessGroups && !commandAuthorized) {
          await respond({
            text: "You are not authorized to use this command.",
            response_type: "ephemeral",
          });
          return;
        }
      }

      if (commandDefinition && supportsInteractiveArgMenus) {
        const reg = await getCommandsRegistry();
        const menu = reg.resolveCommandArgMenu({
          command: commandDefinition,
          args: commandArgs,
          cfg,
        });
        if (menu) {
          const commandLabel = commandDefinition.nativeName ?? commandDefinition.key;
          const title =
            menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
          const blocks = buildSlackCommandArgMenuBlocks({
            title,
            command: commandLabel,
            arg: menu.arg.name,
            choices: menu.choices,
            userId: command.user_id,
          });
          await respond({
            text: title,
            blocks,
            response_type: "ephemeral",
          });
          return;
        }
      }

      const channelName = channelInfo?.name;
      const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
      const [{ resolveAgentRoute }, { finalizeInboundContext }, { dispatchReplyWithDispatcher }] =
        await Promise.all([
          import("../../routing/resolve-route.js"),
          import("../../auto-reply/reply/inbound-context.js"),
          import("../../auto-reply/reply/provider-dispatcher.js"),
        ]);
      const [{ resolveConversationLabel }, { createReplyPrefixOptions }] = await Promise.all([
        import("../../channels/conversation-label.js"),
        import("../../channels/reply-prefix.js"),
      ]);

      const route = resolveAgentRoute({
        cfg,
        channel: "slack",
        accountId: account.accountId,
        teamId: ctx.teamId || undefined,
        peer: {
          kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
          id: isDirectMessage ? command.user_id : command.channel_id,
        },
      });

      const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
        isRoomish,
        channelInfo,
        channelConfig,
      });

      const ctxPayload = finalizeInboundContext({
        Body: prompt,
        BodyForAgent: prompt,
        RawBody: prompt,
        CommandBody: prompt,
        CommandArgs: commandArgs,
        From: isDirectMessage
          ? `slack:${command.user_id}`
          : isRoom
            ? `slack:channel:${command.channel_id}`
            : `slack:group:${command.channel_id}`,
        To: `slash:${command.user_id}`,
        ChatType: isDirectMessage ? "direct" : "channel",
        ConversationLabel:
          resolveConversationLabel({
            ChatType: isDirectMessage ? "direct" : "channel",
            SenderName: senderName,
            GroupSubject: isRoomish ? roomLabel : undefined,
            From: isDirectMessage
              ? `slack:${command.user_id}`
              : isRoom
                ? `slack:channel:${command.channel_id}`
                : `slack:group:${command.channel_id}`,
          }) ?? (isDirectMessage ? senderName : roomLabel),
        GroupSubject: isRoomish ? roomLabel : undefined,
        GroupSystemPrompt: isRoomish ? groupSystemPrompt : undefined,
        UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
        SenderName: senderName,
        SenderId: command.user_id,
        Provider: "slack" as const,
        Surface: "slack" as const,
        WasMentioned: true,
        MessageSid: command.trigger_id,
        Timestamp: Date.now(),
        SessionKey:
          `agent:${route.agentId}:${slashCommand.sessionPrefix}:${command.user_id}`.toLowerCase(),
        CommandTargetSessionKey: route.sessionKey,
        AccountId: route.accountId,
        CommandSource: "native" as const,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "slack" as const,
        OriginatingTo: `user:${command.user_id}`,
      });

      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: route.agentId,
        channel: "slack",
        accountId: route.accountId,
      });

      const deliverSlashPayloads = async (replies: ReplyPayload[]) => {
        const [{ deliverSlackSlashReplies }, { resolveChunkMode }, { resolveMarkdownTableMode }] =
          await Promise.all([
            import("./replies.js"),
            import("../../auto-reply/chunk.js"),
            import("../../config/markdown-tables.js"),
          ]);
        await deliverSlackSlashReplies({
          replies,
          respond,
          ephemeral: slashCommand.ephemeral,
          textLimit: ctx.textLimit,
          chunkMode: resolveChunkMode(cfg, "slack", route.accountId),
          tableMode: resolveMarkdownTableMode({
            cfg,
            channel: "slack",
            accountId: route.accountId,
          }),
        });
      };

      const { counts } = await dispatchReplyWithDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (payload) => deliverSlashPayloads([payload]),
          onError: (err, info) => {
            runtime.error?.(danger(`slack slash ${info.kind} reply failed: ${String(err)}`));
          },
        },
        replyOptions: {
          skillFilter: channelConfig?.skills,
          onModelSelected,
        },
      });
      if (counts.final + counts.tool + counts.block === 0) {
        await deliverSlashPayloads([]);
      }
    } catch (err) {
      runtime.error?.(danger(`slack slash handler failed: ${String(err)}`));
      await respond({
        text: "Sorry, something went wrong handling that command.",
        response_type: "ephemeral",
      });
    }
  };

  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });

  let reg: CommandsRegistry | undefined;
  let nativeCommands: Array<{ name: string }> = [];
  if (nativeEnabled) {
    reg = await getCommandsRegistry();
    const skillCommands = nativeSkillsEnabled
      ? (await import("../../auto-reply/skill-commands.js")).listSkillCommandsForAgents({ cfg })
      : [];
    nativeCommands = reg.listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "slack" });
  }

  if (nativeCommands.length > 0) {
    const registry = reg;
    if (!registry) {
      throw new Error("Missing commands registry for native Slack commands.");
    }
    for (const command of nativeCommands) {
      ctx.app.command(
        `/${command.name}`,
        async ({ command: cmd, ack, respond }: SlackCommandMiddlewareArgs) => {
          const commandDefinition = registry.findCommandByNativeName(command.name, "slack");
          const rawText = cmd.text?.trim() ?? "";
          const commandArgs = commandDefinition
            ? registry.parseCommandArgs(commandDefinition, rawText)
            : rawText
              ? ({ raw: rawText } satisfies CommandArgs)
              : undefined;
          const prompt = commandDefinition
            ? registry.buildCommandTextFromArgs(commandDefinition, commandArgs)
            : rawText
              ? `/${command.name} ${rawText}`
              : `/${command.name}`;
          await handleSlashCommand({
            command: cmd,
            ack,
            respond,
            prompt,
            commandArgs,
            commandDefinition: commandDefinition ?? undefined,
          });
        },
      );
    }
  } else if (slashCommand.enabled) {
    ctx.app.command(
      buildSlackSlashCommandMatcher(slashCommand.name),
      async ({ command, ack, respond }: SlackCommandMiddlewareArgs) => {
        await handleSlashCommand({
          command,
          ack,
          respond,
          prompt: command.text?.trim() ?? "",
        });
      },
    );
  } else {
    logVerbose("slack: slash commands disabled");
  }

  if (nativeCommands.length === 0 || !supportsInteractiveArgMenus) {
    return;
  }

  const registerArgAction = (actionId: string) => {
    (
      ctx.app as unknown as {
        action: NonNullable<(typeof ctx.app & { action?: unknown })["action"]>;
      }
    ).action(actionId, async (args: SlackActionMiddlewareArgs) => {
      const { ack, body, respond } = args;
      const action = args.action as { value?: string; selected_option?: { value?: string } };
      await ack();
      const respondFn =
        respond ??
        (async (payload: { text: string; blocks?: SlackBlock[]; response_type?: string }) => {
          if (!body.channel?.id || !body.user?.id) {
            return;
          }
          await ctx.app.client.chat.postEphemeral({
            token: ctx.botToken,
            channel: body.channel.id,
            user: body.user.id,
            text: payload.text,
            blocks: payload.blocks,
          });
        });
      const actionValue = action?.value ?? action?.selected_option?.value;
      const parsed = parseSlackCommandArgValue(actionValue);
      if (!parsed) {
        await respondFn({
          text: "Sorry, that button is no longer valid.",
          response_type: "ephemeral",
        });
        return;
      }
      if (body.user?.id && parsed.userId !== body.user.id) {
        await respondFn({
          text: "That menu is for another user.",
          response_type: "ephemeral",
        });
        return;
      }
      const reg = await getCommandsRegistry();
      const commandDefinition = reg.findCommandByNativeName(parsed.command, "slack");
      const commandArgs: CommandArgs = {
        values: { [parsed.arg]: parsed.value },
      };
      const prompt = commandDefinition
        ? reg.buildCommandTextFromArgs(commandDefinition, commandArgs)
        : `/${parsed.command} ${parsed.value}`;
      const user = body.user;
      const userName =
        user && "name" in user && user.name
          ? user.name
          : user && "username" in user && user.username
            ? user.username
            : (user?.id ?? "");
      const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
      const commandPayload = {
        user_id: user?.id ?? "",
        user_name: userName,
        channel_id: body.channel?.id ?? "",
        channel_name: body.channel?.name ?? body.channel?.id ?? "",
        trigger_id: triggerId ?? String(Date.now()),
      } as SlackCommandMiddlewareArgs["command"];
      await handleSlashCommand({
        command: commandPayload,
        ack: async () => {},
        respond: respondFn,
        prompt,
        commandArgs,
        commandDefinition: commandDefinition ?? undefined,
      });
    });
  };
  registerArgAction(SLACK_COMMAND_ARG_ACTION_ID);
}
