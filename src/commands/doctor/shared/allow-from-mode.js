import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
export function resolveAllowFromMode(channelName) {
    return getDoctorChannelCapabilities(channelName).dmAllowFromMode;
}
