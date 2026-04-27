import { type OpenClawConfig } from "../config/config.js";
export type ExecApprovalInitiatingSurfaceState = {
    kind: "enabled";
    channel: string | undefined;
    channelLabel: string;
    accountId?: string;
} | {
    kind: "disabled";
    channel: string;
    channelLabel: string;
    accountId?: string;
} | {
    kind: "unsupported";
    channel: string;
    channelLabel: string;
    accountId?: string;
};
export declare function resolveExecApprovalInitiatingSurfaceState(params: {
    channel?: string | null;
    accountId?: string | null;
    cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState;
export declare function supportsNativeExecApprovalClient(channel?: string | null): boolean;
export declare function listNativeExecApprovalClientLabels(params?: {
    excludeChannel?: string | null;
}): string[];
export declare function describeNativeExecApprovalClientSetup(params: {
    channel?: string | null;
    channelLabel?: string | null;
    accountId?: string | null;
}): string | null;
