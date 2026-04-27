import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DoctorAccountRecord } from "../types.js";
import { shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning } from "./channel-doctor.js";
type CollectEmptyAllowlistPolicyWarningsParams = {
    account: DoctorAccountRecord;
    channelName?: string;
    cfg?: OpenClawConfig;
    doctorFixCommand: string;
    parent?: DoctorAccountRecord;
    prefix: string;
    shouldSkipDefaultEmptyGroupAllowlistWarning?: typeof shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning;
};
export declare function collectEmptyAllowlistPolicyWarningsForAccount(params: CollectEmptyAllowlistPolicyWarningsParams): string[];
export {};
