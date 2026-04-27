export type SoftResetParseResult = {
    matched: false;
} | {
    matched: true;
    tail: string;
};
export declare function parseSoftResetCommand(commandBodyNormalized: string): SoftResetParseResult;
