import {
  Button,
  ChannelSelectMenu,
  MentionableSelectMenu,
  Modal,
  RoleSelectMenu,
  StringSelectMenu,
  UserSelectMenu,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ComponentData,
  type MentionableSelectMenuInteraction,
  type ModalInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "@buape/carbon";
import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle, ChannelType } from "discord-api-types/v10";
import { resolveHumanDelayConfig } from "../../agents/identity.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { createReplyReferencePlanner } from "../../auto-reply/reply/reply-reference.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import type { DiscordAccountConfig } from "../../config/types.discord.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { logDebug, logError } from "../../logger.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveDiscordComponentEntry, resolveDiscordModalEntry } from "../components-registry.js";
import {
  createDiscordFormModal,
  formatDiscordComponentEventText,
  parseDiscordComponentCustomId,
  parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomId,
  parseDiscordModalCustomIdForCarbon,
  type DiscordComponentEntry,
  type DiscordModalEntry,
} from "../components.js";
import {
  type DiscordGuildEntryResolved,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAllowFrom,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";
import { buildDirectLabel, buildGuildLabel } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { sendTyping } from "./typing.js";

const AGENT_BUTTON_KEY = "agent";
const AGENT_SELECT_KEY = "agentsel";

type DiscordUser = Parameters<typeof formatDiscordUserTag>[0];

type AgentComponentMessageInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | UserSelectMenuInteraction
  | MentionableSelectMenuInteraction
  | ChannelSelectMenuInteraction;

type AgentComponentInteraction = AgentComponentMessageInteraction | ModalInteraction;

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
  defer?: boolean;
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

  const shouldDefer = params.defer !== false && "defer" in interaction;
  let didDefer = false;
  // Defer immediately to satisfy Discord's 3-second interaction ACK requirement.
  // We use an ephemeral deferred reply so subsequent interaction.reply() calls
  // can safely edit the original deferred response.
  if (shouldDefer) {
    try {
      await (interaction as AgentComponentMessageInteraction).defer({ ephemeral: true });
      didDefer = true;
    } catch (err) {
      logError(`${label}: failed to defer interaction: ${String(err)}`);
    }
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

  const { memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender: {
      id: user.id,
      name: user.username,
      tag: user.discriminator ? `${user.username}#${user.discriminator}` : undefined,
    },
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

async function ensureComponentUserAllowed(params: {
  entry: DiscordComponentEntry;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
}): Promise<boolean> {
  const allowList = normalizeDiscordAllowList(params.entry.allowedUsers, [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return true;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: {
      id: params.user.id,
      name: params.user.username,
      tag: formatDiscordUserTag(params.user),
    },
  });
  if (match.allowed) {
    return true;
  }

  logVerbose(
    `discord component ${params.componentLabel}: blocked user ${params.user.id} (not in allowedUsers)`,
  );
  try {
    await params.interaction.reply({
      content: params.unauthorizedReply,
      ...params.replyOpts,
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
  discordConfig?: DiscordAccountConfig;
  runtime?: RuntimeEnv;
  token?: string;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  /** DM allowlist (from allowFrom config; legacy: dm.allowFrom) */
  allowFrom?: string[];
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

  const storeAllowFrom =
    dmPolicy === "allowlist" ? [] : await readChannelAllowFromStore("discord").catch(() => []);
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
  defer?: boolean;
}): Promise<ComponentInteractionContext | null> {
  const interactionCtx = await resolveComponentInteractionContext({
    interaction: params.interaction,
    label: params.label,
    defer: params.defer,
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

function normalizeComponentId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function parseDiscordComponentData(
  data: ComponentData,
  customId?: string,
): { componentId: string; modalId?: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const rawComponentId =
    "cid" in data
      ? (data as { cid?: unknown }).cid
      : (data as { componentId?: unknown }).componentId;
  const rawModalId =
    "mid" in data ? (data as { mid?: unknown }).mid : (data as { modalId?: unknown }).modalId;
  let componentId = normalizeComponentId(rawComponentId);
  let modalId = normalizeComponentId(rawModalId);
  if (!componentId && customId) {
    const parsed = parseDiscordComponentCustomId(customId);
    if (parsed) {
      componentId = parsed.componentId;
      modalId = parsed.modalId;
    }
  }
  if (!componentId) {
    return null;
  }
  return { componentId, modalId };
}

function parseDiscordModalId(data: ComponentData, customId?: string): string | null {
  if (data && typeof data === "object") {
    const rawModalId =
      "mid" in data ? (data as { mid?: unknown }).mid : (data as { modalId?: unknown }).modalId;
    const modalId = normalizeComponentId(rawModalId);
    if (modalId) {
      return modalId;
    }
  }
  if (customId) {
    return parseDiscordModalCustomId(customId);
  }
  return null;
}

function resolveInteractionCustomId(interaction: AgentComponentInteraction): string | undefined {
  if (!interaction?.rawData || typeof interaction.rawData !== "object") {
    return undefined;
  }
  if (!("data" in interaction.rawData)) {
    return undefined;
  }
  const data = (interaction.rawData as { data?: { custom_id?: unknown } }).data;
  const customId = data?.custom_id;
  if (typeof customId !== "string") {
    return undefined;
  }
  const trimmed = customId.trim();
  return trimmed ? trimmed : undefined;
}

function mapOptionLabels(
  options: Array<{ value: string; label: string }> | undefined,
  values: string[],
) {
  if (!options || options.length === 0) {
    return values;
  }
  const map = new Map(options.map((option) => [option.value, option.label]));
  return values.map((value) => map.get(value) ?? value);
}

function mapSelectValues(entry: DiscordComponentEntry, values: string[]): string[] {
  if (entry.selectType === "string") {
    return mapOptionLabels(entry.options, values);
  }
  if (entry.selectType === "user") {
    return values.map((value) => `user:${value}`);
  }
  if (entry.selectType === "role") {
    return values.map((value) => `role:${value}`);
  }
  if (entry.selectType === "mentionable") {
    return values.map((value) => `mentionable:${value}`);
  }
  if (entry.selectType === "channel") {
    return values.map((value) => `channel:${value}`);
  }
  return values;
}

function resolveModalFieldValues(
  field: DiscordModalEntry["fields"][number],
  interaction: ModalInteraction,
): string[] {
  const fields = interaction.fields;
  const optionLabels = field.options?.map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const required = field.required === true;
  try {
    switch (field.type) {
      case "text": {
        const value = required ? fields.getText(field.id, true) : fields.getText(field.id);
        return value ? [value] : [];
      }
      case "select":
      case "checkbox":
      case "radio": {
        const values = required
          ? fields.getStringSelect(field.id, true)
          : (fields.getStringSelect(field.id) ?? []);
        return mapOptionLabels(optionLabels, values);
      }
      case "role-select": {
        try {
          const roles = required
            ? fields.getRoleSelect(field.id, true)
            : (fields.getRoleSelect(field.id) ?? []);
          return roles.map((role) => role.name ?? role.id);
        } catch {
          const values = required
            ? fields.getStringSelect(field.id, true)
            : (fields.getStringSelect(field.id) ?? []);
          return values;
        }
      }
      case "user-select": {
        const users = required
          ? fields.getUserSelect(field.id, true)
          : (fields.getUserSelect(field.id) ?? []);
        return users.map((user) => formatDiscordUserTag(user));
      }
      default:
        return [];
    }
  } catch (err) {
    logError(`agent modal: failed to read field ${field.id}: ${String(err)}`);
    return [];
  }
}

function formatModalSubmissionText(
  entry: DiscordModalEntry,
  interaction: ModalInteraction,
): string {
  const lines: string[] = [`Form "${entry.title}" submitted.`];
  for (const field of entry.fields) {
    const values = resolveModalFieldValues(field, interaction);
    if (values.length === 0) {
      continue;
    }
    lines.push(`- ${field.label}: ${values.join(", ")}`);
  }
  if (lines.length === 1) {
    lines.push("- (no values)");
  }
  return lines.join("\n");
}

async function dispatchDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  eventText: string;
  replyToId?: string;
  routeOverrides?: { sessionKey?: string; agentId?: string; accountId?: string };
}): Promise<void> {
  const { ctx, interaction, interactionCtx, channelCtx, guildInfo, eventText } = params;
  const runtime = ctx.runtime ?? createNonExitingRuntime();
  const route = resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "discord",
    accountId: ctx.accountId,
    guildId: interactionCtx.rawGuildId,
    memberRoleIds: interactionCtx.memberRoleIds,
    peer: {
      kind: interactionCtx.isDirectMessage ? "direct" : "channel",
      id: interactionCtx.isDirectMessage ? interactionCtx.userId : interactionCtx.channelId,
    },
    parentPeer: channelCtx.parentId ? { kind: "channel", id: channelCtx.parentId } : undefined,
  });
  const sessionKey = params.routeOverrides?.sessionKey ?? route.sessionKey;
  const agentId = params.routeOverrides?.agentId ?? route.agentId;
  const accountId = params.routeOverrides?.accountId ?? route.accountId;

  const fromLabel = interactionCtx.isDirectMessage
    ? buildDirectLabel(interactionCtx.user)
    : buildGuildLabel({
        guild: interaction.guild ?? undefined,
        channelName: channelCtx.channelName ?? interactionCtx.channelId,
        channelId: interactionCtx.channelId,
      });
  const senderName = interactionCtx.user.globalName ?? interactionCtx.user.username;
  const senderUsername = interactionCtx.user.username;
  const senderTag = formatDiscordUserTag(interactionCtx.user);
  const groupChannel =
    !interactionCtx.isDirectMessage && channelCtx.channelSlug
      ? `#${channelCtx.channelSlug}`
      : undefined;
  const groupSubject = interactionCtx.isDirectMessage ? undefined : groupChannel;
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: interactionCtx.channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const groupSystemPrompt = channelConfig?.systemPrompt?.trim() || undefined;
  const ownerAllowFrom = resolveDiscordOwnerAllowFrom({
    channelConfig,
    guildInfo,
    sender: { id: interactionCtx.user.id, name: interactionCtx.user.username, tag: senderTag },
  });
  const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const timestamp = Date.now();
  const combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp,
    body: eventText,
    chatType: interactionCtx.isDirectMessage ? "direct" : "channel",
    senderLabel: senderName,
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: eventText,
    RawBody: eventText,
    CommandBody: eventText,
    From: interactionCtx.isDirectMessage
      ? `discord:${interactionCtx.userId}`
      : `discord:channel:${interactionCtx.channelId}`,
    To: `channel:${interactionCtx.channelId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: interactionCtx.isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: interactionCtx.userId,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    GroupSystemPrompt: interactionCtx.isDirectMessage ? undefined : groupSystemPrompt,
    GroupSpace: guildInfo?.id ?? guildInfo?.slug ?? interactionCtx.rawGuildId ?? undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    CommandAuthorized: true,
    CommandSource: "text" as const,
    MessageSid: interaction.rawData.id,
    Timestamp: timestamp,
    OriginatingChannel: "discord" as const,
    OriginatingTo: `channel:${interactionCtx.channelId}`,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    updateLastRoute: interactionCtx.isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "discord",
          to: `user:${interactionCtx.userId}`,
          accountId,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`discord: failed updating component session meta: ${String(err)}`);
    },
  });

  const deliverTarget = `channel:${interactionCtx.channelId}`;
  const typingChannelId = interactionCtx.channelId;
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: ctx.cfg,
    agentId,
    channel: "discord",
    accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "discord",
    accountId,
  });
  const textLimit = resolveTextChunkLimit(ctx.cfg, "discord", accountId, {
    fallbackLimit: 2000,
  });
  const token = ctx.token ?? "";
  const replyToMode =
    ctx.discordConfig?.replyToMode ?? ctx.cfg.channels?.discord?.replyToMode ?? "off";
  const replyReference = createReplyReferencePlanner({
    replyToMode,
    startId: params.replyToId,
  });

  await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    replyOptions: { onModelSelected },
    dispatcherOptions: {
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(ctx.cfg, agentId),
      deliver: async (payload) => {
        const replyToId = replyReference.use();
        await deliverDiscordReply({
          replies: [payload],
          target: deliverTarget,
          token,
          accountId,
          rest: interaction.client.rest,
          runtime,
          replyToId,
          replyToMode,
          textLimit,
          maxLinesPerMessage: ctx.discordConfig?.maxLinesPerMessage,
          tableMode,
          chunkMode: resolveChunkMode(ctx.cfg, "discord", accountId),
        });
        replyReference.markSent();
      },
      onReplyStart: async () => {
        try {
          await sendTyping({ client: interaction.client, channelId: typingChannelId });
        } catch (err) {
          logVerbose(`discord: typing failed for component reply: ${String(err)}`);
        }
      },
      onError: (err) => {
        logError(`discord component dispatch failed: ${String(err)}`);
      },
    },
  });
}

async function handleDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  componentLabel: string;
  values?: string[];
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    try {
      await params.interaction.reply({
        content: "This component is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const entry = resolveDiscordComponentEntry({ id: parsed.componentId, consume: false });
  if (!entry) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.componentLabel,
  });
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const unauthorizedReply = `You are not authorized to use this ${params.componentLabel}.`;
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply,
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply,
  });
  if (!componentAllowed) {
    return;
  }

  const consumed = resolveDiscordComponentEntry({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  if (consumed.kind === "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const values = params.values ? mapSelectValues(consumed, params.values) : undefined;
  const eventText = formatDiscordComponentEventText({
    kind: consumed.kind === "select" ? "select" : "button",
    label: consumed.label,
    values,
  });

  try {
    await params.interaction.reply({ content: "✓", ...replyOpts });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }

  await dispatchDiscordComponentEvent({
    ctx: params.ctx,
    interaction: params.interaction,
    interactionCtx,
    channelCtx,
    guildInfo,
    eventText,
    replyToId: consumed.messageId ?? params.interaction.message?.id,
    routeOverrides: {
      sessionKey: consumed.sessionKey,
      agentId: consumed.agentId,
      accountId: consumed.accountId,
    },
  });
}

async function handleDiscordModalTrigger(params: {
  ctx: AgentComponentContext;
  interaction: ButtonInteraction;
  data: ComponentData;
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse modal trigger data`);
    try {
      await params.interaction.reply({
        content: "This button is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }
  const entry = resolveDiscordComponentEntry({ id: parsed.componentId, consume: false });
  if (!entry || entry.kind !== "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This button has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const modalId = entry.modalId ?? parsed.modalId;
  if (!modalId) {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: "form",
    defer: false,
  });
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const unauthorizedReply = "You are not authorized to use this form.";
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: "form",
    unauthorizedReply,
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: "form",
    unauthorizedReply,
  });
  if (!componentAllowed) {
    return;
  }

  const consumed = resolveDiscordComponentEntry({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const resolvedModalId = consumed.modalId ?? modalId;
  const modalEntry = resolveDiscordModalEntry({ id: resolvedModalId, consume: false });
  if (!modalEntry) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  try {
    await params.interaction.showModal(createDiscordFormModal(modalEntry));
  } catch (err) {
    logError(`${params.label}: failed to show modal: ${String(err)}`);
  }
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

class DiscordComponentButton extends Button {
  label = "component";
  customId = "*";
  style = ButtonStyle.Primary;
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
    if (parsed?.modalId) {
      await handleDiscordModalTrigger({
        ctx: this.ctx,
        interaction,
        data,
        label: "discord component modal",
      });
      return;
    }
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "button",
      label: "discord component button",
    });
  }
}

class DiscordComponentStringSelect extends StringSelectMenu {
  customId = "*";
  options: APIStringSelectComponent["options"] = [];
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "select menu",
      label: "discord component select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentUserSelect extends UserSelectMenu {
  customId = "*";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: UserSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "user select",
      label: "discord component user select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentRoleSelect extends RoleSelectMenu {
  customId = "*";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: RoleSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "role select",
      label: "discord component role select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentMentionableSelect extends MentionableSelectMenu {
  customId = "*";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: MentionableSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "mentionable select",
      label: "discord component mentionable select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentChannelSelect extends ChannelSelectMenu {
  customId = "*";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ChannelSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "channel select",
      label: "discord component channel select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentModal extends Modal {
  title = "OpenClaw form";
  customId = "*";
  components = [];
  customIdParser = parseDiscordModalCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ModalInteraction, data: ComponentData): Promise<void> {
    const modalId = parseDiscordModalId(data, resolveInteractionCustomId(interaction));
    if (!modalId) {
      logError("discord component modal: missing modal id");
      try {
        await interaction.reply({
          content: "This form is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const modalEntry = resolveDiscordModalEntry({ id: modalId, consume: false });
    if (!modalEntry) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "discord component modal",
      componentLabel: "form",
      defer: false,
    });
    if (!interactionCtx) {
      return;
    }
    const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
    const guildInfo = resolveDiscordGuildEntry({
      guild: interaction.guild ?? undefined,
      guildEntries: this.ctx.guildEntries,
    });
    const channelCtx = resolveDiscordChannelContext(interaction);
    const memberAllowed = await ensureGuildComponentMemberAllowed({
      interaction,
      guildInfo,
      channelId,
      rawGuildId,
      channelCtx,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "form",
      unauthorizedReply: "You are not authorized to use this form.",
    });
    if (!memberAllowed) {
      return;
    }

    const consumed = resolveDiscordModalEntry({
      id: modalId,
      consume: !modalEntry.reusable,
    });
    if (!consumed) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    try {
      await interaction.acknowledge();
    } catch (err) {
      logError(`discord component modal: failed to acknowledge: ${String(err)}`);
    }

    const eventText = formatModalSubmissionText(consumed, interaction);
    await dispatchDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      interactionCtx,
      channelCtx,
      guildInfo,
      eventText,
      replyToId: consumed.messageId,
      routeOverrides: {
        sessionKey: consumed.sessionKey,
        agentId: consumed.agentId,
        accountId: consumed.accountId,
      },
    });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}

export function createDiscordComponentButton(ctx: AgentComponentContext): Button {
  return new DiscordComponentButton(ctx);
}

export function createDiscordComponentStringSelect(ctx: AgentComponentContext): StringSelectMenu {
  return new DiscordComponentStringSelect(ctx);
}

export function createDiscordComponentUserSelect(ctx: AgentComponentContext): UserSelectMenu {
  return new DiscordComponentUserSelect(ctx);
}

export function createDiscordComponentRoleSelect(ctx: AgentComponentContext): RoleSelectMenu {
  return new DiscordComponentRoleSelect(ctx);
}

export function createDiscordComponentMentionableSelect(
  ctx: AgentComponentContext,
): MentionableSelectMenu {
  return new DiscordComponentMentionableSelect(ctx);
}

export function createDiscordComponentChannelSelect(ctx: AgentComponentContext): ChannelSelectMenu {
  return new DiscordComponentChannelSelect(ctx);
}

export function createDiscordComponentModal(ctx: AgentComponentContext): Modal {
  return new DiscordComponentModal(ctx);
}
