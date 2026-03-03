import { PermissionFlagsBits } from "discord-api-types/v10";
import { readNumberParam, readStringParam } from "./common.js";
const moderationPermissions = {
    timeout: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
    ban: PermissionFlagsBits.BanMembers,
};
export function isDiscordModerationAction(action) {
    return action === "timeout" || action === "kick" || action === "ban";
}
export function requiredGuildPermissionForModerationAction(action) {
    return moderationPermissions[action];
}
export function readDiscordModerationCommand(action, params) {
    if (!isDiscordModerationAction(action)) {
        throw new Error(`Unsupported Discord moderation action: ${action}`);
    }
    return {
        action,
        guildId: readStringParam(params, "guildId", { required: true }),
        userId: readStringParam(params, "userId", { required: true }),
        durationMinutes: readNumberParam(params, "durationMinutes", { integer: true }),
        until: readStringParam(params, "until"),
        reason: readStringParam(params, "reason"),
        deleteMessageDays: readNumberParam(params, "deleteMessageDays", { integer: true }),
    };
}
