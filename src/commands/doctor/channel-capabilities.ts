import type { AllowFromMode } from "./shared/allow-from-mode.js";

export type DoctorGroupModel = "sender" | "route" | "hybrid";

export type DoctorChannelCapabilities = {
  dmAllowFromMode: AllowFromMode;
  groupModel: DoctorGroupModel;
  groupAllowFromFallbackToAllowFrom: boolean;
};

const DEFAULT_DOCTOR_CHANNEL_CAPABILITIES: DoctorChannelCapabilities = {
  dmAllowFromMode: "topOnly",
  groupModel: "sender",
  groupAllowFromFallbackToAllowFrom: true,
};

const DOCTOR_CHANNEL_CAPABILITIES: Record<string, DoctorChannelCapabilities> = {
  discord: {
    dmAllowFromMode: "topOrNested",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
  },
  googlechat: {
    dmAllowFromMode: "nestedOnly",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
  },
  imessage: {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
  },
  irc: {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
  },
  matrix: {
    dmAllowFromMode: "nestedOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
  },
  msteams: {
    dmAllowFromMode: "topOnly",
    groupModel: "hybrid",
    groupAllowFromFallbackToAllowFrom: false,
  },
  slack: {
    dmAllowFromMode: "topOrNested",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
  },
  zalouser: {
    dmAllowFromMode: "topOnly",
    groupModel: "hybrid",
    groupAllowFromFallbackToAllowFrom: false,
  },
};

export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  return DOCTOR_CHANNEL_CAPABILITIES[channelName] ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
}
