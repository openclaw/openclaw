import "../infra/fs-safe-defaults.js";
import { FsSafeError, type FsSafeErrorCode } from "@openclaw/fs-safe";
import { readLocalFileSafely as readLocalFileSafelyImpl } from "@openclaw/fs-safe/root";

export type FsSafeLikeError = {
  code: FsSafeErrorCode;
  message: string;
};

export const readLocalFileSafely = readLocalFileSafelyImpl;

export function isFsSafeError(error: unknown): error is FsSafeLikeError {
  return error instanceof FsSafeError;
}
