export declare function groupChannelIssuesByChannel<T extends {
    channel: string;
}>(issues: readonly T[]): Map<string, T[]>;
