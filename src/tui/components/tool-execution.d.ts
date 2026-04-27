import { Container } from "@mariozechner/pi-tui";
type ToolResultContent = {
    type?: string;
    text?: string;
    mimeType?: string;
    bytes?: number;
    omitted?: boolean;
};
type ToolResult = {
    content?: ToolResultContent[];
    details?: Record<string, unknown>;
};
export declare class ToolExecutionComponent extends Container {
    private box;
    private header;
    private argsLine;
    private output;
    private toolName;
    private args;
    private result?;
    private expanded;
    private isError;
    private isPartial;
    constructor(toolName: string, args: unknown);
    setArgs(args: unknown): void;
    setExpanded(expanded: boolean): void;
    setResult(result: ToolResult | undefined, opts?: {
        isError?: boolean;
    }): void;
    setPartialResult(result: ToolResult | undefined): void;
    private refresh;
}
export {};
