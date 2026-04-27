export type CanvasSnapshotPayload = {
    format: string;
    base64: string;
};
export declare function parseCanvasSnapshotPayload(value: unknown): CanvasSnapshotPayload;
export declare function canvasSnapshotTempPath(opts: {
    ext: string;
    tmpDir?: string;
    id?: string;
}): string;
