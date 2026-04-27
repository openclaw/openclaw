export declare function resolveMessageSecretScope(params: {
    channel?: unknown;
    target?: unknown;
    targets?: unknown;
    fallbackChannel?: string | null;
    accountId?: unknown;
    fallbackAccountId?: string | null;
}): {
    channel?: string;
    accountId?: string;
};
