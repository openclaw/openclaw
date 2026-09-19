import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  PluginStateStoreError,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

type PluginStateWorkerCause =
  | { canonical: OpenClawStateWorkerErrorPayload }
  | {
      name: string;
      message: string;
      code?: string | number;
      errcode?: number;
      cause?: PluginStateWorkerCause;
    };

export type PluginStateWorkerFailure = {
  message: string;
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
  path?: string;
  cause?: PluginStateWorkerCause;
};

// Preserve classification fields and causal messages, not arbitrary error properties or stacks.
function captureCause(
  value: unknown,
  seen = new Set<object>(),
): PluginStateWorkerCause | undefined {
  if (value === undefined) {
    return undefined;
  }
  const canonical = encodeOpenClawStateWorkerError(value);
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
  const cause = "cause" in value ? captureCause(value.cause, seen) : undefined;
  return {
    name,
    message,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof errcode === "number" ? { errcode } : {}),
    ...(cause ? { cause } : {}),
  };
}

const errorConstructors = new Map<string, ErrorConstructor>([
  ["Error", Error],
  ["TypeError", TypeError],
  ["SyntaxError", SyntaxError],
  ["RangeError", RangeError],
  ["ReferenceError", ReferenceError],
  ["URIError", URIError],
  ["EvalError", EvalError],
]);

function restoreCause(value: PluginStateWorkerCause | undefined): Error | undefined {
  if (value && "canonical" in value) {
    const retained = new Error("SQLite worker error cause");
    retainOpenClawStateWorkerErrorPayload(retained, value.canonical);
    return hydrateOpenClawStateWorkerError(retained);
  }
  const Constructor = value ? (errorConstructors.get(value.name) ?? Error) : Error;
  return value
    ? Object.assign(new Constructor(value.message, { cause: restoreCause(value.cause) }), {
        name: value.name,
        ...(value.code === undefined ? {} : { code: value.code }),
        ...(value.errcode === undefined ? {} : { errcode: value.errcode }),
      })
    : undefined;
}

export function capturePluginStateWorkerFailure(
  error: PluginStateStoreError,
): PluginStateWorkerFailure {
  const cause = captureCause(error.cause);
  return {
    message: error.message,
    code: error.code,
    operation: error.operation,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(cause ? { cause } : {}),
  };
}

export function restorePluginStateWorkerFailure(
  error: PluginStateWorkerFailure,
): PluginStateStoreError {
  return new PluginStateStoreError(error.message, {
    code: error.code,
    operation: error.operation,
    ...(error.path === undefined ? {} : { path: error.path }),
    cause: restoreCause(error.cause),
  });
}
