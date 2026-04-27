type CloseTrackedBrowserTabsParams = {
    sessionKeys: Array<string | undefined>;
    closeTab?: (tab: {
        targetId: string;
        baseUrl?: string;
        profile?: string;
    }) => Promise<void>;
    onWarn?: (message: string) => void;
};
export declare function closeTrackedBrowserTabsForSessions(params: CloseTrackedBrowserTabsParams): Promise<number>;
export declare function movePathToTrash(targetPath: string): Promise<string>;
export {};
