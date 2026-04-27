import { readLocalFileSafely as readLocalFileSafelyImpl, type SafeOpenErrorCode } from "../infra/fs-safe.js";
export type SafeOpenLikeError = {
    code: SafeOpenErrorCode;
    message: string;
};
export declare const readLocalFileSafely: typeof readLocalFileSafelyImpl;
export declare function isSafeOpenError(error: unknown): error is SafeOpenLikeError;
