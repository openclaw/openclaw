import { Routes, type APIGuildMember, type APIUser } from "discord-api-types/v10";
import { resolveDiscordRest } from "./send.shared.js";
import type { DiscordReactOpts } from "./send.types.js";

export async function fetchCurrentUserDiscord(opts: DiscordReactOpts = {}): Promise<APIUser> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(Routes.user("@me"))) as APIUser;
}

export async function updateSelfNicknameDiscord(
  payload: { guildId: string; nickname: string | null },
  opts: DiscordReactOpts = {},
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  return (await rest.patch(Routes.guildMember(payload.guildId, "@me"), {
    body: { nick: payload.nickname },
  })) as APIGuildMember;
}

export async function updateCurrentUserAvatarDiscord(
  payload: { avatar: string | null },
  opts: DiscordReactOpts = {},
): Promise<APIUser> {
  const rest = resolveDiscordRest(opts);
  return (await rest.patch(Routes.user("@me"), {
    body: { avatar: payload.avatar },
  })) as APIUser;
}
