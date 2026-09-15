import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "./openclaw-state-ownership.js";

type MaintenanceKind = ConstructorParameters<typeof StartupMaintenanceRequiredError>[0];
type StateMigrationKind = ConstructorParameters<
  typeof OpenClawStateDatabaseSchemaMigrationRequiredError
>[0];
type CoordinatorFamily = ConstructorParameters<typeof StateDatabaseCoordinatorContentionError>[0];

type ErrorValue =
  | { ref: number }
  | { value: string | number | boolean | null }
  | { undefined: true };

type ErrorIdentity =
  | { type: "error" | "aggregate" | "ownership" | "newer-schema" | "coordinator" }
  | { type: "coordinator-contention"; family: CoordinatorFamily }
  | { type: "ownership-metadata"; databasePath: string }
  | { type: "external-ownership"; databasePath: string; managerId: string }
  | { type: "maintenance"; kind: MaintenanceKind }
  | { type: "state-migration"; kind: StateMigrationKind; pathname: string }
  | { type: "agent-media-migration"; pathname: string; schemaVersion: number };

type ErrorNode = ErrorIdentity & {
  name: string;
  message: string;
  code?: string | number;
  errcode?: number;
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

function identifyError(error: Error): ErrorIdentity {
  if (error instanceof StateDatabaseCoordinatorContentionError) {
    return { type: "coordinator-contention", family: error.family };
  }
  if (error instanceof SqliteCoordinatorError) {
    return { type: "coordinator" };
  }
  if (error instanceof OpenClawStateOwnershipMetadataError) {
    return { type: "ownership-metadata", databasePath: error.databasePath };
  }
  if (error instanceof OpenClawStateExternalOwnershipError) {
    return {
      type: "external-ownership",
      databasePath: error.databasePath,
      managerId: error.managerId,
    };
  }
  if (error instanceof OpenClawStateOwnershipError) {
    return { type: "ownership" };
  }
  if (error instanceof SqliteSchemaVersionError) {
    return { type: "newer-schema" };
  }
  if (error instanceof OpenClawStateDatabaseSchemaMigrationRequiredError) {
    return { type: "state-migration", kind: error.kind, pathname: error.pathname };
  }
  if (error instanceof OpenClawAgentDatabaseMediaMigrationRequiredError) {
    return {
      type: "agent-media-migration",
      pathname: error.pathname,
      schemaVersion: error.schemaVersion,
    };
  }
  if (error instanceof StartupMaintenanceRequiredError) {
    return { type: "maintenance", kind: error.kind };
  }
  return { type: error instanceof AggregateError ? "aggregate" : "error" };
}

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
      canonical ||= identity.type !== "error" && identity.type !== "aggregate";
      const code = "code" in current ? current.code : undefined;
      const errcode = "errcode" in current ? current.errcode : undefined;
      nodes.push({
        ...identity,
        name: current.name,
        message: current.message,
        ...(typeof code === "string" || (typeof code === "number" && Number.isFinite(code))
          ? { code }
          : {}),
        ...(isNativeErrorCode(errcode) ? { errcode } : {}),
        ...("cause" in current ? { cause: encodeValue(current.cause) } : {}),
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

function isMaintenanceKind(kind: unknown): kind is MaintenanceKind {
  return (
    kind === "newer-schema" ||
    kind === "agent-media" ||
    kind === "agent-databases-composite-primary-key" ||
    kind === "audit-events-v2" ||
    kind === "legacy-workshop-review-index" ||
    kind === "legacy-workspace" ||
    kind === "legacy-session-store"
  );
}

function parseIdentity(node: Record<string, unknown>): ErrorIdentity | undefined {
  switch (node.type) {
    case "error":
    case "aggregate":
    case "ownership":
    case "newer-schema":
    case "coordinator":
      return { type: node.type };
    case "coordinator-contention":
      return node.family === "gateway-lifecycle" ||
        node.family === "state-lifecycle" ||
        node.family === "state-handles"
        ? { type: node.type, family: node.family }
        : undefined;
    case "ownership-metadata":
      return typeof node.databasePath === "string"
        ? { type: node.type, databasePath: node.databasePath }
        : undefined;
    case "external-ownership":
      return typeof node.databasePath === "string" && typeof node.managerId === "string"
        ? { type: node.type, databasePath: node.databasePath, managerId: node.managerId }
        : undefined;
    case "maintenance":
      return isMaintenanceKind(node.kind) ? { type: node.type, kind: node.kind } : undefined;
    case "state-migration":
      return (node.kind === "agent-databases-composite-primary-key" ||
        node.kind === "audit-events-v2" ||
        node.kind === "legacy-workshop-review-index") &&
        typeof node.pathname === "string"
        ? { type: node.type, kind: node.kind, pathname: node.pathname }
        : undefined;
    case "agent-media-migration":
      return typeof node.pathname === "string" &&
        typeof node.schemaVersion === "number" &&
        Number.isSafeInteger(node.schemaVersion) &&
        node.schemaVersion >= 0
        ? { type: node.type, pathname: node.pathname, schemaVersion: node.schemaVersion }
        : undefined;
    default:
      return undefined;
  }
}

function isErrorValue(value: unknown, count: number): value is ErrorValue {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
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

function parseNode(value: unknown, count: number): ErrorNode | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  const identity = parseIdentity(value);
  if (!identity) {
    return undefined;
  }
  const allowed = new Set([
    ...Object.keys(identity),
    "name",
    "message",
    "code",
    "errcode",
    "cause",
  ]);
  const errors: ErrorValue[] = [];
  if (identity.type === "aggregate") {
    allowed.add("errors");
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
    Object.keys(value).some((key) => !allowed.has(key)) ||
    ("code" in value &&
      typeof value.code !== "string" &&
      !(typeof value.code === "number" && Number.isFinite(value.code))) ||
    ("errcode" in value && !isNativeErrorCode(value.errcode)) ||
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
    ...(isErrorValue(value.cause, count) ? { cause: value.cause } : {}),
    ...(identity.type === "aggregate" ? { errors } : {}),
  };
}

function unreachableErrorNode(node: never): never {
  throw new Error(`Unexpected shared-state worker error node: ${String(node)}`);
}

function createError(node: ErrorNode): Error {
  switch (node.type) {
    case "error":
      return new Error(node.message);
    case "aggregate":
      return new AggregateError([], node.message);
    case "coordinator":
      return new SqliteCoordinatorError(node.message);
    case "coordinator-contention":
      return new StateDatabaseCoordinatorContentionError(node.family);
    case "ownership":
      return new OpenClawStateOwnershipError(node.message);
    case "ownership-metadata":
      return new OpenClawStateOwnershipMetadataError(node.databasePath, "");
    case "external-ownership":
      return new OpenClawStateExternalOwnershipError(node.databasePath, node.managerId);
    case "newer-schema":
      return new SqliteSchemaVersionError(node.message);
    case "maintenance":
      return new StartupMaintenanceRequiredError(node.kind, node.message);
    case "state-migration":
      return new OpenClawStateDatabaseSchemaMigrationRequiredError(node.kind, node.pathname);
    case "agent-media-migration":
      return new OpenClawAgentDatabaseMediaMigrationRequiredError(
        node.pathname,
        node.schemaVersion,
      );
  }
  return unreachableErrorNode(node);
}

function decodeErrorGraph(
  value: unknown,
  options: ErrorGraphOptions,
): { errors: Error[]; nodes: ErrorNode[]; root: number } | undefined {
  try {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !["version", "root", "nodes"].includes(key)) ||
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
    const visited = new Set<number>();
    const pending = [value.root];
    let canonical = false;
    for (const ref of pending) {
      if (visited.has(ref)) {
        continue;
      }
      visited.add(ref);
      const node = nodes[ref]!;
      canonical ||= node.type !== "error" && node.type !== "aggregate";
      for (const edge of [...(node.cause ? [node.cause] : []), ...(node.errors ?? [])]) {
        if ("ref" in edge) {
          pending.push(edge.ref);
        }
      }
    }
    if ((!canonical && options.includeOrdinary !== true) || visited.size !== nodes.length) {
      return undefined;
    }
    const errors = nodes.map(createError);
    const decodeValue = (entry: ErrorValue): unknown =>
      "ref" in entry ? errors[entry.ref] : "value" in entry ? entry.value : undefined;
    for (const [index, node] of nodes.entries()) {
      const error = errors[index]!;
      error.name = node.name;
      error.message = node.message;
      if (node.code !== undefined) {
        Object.defineProperty(error, "code", {
          value: node.code,
          configurable: true,
          writable: true,
        });
      }
      if (node.errcode !== undefined) {
        Object.defineProperty(error, "errcode", {
          value: node.errcode,
          configurable: true,
          writable: true,
        });
      }
      if (node.cause) {
        Object.defineProperty(error, "cause", {
          value: decodeValue(node.cause),
          configurable: true,
          writable: true,
        });
      }
      if (error instanceof AggregateError) {
        error.errors = (node.errors ?? []).map(decodeValue);
      }
    }
    const group = Object.freeze({});
    for (const [index, error] of errors.entries()) {
      retainPayload(error, value, index, true, group);
    }
    return { errors, nodes, root: value.root };
  } catch {
    return undefined;
  }
}

const retainedPayloadKey = Symbol.for("openclaw.sharedStateWorkerErrorPayload");

function retainPayload(
  error: Error,
  payload: unknown,
  node: number,
  materialized: boolean,
  group: object,
): void {
  Object.defineProperty(error, retainedPayloadKey, {
    value: Object.freeze({ payload, node, materialized, group }),
  });
}

/** Keep the closed wire graph without binding it to a process-global broker's classes. */
export function retainOpenClawStateWorkerErrorPayload(error: Error, payload: unknown): void {
  retainPayload(error, payload, 0, false, Object.freeze({}));
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
  const groups = new Map<unknown, ReturnType<typeof decodeErrorGraph>>();
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
    const retained: unknown = Object.getOwnPropertyDescriptor(error, retainedPayloadKey)?.value;
    if (
      isRecord(retained) &&
      typeof retained.node === "number" &&
      Number.isSafeInteger(retained.node) &&
      retained.node >= 0 &&
      typeof retained.materialized === "boolean" &&
      isRecord(retained.group)
    ) {
      if (!groups.has(retained.group)) {
        groups.set(retained.group, decodeErrorGraph(retained.payload, options));
      }
      const graph = groups.get(retained.group);
      const index = retained.materialized ? retained.node : graph?.root;
      const replacement = index === undefined ? undefined : graph?.errors[index];
      const identity = index === undefined ? undefined : graph?.nodes[index];
      if (replacement && identity) {
        node.replacement = replacement;
        node.opaque = !retained.materialized;
        node.changed = node.opaque || identifyError(error).type !== identity.type;
      }
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
