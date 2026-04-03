import {
  readLocalFileSafely as readLocalFileSafelyImpl,
  SafeOpenError,
  type SafeOpenErrorCode,
} from "../infra/fs-safe.js";

export type SafeOpenLikeError = {
  code: SafeOpenErrorCode;
  message: string;
};

export const readLocalFileSafely = readLocalFileSafelyImpl;

export function isSafeOpenError(error: unknown): error is SafeOpenLikeError {
  return error instanceof SafeOpenError;
}
