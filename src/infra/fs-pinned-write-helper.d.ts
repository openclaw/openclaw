import type { Readable } from "node:stream";
import type { FileIdentityStat } from "./file-identity.js";
export type PinnedWriteInput = {
    kind: "buffer";
    data: string | Buffer;
    encoding?: BufferEncoding;
} | {
    kind: "stream";
    stream: Readable;
};
export declare function runPinnedWriteHelper(params: {
    rootPath: string;
    relativeParentPath: string;
    basename: string;
    mkdir: boolean;
    mode: number;
    input: PinnedWriteInput;
}): Promise<FileIdentityStat>;
