import type { ReplyDirectiveParseResult } from "./reply-directives.js";
type ConsumeOptions = {
    final?: boolean;
    silentToken?: string;
};
type SplitTrailingDirectiveOptions = {
    final?: boolean;
};
export declare const splitTrailingDirective: (text: string, options?: SplitTrailingDirectiveOptions) => {
    text: string;
    tail: string;
};
export declare function createStreamingDirectiveAccumulator(): {
    consume: (raw: string, options?: ConsumeOptions) => ReplyDirectiveParseResult | null;
    reset: () => void;
};
export {};
