import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import { INCOGNITO_AGENT_SQLITE_BASENAME } from "../state/openclaw-agent-db.paths.js";
import type {
  PreparedSqliteWorkerOpen,
  SqliteWorkerStoreOptions,
  Actor,
} from "./sqlite-worker-broker.types.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import { readDatabasePathIdentity, type DatabasePathIdentity } from "./sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import { tryCreateGatewaySchemaFenceDelegate } from "./state-database-coordinator.js";

export function validateSqliteWorkerDatabaseLocator(databasePath: string): void {
  const basename = path.basename(databasePath);
  if (
    !databasePath ||
    databasePath.startsWith("file:") ||
    basename === ":memory:" ||
    basename === INCOGNITO_AGENT_SQLITE_BASENAME
  ) {
    throw new Error(
      "SQLite worker stores require a file-backed filesystem path; in-memory and incognito databases are not supported",
    );
  }
}

export function captureSqliteWorkerOpen(
  options: SqliteWorkerStoreOptions,
  stateContext?: SqliteWorkerStateContext,
  assertCurrent?: () => void,
): PreparedSqliteWorkerOpen {
  return {
    assertCurrent,
    moduleUrl: new URL(options.moduleUrl),
    databasePath: path.resolve(options.databasePath),
    input: serialize(options.input),
    existingOnly: options.existingOnly === true,
    ...(stateContext
      ? {
          stateContext: {
            environment: { ...stateContext.environment },
            coordinatorRuntime: { ...stateContext.coordinatorRuntime },
          },
        }
      : {}),
  };
}

function validateSqliteWorkerModuleUrl(moduleUrl: URL): void {
  if (moduleUrl.protocol !== "file:" || moduleUrl.search || moduleUrl.hash) {
    throw new Error("SQLite worker backend must be a static local module URL");
  }
}

export async function prepareSqliteWorkerDatabaseAdmission(options: PreparedSqliteWorkerOpen) {
  validateSqliteWorkerModuleUrl(options.moduleUrl);
  const databasePath = path.resolve(options.databasePath);
  const inputHash = createHash("sha256").update(options.input).digest("hex");
  const identity = await readDatabasePathIdentity(databasePath);
  return { databasePath, inputHash, identity };
}

export async function resolveOpenedSqliteWorkerIdentity(
  databasePath: string,
  previous: DatabasePathIdentity,
  isOwnedElsewhere: (key: string) => boolean,
): Promise<string> {
  const openedIdentity = await readDatabasePathIdentity(databasePath);
  const physical = openedIdentity.key;
  if (openedIdentity.canonicalPath !== previous.canonicalPath) {
    throw new Error("SQLite database canonical pathname changed during open");
  }
  if (!physical.startsWith("file:")) {
    throw new Error("SQLite worker backend did not establish its database file");
  }
  if (isOwnedElsewhere(physical)) {
    throw new Error("SQLite database identity collided with an existing worker owner during open");
  }
  if (previous.key.startsWith("file:") && physical !== previous.key) {
    throw new Error("SQLite database file identity changed during open");
  }
  return physical;
}

export function findUnclaimedSharedStateActors(
  actors: Iterable<Actor>,
  databasePath: string,
): Actor[] {
  const pathname = path.resolve(databasePath);
  return [...actors].filter(
    (actor) =>
      actor.stateContext !== undefined &&
      actor.references === 0 &&
      actor.cleanupState === "pending" &&
      actor.databasePath === pathname,
  );
}

export async function resolveSqliteWorkerModuleUrl(sourceUrl: URL) {
  const modulePath = await realpath(fileURLToPath(sourceUrl));
  const moduleUrl = pathToFileURL(modulePath).href;
  if (!/\.[cm]?[jt]s$/.test(modulePath) || !(await stat(modulePath)).isFile()) {
    throw new Error("SQLite worker backend must identify a JavaScript or TypeScript file");
  }
  return { modulePath, moduleUrl };
}

export function prepareSqliteWorkerActorContext(
  actor: Actor | undefined,
  request: SqliteWorkerRequest,
): void {
  const stateContext = request.stateContext ?? actor?.stateContext;
  if (actor && stateContext) {
    if (
      actor.stateContext?.coordinatorRuntime.directory !== stateContext.coordinatorRuntime.directory
    ) {
      throw new Error("Shared-state worker coordinator scope changed; close its actor first");
    }
    request.stateContext = stateContext;
    if (!actor.cleanupState && !actor.gatewaySchemaFence) {
      const delegate = tryCreateGatewaySchemaFenceDelegate({
        databasePath: actor.databasePath,
        runtimeDirectory: stateContext.coordinatorRuntime.directory,
        actorId: String(actor.id),
      });
      if (delegate) {
        actor.gatewaySchemaFence = delegate;
        request.gatewaySchemaFence = delegate.port;
      }
    }
  }
}
