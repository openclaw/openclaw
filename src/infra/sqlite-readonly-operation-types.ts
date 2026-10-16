export type SqliteReadOnlyOperationContext = { path: string; env: NodeJS.ProcessEnv };
export type SqliteReadOnlyOperationCommand = { type: string; input: unknown };
export type SqliteReadOnlyOperationResult = { operation: string; value: unknown };
