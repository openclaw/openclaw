import { readLocalFileSafely as readLocalFileSafelyImpl, SafeOpenError, } from "../infra/fs-safe.js";
export const readLocalFileSafely = readLocalFileSafelyImpl;
export function isSafeOpenError(error) {
    return error instanceof SafeOpenError;
}
