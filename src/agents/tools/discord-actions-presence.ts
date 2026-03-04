import type { Activity, UpdatePresenceData } from "@buape/carbon/gateway";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DiscordActionConfig } from "../../config/config.js";
import { getGateway } from "../../discord/monitor/gateway-registry.js";
import {
  fetchCurrentUserDiscord,
  updateCurrentUserAvatarDiscord,
  updateSelfNicknameDiscord,
} from "../../discord/send.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { loadWebMediaRaw } from "../../web/media.js";
import { type ActionGate, jsonResult, readStringParam } from "./common.js";

const ACTIVITY_TYPE_MAP: Record<string, number> = {
  playing: 0,
  streaming: 1,
  listening: 2,
  watching: 3,
  custom: 4,
  competing: 5,
};

const CUSTOM_STATUS_ACTIVITY_NAME = "Custom Status";

const VALID_STATUSES = new Set(["online", "dnd", "idle", "invisible"]);
const ALLOWED_AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);
const DISCORD_MAX_AVATAR_BYTES = 10 * 1024 * 1024;

function buildPresencePayload(params: {
  values: Record<string, unknown>;
  defaultStatus: UpdatePresenceData["status"];
  includeStatusMessageAlias: boolean;
  allowEmpty: boolean;
}): UpdatePresenceData | undefined {
  const statusRaw = readStringParam(params.values, "status");
  if (statusRaw && !VALID_STATUSES.has(statusRaw)) {
    throw new Error(
      `Invalid status "${statusRaw}". Must be one of: ${[...VALID_STATUSES].join(", ")}`,
    );
  }

  let activityTypeRaw = readStringParam(params.values, "activityType");
  const activityName = readStringParam(params.values, "activityName");
  const activityUrl = readStringParam(params.values, "activityUrl");
  let activityState = readStringParam(params.values, "activityState");
  const statusMessage = params.includeStatusMessageAlias
    ? readStringParam(params.values, "statusMessage", { allowEmpty: true })
    : undefined;

  if (statusMessage !== undefined) {
    if (activityState === undefined) {
      activityState = statusMessage;
    }
    if (!activityTypeRaw) {
      activityTypeRaw = "custom";
    }
  }

  const hasPresenceInputs =
    statusRaw !== undefined ||
    activityTypeRaw !== undefined ||
    activityName !== undefined ||
    activityUrl !== undefined ||
    activityState !== undefined;

  if (!hasPresenceInputs) {
    if (!params.allowEmpty) {
      return undefined;
    }
    return {
      since: null,
      activities: [],
      status: params.defaultStatus,
      afk: false,
    };
  }

  const activities: Activity[] = [];

  if (activityTypeRaw || activityName || activityUrl || activityState !== undefined) {
    if (!activityTypeRaw) {
      throw new Error(
        "activityType is required when activityName/activityState/activityUrl is provided. " +
          `Valid types: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`,
      );
    }
    const typeNum = ACTIVITY_TYPE_MAP[activityTypeRaw.toLowerCase()];
    if (typeNum === undefined) {
      throw new Error(
        `Invalid activityType "${activityTypeRaw}". Must be one of: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`,
      );
    }

    const activity: Activity = {
      name: activityName ?? (typeNum === 4 ? CUSTOM_STATUS_ACTIVITY_NAME : ""),
      type: typeNum,
    };

    if (typeNum === 1 && activityUrl) {
      activity.url = activityUrl;
    }

    if (activityState !== undefined) {
      activity.state = activityState;
    }

    activities.push(activity);
  }

  return {
    since: null,
    activities,
    status: (statusRaw ?? params.defaultStatus) as UpdatePresenceData["status"],
    afk: false,
  };
}

function requireConnectedGateway(accountId?: string): {
  updatePresence: (payload: UpdatePresenceData) => void;
} {
  const gateway = getGateway(accountId);
  if (!gateway) {
    throw new Error(
      `Discord gateway not available${accountId ? ` for account "${accountId}"` : ""}. The bot may not be connected.`,
    );
  }
  if (!gateway.isConnected) {
    throw new Error(
      `Discord gateway is not connected${accountId ? ` for account "${accountId}"` : ""}.`,
    );
  }
  return gateway;
}

function normalizeUserLikeTarget(raw: string, label: string): string {
  let parsed: ReturnType<typeof parseDiscordTarget> | undefined;
  try {
    parsed = parseDiscordTarget(raw, { defaultKind: "user" });
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    if (parsed.kind !== "user") {
      throw new Error(
        `Discord self-profile updates only accept user/member selectors. ${label} must resolve to a user id.`,
      );
    }
    return parsed.id;
  }
  return raw.trim();
}

function enforceSelfOnlyScope(params: { values: Record<string, unknown>; selfId: string }): void {
  const checks: Array<{ label: string; value?: string }> = [
    { label: "userId", value: readStringParam(params.values, "userId") },
    { label: "memberId", value: readStringParam(params.values, "memberId") },
    { label: "target", value: readStringParam(params.values, "target") },
  ];

  for (const check of checks) {
    if (!check.value) {
      continue;
    }
    const normalized = normalizeUserLikeTarget(check.value, check.label);
    if (normalized !== params.selfId) {
      throw new Error(
        `Discord self-profile updates are restricted to the bot account. ${check.label} "${check.value}" does not match bot user id "${params.selfId}".`,
      );
    }
  }
}

function normalizeAvatarMime(raw?: string): string | undefined {
  const contentType = raw?.trim().toLowerCase();
  if (!contentType) {
    return undefined;
  }
  if (contentType === "image/jpg") {
    return "image/jpeg";
  }
  return contentType;
}

function validateAvatarMime(contentType?: string): string {
  const normalized = normalizeAvatarMime(contentType);
  if (!normalized || !ALLOWED_AVATAR_MIME_TYPES.has(normalized)) {
    throw new Error(
      "Discord avatar updates require PNG, JPEG, GIF, or WEBP image input (contentType/mimeType).",
    );
  }
  return normalized;
}

function decodeBase64Strict(raw: string): Buffer {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (!/^[A-Za-z0-9+/]+=*$/.test(padded)) {
    throw new Error("Avatar buffer must be valid base64 data.");
  }
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length === 0 && padded.length > 0) {
    throw new Error("Avatar buffer must be valid base64 data.");
  }
  const reEncoded = decoded.toString("base64").replace(/=+$/g, "");
  const comparable = padded.replace(/=+$/g, "");
  if (reEncoded !== comparable) {
    throw new Error("Avatar buffer must be valid base64 data.");
  }
  return decoded;
}

async function resolveAvatarDataUri(params: {
  values: Record<string, unknown>;
  mediaLocalRoots?: readonly string[];
}): Promise<string | undefined> {
  const explicitAvatar = readStringParam(params.values, "avatar", { trim: false });
  const mediaUrl =
    explicitAvatar ??
    readStringParam(params.values, "mediaUrl", { trim: false }) ??
    readStringParam(params.values, "media", { trim: false }) ??
    readStringParam(params.values, "path", { trim: false }) ??
    readStringParam(params.values, "filePath", { trim: false });

  const rawBuffer = readStringParam(params.values, "buffer", { trim: false });
  const hintedContentType =
    readStringParam(params.values, "contentType") ?? readStringParam(params.values, "mimeType");

  if (!mediaUrl && !rawBuffer) {
    return undefined;
  }

  if (rawBuffer) {
    const dataUrlMatch = /^data:([^;]+);base64,(.*)$/i.exec(rawBuffer.trim());
    const contentType = validateAvatarMime(hintedContentType ?? dataUrlMatch?.[1]);
    const payload = (dataUrlMatch ? dataUrlMatch[2] : rawBuffer.trim()).replace(/\s+/g, "");
    if (!payload) {
      throw new Error("Avatar buffer is empty.");
    }
    const decodedBuffer = decodeBase64Strict(payload);
    if (decodedBuffer.byteLength > DISCORD_MAX_AVATAR_BYTES) {
      throw new Error(
        `Avatar buffer exceeds the Discord limit of ${Math.floor(DISCORD_MAX_AVATAR_BYTES / (1024 * 1024))} MB.`,
      );
    }
    return `data:${contentType};base64,${decodedBuffer.toString("base64")}`;
  }

  const media = await loadWebMediaRaw(mediaUrl as string, {
    maxBytes: DISCORD_MAX_AVATAR_BYTES,
    localRoots: params.mediaLocalRoots,
  });
  const contentType = validateAvatarMime(hintedContentType ?? media.contentType);
  return `data:${contentType};base64,${media.buffer.toString("base64")}`;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  return String(err);
}

function listAppliedSelfProfileSteps(updates: Record<string, unknown>): string[] {
  return ["nickname", "avatar", "presence"].filter((key) => Object.hasOwn(updates, key));
}

export async function handleDiscordPresenceAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  options?: {
    mediaLocalRoots?: readonly string[];
  },
): Promise<AgentToolResult<unknown>> {
  const accountId = readStringParam(params, "accountId");

  if (action === "setPresence") {
    if (!isActionEnabled("presence", false)) {
      throw new Error("Discord presence changes are disabled.");
    }

    const gateway = requireConnectedGateway(accountId);
    const presenceData = buildPresencePayload({
      values: params,
      defaultStatus: "online",
      includeStatusMessageAlias: false,
      allowEmpty: true,
    });

    if (!presenceData) {
      throw new Error("Failed to build Discord presence payload.");
    }

    gateway.updatePresence(presenceData);

    return jsonResult({
      ok: true,
      status: presenceData.status,
      activities: presenceData.activities.map((a) => ({
        type: a.type,
        name: a.name,
        ...(a.url ? { url: a.url } : {}),
        ...(a.state !== undefined ? { state: a.state } : {}),
      })),
    });
  }

  if (action === "updateSelfProfile") {
    if (!isActionEnabled("selfProfile", false)) {
      throw new Error("Discord self-profile updates are disabled.");
    }

    const selfUser = accountId
      ? await fetchCurrentUserDiscord({ accountId })
      : await fetchCurrentUserDiscord();
    enforceSelfOnlyScope({ values: params, selfId: selfUser.id });

    const nickname = readStringParam(params, "nickname", { allowEmpty: true });
    const avatarDataUri = await resolveAvatarDataUri({
      values: params,
      mediaLocalRoots: options?.mediaLocalRoots,
    });
    const presenceData = buildPresencePayload({
      values: params,
      defaultStatus: "online",
      includeStatusMessageAlias: true,
      allowEmpty: false,
    });

    if (nickname === undefined && !avatarDataUri && !presenceData) {
      throw new Error(
        "No self-profile fields provided. Set at least one of: nickname, avatar (avatar/media/path/filePath/buffer), status, statusMessage, or activity* fields.",
      );
    }

    const gateway = presenceData ? requireConnectedGateway(accountId) : null;
    const bestEffort = params.bestEffort === true;

    const updates: Record<string, unknown> = {};
    const errors: Array<{ step: "nickname" | "avatar" | "presence"; message: string }> = [];

    const runSelfProfileStep = async (
      step: "nickname" | "avatar" | "presence",
      task: () => Promise<void>,
    ): Promise<void> => {
      try {
        await task();
      } catch (err) {
        const message = stringifyError(err);
        errors.push({ step, message });
        if (!bestEffort) {
          const appliedSteps = listAppliedSelfProfileSteps(updates);
          const appliedMessage =
            appliedSteps.length > 0 ? ` Applied before failure: ${appliedSteps.join(", ")}.` : "";
          const normalizedMessage = message.replace(/[.\s]+$/g, "");
          throw new Error(
            `Discord self-profile update failed at ${step}: ${normalizedMessage}.${appliedMessage}`,
            { cause: err },
          );
        }
      }
    };

    if (nickname !== undefined) {
      await runSelfProfileStep("nickname", async () => {
        const guildId = readStringParam(params, "guildId", { required: true });
        if (accountId) {
          await updateSelfNicknameDiscord(
            {
              guildId,
              nickname: nickname || null,
            },
            { accountId },
          );
        } else {
          await updateSelfNicknameDiscord({
            guildId,
            nickname: nickname || null,
          });
        }
        updates.nickname = {
          guildId,
          nickname: nickname || null,
        };
      });
    }

    if (avatarDataUri) {
      await runSelfProfileStep("avatar", async () => {
        if (accountId) {
          await updateCurrentUserAvatarDiscord({ avatar: avatarDataUri }, { accountId });
        } else {
          await updateCurrentUserAvatarDiscord({ avatar: avatarDataUri });
        }
        updates.avatar = { updated: true };
      });
    }

    if (presenceData && gateway) {
      await runSelfProfileStep("presence", async () => {
        gateway.updatePresence(presenceData);
        updates.presence = {
          status: presenceData.status,
          activities: presenceData.activities.map((a) => ({
            type: a.type,
            name: a.name,
            ...(a.url ? { url: a.url } : {}),
            ...(a.state !== undefined ? { state: a.state } : {}),
          })),
        };
      });
    }

    if (errors.length > 0) {
      return jsonResult({
        ok: false,
        partial: true,
        selfUserId: selfUser.id,
        updates,
        errors,
      });
    }

    return jsonResult({
      ok: true,
      selfUserId: selfUser.id,
      updates,
    });
  }

  throw new Error(`Unknown presence action: ${action}`);
}
