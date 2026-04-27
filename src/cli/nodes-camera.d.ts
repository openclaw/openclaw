export type CameraFacing = "front" | "back";
export type CameraSnapPayload = {
    format: string;
    base64?: string;
    url?: string;
    width: number;
    height: number;
};
export type CameraClipPayload = {
    format: string;
    base64?: string;
    url?: string;
    durationMs: number;
    hasAudio: boolean;
};
export declare function parseCameraSnapPayload(value: unknown): CameraSnapPayload;
export declare function parseCameraClipPayload(value: unknown): CameraClipPayload;
export declare function cameraTempPath(opts: {
    kind: "snap" | "clip";
    facing?: CameraFacing;
    ext: string;
    tmpDir?: string;
    id?: string;
}): string;
export declare function writeUrlToFile(filePath: string, url: string, opts: {
    expectedHost: string;
}): Promise<{
    path: string;
    bytes: number;
}>;
export declare function writeBase64ToFile(filePath: string, base64: string): Promise<{
    path: string;
    bytes: number;
}>;
export declare function requireNodeRemoteIp(remoteIp?: string): string;
export declare function writeCameraPayloadToFile(params: {
    filePath: string;
    payload: {
        url?: string;
        base64?: string;
    };
    expectedHost?: string;
    invalidPayloadMessage?: string;
}): Promise<void>;
export declare function writeCameraClipPayloadToFile(params: {
    payload: CameraClipPayload;
    facing: CameraFacing;
    tmpDir?: string;
    id?: string;
    expectedHost?: string;
}): Promise<string>;
