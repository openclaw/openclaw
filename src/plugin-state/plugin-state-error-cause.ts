import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";

export type PluginStateErrorCause =
  | { canonical: OpenClawStateWorkerErrorPayload }
  | {
      name: string;
      message: string;
      errorCode?: string | number;
      errcode?: number;
      errno?: number;
      cause?: PluginStateErrorCause;
      errors?: Array<PluginStateErrorCause | undefined>;
    };

// The wire and log share one bounded field policy; only the worker retains canonical identity.
export function capturePluginStateErrorCause(
  value: unknown,
  encodeCanonical?: (value: unknown) => OpenClawStateWorkerErrorPayload | undefined,
  seen = new Set<object>(),
): PluginStateErrorCause | undefined {
  if (value === undefined) {
    return undefined;
  }
  const canonical = encodeCanonical?.(value);
  if (canonical) {
    return { canonical };
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return { name: "Error", message: String(value) };
  }
  if (typeof value !== "object") {
    return { name: "Error", message: "Unknown SQLite error cause" };
  }
  if (seen.has(value) || seen.size >= 8) {
    return { name: "Error", message: "Additional SQLite error cause omitted" };
  }
  seen.add(value);
  const name = "name" in value && typeof value.name === "string" ? value.name : "Error";
  const message = "message" in value && typeof value.message === "string" ? value.message : name;
  const code = "code" in value ? value.code : undefined;
  const errcode = "errcode" in value ? value.errcode : undefined;
  const errno = "errno" in value ? value.errno : undefined;
  return {
    name,
    message,
    // Nested `code` fields are OAuth secrets to the structured log redactor.
    ...(typeof code === "string" || typeof code === "number" ? { errorCode: code } : {}),
    ...(typeof errcode === "number" ? { errcode } : {}),
    ...(typeof errno === "number" ? { errno } : {}),
    ...("cause" in value
      ? { cause: capturePluginStateErrorCause(value.cause, encodeCanonical, seen) }
      : {}),
    ...(value instanceof AggregateError
      ? {
          errors: value.errors
            .slice(0, 8)
            .map((error: unknown) => capturePluginStateErrorCause(error, encodeCanonical, seen)),
        }
      : {}),
  };
}
