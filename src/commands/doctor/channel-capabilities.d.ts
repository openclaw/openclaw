import type { AllowFromMode } from "./shared/allow-from-mode.types.js";
export type DoctorGroupModel = "sender" | "route" | "hybrid";
export type DoctorChannelCapabilities = {
    dmAllowFromMode: AllowFromMode;
    groupModel: DoctorGroupModel;
    groupAllowFromFallbackToAllowFrom: boolean;
    warnOnEmptyGroupSenderAllowlist: boolean;
};
export declare function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities;
