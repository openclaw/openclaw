// Doctor helper for resolving channel-specific direct-message allowlist semantics.
<<<<<<< HEAD
import type { ChannelDmAllowFromMode } from "../../../channels/plugins/dm-access.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";

export type AllowFromMode = ChannelDmAllowFromMode;
=======
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { AllowFromMode } from "./allow-from-mode.types.js";

export type { AllowFromMode } from "./allow-from-mode.types.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

/** Return the allowFrom interpretation mode advertised by a channel's doctor metadata. */
export function resolveAllowFromMode(channelName: string): AllowFromMode {
  return getDoctorChannelCapabilities(channelName).dmAllowFromMode;
}
