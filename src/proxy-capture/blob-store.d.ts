import type { CaptureBlobRecord } from "./types.js";
export declare function writeCaptureBlob(params: {
    blobDir: string;
    data: Buffer;
    contentType?: string;
}): CaptureBlobRecord;
export declare function readCaptureBlobText(blobPath: string): string;
