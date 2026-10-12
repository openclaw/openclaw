import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSqliteLockError,
  isSqliteNativeOpenFailure,
  markSqliteNativeOpenFailure,
} from "../infra/sqlite-error-diagnostics.js";
import {
  DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME,
  OpenClawQuarantineReadCleanupError,
} from "./openclaw-quarantine-error.js";
import {
  markOpenClawStateDatabaseFailure,
  readOpenClawStateDatabaseFailurePath,
} from "./openclaw-state-db-failure.js";
import {
  createError,
  identifyError,
  parseIdentity,
} from "./openclaw-state-worker-error-identity.js";

type ErrorValue =
  | { ref: number }
  | { value: string | number | boolean | null }
  | { undefined: true };

type ErrorNode = NonNullable<ReturnType<typeof parseNode>>;

/** A closed error graph; references preserve shared causes and cyclic aggregates. */
export type OpenClawStateWorkerErrorPayload = {
  version: 1;
  root: number;
  nodes: ErrorNode[];
};

type ErrorGraphOptions = { includeOrdinary?: boolean };

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isNativeErrorCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fff_ffff;
}

export function encodeOpenClawStateWorkerError(
  error: unknown,
  options: ErrorGraphOptions = {},
): OpenClawStateWorkerErrorPayload | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const nodes: ErrorNode[] = [];
  const errors: Error[] = [];
  const references = new Map<Error, number>();
  let canonical = false;
  const encodeValue = (value: unknown): ErrorValue => {
    if (!(value instanceof Error)) {
      // Arbitrary thrown objects may contain credentials or unrelated runtime state.
      return isScalar(value) ? { value } : { undefined: true };
    }
    const known = references.get(value);
    if (known !== undefined) {
      return { ref: known };
    }
    const ref = errors.length;
    references.set(value, ref);
    errors.push(value);
    return { ref };
  };
  try {
    encodeValue(error);
    for (const current of errors) {
      const identity = identifyError(current);
      const nativeOpen = isSqliteNativeOpenFailure(current);
      const stateDatabasePath = readOpenClawStateDatabaseFailurePath(current);
      const errcode = "errcode" in current ? current.errcode : undefined;
      canonical ||=
        stateDatabasePath !== undefined ||
        nativeOpen ||
        isNativeErrorCode(errcode) ||
        isSqliteLockError(current) ||
        current instanceof OpenClawQuarantineReadCleanupError ||
        (identity.type !== "error" && identity.type !== "aggregate");
      const code = "code" in current ? current.code : undefined;
      const errno = "errno" in current ? current.errno : undefined;
      nodes.push({
        ...identity,
        name: current.name,
        message: current.message,
        ...(typeof code === "string" || (typeof code === "number" && Number.isFinite(code))
          ? { code }
          : {}),
        ...(isNativeErrorCode(errcode) ? { errcode } : {}),
        ...(typeof errno === "number" && Number.isInteger(errno) ? { errno } : {}),
        ...(nativeOpen ? { nativeOpen: true } : {}),
        ...(stateDatabasePath === undefined ? {} : { stateDatabasePath }),
        ...("cause" in current &&
        !(identity.type === "session-transcript-writer-claim-rebound" && identity.refusal)
          ? { cause: encodeValue(current.cause) }
          : {}),
        ...(current instanceof AggregateError ? { errors: current.errors.map(encodeValue) } : {}),
      });
    }
    return canonical || options.includeOrdinary === true
      ? { version: 1, root: 0, nodes }
      : undefined;
  } catch {
    return undefined;
  }
}

function isErrorValue(value: unknown, count: number): value is ErrorValue {
  if (!isRecord(value)) {
    return false;
  }
  if ("ref" in value) {
    return (
      typeof value.ref === "number" &&
      Number.isSafeInteger(value.ref) &&
      value.ref >= 0 &&
      value.ref < count
    );
  }
  return "value" in value ? isScalar(value.value) : value.undefined === true;
}

function parseNode(value: unknown, count: number) {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  const identity = parseIdentity(value);
  if (!identity) {
    return undefined;
  }
  const errors: ErrorValue[] = [];
  if (identity.type === "aggregate") {
    if (!Array.isArray(value.errors)) {
      return undefined;
    }
    for (const entry of value.errors) {
      if (!isErrorValue(entry, count)) {
        return undefined;
      }
      errors.push(entry);
    }
  }
  if (
    (identity.type === "session-transcript-writer-claim-rebound" &&
      identity.refusal !== undefined &&
      "cause" in value) ||
    ("code" in value &&
      typeof value.code !== "string" &&
      !(typeof value.code === "number" && Number.isFinite(value.code))) ||
    ("errcode" in value && !isNativeErrorCode(value.errcode)) ||
    ("errno" in value && (typeof value.errno !== "number" || !Number.isInteger(value.errno))) ||
    ("nativeOpen" in value && value.nativeOpen !== true) ||
    ("stateDatabasePath" in value && typeof value.stateDatabasePath !== "string") ||
    ("cause" in value && !isErrorValue(value.cause, count))
  ) {
    return undefined;
  }
  return {
    ...identity,
    name: value.name,
    message: value.message,
    ...(typeof value.code === "string" || typeof value.code === "number"
      ? { code: value.code }
      : {}),
    ...(isNativeErrorCode(value.errcode) ? { errcode: value.errcode } : {}),
    ...(typeof value.errno === "number" ? { errno: value.errno } : {}),
    ...(value.nativeOpen === true ? { nativeOpen: true as const } : {}),
    ...(typeof value.stateDatabasePath === "string"
      ? { stateDatabasePath: value.stateDatabasePath }
      : {}),
    ...(isErrorValue(value.cause, count) ? { cause: value.cause } : {}),
    ...(identity.type === "aggregate" ? { errors } : {}),
  };
}

function decodeErrorGraph(
  value: unknown,
  options: ErrorGraphOptions,
): { errors: Error[]; root: number } | undefined {
  try {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.nodes) ||
      typeof value.root !== "number" ||
      !Number.isSafeInteger(value.root) ||
      value.root < 0 ||
      value.root >= value.nodes.length
    ) {
      return undefined;
    }
    const nodes: ErrorNode[] = [];
    for (const valueNode of value.nodes) {
      const node = parseNode(valueNode, value.nodes.length);
      if (!node) {
        return undefined;
      }
      nodes.push(node);
    }
    // The encoder selects fields and only emits nodes reachable from its root.
    const canonical = nodes.some(
      (node) =>
        node.stateDatabasePath !== undefined ||
        node.nativeOpen === true ||
        isNativeErrorCode(node.errcode) ||
        isSqliteLockError(node) ||
        (node.type === "aggregate" && node.name === DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME) ||
        (node.type !== "error" && node.type !== "aggregate"),
    );
    if (!canonical && options.includeOrdinary !== true) {
      return undefined;
    }
    const errors = nodes.map(createError);
    const decodeValue = (entry: ErrorValue): unknown =>
      "ref" in entry ? errors[entry.ref] : "value" in entry ? entry.value : undefined;
    for (const [index, node] of nodes.entries()) {
      const error = errors[index]!;
      error.name = node.name;
      error.message = node.message;
      if (node.nativeOpen) {
        markSqliteNativeOpenFailure(error);
      }
      if (node.stateDatabasePath !== undefined) {
        markOpenClawStateDatabaseFailure(error, node.stateDatabasePath);
      }
      for (const [key, propertyValue] of Object.entries({
        ...(node.code !== undefined ? { code: node.code } : {}),
        ...(node.errcode !== undefined ? { errcode: node.errcode } : {}),
        ...(node.errno !== undefined ? { errno: node.errno } : {}),
        ...(node.cause ? { cause: decodeValue(node.cause) } : {}),
      })) {
        Object.defineProperty(error, key, {
          value: propertyValue,
          configurable: true,
          writable: true,
        });
      }
      if (error instanceof AggregateError) {
        error.errors = (node.errors ?? []).map(decodeValue);
      }
    }
    return { errors, root: value.root };
  } catch {
    return undefined;
  }
}

const retainedPayloadKey = Symbol.for("openclaw.sharedStateWorkerErrorPayload");

/** Keep the closed wire graph until the receiving caller hydrates it. */
export function retainOpenClawStateWorkerErrorPayload(error: Error, payload: unknown): void {
  Object.defineProperty(error, retainedPayloadKey, { value: payload });
}

/** Hydrate each caller independently; never rewrite a cached opening rejection. */
export function hydrateOpenClawStateWorkerError(value: Error, options?: ErrorGraphOptions): Error;
export function hydrateOpenClawStateWorkerError(
  value: unknown,
  options?: ErrorGraphOptions,
): unknown;
export function hydrateOpenClawStateWorkerError(
  value: unknown,
  options: ErrorGraphOptions = {},
): unknown {
  if (!(value instanceof Error)) {
    return value;
  }
  const replacements = new Map<Error, Error>();
  const pending = [{ error: value, finish: false }];
  const replace = (child: unknown): unknown =>
    child instanceof Error ? (replacements.get(child) ?? child) : child;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const { error } = entry;
    if (!entry.finish) {
      if (replacements.has(error)) {
        continue;
      }
      // A circular local cause stays on its original object; wire graphs keep their aliases.
      replacements.set(error, error);
      const payload: unknown = Object.getOwnPropertyDescriptor(error, retainedPayloadKey)?.value;
      const graph = payload === undefined ? undefined : decodeErrorGraph(payload, options);
      if (graph) {
        replacements.set(error, graph.errors[graph.root]!);
        continue;
      }
      pending.push({ error, finish: true });
      if (error.cause instanceof Error) {
        pending.push({ error: error.cause, finish: false });
      }
      if (error instanceof AggregateError) {
        for (const child of error.errors) {
          if (child instanceof Error) {
            pending.push({ error: child, finish: false });
          }
        }
      }
      continue;
    }
    const cause = replace(error.cause);
    const originalErrors = error instanceof AggregateError ? error.errors : undefined;
    const errors = originalErrors?.map(replace);
    if (
      cause === error.cause &&
      (!errors || errors.every((child, index) => child === originalErrors?.[index]))
    ) {
      continue;
    }
    const replacement =
      error instanceof AggregateError
        ? new AggregateError([], error.message)
        : new Error(error.message);
    Object.setPrototypeOf(replacement, Object.getPrototypeOf(error));
    const descriptors = Object.getOwnPropertyDescriptors(error);
    Reflect.deleteProperty(descriptors, retainedPayloadKey);
    if ("cause" in error) {
      descriptors.cause = {
        configurable: true,
        writable: true,
        ...descriptors.cause,
        value: cause,
      };
    }
    if (errors) {
      descriptors.errors = {
        configurable: true,
        writable: true,
        ...descriptors.errors,
        value: errors,
      };
    }
    Object.defineProperties(replacement, descriptors);
    replacements.set(error, replacement);
  }
  return replacements.get(value)!;
}
