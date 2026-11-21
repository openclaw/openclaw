/** Identity facts issued only while Doctor relocates an enrolled shared credential store. */
import path from "node:path";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAuthProfileAuthorizationLifetimes } from "../agents/auth-profiles/authorization-lifetime.js";
import { prepareSharedAuthStoreOwnershipForNative as resolveSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.native.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  inspectSharedAuthLegacySourceFile,
  readSharedAuthLegacyRowsFromDatabase,
  SharedAuthStoreSourceInspectionError,
  type SharedAuthLegacyRows as AuthRows,
  type SharedAuthLegacyStoreRow,
} from "../agents/auth-profiles/shared-store-bootstrap.js";
import { AUTH_PROFILE_PRIMARY_ROW_KEY } from "../agents/auth-profiles/sqlite-json.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabaseOwnerId,
} from "../agents/auth-profiles/sqlite.js";
import type { SharedAuthStoreOwnership } from "../agents/auth-profiles/types.js";
import { resolveStateDir } from "../config/paths.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export function prepareRelocatedSharedAuthOwnership(
  current: SharedAuthStoreOwnership,
  sourcePath: string,
  store: SharedAuthLegacyStoreRow | null,
  env: NodeJS.ProcessEnv,
): SharedAuthStoreOwnership {
  // Do not retrofit an origin onto stores whose existing bindings use central paths.
  if (current.location === "state-db") {
    return current;
  }
  const ownership: SharedAuthStoreOwnership = { location: "state-db" };
  const raw = store && safeParseJsonRecord(store.store_json);
  const source = resolvePathViaExistingAncestorSync(sourcePath);
  if (
    Object.keys(readAuthProfileAuthorizationLifetimes(raw)).length > 0 &&
    source ===
      resolvePathViaExistingAncestorSync(
        path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite"),
      )
  ) {
    const relative = path.relative(
      resolvePathViaExistingAncestorSync(resolveStateDir(env)),
      source,
    );
    // Relative origins follow the private copy during a copy-and-swap upgrade.
    ownership.authorizationOrigin =
      relative.startsWith("..") || path.isAbsolute(relative) ? source : relative;
  }
  return ownership;
}

export function isRelocatedSharedAuthSource(
  ownership: SharedAuthStoreOwnership,
  sourcePath: string,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    ownership.location === "state-db" &&
    ownership.authorizationOrigin !== undefined &&
    resolvePathViaExistingAncestorSync(
      path.resolve(resolveStateDir(env), ownership.authorizationOrigin),
    ) === resolvePathViaExistingAncestorSync(sourcePath)
  );
}

function retainedSharedAuthSourceAuthorization(
  store: SharedAuthLegacyStoreRow | null,
): string | undefined {
  const raw = store && safeParseJsonRecord(store.store_json);
  const lifetimes = readAuthProfileAuthorizationLifetimes(raw);
  if (!raw || !Object.keys(lifetimes).length) {
    return undefined;
  }
  // Keep only credential-free replacement/absence fences in the former shared owner.
  return JSON.stringify({ version: raw.version, profiles: {}, authorizationLifetimes: lifetimes });
}

type SourceAuthDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
export function rowsHaveCredentials({ store }: AuthRows): boolean {
  if (!store) {
    return false;
  }
  const profiles = safeParseJsonRecord(store.store_json)?.profiles;
  // Malformed rows may still contain the only credential; never discard them as empty.
  return !isRecord(profiles) || Object.keys(profiles).length > 0;
}

export async function cleanupSharedAuthSource(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  ownerId?: string;
  integrityCheck?: "quick" | "full";
}): Promise<boolean> {
  if (inspectSharedAuthLegacySourceFile(params.sourcePath).status === "missing") {
    return false;
  }
  try {
    const ownership = resolveSharedAuthStoreOwnership(params.env);
    const preserveAuthorization = isRelocatedSharedAuthSource(
      ownership,
      params.sourcePath,
      params.env,
    );
    const removed = runOpenClawAgentWriteTransaction(
      ({ db: database }) => {
        const db = getNodeSqliteKysely<SourceAuthDatabase>(database);
        const before = readSharedAuthLegacyRowsFromDatabase(database);
        const retained = preserveAuthorization
          ? retainedSharedAuthSourceAuthorization(before.store)
          : undefined;
        if (retained) {
          executeSqliteQuerySync(
            database,
            db
              .updateTable("auth_profile_store")
              .set({ store_json: retained })
              .where("store_key", "=", AUTH_PROFILE_PRIMARY_ROW_KEY),
          );
        } else {
          executeSqliteQuerySync(
            database,
            db
              .deleteFrom("auth_profile_store")
              .where("store_key", "=", AUTH_PROFILE_PRIMARY_ROW_KEY),
          );
        }
        executeSqliteQuerySync(
          database,
          db.deleteFrom("auth_profile_state").where("state_key", "=", AUTH_PROFILE_PRIMARY_ROW_KEY),
        );
        return rowsHaveCredentials(before) || before.state !== null;
      },
      {
        agentId:
          params.ownerId ?? resolveAuthProfileDatabaseOwnerId(path.dirname(params.sourcePath)),
        path: params.sourcePath,
        env: params.env,
      },
      {
        operationLabel: "state-migration.shared-auth-cleanup",
        repairAdmission: {
          integrityCheck: params.integrityCheck ?? "quick",
          integrityTables: ["auth_profile_store", "auth_profile_state"],
        },
      },
    );
    closeAuthProfileReadPool({ kind: "database", databasePath: params.sourcePath });
    await closeOpenClawAgentDatabaseByPathAsync(params.sourcePath);
    return removed;
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(params.sourcePath, "clean", error);
  }
}
