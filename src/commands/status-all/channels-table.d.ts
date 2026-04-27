type ChannelTableRowInput = {
    id: string;
    label: string;
    enabled: boolean;
    state: "ok" | "warn" | "off" | "setup";
    detail: string;
};
type ChannelIssueLike = {
    channel: string;
    message: string;
};
export declare const statusChannelsTableColumns: readonly [{
    readonly key: "Channel";
    readonly header: "Channel";
    readonly minWidth: 10;
}, {
    readonly key: "Enabled";
    readonly header: "Enabled";
    readonly minWidth: 7;
}, {
    readonly key: "State";
    readonly header: "State";
    readonly minWidth: 8;
}, {
    readonly key: "Detail";
    readonly header: "Detail";
    readonly flex: true;
    readonly minWidth: 24;
}];
export declare function buildStatusChannelsTableRows(params: {
    rows: readonly ChannelTableRowInput[];
    channelIssues: readonly ChannelIssueLike[];
    ok: (text: string) => string;
    warn: (text: string) => string;
    muted: (text: string) => string;
    accentDim: (text: string) => string;
    formatIssueMessage?: (message: string) => string;
}): {
    Channel: string;
    Enabled: string;
    State: string;
    Detail: string;
}[];
export {};
