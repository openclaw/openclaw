export type SessionTranscriptUpdate = {
    sessionFile: string;
    sessionKey?: string;
    message?: unknown;
    messageId?: string;
};
type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;
export declare function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void;
export declare function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void;
export {};
