export declare const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 10000;
export declare const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
export declare const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = 10000;
export declare function clampConnectChallengeTimeoutMs(timeoutMs: number): number;
export declare function getConnectChallengeTimeoutMsFromEnv(env?: NodeJS.ProcessEnv): number | undefined;
export declare function resolveConnectChallengeTimeoutMs(timeoutMs?: number | null): number;
export declare function getPreauthHandshakeTimeoutMsFromEnv(env?: NodeJS.ProcessEnv): number;
