import {
  readLocalFileSafely as readLocalFileSafelyImpl,
  FsSafeError,
  type FsSafeErrorCode,
} from "../infra/fs-safe.js";

export type FsSafeLikeError = {
  code: FsSafeErrorCode;
  message: string;
};

export const readLocalFileSafely = readLocalFileSafelyImpl;

export function isFsSafeError(error: unknown): error is FsSafeLikeError {
  return error instanceof FsSafeError;
}
