import type { BoundWebPushSubscription } from "../infra/push-web.js";

export function makeSubscription(
  id: string,
  profileId: string | null = null,
  preferences: Partial<BoundWebPushSubscription["devicePreferences"]> = {},
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${id}`,
    endpoint: `https://push.example.test/${id}`,
    keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId: id,
    userProfileId: profileId,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
      },
      ...preferences,
    },
  };
}
