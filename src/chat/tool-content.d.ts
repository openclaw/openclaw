export type ToolContentBlock = Record<string, unknown>;
export declare function normalizeToolContentType(value: unknown): string;
export declare function isToolCallContentType(value: unknown): boolean;
export declare function isToolResultContentType(value: unknown): boolean;
export declare function isToolCallBlock(block: ToolContentBlock): boolean;
export declare function isToolResultBlock(block: ToolContentBlock): boolean;
export declare function resolveToolBlockArgs(block: ToolContentBlock): unknown;
export declare function resolveToolUseId(block: ToolContentBlock): string | undefined;
