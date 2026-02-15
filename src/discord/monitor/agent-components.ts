import type { APIStringSelectComponent } from "discord-api-types/v10";
import {
  Button,
  type ButtonInteraction,
  type ComponentData,
  StringSelectMenu,
  type StringSelectMenuInteraction,
} from "@buape/carbon";
import { ButtonStyle, ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { logDebug, logError } from "../../logger.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  type DiscordGuildEntryResolved,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAllowed,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";

const AGENT_BUTTON_KEY = "agent";
const AGENT_SELECT_KEY = "agentsel";

type DiscordUser = Parameters<typeof formatDiscordUserTag>[0];

type AgentComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

type ComponentInteractionContext = NonNullable<
  Awaited<ReturnType<typeof resolveComponentInteractionContext>>
>;

type DiscordChannelContext = {
  channelName: string | undefined;
  channelSlug: string;
  channelType: number | undefined;
  isThread: boolean;
  parentId: string | undefined;
  parentName: string | undefined;
  parentSlug: string;
};

function resolveAgentComponentRoute(params: {
  ctx: AgentComponentContext;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  isDirectMessage: boolean;
  userId: string;
  channelId: string;
  parentId: string | undefined;
}) {
  return resolveAgentRoute({
    cfg: params.ctx.cfg,
    channel: "discord",
    accountId: params.ctx.accountId,
    guildId: params.rawGuildId,
    memberRoleIds: params.memberRoleIds,
    peer: {
      kind: params.isDirectMessage ? "direct" : "channel",
      id: params.isDirectMessage ? params.userId : params.channelId,
    },
    parentPeer: params.parentId ? { kind: "channel", id: params.parentId } : undefined,
  });
}

async function ackComponentInteraction(params: {
  interaction: AgentComponentInteraction;
  replyOpts: { ephemeral?: boolean };
  label: string;
}) {
  try {
    await params.interaction.reply({
      content: "✓",
      ...params.replyOpts,
    });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }
}

function resolveDiscordChannelContext(
  interaction: AgentComponentInteraction,
): DiscordChannelContext {
  const channel = interaction.channel;
  const channelName = channel && "name" in channel ? (channel.name as string) : undefined;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const channelType = channel && "type" in channel ? (channel.type as number) : undefined;
  const isThread = isThreadChannelType(channelType);

  let parentId: string | undefined;
  let parentName: string | undefined;
  let parentSlug = "";
  if (isThread && channel && "parentId" in channel) {
    parentId = (channel.parentId as string) ?? undefined;
    if ("parent" in channel) {
      const parent = (channel as { parent?: { name?: string } }).parent;
      if (parent?.name) {
        parentName = parent.name;
        parentSlug = normalizeDiscordSlug(parentName);
      }
    }
  }

  return { channelName, channelSlug, channelType, isThread, parentId, parentName, parentSlug };
}

async function resolveComponentInteractionContext(params: {
  interaction: AgentComponentInteraction;
  label: string;
}): Promise<{
  channelId: string;
  user: DiscordUser;
  username: string;
  userId: string;
  replyOpts: { ephemeral?: boolean };
  rawGuildId: string | undefined;
  isDirectMessage: boolean;
  memberRoleIds: string[];
} | null> {
  const { interaction, label } = params;

  // Use interaction's actual channel_id (trusted source from Discord)
  // This prevents channel spoofing attacks
  const channelId = interaction.rawData.channel_id;
  if (!channelId) {
    logError(`${label}: missing channel_id in interaction`);
    return null;
  }

  const user = interaction.user;
  if (!user) {
    logError(`${label}: missing user in interaction`);
    return null;
  }

  let didDefer = false;
  // Defer immediately to satisfy Discord's 3-second interaction ACK requirement.
  // We use an ephemeral deferred reply so subsequent interaction.reply() calls
  // can safely edit the original deferred response.
  try {
    await interaction.defer({ ephemeral: true });
    didDefer = true;
  } catch (err) {
    logError(`${label}: failed to defer interaction: ${String(err)}`);
  }
  const replyOpts = didDefer ? {} : { ephemeral: true };

  const username = formatUsername(user);
  const userId = user.id;

  // P1 FIX: Use rawData.guild_id as source of truth - interaction.guild can be null
  // when guild is not cached even though guild_id is present in rawData
  const rawGuildId = interaction.rawData.guild_id;
  const isDirectMessage = !rawGuildId;
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => String(roleId))
    : [];

  return {
    channelId,
    user,
    username,
    userId,
    replyOpts,
    rawGuildId,
    isDirectMessage,
    memberRoleIds,
  };
}

async function ensureGuildComponentMemberAllowed(params: {
  interaction: AgentComponentInteraction;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  channelId: string;
  rawGuildId: string | undefined;
  channelCtx: DiscordChannelContext;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
}): Promise<boolean> {
  const {
    interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel,
    unauthorizedReply,
  } = params;

  if (!rawGuildId) {
    return true;
  }

  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });

  const channelUsers = channelConfig?.users ?? guildInfo?.users;
  const channelRoles = channelConfig?.roles ?? guildInfo?.roles;
  const memberAllowed = resolveDiscordMemberAllowed({
    userAllowList: channelUsers,
    roleAllowList: channelRoles,
    memberRoleIds,
    userId: user.id,
    userName: user.username,
    userTag: user.discriminator ? `${user.username}#${user.discriminator}` : undefined,
  });
  if (memberAllowed) {
    return true;
  }

  logVerbose(`agent ${componentLabel}: blocked user ${user.id} (not in users/roles allowlist)`);
  try {
    await interaction.reply({
      content: unauthorizedReply,
      ...replyOpts,
    });
  } catch {
    // Interaction may have expired
  }
  return false;
}

async function ensureAgentComponentInteractionAllowed(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
}): Promise<{ parentId: string | undefined } | null> {
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId: params.channelId,
    rawGuildId: params.rawGuildId,
    channelCtx,
    memberRoleIds: params.memberRoleIds,
    user: params.user,
    replyOpts: params.replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply: params.unauthorizedReply,
  });
  if (!memberAllowed) {
    return null;
  }
  return { parentId: channelCtx.parentId };
}

export type AgentComponentContext = {
  cfg: OpenClawConfig;
  accountId: string;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  /** DM allowlist (from allowFrom config; legacy: dm.allowFrom) */
  allowFrom?: Array<string | number>;
  /** DM policy (default: "pairing") */
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
};

/**
 * Build agent button custom ID: agent:componentId=<id>
 * The channelId is NOT embedded in customId - we use interaction.rawData.channel_id instead
 * to prevent channel spoofing attacks.
 *
 * Carbon's customIdParser parses "key:arg1=value1;arg2=value2" into { arg1: value1, arg2: value2 }
 */
export function buildAgentButtonCustomId(componentId: string): string {
  return `${AGENT_BUTTON_KEY}:componentId=${encodeURIComponent(componentId)}`;
}

/**
 * Build agent select menu custom ID: agentsel:componentId=<id>
 */
export function buildAgentSelectCustomId(componentId: string): string {
  return `${AGENT_SELECT_KEY}:componentId=${encodeURIComponent(componentId)}`;
}

/**
 * Parse agent component data from Carbon's parsed ComponentData
 * Carbon parses "key:componentId=xxx" into { componentId: "xxx" }
 */
function parseAgentComponentData(data: ComponentData): {
  componentId: string;
} | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const componentId =
    typeof data.componentId === "string"
      ? decodeURIComponent(data.componentId)
      : typeof data.componentId === "number"
        ? String(data.componentId)
        : null;
  if (!componentId) {
    return null;
  }
  return { componentId };
}

function formatUsername(user: { username: string; discriminator?: string | null }): string {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

/**
 * Check if a channel type is a thread type
 */
function isThreadChannelType(channelType: number | undefined): boolean {
  return (
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread
  );
}

async function ensureDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  componentLabel: string;
  replyOpts: { ephemeral?: boolean };
}): Promise<boolean> {
  const { ctx, interaction, user, componentLabel, replyOpts } = params;
  const dmPolicy = ctx.dmPolicy ?? "pairing";
  if (dmPolicy === "disabled") {
    logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
    try {
      await interaction.reply({
        content: "DM interactions are disabled.",
        ...replyOpts,
      });
    } catch {
      // Interaction may have expired
    }
    return false;
  }
  if (dmPolicy === "open") {
    return true;
  }

  const storeAllowFrom = await readChannelAllowFromStore("discord").catch(() => []);
  const effectiveAllowFrom = [...(ctx.allowFrom ?? []), ...storeAllowFrom];
  const allowList = normalizeDiscordAllowList(effectiveAllowFrom, ["discord:", "user:", "pk:"]);
  const allowMatch = allowList
    ? resolveDiscordAllowListMatch({
        allowList,
        candidate: {
          id: user.id,
          name: user.username,
          tag: formatDiscordUserTag(user),
        },
      })
    : { allowed: false };
  if (allowMatch.allowed) {
    return true;
  }

  if (dmPolicy === "pairing") {
    const { code, created } = await upsertChannelPairingRequest({
      channel: "discord",
      id: user.id,
      meta: {
        tag: formatDiscordUserTag(user),
        name: user.username,
      },
    });
    try {
      await interaction.reply({
        content: created
          ? buildPairingReply({
              channel: "discord",
              idLine: `Your Discord user id: ${user.id}`,
              code,
            })
          : "Pairing already requested. Ask the bot owner to approve your code.",
        ...replyOpts,
      });
    } catch {
      // Interaction may have expired
    }
    return false;
  }

  logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
  try {
    await interaction.reply({
      content: `You are not authorized to use this ${componentLabel}.`,
      ...replyOpts,
    });
  } catch {
    // Interaction may have expired
  }
  return false;
}

async function resolveInteractionContextWithDmAuth(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  label: string;
  componentLabel: string;
}): Promise<ComponentInteractionContext | null> {
  const interactionCtx = await resolveComponentInteractionContext({
    interaction: params.interaction,
    label: params.label,
  });
  if (!interactionCtx) {
    return null;
  }
  if (interactionCtx.isDirectMessage) {
    const authorized = await ensureDmComponentAuthorized({
      ctx: params.ctx,
      interaction: params.interaction,
      user: interactionCtx.user,
      componentLabel: params.componentLabel,
      replyOpts: interactionCtx.replyOpts,
    });
    if (!authorized) {
      return null;
    }
  }
  return interactionCtx;
}

export class AgentComponentButton extends Button {
  label = AGENT_BUTTON_KEY;
  customId = `${AGENT_BUTTON_KEY}:seed=1`;
  style = ButtonStyle.Primary;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    // Parse componentId from Carbon's parsed ComponentData
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent button: failed to parse component data");
      try {
        await interaction.reply({
          content: "This button is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "agent button",
      componentLabel: "button",
    });
    if (!interactionCtx) {
      return;
    }
    const {
      channelId,
      user,
      username,
      userId,
      replyOpts,
      rawGuildId,
      isDirectMessage,
      memberRoleIds,
    } = interactionCtx;

    // Check user allowlist before processing component interaction
    // This prevents unauthorized users from injecting system events.
    const allowed = await ensureAgentComponentInteractionAllowed({
      ctx: this.ctx,
      interaction,
      channelId,
      rawGuildId,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "button",
      unauthorizedReply: "You are not authorized to use this button.",
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    const route = resolveAgentComponentRoute({
      ctx: this.ctx,
      rawGuildId,
      memberRoleIds,
      isDirectMessage,
      userId,
      channelId,
      parentId,
    });

    const eventText = `[Discord component: ${componentId} clicked by ${username} (${userId})]`;

    logDebug(`agent button: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      sessionKey: route.sessionKey,
      contextKey: `discord:agent-button:${channelId}:${componentId}:${userId}`,
    });

    await ackComponentInteraction({ interaction, replyOpts, label: "agent button" });
  }
}

export class AgentSelectMenu extends StringSelectMenu {
  customId = `${AGENT_SELECT_KEY}:seed=1`;
  options: APIStringSelectComponent["options"] = [];
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    // Parse componentId from Carbon's parsed ComponentData
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent select: failed to parse component data");
      try {
        await interaction.reply({
          content: "This select menu is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "agent select",
      componentLabel: "select menu",
    });
    if (!interactionCtx) {
      return;
    }
    const {
      channelId,
      user,
      username,
      userId,
      replyOpts,
      rawGuildId,
      isDirectMessage,
      memberRoleIds,
    } = interactionCtx;

    // Check user allowlist before processing component interaction.
    const allowed = await ensureAgentComponentInteractionAllowed({
      ctx: this.ctx,
      interaction,
      channelId,
      rawGuildId,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "select",
      unauthorizedReply: "You are not authorized to use this select menu.",
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    // Extract selected values
    const values = interaction.values ?? [];
    const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";

    const route = resolveAgentComponentRoute({
      ctx: this.ctx,
      rawGuildId,
      memberRoleIds,
      isDirectMessage,
      userId,
      channelId,
      parentId,
    });

    const eventText = `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`;

    logDebug(`agent select: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      sessionKey: route.sessionKey,
      contextKey: `discord:agent-select:${channelId}:${componentId}:${userId}`,
    });

    await ackComponentInteraction({ interaction, replyOpts, label: "agent select" });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}
