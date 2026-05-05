import {
  readLocalFileSafely as readLocalFileSafelyImpl,
  FsSafeError,
  type FsSafeErrorCode,
} from "@openclaw/fs-safe";

export type FsSafeLikeError = {
  code: FsSafeErrorCode;
  message: string;
};

export const readLocalFileSafely = readLocalFileSafelyImpl;

export function isFsSafeError(error: unknown): error is FsSafeLikeError {
  return error instanceof FsSafeError;
}
