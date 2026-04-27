export declare function isSecretRefShape(value: Record<string, unknown>): value is Record<string, unknown> & {
    source: string;
    id: string;
};
export declare function redactSecretRefId(params: {
    value: Record<string, unknown> & {
        source: string;
        id: string;
    };
    values: string[];
    redactedSentinel: string;
    isEnvVarPlaceholder: (value: string) => boolean;
}): Record<string, unknown>;
