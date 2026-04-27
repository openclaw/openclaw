export type InlineCodeState = {
    open: boolean;
    ticks: number;
};
export declare function createInlineCodeState(): InlineCodeState;
export type CodeSpanIndex = {
    inlineState: InlineCodeState;
    isInside: (index: number) => boolean;
};
export declare function buildCodeSpanIndex(text: string, inlineState?: InlineCodeState): CodeSpanIndex;
