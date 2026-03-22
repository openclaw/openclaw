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

const DOCTOR_CHANNEL_CAPABILITIES: Record<string, DoctorChannelCapabilities> = {
  discord: {
    dmAllowFromMode: "topOrNested",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false,
  },
  googlechat: {
    dmAllowFromMode: "nestedOnly",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false,
  },
  imessage: {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: true,
  },
  irc: {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: true,
  },
  matrix: {
    dmAllowFromMode: "nestedOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: true,
  },
  msteams: {
    dmAllowFromMode: "topOnly",
    groupModel: "hybrid",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: true,
  },
  slack: {
    dmAllowFromMode: "topOrNested",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false,
  },
  zalouser: {
    dmAllowFromMode: "topOnly",
    groupModel: "hybrid",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false,
  },
};

export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  return DOCTOR_CHANNEL_CAPABILITIES[channelName] ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
}
