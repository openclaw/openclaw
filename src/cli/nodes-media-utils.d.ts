import { readStringValue } from "../shared/string-coerce.js";
export { asRecord } from "../shared/record-coerce.js";
export declare const asString: typeof readStringValue;
export declare function asNumber(value: unknown): number | undefined;
export declare function asBoolean(value: unknown): boolean | undefined;
export declare function resolveTempPathParts(opts: {
    ext: string;
    tmpDir?: string;
    id?: string;
}): {
    ext: string;
    tmpDir: string;
    id: string;
};
