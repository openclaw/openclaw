import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { AllowFromMode } from "./shared/allow-from-mode.js";

export type DoctorGroupModel = "sender" | "route" | "hybrid";

export type DoctorChannelCapabilities = {
  dmAllowFromMode: AllowFromMode;
  groupModel: DoctorGroupModel;
  groupAllowFromFallbackToAllowFrom: boolean;
  warnOnEmptyGroupSenderAllowlist: boolean;
};

const DEFAULT_DOCTOR_CHANNEL_CAPABILITIES: DoctorChannelCapabilities = {
  dmAllowFromMode: "topOnly",
  groupModel: "sender",
  groupAllowFromFallbackToAllowFrom: true,
  warnOnEmptyGroupSenderAllowlist: true,
};

export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  const pluginDoctor =
    getChannelPlugin(channelName)?.doctor ?? getBundledChannelPlugin(channelName)?.doctor;
  if (pluginDoctor) {
    return {
      dmAllowFromMode:
        pluginDoctor.dmAllowFromMode ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.dmAllowFromMode,
      groupModel: pluginDoctor.groupModel ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupModel,
      groupAllowFromFallbackToAllowFrom:
        pluginDoctor.groupAllowFromFallbackToAllowFrom ??
        DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupAllowFromFallbackToAllowFrom,
      warnOnEmptyGroupSenderAllowlist:
        pluginDoctor.warnOnEmptyGroupSenderAllowlist ??
        DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.warnOnEmptyGroupSenderAllowlist,
    };
  }
  return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
}
