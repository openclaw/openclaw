export declare function wrapNoteMessage(message: string, options?: {
    maxWidth?: number;
    columns?: number;
}): string;
export declare function resolveNoteColumns(columns: number | undefined): number;
export declare function note(message: string, title?: string): void;
