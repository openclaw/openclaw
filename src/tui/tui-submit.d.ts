export declare function createEditorSubmitHandler(params: {
    editor: {
        setText: (value: string) => void;
        addToHistory: (value: string) => void;
    };
    handleCommand: (value: string) => Promise<void> | void;
    sendMessage: (value: string) => Promise<void> | void;
    handleBangLine: (value: string) => Promise<void> | void;
}): (text: string) => void;
export declare function shouldEnableWindowsGitBashPasteFallback(params?: {
    platform?: string;
    env?: NodeJS.ProcessEnv;
}): boolean;
export declare function createSubmitBurstCoalescer(params: {
    submit: (value: string) => void;
    enabled: boolean;
    burstWindowMs?: number;
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}): (value: string) => void;
