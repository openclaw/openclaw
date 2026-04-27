export declare function isHeartbeatUserMessage(message: {
    role: string;
    content?: unknown;
}, heartbeatPrompt?: string): boolean;
export declare function isHeartbeatOkResponse(message: {
    role: string;
    content?: unknown;
}, ackMaxChars?: number): boolean;
export declare function filterHeartbeatPairs<T extends {
    role: string;
    content?: unknown;
}>(messages: T[], ackMaxChars?: number, heartbeatPrompt?: string): T[];
