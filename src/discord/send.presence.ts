import { getDiscordGateway } from "./client-registry.js";

export type DiscordPresenceStatus = "online" | "dnd" | "idle" | "invisible" | "offline";

export type DiscordActivityType =
  | "playing"
  | "streaming"
  | "listening"
  | "watching"
  | "custom"
  | "competing";

const ACTIVITY_TYPE_MAP: Record<DiscordActivityType, number> = {
  playing: 0,
  streaming: 1,
  listening: 2,
  watching: 3,
  custom: 4,
  competing: 5,
};

export type DiscordPresenceUpdate = {
  accountId?: string;
  status?: DiscordPresenceStatus;
  activityType?: DiscordActivityType;
  activityName?: string;
  activityUrl?: string;
  afk?: boolean;
};

export type DiscordPresenceResult = {
  success: boolean;
  status?: DiscordPresenceStatus;
  activity?: {
    type: DiscordActivityType;
    name: string;
    url?: string;
  };
  error?: string;
};

export function updatePresenceDiscord(params: DiscordPresenceUpdate): DiscordPresenceResult {
  const gateway = getDiscordGateway(params.accountId);
  if (!gateway) {
    return {
      success: false,
      error: params.accountId
        ? `Discord gateway not found for account: ${params.accountId}`
        : "Discord gateway not connected",
    };
  }

  const status = params.status ?? "online";
  const activityType = params.activityType ?? "playing";
  const activityName = params.activityName?.trim();

  const activities = activityName
    ? [
        {
          name: activityName,
          type: ACTIVITY_TYPE_MAP[activityType],
          ...(params.activityUrl && activityType === "streaming"
            ? { url: params.activityUrl }
            : {}),
        },
      ]
    : [];

  gateway.updatePresence({
    since: null,
    activities,
    status,
    afk: params.afk ?? false,
  });

  return {
    success: true,
    status,
    ...(activityName
      ? {
          activity: {
            type: activityType,
            name: activityName,
            ...(params.activityUrl ? { url: params.activityUrl } : {}),
          },
        }
      : {}),
  };
}
