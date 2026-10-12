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
  type ErrorIdentity,
} from "./openclaw-state-worker-error-identity.js";

type ErrorValue =
  | { ref: number }
  | { value: string | number | boolean | null }
  | { undefined: true };

type ErrorNode = ErrorIdentity & {
  name: string;
  message: string;
  code?: string | number;
  errcode?: number;
  errno?: number;
  nativeOpen?: true;
  stateDatabasePath?: string;
  cause?: ErrorValue;
  errors?: ErrorValue[];
};

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
      const { name, message } = current;
      if (typeof name !== "string" || typeof message !== "string") {
        return undefined;
      }
      const identity = identifyError(current);
      // Only the typed identity's known nested fields may carry objects. Keep
      // hostile diagnostic values and JSON hooks out of the transport at its source.
      if (
        Object.entries(identity).some(([key, value]) => {
          const fields =
            key === "owner" || key === "blockedByRun" || key === "refusal"
              ? Object.values(value)
              : key === "missingTables" && Array.isArray(value)
                ? value
                : [value];
          return fields.some((field) => field !== undefined && !isScalar(field));
        })
      ) {
        return undefined;
      }
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
        name,
        message,
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

function decodeErrorGraph(
  value: OpenClawStateWorkerErrorPayload,
  options: ErrorGraphOptions,
): { errors: Error[]; root: number } | undefined {
  try {
    if (value.version !== 1) {
      return undefined;
    }
    const nodes = value.nodes;
    if (
      options.includeOrdinary !== true &&
      !nodes.some(
        (node) =>
          node.stateDatabasePath !== undefined ||
          node.nativeOpen === true ||
          isNativeErrorCode(node.errcode) ||
          isSqliteLockError(node) ||
          (node.type === "aggregate" &&
            node.name === DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME) ||
          (node.type !== "error" && node.type !== "aggregate"),
      )
    ) {
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
export function retainOpenClawStateWorkerErrorPayload(
  error: Error,
  payload: OpenClawStateWorkerErrorPayload | undefined,
): void {
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
  type Node = {
    source: Error;
    parents: Set<Node>;
    changed: boolean;
    opaque: boolean;
    replacement: Error;
    cause?: { value: unknown };
    errors?: unknown[];
  };
  const nodes = new Map<Error, Node>();
  const queue: Node[] = [];
  const add = (error: Error): Node => {
    const previous = nodes.get(error);
    if (previous) {
      return previous;
    }
    const node: Node = {
      source: error,
      replacement: error,
      parents: new Set(),
      changed: false,
      opaque: false,
    };
    nodes.set(error, node);
    queue.push(node);
    // The typed writer owns this property; the symbol crosses duplicated runtime chunks.
    const payload: OpenClawStateWorkerErrorPayload | undefined = Object.getOwnPropertyDescriptor(
      error,
      retainedPayloadKey,
    )?.value;
    const graph = payload === undefined ? undefined : decodeErrorGraph(payload, options);
    if (graph) {
      node.replacement = graph.errors[graph.root]!;
      node.opaque = true;
      node.changed = true;
    }
    return node;
  };
  const root = add(value);
  for (const node of queue) {
    if (node.opaque) {
      continue;
    }
    const edge = (child: unknown) => {
      if (child instanceof Error) {
        add(child).parents.add(node);
      }
    };
    if ("cause" in node.source) {
      node.cause = { value: node.source.cause };
      edge(node.cause.value);
    }
    if (node.source instanceof AggregateError) {
      node.errors = [...node.source.errors];
      node.errors.forEach(edge);
    }
  }
  const affected = queue.filter((node) => node.changed);
  for (const node of affected) {
    for (const parent of node.parents) {
      if (!parent.changed) {
        parent.changed = true;
        affected.push(parent);
      }
    }
  }
  if (!root.changed) {
    return value;
  }
  for (const node of affected) {
    if (node.replacement === node.source) {
      node.replacement =
        node.source instanceof AggregateError
          ? new AggregateError([], node.source.message)
          : new Error(node.source.message);
      Object.setPrototypeOf(node.replacement, Object.getPrototypeOf(node.source));
    }
  }
  const replace = (child: unknown): unknown => {
    const node = child instanceof Error ? nodes.get(child) : undefined;
    return node?.changed ? node.replacement : child;
  };
  for (const node of affected) {
    if (node.opaque) {
      continue;
    }
    const descriptors = Object.getOwnPropertyDescriptors(node.source);
    Reflect.deleteProperty(descriptors, retainedPayloadKey);
    if (node.cause) {
      descriptors.cause = {
        configurable: descriptors.cause?.configurable ?? true,
        enumerable: descriptors.cause?.enumerable ?? false,
        writable: descriptors.cause?.writable ?? true,
        value: replace(node.cause.value),
      };
    }
    if (node.errors) {
      descriptors.errors = {
        configurable: descriptors.errors?.configurable ?? true,
        enumerable: descriptors.errors?.enumerable ?? false,
        writable: descriptors.errors?.writable ?? true,
        value: node.errors.map(replace),
      };
    }
    Object.defineProperties(node.replacement, descriptors);
  }
  return root.replacement;
}
