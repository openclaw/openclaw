// KOOK REST API wrapper

export const KOOK_API_BASE = "https://www.kookapp.cn/api";
export const KOOK_API_VERSION = "v3";

export type KookApiResponse<T = unknown> = {
  code: number;
  message: string;
  data: T;
};

export type KookApiErrorType = "auth" | "rateLimit" | "notFound" | "server" | "unknown";

export class KookApiError extends Error {
  constructor(
    message: string,
    public readonly type: KookApiErrorType,
    public readonly statusCode?: number,
    public readonly apiCode?: number,
  ) {
    super(message);
    this.name = "KookApiError";
  }

  isRetryable(): boolean {
    return this.type === "rateLimit" || this.type === "server";
  }
}

/**
 * Classify HTTP status code to error type
 */
function classifyErrorType(status: number): KookApiErrorType {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimit";
  if (status >= 500) return "server";
  return "unknown";
}

/**
 * Fetch with KOOK authorization
 */
export async function fetchKook<T = unknown>(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${KOOK_API_BASE}/${KOOK_API_VERSION}${path}`;

  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bot ${token}`);
  headers.set("Content-Type", "application/json");

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorType = classifyErrorType(response.status);
    throw new KookApiError(
      `KOOK API HTTP error: ${response.status} ${response.statusText}`,
      errorType,
      response.status,
    );
  }

  const json = (await response.json()) as KookApiResponse<T>;

  if (json.code !== 0) {
    // Classify API error codes
    let errorType: KookApiErrorType = "unknown";
    if (json.code >= 40100 && json.code < 40200) errorType = "auth";
    else if (json.code === 429) errorType = "rateLimit";
    else if (json.code >= 50000) errorType = "server";

    throw new KookApiError(
      `KOOK API error: code=${json.code}, message=${json.message}`,
      errorType,
      undefined,
      json.code,
    );
  }

  return json.data;
}

/**
 * Get KOOK Gateway WebSocket URL
 */
export async function getKookGateway(token: string, compress: boolean = true): Promise<string> {
  const data = await fetchKook<{ url: string }>(
    `/gateway/index?compress=${compress ? "1" : "0"}`,
    token,
  );

  return data.url;
}

/**
 * Send a message to a channel or user
 */
export async function sendKookMessage(params: {
  token: string;
  type: number;
  targetId: string;
  content: string;
  quote?: string;
  nonce?: string;
  tempTargetId?: string;
}): Promise<{
  msgId: string;
  msgTimestamp: number;
  nonce: string;
}> {
  const data = await fetchKook<{
    msg_id: string;
    msg_timestamp: number;
    nonce: string;
  }>("/message/create", params.token, {
    method: "POST",
    body: JSON.stringify({
      type: params.type,
      target_id: params.targetId,
      content: params.content,
      quote: params.quote,
      nonce: params.nonce,
      temp_target_id: params.tempTargetId,
    }),
  });

  return {
    msgId: data.msg_id,
    msgTimestamp: data.msg_timestamp,
    nonce: data.nonce,
  };
}

/**
 * Send a direct message
 */
export async function sendKookDirectMessage(params: {
  token: string;
  type: number;
  targetId: string;
  content: string;
  quote?: string;
  nonce?: string;
}): Promise<{
  msgId: string;
  msgTimestamp: number;
  nonce: string;
}> {
  const data = await fetchKook<{
    msg_id: string;
    msg_timestamp: number;
    nonce: string;
  }>("/direct-message/create", params.token, {
    method: "POST",
    body: JSON.stringify({
      type: params.type,
      target_id: params.targetId,
      content: params.content,
      quote: params.quote,
      nonce: params.nonce,
    }),
  });

  return {
    msgId: data.msg_id,
    msgTimestamp: data.msg_timestamp,
    nonce: data.nonce,
  };
}

// ============================================================
// User API
// ============================================================

export type KookUser = {
  id: string;
  username: string;
  nickname?: string;
  identifyNum: string;
  online: boolean;
  bot: boolean;
  status: number;
  avatar: string;
  vipAvatar?: string;
  mobileVerified: boolean;
  roles?: number[];
  joinedAt?: number;
  activeTime?: number;
};

/**
 * Get current bot user info
 */
export async function getKookMe(token: string): Promise<KookUser> {
  const data = await fetchKook<{
    id: string;
    username: string;
    identify_num: string;
    online: boolean;
    bot: boolean;
    status: number;
    avatar: string;
    vip_avatar?: string;
    mobile_verified: boolean;
  }>("/user/me", token);

  return {
    id: data.id,
    username: data.username,
    identifyNum: data.identify_num,
    online: data.online,
    bot: data.bot,
    status: data.status,
    avatar: data.avatar,
    vipAvatar: data.vip_avatar,
    mobileVerified: data.mobile_verified,
  };
}

/**
 * Get user info by ID
 */
export async function getKookUser(params: {
  token: string;
  userId: string;
  guildId?: string;
}): Promise<KookUser> {
  const query = params.guildId
    ? `?user_id=${params.userId}&guild_id=${params.guildId}`
    : `?user_id=${params.userId}`;

  const data = await fetchKook<{
    id: string;
    username: string;
    nickname?: string;
    identify_num: string;
    online: boolean;
    bot: boolean;
    status: number;
    avatar: string;
    vip_avatar?: string;
    mobile_verified: boolean;
    roles?: number[];
    joined_at?: number;
    active_time?: number;
  }>(`/user/view${query}`, params.token);

  return {
    id: data.id,
    username: data.username,
    nickname: data.nickname,
    identifyNum: data.identify_num,
    online: data.online,
    bot: data.bot,
    status: data.status,
    avatar: data.avatar,
    vipAvatar: data.vip_avatar,
    mobileVerified: data.mobile_verified,
    roles: data.roles,
    joinedAt: data.joined_at,
    activeTime: data.active_time,
  };
}

// ============================================================
// Guild API
// ============================================================

export type KookGuild = {
  id: string;
  name: string;
  topic: string;
  userId: string;
  icon: string;
  notifyType: number;
  region: string;
  enableOpen: boolean;
  openId: string;
  defaultChannelId: string;
  welcomeChannelId: string;
  roles?: KookRole[];
  channels?: KookChannel[];
};

export type KookRole = {
  roleId: number;
  name: string;
  color: number;
  position: number;
  hoist: number;
  mentionable: number;
  permissions: number;
};

export type KookChannel = {
  id: string;
  name: string;
  userId: string;
  guildId: string;
  topic: string;
  isCategory: boolean;
  parentId: string;
  level: number;
  slowMode: number;
  type: number;
  permissionOverwrites: unknown[];
  permissionUsers: unknown[];
  permissionSync: number;
};

/**
 * Get guild list
 */
export async function getKookGuildList(token: string): Promise<KookGuild[]> {
  const data = await fetchKook<{
    items: Array<{
      id: string;
      name: string;
      topic: string;
      user_id: string;
      icon: string;
      notify_type: number;
      region: string;
      enable_open: boolean;
      open_id: string;
      default_channel_id: string;
      welcome_channel_id: string;
    }>;
  }>("/guild/list", token);

  return data.items.map((g) => ({
    id: g.id,
    name: g.name,
    topic: g.topic,
    userId: g.user_id,
    icon: g.icon,
    notifyType: g.notify_type,
    region: g.region,
    enableOpen: g.enable_open,
    openId: g.open_id,
    defaultChannelId: g.default_channel_id,
    welcomeChannelId: g.welcome_channel_id,
  }));
}

/**
 * Get guild info by ID
 */
export async function getKookGuild(params: { token: string; guildId: string }): Promise<KookGuild> {
  const data = await fetchKook<{
    id: string;
    name: string;
    topic: string;
    user_id: string;
    icon: string;
    notify_type: number;
    region: string;
    enable_open: boolean;
    open_id: string;
    default_channel_id: string;
    welcome_channel_id: string;
    roles?: Array<{
      role_id: number;
      name: string;
      color: number;
      position: number;
      hoist: number;
      mentionable: number;
      permissions: number;
    }>;
    channels?: Array<{
      id: string;
      name: string;
      user_id: string;
      guild_id: string;
      topic: string;
      is_category: boolean;
      parent_id: string;
      level: number;
      slow_mode: number;
      type: number;
      permission_overwrites: unknown[];
      permission_users: unknown[];
      permission_sync: number;
    }>;
  }>(`/guild/view?guild_id=${params.guildId}`, params.token);

  return {
    id: data.id,
    name: data.name,
    topic: data.topic,
    userId: data.user_id,
    icon: data.icon,
    notifyType: data.notify_type,
    region: data.region,
    enableOpen: data.enable_open,
    openId: data.open_id,
    defaultChannelId: data.default_channel_id,
    welcomeChannelId: data.welcome_channel_id,
    roles: data.roles?.map((r) => ({
      roleId: r.role_id,
      name: r.name,
      color: r.color,
      position: r.position,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions,
    })),
    channels: data.channels?.map((c) => ({
      id: c.id,
      name: c.name,
      userId: c.user_id,
      guildId: c.guild_id,
      topic: c.topic,
      isCategory: c.is_category,
      parentId: c.parent_id,
      level: c.level,
      slowMode: c.slow_mode,
      type: c.type,
      permissionOverwrites: c.permission_overwrites,
      permissionUsers: c.permission_users,
      permissionSync: c.permission_sync,
    })),
  };
}

/**
 * Get guild member count
 */
export async function getKookGuildUserCount(params: {
  token: string;
  guildId: string;
}): Promise<{ userCount: number; onlineCount: number; offlineCount: number }> {
  const data = await fetchKook<{
    user_count: number;
    online_count: number;
    offline_count: number;
  }>(`/guild/user-list?guild_id=${params.guildId}&page=1&page_size=1`, params.token);

  return {
    userCount: data.user_count,
    onlineCount: data.online_count,
    offlineCount: data.offline_count,
  };
}

// ============================================================
// Channel API
// ============================================================

/**
 * Get channel info
 */
export async function getKookChannel(params: {
  token: string;
  channelId: string;
}): Promise<KookChannel> {
  const data = await fetchKook<{
    id: string;
    name: string;
    user_id: string;
    guild_id: string;
    topic: string;
    is_category: boolean;
    parent_id: string;
    level: number;
    slow_mode: number;
    type: number;
    permission_overwrites: unknown[];
    permission_users: unknown[];
    permission_sync: number;
  }>(`/channel/view?target_id=${params.channelId}`, params.token);

  return {
    id: data.id,
    name: data.name,
    userId: data.user_id,
    guildId: data.guild_id,
    topic: data.topic,
    isCategory: data.is_category,
    parentId: data.parent_id,
    level: data.level,
    slowMode: data.slow_mode,
    type: data.type,
    permissionOverwrites: data.permission_overwrites,
    permissionUsers: data.permission_users,
    permissionSync: data.permission_sync,
  };
}

/**
 * Get users in voice channel
 */
export async function getKookChannelUserList(params: {
  token: string;
  channelId: string;
}): Promise<KookUser[]> {
  const data = await fetchKook<
    Array<{
      id: string;
      username: string;
      nickname?: string;
      identify_num: string;
      online: boolean;
      bot: boolean;
      status: number;
      avatar: string;
      vip_avatar?: string;
      mobile_verified: boolean;
    }>
  >(`/channel/user-list?channel_id=${params.channelId}`, params.token);

  return data.map((u) => ({
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    identifyNum: u.identify_num,
    online: u.online,
    bot: u.bot,
    status: u.status,
    avatar: u.avatar,
    vipAvatar: u.vip_avatar,
    mobileVerified: u.mobile_verified,
  }));
}

// ============================================================
// Message Management API
// ============================================================

export type KookMessage = {
  id: string;
  type: number;
  content: string;
  mention: string[];
  mentionAll: boolean;
  mentionRoles: number[];
  mentionHere: boolean;
  embeds: unknown[];
  attachments?: {
    type: string;
    url: string;
    name: string;
    size: number;
    [key: string]: unknown;
  };
  reactions?: Array<{
    emoji: {
      id: string;
      name: string;
    };
    count: number;
    me: boolean;
  }>;
  quote?: {
    id: string;
    type: number;
    content: string;
    createAt: number;
    author: KookUser;
  };
  createAt: number;
  updatedAt: number;
  author: KookUser;
};

export type KookMessageList = {
  items: KookMessage[];
};

/**
 * Get message list from channel
 */
export async function getKookMessageList(params: {
  token: string;
  targetId: string;
  msgId?: string;
  pin?: 0 | 1;
  flag?: "before" | "around" | "after";
  pageSize?: number;
}): Promise<KookMessage[]> {
  const query = new URLSearchParams({
    target_id: params.targetId,
    ...(params.msgId && { msg_id: params.msgId }),
    ...(params.pin !== undefined && { pin: params.pin.toString() }),
    ...(params.flag && { flag: params.flag }),
    ...(params.pageSize && { page_size: params.pageSize.toString() }),
  });

  const data = await fetchKook<{
    items: Array<{
      id: string;
      type: number;
      content: string;
      mention?: string[];
      mention_all?: boolean;
      mention_roles?: number[];
      mention_here?: boolean;
      embeds?: unknown[];
      attachments?: KookMessage["attachments"];
      reactions?: KookMessage["reactions"];
      quote?: {
        id: string;
        type: number;
        content: string;
        create_at: number;
        author: KookUser;
      };
      create_at: number;
      updated_at: number;
      author: KookUser;
    }>;
  }>(`/message/list?${query.toString()}`, params.token);

  return data.items.map((msg) => ({
    id: msg.id,
    type: msg.type,
    content: msg.content,
    mention: msg.mention || [],
    mentionAll: msg.mention_all || false,
    mentionRoles: msg.mention_roles || [],
    mentionHere: msg.mention_here || false,
    embeds: msg.embeds || [],
    attachments: msg.attachments,
    reactions: msg.reactions,
    quote: msg.quote
      ? {
          id: msg.quote.id,
          type: msg.quote.type,
          content: msg.quote.content,
          createAt: msg.quote.create_at,
          author: msg.quote.author,
        }
      : undefined,
    createAt: msg.create_at,
    updatedAt: msg.updated_at,
    author: msg.author,
  }));
}

/**
 * Get message details
 */
export async function getKookMessage(params: {
  token: string;
  msgId: string;
}): Promise<KookMessage & { channelId: string }> {
  const data = await fetchKook<{
    id: string;
    type: number;
    content: string;
    mention?: string[];
    mention_all?: boolean;
    mention_roles?: number[];
    mention_here?: boolean;
    embeds?: unknown[];
    attachments?: KookMessage["attachments"];
    reactions?: KookMessage["reactions"];
    quote?: {
      id: string;
      type: number;
      content: string;
      create_at: number;
      author: KookUser;
    };
    create_at: number;
    updated_at: number;
    author: KookUser;
    channel_id: string;
  }>(`/message/view?msg_id=${params.msgId}`, params.token);

  return {
    id: data.id,
    type: data.type,
    content: data.content,
    mention: data.mention || [],
    mentionAll: data.mention_all || false,
    mentionRoles: data.mention_roles || [],
    mentionHere: data.mention_here || false,
    embeds: data.embeds || [],
    attachments: data.attachments,
    reactions: data.reactions,
    quote: data.quote
      ? {
          id: data.quote.id,
          type: data.quote.type,
          content: data.quote.content,
          createAt: data.quote.create_at,
          author: data.quote.author,
        }
      : undefined,
    createAt: data.create_at,
    updatedAt: data.updated_at,
    author: data.author,
    channelId: data.channel_id,
  };
}

/**
 * Update message (KMarkdown and CardMessage only)
 */
export async function updateKookMessage(params: {
  token: string;
  msgId: string;
  content: string;
  quote?: string;
  tempTargetId?: string;
}): Promise<void> {
  await fetchKook("/message/update", params.token, {
    method: "POST",
    body: JSON.stringify({
      msg_id: params.msgId,
      content: params.content,
      ...(params.quote && { quote: params.quote }),
      ...(params.tempTargetId && { temp_target_id: params.tempTargetId }),
    }),
  });
}

/**
 * Delete message
 */
export async function deleteKookMessage(params: { token: string; msgId: string }): Promise<void> {
  await fetchKook("/message/delete", params.token, {
    method: "POST",
    body: JSON.stringify({
      msg_id: params.msgId,
    }),
  });
}

/**
 * Add reaction to message
 */
export async function addKookReaction(params: {
  token: string;
  msgId: string;
  emoji: string;
}): Promise<void> {
  await fetchKook("/message/add-reaction", params.token, {
    method: "POST",
    body: JSON.stringify({
      msg_id: params.msgId,
      emoji: params.emoji,
    }),
  });
}

/**
 * Delete reaction from message
 */
export async function deleteKookReaction(params: {
  token: string;
  msgId: string;
  emoji: string;
  userId?: string;
}): Promise<void> {
  await fetchKook("/message/delete-reaction", params.token, {
    method: "POST",
    body: JSON.stringify({
      msg_id: params.msgId,
      emoji: params.emoji,
      ...(params.userId && { user_id: params.userId }),
    }),
  });
}

/**
 * Get reaction list for message
 */
export async function getKookReactionList(params: {
  token: string;
  msgId: string;
  emoji: string;
}): Promise<(KookUser & { reactionTime: number })[]> {
  const data = await fetchKook<Array<KookUser & { reaction_time?: number }>>(
    `/message/reaction-list?msg_id=${params.msgId}&emoji=${encodeURIComponent(params.emoji)}`,
    params.token,
  );

  return data.map((user) => ({
    ...user,
    reactionTime: user.reaction_time ?? 0,
  }));
}

// ============================================================
// Guild Extended API
// ============================================================

/**
 * Get guild user list
 */
export async function getKookGuildUsers(params: {
  token: string;
  guildId: string;
  page?: number;
  pageSize?: number;
}): Promise<{
  items: KookUser[];
  meta: {
    page: number;
    pageTotal: number;
    pageSize: number;
    total: number;
  };
}> {
  const query = new URLSearchParams({
    guild_id: params.guildId,
    ...(params.page && { page: params.page.toString() }),
    ...(params.pageSize && { page_size: params.pageSize.toString() }),
  });

  const data = await fetchKook<{
    items: Array<{
      id: string;
      username: string;
      nickname?: string;
      identify_num: string;
      online: boolean;
      bot: boolean;
      status: number;
      avatar: string;
      vip_avatar?: string;
      mobile_verified: boolean;
      roles?: number[];
      joined_at?: number;
      active_time?: number;
    }>;
    meta: {
      page: number;
      page_total: number;
      page_size: number;
      total: number;
    };
  }>(`/guild/user-list?${query.toString()}`, params.token);

  return {
    items: data.items.map((u) => ({
      id: u.id,
      username: u.username,
      nickname: u.nickname,
      identifyNum: u.identify_num,
      online: u.online,
      bot: u.bot,
      status: u.status,
      avatar: u.avatar,
      vipAvatar: u.vip_avatar,
      mobileVerified: u.mobile_verified,
      roles: u.roles,
      joinedAt: u.joined_at,
      activeTime: u.active_time,
    })),
    meta: {
      page: data.meta.page,
      pageTotal: data.meta.page_total,
      pageSize: data.meta.page_size,
      total: data.meta.total,
    },
  };
}

/**
 * Update user nickname in guild
 */
export async function updateKookNickname(params: {
  token: string;
  guildId: string;
  userId: string;
  nickname: string;
}): Promise<void> {
  await fetchKook("/guild/nickname", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      user_id: params.userId,
      nickname: params.nickname,
    }),
  });
}

/**
 * Leave guild
 */
export async function leaveKookGuild(params: { token: string; guildId: string }): Promise<void> {
  await fetchKook("/guild/leave", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
    }),
  });
}

/**
 * Kick user from guild
 */
export async function kickKookGuildUser(params: {
  token: string;
  guildId: string;
  userId: string;
}): Promise<void> {
  await fetchKook("/guild/kickout", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      user_id: params.userId,
    }),
  });
}

// ============================================================
// Channel Management API
// ============================================================

/**
 * Get channel list from guild
 */
export async function getKookChannelList(params: {
  token: string;
  guildId: string;
  page?: number;
  pageSize?: number;
  type?: 1 | 2;
}): Promise<{
  items: KookChannel[];
  meta: {
    page: number;
    pageTotal: number;
    pageSize: number;
    total: number;
  };
}> {
  const query = new URLSearchParams({
    guild_id: params.guildId,
    ...(params.page && { page: params.page.toString() }),
    ...(params.pageSize && { page_size: params.pageSize.toString() }),
    ...(params.type && { type: params.type.toString() }),
  });

  const data = await fetchKook<{
    items: Array<{
      id: string;
      name: string;
      user_id: string;
      guild_id?: string;
      topic: string;
      is_category: boolean;
      parent_id: string;
      level: number;
      slow_mode: number;
      type: number;
      permission_overwrites?: unknown[];
      permission_users?: unknown[];
      permission_sync: number;
    }>;
    meta: {
      page: number;
      page_total: number;
      page_size: number;
      total: number;
    };
  }>(`/channel/list?${query.toString()}`, params.token);

  return {
    items: data.items.map((c) => ({
      id: c.id,
      name: c.name,
      userId: c.user_id,
      guildId: c.guild_id || params.guildId,
      topic: c.topic,
      isCategory: c.is_category,
      parentId: c.parent_id,
      level: c.level,
      slowMode: c.slow_mode,
      type: c.type,
      permissionOverwrites: c.permission_overwrites || [],
      permissionUsers: c.permission_users || [],
      permissionSync: c.permission_sync,
    })),
    meta: {
      page: data.meta.page,
      pageTotal: data.meta.page_total,
      pageSize: data.meta.page_size,
      total: data.meta.total,
    },
  };
}

/**
 * Create channel
 */
export async function createKookChannel(params: {
  token: string;
  guildId: string;
  name: string;
  type: 1 | 2;
  parentId?: string;
  limitAmount?: number;
  voiceQuality?: 1 | 2 | 3;
}): Promise<KookChannel> {
  const data = await fetchKook<{
    id: string;
    name: string;
    user_id: string;
    guild_id: string;
    topic: string;
    is_category: boolean;
    parent_id: string;
    level: number;
    slow_mode: number;
    type: number;
    permission_overwrites?: unknown[];
    permission_users?: unknown[];
    permission_sync: number;
  }>("/channel/create", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      name: params.name,
      type: params.type,
      ...(params.parentId && { parent_id: params.parentId }),
      ...(params.limitAmount && { limit_amount: params.limitAmount }),
      ...(params.voiceQuality && { voice_quality: params.voiceQuality }),
    }),
  });

  return {
    id: data.id,
    name: data.name,
    userId: data.user_id,
    guildId: data.guild_id,
    topic: data.topic,
    isCategory: data.is_category,
    parentId: data.parent_id,
    level: data.level,
    slowMode: data.slow_mode,
    type: data.type,
    permissionOverwrites: data.permission_overwrites || [],
    permissionUsers: data.permission_users || [],
    permissionSync: data.permission_sync,
  };
}

/**
 * Update channel
 */
export async function updateKookChannel(params: {
  token: string;
  channelId: string;
  name?: string;
  topic?: string;
  parentId?: string;
  limitAmount?: number;
  slowMode?: number;
  voiceQuality?: 1 | 2 | 3;
}): Promise<KookChannel> {
  const data = await fetchKook<{
    id: string;
    name: string;
    user_id: string;
    guild_id: string;
    topic: string;
    is_category: boolean;
    parent_id: string;
    level: number;
    slow_mode: number;
    type: number;
    permission_overwrites?: unknown[];
    permission_users?: unknown[];
    permission_sync: number;
  }>("/channel/update", params.token, {
    method: "POST",
    body: JSON.stringify({
      channel_id: params.channelId,
      ...(params.name && { name: params.name }),
      ...(params.topic && { topic: params.topic }),
      ...(params.parentId !== undefined && { parent_id: params.parentId }),
      ...(params.limitAmount && { limit_amount: params.limitAmount }),
      ...(params.slowMode !== undefined && { slow_mode: params.slowMode }),
      ...(params.voiceQuality && { voice_quality: params.voiceQuality }),
    }),
  });

  return {
    id: data.id,
    name: data.name,
    userId: data.user_id,
    guildId: data.guild_id,
    topic: data.topic,
    isCategory: data.is_category,
    parentId: data.parent_id,
    level: data.level,
    slowMode: data.slow_mode,
    type: data.type,
    permissionOverwrites: data.permission_overwrites || [],
    permissionUsers: data.permission_users || [],
    permissionSync: data.permission_sync,
  };
}

/**
 * Delete channel
 */
export async function deleteKookChannel(params: {
  token: string;
  channelId: string;
}): Promise<void> {
  await fetchKook("/channel/delete", params.token, {
    method: "POST",
    body: JSON.stringify({
      channel_id: params.channelId,
    }),
  });
}

/**
 * Move user between voice channels
 */
export async function moveKookUser(params: {
  token: string;
  userId: string;
  targetChannelId: string;
}): Promise<void> {
  await fetchKook("/channel/move-user", params.token, {
    method: "POST",
    body: JSON.stringify({
      user_id: params.userId,
      target_channel_id: params.targetChannelId,
    }),
  });
}

// ============================================================
// Role Management API
// ============================================================

/**
 * Get guild role list
 */
export async function getKookRoleList(params: {
  token: string;
  guildId: string;
}): Promise<KookRole[]> {
  const data = await fetchKook<{
    items: Array<{
      role_id: number;
      name: string;
      color: number;
      position: number;
      hoist: number;
      mentionable: number;
      permissions: number;
    }>;
  }>(`/guild-role/list?guild_id=${params.guildId}`, params.token);

  return data.items.map((r) => ({
    roleId: r.role_id,
    name: r.name,
    color: r.color,
    position: r.position,
    hoist: r.hoist,
    mentionable: r.mentionable,
    permissions: r.permissions,
  }));
}

/**
 * Create guild role
 */
export async function createKookRole(params: {
  token: string;
  guildId: string;
  name: string;
  color?: number;
  hoist?: 0 | 1;
  mentionable?: 0 | 1;
  permissions?: number;
}): Promise<KookRole> {
  const data = await fetchKook<{
    role_id: number;
    name: string;
    color: number;
    position: number;
    hoist: number;
    mentionable: number;
    permissions: number;
  }>("/guild-role/create", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      name: params.name,
      ...(params.color && { color: params.color }),
      ...(params.hoist !== undefined && { hoist: params.hoist }),
      ...(params.mentionable !== undefined && { mentionable: params.mentionable }),
      ...(params.permissions && { permissions: params.permissions }),
    }),
  });

  return {
    roleId: data.role_id,
    name: data.name,
    color: data.color,
    position: data.position,
    hoist: data.hoist,
    mentionable: data.mentionable,
    permissions: data.permissions,
  };
}

/**
 * Update guild role
 */
export async function updateKookRole(params: {
  token: string;
  guildId: string;
  roleId: number;
  name?: string;
  color?: number;
  hoist?: 0 | 1;
  mentionable?: 0 | 1;
  permissions?: number;
}): Promise<KookRole> {
  const data = await fetchKook<{
    role_id: number;
    name: string;
    color: number;
    position: number;
    hoist: number;
    mentionable: number;
    permissions: number;
  }>("/guild-role/update", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      role_id: params.roleId,
      ...(params.name && { name: params.name }),
      ...(params.color && { color: params.color }),
      ...(params.hoist !== undefined && { hoist: params.hoist }),
      ...(params.mentionable !== undefined && { mentionable: params.mentionable }),
      ...(params.permissions && { permissions: params.permissions }),
    }),
  });

  return {
    roleId: data.role_id,
    name: data.name,
    color: data.color,
    position: data.position,
    hoist: data.hoist,
    mentionable: data.mentionable,
    permissions: data.permissions,
  };
}

/**
 * Delete guild role
 */
export async function deleteKookRole(params: {
  token: string;
  guildId: string;
  roleId: number;
}): Promise<void> {
  await fetchKook("/guild-role/delete", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      role_id: params.roleId,
    }),
  });
}

/**
 * Grant role to user
 */
export async function grantKookRole(params: {
  token: string;
  guildId: string;
  userId: string;
  roleId: number;
}): Promise<void> {
  await fetchKook("/guild-role/grant", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      user_id: params.userId,
      role_id: params.roleId,
    }),
  });
}

/**
 * Revoke role from user
 */
export async function revokeKookRole(params: {
  token: string;
  guildId: string;
  userId: string;
  roleId: number;
}): Promise<void> {
  await fetchKook("/guild-role/revoke", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      user_id: params.userId,
      role_id: params.roleId,
    }),
  });
}

// ============================================================
// Emoji Management API
// ============================================================

export type KookEmoji = {
  id: string;
  name: string;
  userInfo: KookUser;
};

/**
 * Get guild emoji list
 */
export async function getKookEmojiList(params: {
  token: string;
  guildId: string;
  page?: number;
  pageSize?: number;
}): Promise<{
  items: KookEmoji[];
  meta: {
    page: number;
    pageTotal: number;
    pageSize: number;
    total: number;
  };
}> {
  const query = new URLSearchParams({
    guild_id: params.guildId,
    ...(params.page && { page: params.page.toString() }),
    ...(params.pageSize && { page_size: params.pageSize.toString() }),
  });

  const data = await fetchKook<{
    items: Array<{
      id: string;
      name: string;
      user_info: {
        id: string;
        username: string;
        nickname?: string;
        identify_num: string;
        online: boolean;
        bot: boolean;
        status: number;
        avatar: string;
        vip_avatar?: string;
        mobile_verified: boolean;
        roles?: number[];
        joined_at?: number;
        active_time?: number;
      };
    }>;
    meta: {
      page: number;
      page_total: number;
      page_size: number;
      total: number;
    };
  }>(`/guild-emoji/list?${query.toString()}`, params.token);

  return {
    items: data.items.map((e) => ({
      id: e.id,
      name: e.name,
      userInfo: {
        id: e.user_info.id,
        username: e.user_info.username,
        nickname: e.user_info.nickname,
        identifyNum: e.user_info.identify_num,
        online: e.user_info.online,
        bot: e.user_info.bot,
        status: e.user_info.status,
        avatar: e.user_info.avatar,
        vipAvatar: e.user_info.vip_avatar,
        mobileVerified: e.user_info.mobile_verified,
        roles: e.user_info.roles,
        joinedAt: e.user_info.joined_at,
        activeTime: e.user_info.active_time,
      },
    })),
    meta: {
      page: data.meta.page,
      pageTotal: data.meta.page_total,
      pageSize: data.meta.page_size,
      total: data.meta.total,
    },
  };
}

/**
 * Create guild emoji
 */
export async function createKookEmoji(params: {
  token: string;
  guildId: string;
  name: string;
  emoji: string;
}): Promise<KookEmoji> {
  const data = await fetchKook<{
    id: string;
    name: string;
    user_info: {
      id: string;
      username: string;
      nickname?: string;
      identify_num: string;
      online: boolean;
      bot: boolean;
      status: number;
      avatar: string;
      vip_avatar?: string;
      mobile_verified: boolean;
      roles?: number[];
      joined_at?: number;
      active_time?: number;
    };
  }>("/guild-emoji/create", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      name: params.name,
      emoji: params.emoji,
    }),
  });

  return {
    id: data.id,
    name: data.name,
    userInfo: {
      id: data.user_info.id,
      username: data.user_info.username,
      nickname: data.user_info.nickname,
      identifyNum: data.user_info.identify_num,
      online: data.user_info.online,
      bot: data.user_info.bot,
      status: data.user_info.status,
      avatar: data.user_info.avatar,
      vipAvatar: data.user_info.vip_avatar,
      mobileVerified: data.user_info.mobile_verified,
      roles: data.user_info.roles,
      joinedAt: data.user_info.joined_at,
      activeTime: data.user_info.active_time,
    },
  };
}

/**
 * Update guild emoji
 */
export async function updateKookEmoji(params: {
  token: string;
  guildId: string;
  emojiId: string;
  name?: string;
  emoji?: string;
}): Promise<KookEmoji> {
  const data = await fetchKook<{
    id: string;
    name: string;
    user_info: {
      id: string;
      username: string;
      nickname?: string;
      identify_num: string;
      online: boolean;
      bot: boolean;
      status: number;
      avatar: string;
      vip_avatar?: string;
      mobile_verified: boolean;
      roles?: number[];
      joined_at?: number;
      active_time?: number;
    };
  }>("/guild-emoji/update", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      emoji_id: params.emojiId,
      ...(params.name && { name: params.name }),
      ...(params.emoji && { emoji: params.emoji }),
    }),
  });

  return {
    id: data.id,
    name: data.name,
    userInfo: {
      id: data.user_info.id,
      username: data.user_info.username,
      nickname: data.user_info.nickname,
      identifyNum: data.user_info.identify_num,
      online: data.user_info.online,
      bot: data.user_info.bot,
      status: data.user_info.status,
      avatar: data.user_info.avatar,
      vipAvatar: data.user_info.vip_avatar,
      mobileVerified: data.user_info.mobile_verified,
      roles: data.user_info.roles,
      joinedAt: data.user_info.joined_at,
      activeTime: data.user_info.active_time,
    },
  };
}

/**
 * Delete guild emoji
 */
export async function deleteKookEmoji(params: {
  token: string;
  guildId: string;
  emojiId: string;
}): Promise<void> {
  await fetchKook("/guild-emoji/delete", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      emoji_id: params.emojiId,
    }),
  });
}

// ============================================================
// Guild Mute API
// ============================================================

/**
 * Get guild mute list
 */
export async function getKookGuildMuteList(params: { token: string; guildId: string }): Promise<{
  items: Array<{
    userId: string;
    type: number;
    startAt: number;
    duration: number;
  }>;
}> {
  const data = await fetchKook<{
    items: Array<{
      user_id: string;
      type: number;
      start_at: number;
      duration: number;
    }>;
  }>(`/guild-mute/list?guild_id=${params.guildId}`, params.token);

  return {
    items: data.items.map((m) => ({
      userId: m.user_id,
      type: m.type,
      startAt: m.start_at,
      duration: m.duration,
    })),
  };
}

/**
 * Create guild mute
 */
export async function createKookGuildMute(params: {
  token: string;
  guildId: string;
  userId: string;
  type: number;
  duration?: number;
}): Promise<void> {
  await fetchKook("/guild-mute/create", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      user_id: params.userId,
      type: params.type,
      ...(params.duration && { duration: params.duration }),
    }),
  });
}

/**
 * Delete guild mute
 */
export async function deleteKookGuildMute(params: {
  token: string;
  guildId: string;
  userId: string;
  type: number;
}): Promise<void> {
  await fetchKook("/guild-mute/delete", params.token, {
    method: "POST",
    body: JSON.stringify({
      guild_id: params.guildId,
      user_id: params.userId,
      type: params.type,
    }),
  });
}
