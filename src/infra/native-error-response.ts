import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { NativeErrorResponse } from "./native-error-response-schema.js";

function nativeErrorDetails(error: Error) {
  // SAFETY: Node's filesystem and SQLite errors attach these optional diagnostic fields.
  const nativeError = error as Error & { code?: string; errcode?: number };
  return { message: error.message, code: nativeError.code, errcode: nativeError.errcode };
}

export function serializeNativeErrorResponse(value: unknown): NativeErrorResponse {
  const error = toStringifiedError(value);
  return {
    name: error.name,
    ...nativeErrorDetails(error),
    ...(error.cause instanceof Error ? { cause: nativeErrorDetails(error.cause) } : {}),
  };
}

export function restoreNativeErrorResponse(value: NativeErrorResponse): Error {
  const cause = value.cause
    ? Object.assign(new Error(value.cause.message), value.cause)
    : undefined;
  return Object.assign(new Error(value.message, cause ? { cause } : undefined), {
    name: value.name,
    code: value.code,
    errcode: value.errcode,
  });
}
