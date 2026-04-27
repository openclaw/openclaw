import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { findBundledPackageChannelMetadata } from "../../plugins/bundled-package-channel-metadata.js";
const DEFAULT_DOCTOR_CHANNEL_CAPABILITIES = {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: true,
};
function mergeDoctorChannelCapabilities(capabilities) {
    return {
        dmAllowFromMode: capabilities?.dmAllowFromMode ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.dmAllowFromMode,
        groupModel: capabilities?.groupModel ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupModel,
        groupAllowFromFallbackToAllowFrom: capabilities?.groupAllowFromFallbackToAllowFrom ??
            DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupAllowFromFallbackToAllowFrom,
        warnOnEmptyGroupSenderAllowlist: capabilities?.warnOnEmptyGroupSenderAllowlist ??
            DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.warnOnEmptyGroupSenderAllowlist,
    };
}
function getManifestDoctorCapabilities(channelId) {
    return findBundledPackageChannelMetadata(channelId)?.doctorCapabilities;
}
export function getDoctorChannelCapabilities(channelName) {
    if (!channelName) {
        return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
    }
    const manifestCapabilities = getManifestDoctorCapabilities(channelName);
    if (manifestCapabilities) {
        return mergeDoctorChannelCapabilities(manifestCapabilities);
    }
    const channelId = normalizeAnyChannelId(channelName);
    if (!channelId) {
        return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
    }
    const pluginDoctor = getChannelPlugin(channelId)?.doctor ?? getBundledChannelPlugin(channelId)?.doctor;
    if (pluginDoctor) {
        return mergeDoctorChannelCapabilities(pluginDoctor);
    }
    return mergeDoctorChannelCapabilities(getManifestDoctorCapabilities(channelId));
}
