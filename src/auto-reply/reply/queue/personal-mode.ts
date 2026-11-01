import {
  CHAT_FOLLOW_UP_PREFERENCE_KEY,
  normalizeChatFollowUpModePreference,
} from "../../../../packages/gateway-protocol/src/schema/chat-follow-up-preferences.js";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { getUserPreferenceValues } from "../../../state/user-preferences.js";

/** Read the submitting person's choice, never the session owner's preferences. */
export async function resolvePersonalQueueMode(profileId?: string): Promise<QueueMode | undefined> {
  if (!profileId) {
    return undefined;
  }
  const { values } = await getUserPreferenceValues([profileId], CHAT_FOLLOW_UP_PREFERENCE_KEY);
  const mode = normalizeChatFollowUpModePreference(values.get(profileId));
  return mode === "queue" ? "followup" : mode;
}
