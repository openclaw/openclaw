import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { listAgentIds } from "../agents/agent-roster.js";
import {
  claimFullyCopied,
  claimsMatch,
  readClaim,
} from "../config/sessions/legacy-main-session-migration-claims.js";
import { restoreColdSessionClaims } from "../config/sessions/legacy-main-session-migration-restore.js";
import type {
  PhysicalStore,
  SessionClaim,
} from "../config/sessions/legacy-main-session-migration.contract.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { copySessionClaimForRepair } from "../config/sessions/session-claim-repair-copy.js";
import { listSessionMembersInDatabase } from "../config/sessions/session-sharing-store.kernel.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { hasOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import {
  isUpdateRehearsalReadOnlyPath,
  resolveUpdateRehearsalRoot,
} from "../infra/update-rehearsal-paths.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  listOpenClawRegisteredAgentDatabases,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db.paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { backupDoctorSqliteDatabases } from "./doctor-migration-backup.js";
import { resolveRelativeSessionStoreMigrationTargets } from "./doctor-relative-session-store-paths.js";
import { readRelativeStorePreservationState } from "./doctor-relative-session-store-preservation.js";

type StoreMove = {
  source: PhysicalStore;
  destination: PhysicalStore;
  aliases: string[];
  legacyStorePath: string;
};

function refuse(message: string): never {
  throw new DoctorMaintenanceRefusalError(
    `Cannot merge the old relative session.store: ${message}. Original stores and existing backups are retained. Resolve the reported conflict before retrying Doctor or the update.`,
    { kind: "data-at-risk", reason: "incomplete-migration" },
  );
}

function discoverStoreMoves(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  priorRegistry: readonly { agentId: string; path: string }[],
): StoreMove[] {
  const store = cfg.session?.store;
  if (!store || store.startsWith("~") || path.isAbsolute(store)) {
    return [];
  }
  const registered = [
    ...new Map(
      [
        ...priorRegistry,
        ...listOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true }),
      ].map((row) => [`${row.agentId}\n${row.path}`, row]),
    ).values(),
  ];
  const legacyTargets = resolveRelativeSessionStoreMigrationTargets(cfg, env, registered);
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  const rehearsal = resolveUpdateRehearsalRoot(env);
  const moves = new Map<string, StoreMove>();
  for (const agentId of listAgentIds(cfg)) {
    const expanded = store.replaceAll("{agentId}", agentId);
    const canonicalStore = resolveSessionStorePathCore(store, { agentId, env });
    const canonicalPath = resolveUnsuffixedSqliteTargetFromSessionStorePath(canonicalStore).path;
    if (isUpdateRehearsalReadOnlyPath(canonicalPath, env)) {
      refuse(
        `the new destination ${canonicalPath} is outside the copied update state; run openclaw doctor --fix against the original state directory outside the update rehearsal first`,
      );
    }
    const canonical = resolveSqliteTargetFromSessionStorePath(canonicalStore, {
      agentId,
      defaultAgentId,
      env,
      registeredDatabases: registered,
    });
    const candidates: Array<{ storePath: string; path?: string; owner: string }> = [];
    if (!rehearsal) {
      for (const base of new Set([process.cwd(), resolveRequiredHomeDir(env)])) {
        candidates.push({ storePath: path.resolve(base, expanded), owner: agentId });
      }
    }
    candidates.push(
      ...legacyTargets
        .filter((target) => target.configuredAgentId === agentId)
        .map((target) => ({
          storePath: target.storePath,
          path: target.path,
          owner: target.agentId,
        })),
    );
    for (const candidate of candidates) {
      if (candidate.storePath === canonicalStore || candidate.path === canonical.path) {
        continue;
      }
      const unsuffixed = resolveUnsuffixedSqliteTargetFromSessionStorePath(candidate.storePath);
      if (isUpdateRehearsalReadOnlyPath(candidate.path ?? unsuffixed.path, env)) {
        refuse(
          `the recorded source ${candidate.path ?? unsuffixed.path} was not copied for rehearsal; run openclaw doctor --fix against the original state directory outside the update rehearsal first`,
        );
      }
      const source = candidate.path
        ? { path: candidate.path, agentId: candidate.owner }
        : resolveSqliteTargetFromSessionStorePath(candidate.storePath, {
            agentId,
            defaultAgentId,
            env,
            registeredDatabases: registered,
          });
      const sourceExists = fs.existsSync(source.path);
      if (!sourceExists && hasOrphanedSqliteSidecars(source.path)) {
        refuse(`SQLite sidecars at ${source.path} need their matching main database restored`);
      }
      if (!sourceExists && !fs.existsSync(candidate.storePath)) {
        continue;
      }
      if (isSameOpenClawAgentDatabasePath(source.path, canonical.path)) {
        continue;
      }
      const identity = sourceExists ? readDatabasePathIdentitySync(source.path) : undefined;
      const owner = source.agentId ?? candidate.owner;
      const key = `${identity?.key ?? source.path}\n${canonical.path}`;
      if (!moves.has(key)) {
        moves.set(key, {
          source: {
            path: identity?.canonicalPath ?? source.path,
            ownerStorePath: source.path,
            databaseAgentId: owner,
          },
          destination: {
            path: canonical.path,
            ownerStorePath: canonical.path,
            databaseAgentId: canonical.agentId ?? owner,
          },
          aliases: registered
            .filter(
              (row) =>
                row.agentId === owner &&
                !isUpdateRehearsalReadOnlyPath(row.path, env) &&
                isSameOpenClawAgentDatabasePath(row.path, source.path),
            )
            .map((row) => row.path),
          legacyStorePath: candidate.storePath,
        });
      }
    }
  }
  return [...moves.values()];
}

function readStoreSnapshot(store: PhysicalStore, env: NodeJS.ProcessEnv, retiring = false) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const claims = executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select("session_key")
          .orderBy("session_key"),
      ).rows.map(({ session_key: key }) => {
        const claim = readClaim(database, store, key, key);
        if (!claim) {
          refuse(`source session ${key} could not be read from ${store.path}`);
        }
        return claim;
      });
      const memberIds = new Map(
        claims.map((claim) => [
          claim.key,
          listSessionMembersInDatabase(database, claim.key).map((member) => member.identityId),
        ]),
      );
      const deliveryInventory = retiring
        ? readRelativeStorePreservationState(
            database,
            claims.map((claim) => claim.key),
            (message) => refuse(`${store.path}: ${message}`),
          )
        : undefined;
      return { claims, memberIds, deliveryInventory };
    },
    { agentId: store.databaseAgentId, path: store.path, env },
  );
  return result.found
    ? result.value
    : { claims: [], memberIds: new Map<string, string[]>(), deliveryInventory: undefined };
}

function sourceFingerprint(
  store: PhysicalStore,
  snapshot: ReturnType<typeof readStoreSnapshot>,
): string {
  return sha256Hex(
    JSON.stringify([
      readDatabasePathIdentitySync(store.path),
      snapshot.claims.map((claim) => [
        claim.key,
        claim.entry,
        claim.nodeArtifactFingerprint,
        claim.generations.map((generation) => generation.fingerprint),
      ]),
      snapshot.deliveryInventory,
    ]),
  );
}

/** Offline repair retires the old selector only after backed-up, verified same-owner copies. */
export async function repairRelativeSessionStores(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  registeredDatabases?: readonly { agentId: string; path: string }[];
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  let moves: StoreMove[];
  try {
    moves = discoverStoreMoves(params.cfg, params.env, params.registeredDatabases ?? []);
  } catch (error) {
    if (error instanceof DoctorMaintenanceRefusalError) {
      throw error;
    }
    refuse(`store discovery failed: ${formatErrorMessage(error)}`);
  }
  if (moves.length === 0) {
    return { changes, warnings };
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    refuse("repair requires Doctor maintenance ownership");
  }
  const authority = { assertCurrent: () => maintenance.assertAdmission() };
  for (const { source, destination, aliases, legacyStorePath } of moves) {
    try {
      authority.assertCurrent();
      const receiptKey = `sessions.relative-store.v1.${sha256Hex(JSON.stringify([source.path, destination.path]))}`;
      const completed = readConfigMachineState<string>(receiptKey, { env: params.env });
      let claims: SessionClaim[];
      let fingerprint: string;
      if (completed === undefined) {
        const paths = [
          source.path,
          destination.path,
          resolveOpenClawStateSqlitePath(params.env),
        ].filter((pathname) => fs.existsSync(pathname));
        const backup = await backupDoctorSqliteDatabases({
          env: params.env,
          pendingDatabasePaths: paths,
          databasePaths: paths,
          authority,
          requireSnapshots: true,
        });
        changes.push(...backup.changes);
        warnings.push(...backup.warnings);
        if (!legacyStorePath.endsWith(".sqlite") && fs.existsSync(legacyStorePath)) {
          const { runDoctorSessionSqlite } = await import("./doctor-session-sqlite.js");
          const { countBlockingSessionSqliteIssues } =
            await import("./doctor-session-sqlite-types.js");
          const imported = await runDoctorSessionSqlite(
            {
              cfg: params.cfg,
              env: params.env,
              mode: "import",
              agent: source.databaseAgentId,
              store: legacyStorePath,
            },
            authority,
          );
          if (imported.targets.some((target) => countBlockingSessionSqliteIssues(target) > 0)) {
            refuse(`legacy JSON at ${legacyStorePath} has unresolved Doctor import issues`);
          }
        }
        if (!fs.existsSync(source.path)) {
          authority.assertCurrent();
          for (const pathname of new Set([source.path, ...aliases])) {
            unregisterOpenClawAgentDatabase({
              agentId: source.databaseAgentId,
              path: pathname,
              env: params.env,
            });
          }
          continue;
        }
        const sourceSnapshot = readStoreSnapshot(source, params.env, true);
        claims = sourceSnapshot.claims;
        await restoreColdSessionClaims(claims, params.env, authority.assertCurrent);
        fingerprint = sourceFingerprint(source, { ...sourceSnapshot, claims });
        const destinationSnapshot = readStoreSnapshot(destination, params.env);
        const destinationClaims = new Map(
          destinationSnapshot.claims.map((claim) => [claim.key, claim]),
        );
        const prepareCanonical = async (key: string) => {
          const canonical = destinationClaims.get(key);
          if (!canonical) {
            return undefined;
          }
          const restored = [canonical];
          await restoreColdSessionClaims(restored, params.env, authority.assertCurrent);
          destinationClaims.set(key, restored[0]!);
          return restored[0];
        };
        for (const sourceClaim of claims) {
          authority.assertCurrent();
          let key = sourceClaim.key;
          let canonical = await prepareCanonical(key);
          const memberIds = sourceSnapshot.memberIds.get(sourceClaim.key)!;
          const sameMembers = (candidateKey: string) =>
            JSON.stringify(memberIds) ===
            JSON.stringify(destinationSnapshot.memberIds.get(candidateKey) ?? []);
          if (canonical && (!claimsMatch(sourceClaim, canonical) || !sameMembers(key))) {
            const logicalAgentId =
              parseAgentSessionKey(sourceClaim.key)?.agentId ?? source.databaseAgentId;
            key = `agent:${logicalAgentId}:relative-store-recovery-${sha256Hex(`${source.path}\n${sourceClaim.key}`).slice(0, 24)}`;
            canonical = await prepareCanonical(key);
            if (canonical && !sameMembers(key)) {
              refuse(`recovered session ${key} already has different sharing permissions`);
            }
          }
          const copySource = { ...sourceClaim, canonicalKey: key };
          const copied = await copySessionClaimForRepair({
            source: copySource,
            destination,
            canonicalKey: key,
            ...(canonical ? { expectedDestination: canonical } : {}),
            mode: "store-relocation",
            env: params.env,
            beforePersistentApply: authority.assertCurrent,
          });
          if (!copied || !claimFullyCopied(copySource, copied)) {
            refuse(
              `conflicting session generations or sharing in ${source.path} and ${destination.path}; preserve the originals and their pre-migration backups for recovery`,
            );
          }
          destinationClaims.set(key, copied);
          destinationSnapshot.memberIds.set(key, memberIds);
        }
        authority.assertCurrent();
        const verifiedSource = readStoreSnapshot(source, params.env, true);
        claims = verifiedSource.claims;
        if (sourceFingerprint(source, verifiedSource) !== fingerprint) {
          refuse(`source ${source.path} changed during the copy`);
        }
        writeConfigMachineState(receiptKey, fingerprint, { env: params.env });
        changes.push(
          `Merged ${claims.length} session(s) from ${source.path} into ${destination.path}; retained the original store and its pre-migration backup for recovery.`,
        );
      } else {
        const retiredSource = readStoreSnapshot(source, params.env, true);
        claims = retiredSource.claims;
        fingerprint = sourceFingerprint(source, retiredSource);
        if (
          completed !== fingerprint ||
          (!legacyStorePath.endsWith(".sqlite") && fs.existsSync(legacyStorePath))
        ) {
          refuse(
            `the retired source ${source.path} changed; preserve it for explicit recovery without replaying deleted conversations`,
          );
        }
      }
      authority.assertCurrent();
      for (const pathname of new Set([source.path, ...aliases])) {
        unregisterOpenClawAgentDatabase({
          agentId: source.databaseAgentId,
          path: pathname,
          env: params.env,
        });
      }
    } catch (error) {
      if (error instanceof DoctorMaintenanceRefusalError) {
        throw error;
      }
      refuse(`${source.path}: ${formatErrorMessage(error)}`);
    }
  }
  return { changes, warnings };
}
