import { getDoctorChannelCapabilities } from "../channel-capabilities.js";

export type AllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

export function resolveAllowFromMode(channelName: string): AllowFromMode {
  return getDoctorChannelCapabilities(channelName).dmAllowFromMode;
}
