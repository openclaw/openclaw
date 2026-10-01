import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SqliteNativeRequest,
  SqliteNativeSessionLaunch,
  SqliteNativeTokenReservation,
} from "./sqlite-readonly-native-resource.types.js";
import { readSqliteStagingTokenIdentity } from "./sqlite-staging-token.js";
import { readDatabaseFileIdentity } from "./sqlite-worker-identity.js";

export function readId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("SQLite native resource requires a positive request identity");
  }
  return value;
}
function readPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("SQLite native resource requires a filesystem path");
  }
  return value;
}
function readLaunch(value: unknown): Pick<SqliteNativeSessionLaunch, "env" | "cwd"> {
  if (!isRecord(value) || !isRecord(value.env)) {
    throw new Error("SQLite native resource requires captured launch facts");
  }
  const entries: Array<[string, string | undefined]> = [];
  for (const [key, item] of Object.entries(value.env)) {
    if (
      !key ||
      key.includes("=") ||
      key.includes("\0") ||
      (item !== undefined && (typeof item !== "string" || item.includes("\0")))
    ) {
      throw new Error("SQLite native resource received an invalid environment");
    }
    entries.push([key, item]);
  }
  return { env: Object.fromEntries(entries), cwd: readPath(value.cwd) };
}
function readTokenReservation(value: unknown): SqliteNativeTokenReservation {
  if (!isRecord(value) || (value.mode !== "create" && value.mode !== "reclaim")) {
    throw new Error("SQLite native token requires its original reservation");
  }
  return {
    directory: readPath(value.directory),
    preparationId: readId(value.preparationId),
    mode: value.mode,
    identity: readSqliteStagingTokenIdentity(value.identity),
  };
}
export function readRequest(value: unknown): SqliteNativeRequest {
  if (!isRecord(value)) {
    throw new Error("SQLite native resource requires a command");
  }
  const id = readId(value.id);
  if (value.type === "copy.cancel") {
    return { type: value.type, id };
  }
  if (value.type === "directory.removed") {
    return { type: value.type, id, directory: readPath(value.directory) };
  }
  if (value.type === "token.settle") {
    return {
      type: value.type,
      id,
      session: readId(value.session),
      directory: readPath(value.directory),
      preparationId: readId(value.preparationId),
    };
  }
  if (
    value.type === "session.run" &&
    (value.mode === "token-create" || value.mode === "token-reclaim")
  ) {
    return {
      type: value.type,
      id,
      session: readId(value.session),
      pathname: readPath(value.pathname),
      mode: value.mode,
      preparationId: readId(value.preparationId),
      identity: readSqliteStagingTokenIdentity(value.identity),
    };
  }
  if (value.type === "session.close") {
    return { type: value.type, id, session: readId(value.session) };
  }
  if (
    value.type === "session.run" &&
    (value.mode === "staging-create" ||
      value.mode === "staging-create-legacy" ||
      value.mode === "staging-retire" ||
      value.mode === "staging-reconcile")
  ) {
    return {
      type: value.type,
      id,
      session: readId(value.session),
      pathname: readPath(value.pathname),
      ...(value.mode === "staging-create" || value.mode === "staging-create-legacy"
        ? { mode: value.mode, preparationId: readId(value.preparationId) }
        : { mode: value.mode }),
    };
  }
  if (
    value.type === "session.create" &&
    isRecord(value.launch) &&
    isRecord(value.launch.transport) &&
    value.launch.transport.kind === "native" &&
    (value.launch.retainLifetime === undefined ||
      typeof value.launch.retainLifetime === "boolean") &&
    (value.launch.retainOnOperationError === undefined ||
      typeof value.launch.retainOnOperationError === "boolean")
  ) {
    return {
      type: value.type,
      id,
      session: readId(value.session),
      token: value.token === undefined ? undefined : readTokenReservation(value.token),
      launch: {
        ...readLaunch(value.launch),
        transport: { kind: "native" },
        retainLifetime: value.launch.retainLifetime,
        retainOnOperationError: value.launch.retainOnOperationError,
      },
    };
  }
  if (
    value.type === "copy.run" &&
    (value.mode === "sync" || value.mode === "async") &&
    isRecord(value.launch) &&
    typeof value.launch.deadlineOwnedByCaller === "boolean"
  ) {
    const expectedSourceIdentity =
      value.expectedSourceIdentity === undefined
        ? undefined
        : readDatabaseFileIdentity(value.expectedSourceIdentity);
    if (expectedSourceIdentity && value.mode !== "sync") {
      throw new Error("SQLite source identity requires artifact-preserving preparation");
    }
    return {
      type: value.type,
      id,
      pathname: readPath(value.pathname),
      mode: value.mode,
      stagingRoot: value.stagingRoot === undefined ? undefined : readPath(value.stagingRoot),
      expectedSourceIdentity,
      launch: {
        ...readLaunch(value.launch),
        deadlineOwnedByCaller: value.launch.deadlineOwnedByCaller,
      },
    };
  }
  throw new Error("SQLite native resource received an unsupported command");
}
