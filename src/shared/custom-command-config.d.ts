export type CustomCommandInput = {
    command?: string | null;
    description?: string | null;
};
export type CustomCommandIssue = {
    index: number;
    field: "command" | "description";
    message: string;
};
export type CustomCommandConfig = {
    label: string;
    pattern: RegExp;
    patternDescription: string;
    prefix?: string;
};
export declare function normalizeSlashCommandName(value: string): string;
export declare function normalizeCommandDescription(value: string): string;
export declare function resolveCustomCommands(params: {
    commands?: CustomCommandInput[] | null;
    reservedCommands?: Set<string>;
    checkReserved?: boolean;
    checkDuplicates?: boolean;
    config: CustomCommandConfig;
}): {
    commands: Array<{
        command: string;
        description: string;
    }>;
    issues: CustomCommandIssue[];
};
