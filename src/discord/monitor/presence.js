const DEFAULT_CUSTOM_ACTIVITY_TYPE = 4;
const CUSTOM_STATUS_NAME = "Custom Status";
export function resolveDiscordPresenceUpdate(config) {
    const activityText = typeof config.activity === "string" ? config.activity.trim() : "";
    const status = typeof config.status === "string" ? config.status.trim() : "";
    const activityType = config.activityType;
    const activityUrl = typeof config.activityUrl === "string" ? config.activityUrl.trim() : "";
    const hasActivity = Boolean(activityText);
    const hasStatus = Boolean(status);
    if (!hasActivity && !hasStatus) {
        return null;
    }
    const activities = [];
    if (hasActivity) {
        const resolvedType = activityType ?? DEFAULT_CUSTOM_ACTIVITY_TYPE;
        const activity = resolvedType === DEFAULT_CUSTOM_ACTIVITY_TYPE
            ? { name: CUSTOM_STATUS_NAME, type: resolvedType, state: activityText }
            : { name: activityText, type: resolvedType };
        if (resolvedType === 1 && activityUrl) {
            activity.url = activityUrl;
        }
        activities.push(activity);
    }
    return {
        since: null,
        activities,
        status: (status || "online"),
        afk: false,
    };
}
