export declare const toPosixPath: (value: string) => string;
export declare function formatLine(label: string, value: string): string;
export declare function writeFormattedLines(stdout: NodeJS.WritableStream, lines: Array<{
    label: string;
    value: string;
}>, opts?: {
    leadingBlankLine?: boolean;
}): void;
