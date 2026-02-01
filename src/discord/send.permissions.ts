import type { APIChannel, APIGuild, APIGuildMember, APIRole } from "discord-api-types/v10";
import { RequestClient } from "@buape/carbon";
import { ChannelType, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import type { RetryConfig } from "../infra/retry.js";
import type { DiscordPermissionsSummary, DiscordReactOpts } from "./send.types.js";
import { loadConfig } from "../config/config.js";
import { resolveDiscordAccount } from "./accounts.js";
import { normalizeDiscordToken } from "./token.js";

const PERMISSION_ENTRIES = Object.entries(PermissionFlagsBits).filter(
  ([, value]) => typeof value === "bigint",
);

type DiscordClientOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { explicit?: string; accountId: string; fallbackToken?: string }) {
  const explicit = normalizeDiscordToken(params.explicit);
  if (explicit) {
    return explicit;
  }
  const fallback = normalizeDiscordToken(params.fallbackToken);
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function resolveRest(token: string, rest?: RequestClient) {
  return rest ?? new RequestClient(token);
}

function resolveDiscordRest(opts: DiscordClientOpts) {
  const cfg = loadConfig();
  const account = resolveDiscordAccount({ cfg, accountId: opts.accountId });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.token,
  });
  return resolveRest(token, opts.rest);
}

function addPermissionBits(base: bigint, add?: string) {
  if (!add) {
    return base;
  }
  return base | BigInt(add);
}

function removePermissionBits(base: bigint, deny?: string) {
  if (!deny) {
    return base;
  }
  return base & ~BigInt(deny);
}

function bitfieldToPermissions(bitfield: bigint) {
  return PERMISSION_ENTRIES.filter(([, value]) => (bitfield & value) === value)
    .map(([name]) => name)
    .toSorted();
}

export function isThreadChannelType(channelType?: number) {
  return (
    channelType === ChannelType.GuildNewsThread ||
    channelType === ChannelType.GuildPublicThread ||
    channelType === ChannelType.GuildPrivateThread
  );
}

async function fetchBotUserId(rest: RequestClient) {
  const me = (await rest.get(Routes.user("@me"))) as { id?: string };
  if (!me?.id) {
    throw new Error("Failed to resolve bot user id");
  }
  return me.id;
}

export async function fetchChannelPermissionsDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<DiscordPermissionsSummary> {
  const rest = resolveDiscordRest(opts);
  const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
  const channelType = "type" in channel ? channel.type : undefined;
  const guildId = "guild_id" in channel ? channel.guild_id : undefined;
  if (!guildId) {
    return {
      channelId,
      permissions: [],
      raw: "0",
      isDm: true,
      channelType,
    };
  }

  const botId = await fetchBotUserId(rest);
  const [guild, member] = await Promise.all([
    rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
    rest.get(Routes.guildMember(guildId, botId)) as Promise<APIGuildMember>,
  ]);

  const rolesById = new Map<string, APIRole>((guild.roles ?? []).map((role) => [role.id, role]));
  const everyoneRole = rolesById.get(guildId);
  let base = 0n;
  if (everyoneRole?.permissions) {
    base = addPermissionBits(base, everyoneRole.permissions);
  }
  for (const roleId of member.roles ?? []) {
    const role = rolesById.get(roleId);
    if (role?.permissions) {
      base = addPermissionBits(base, role.permissions);
    }
  }

  let permissions = base;
  const overwrites =
    "permission_overwrites" in channel ? (channel.permission_overwrites ?? []) : [];
  for (const overwrite of overwrites) {
    if (overwrite.id === guildId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }
  for (const overwrite of overwrites) {
    if (member.roles?.includes(overwrite.id)) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }
  for (const overwrite of overwrites) {
    if (overwrite.id === botId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }

  return {
    channelId,
    guildId,
    permissions: bitfieldToPermissions(permissions),
    raw: permissions.toString(),
    isDm: false,
    channelType,
  };
}
