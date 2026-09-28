import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  capturePluginStateErrorCause,
  type PluginStateErrorCause,
} from "./plugin-state-error-cause.js";
import {
  PluginStateStoreError,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

export type PluginStateWorkerFailure = {
  message: string;
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
  path?: string;
  owner: PluginStateStoreError["owner"];
  cause?: PluginStateErrorCause;
};

const errorConstructors = new Map<string, ErrorConstructor>([
  ["Error", Error],
  ["TypeError", TypeError],
  ["SyntaxError", SyntaxError],
  ["RangeError", RangeError],
  ["ReferenceError", ReferenceError],
  ["URIError", URIError],
  ["EvalError", EvalError],
]);

function restoreCause(value: PluginStateErrorCause | undefined): Error | undefined {
  if (value && "canonical" in value) {
    const retained = new Error("SQLite worker error cause");
    retainOpenClawStateWorkerErrorPayload(retained, value.canonical);
    return hydrateOpenClawStateWorkerError(retained, { includeOrdinary: true });
  }
  const Constructor = value ? (errorConstructors.get(value.name) ?? Error) : Error;
  return value
    ? Object.assign(new Constructor(value.message, { cause: restoreCause(value.cause) }), {
        name: value.name,
        ...(value.errorCode === undefined ? {} : { code: value.errorCode }),
        ...(value.errcode === undefined ? {} : { errcode: value.errcode }),
        ...(value.errno === undefined ? {} : { errno: value.errno }),
      })
    : undefined;
}

export function capturePluginStateWorkerFailure(
  error: PluginStateStoreError,
): PluginStateWorkerFailure {
  const cause = capturePluginStateErrorCause(error.cause, (value) =>
    encodeOpenClawStateWorkerError(value, { includeOrdinary: value instanceof AggregateError }),
  );
  return {
    message: error.message,
    code: error.code,
    operation: error.operation,
    owner: error.owner,
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
    owner: error.owner,
    ...(error.path === undefined ? {} : { path: error.path }),
    cause: restoreCause(error.cause),
  });
}
