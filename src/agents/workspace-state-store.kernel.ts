import fs from "node:fs";
import path from "node:path";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { formatDoctorStateRepairFailure } from "../infra/state-repair-message.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { resolveUserPath } from "../utils.js";
import {
  createWorkspaceStateIdentity,
  resolveWorkspaceStateAliases,
  WorkspaceAliasRepointedError,
  type WorkspaceStateIdentity,
} from "./workspace-state-identity.js";

export const WORKSPACE_SETUP_STATE_VERSION = 1 as const;
export const WORKSPACE_ATTESTATION_RECENT_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_LEGACY_STATE_MIGRATION_KIND = "legacy-workspace-setup-files";
export const WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND = "workspace-content-relocation";
const MAX_WORKSPACE_ATTESTATION_FILENAME_LENGTH = 255;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
// Attested names are joined onto the workspace dir and read back, so keep the
// accepted set closed rather than denying unsafe forms one at a time: a plain
// ASCII markdown basename excludes separators, traversal, colons, NUL, and the
// Win32 superscript/`CONIN$` device aliases in one rule.
const SAFE_ATTESTATION_BASENAME = /^[A-Za-z0-9._-]+\.md$/u;
// Win32 keeps these stems special even with an extension, so `NUL.md` names a
// device rather than a workspace file; the charset above cannot catch them.
const WINDOWS_RESERVED_DEVICE_STEMS = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;

export function isSafeWorkspaceAttestationFilename(filename: string): boolean {
  return (
    filename.length <= MAX_WORKSPACE_ATTESTATION_FILENAME_LENGTH &&
    SAFE_ATTESTATION_BASENAME.test(filename) &&
    !filename.startsWith(".") &&
    !WINDOWS_RESERVED_DEVICE_STEMS.test(filename.split(".")[0] ?? "")
  );
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

export function assertCanonicalTimestamp(value: string | null, label: string): void {
  if (value !== null && !isCanonicalIsoTimestamp(value)) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}

export function assertCanonicalIntegerTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}

export type WorkspaceSetupState = {
  version: typeof WORKSPACE_SETUP_STATE_VERSION;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

export type WorkspaceAttestation = {
  attestedAtMs: number;
  generatedHashes: ReadonlyMap<string, string>;
};

export type WorkspaceStateSnapshot = {
  identity: WorkspaceStateIdentity;
  setupExists: boolean;
  setupUpdatedAtMs?: number;
  setup: WorkspaceSetupState;
  attestation?: WorkspaceAttestation;
};

export type WorkspaceStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "workspace_setup_state"
  | "workspace_path_aliases"
  | "workspace_generated_bootstrap_hashes"
  | "migration_runs"
  | "migration_sources"
>;

export type WorkspaceStateDatabaseHandle = Pick<OpenClawStateDatabase, "db" | "path">;

export function workspacePathEntryExists(workspaceDir: string): boolean {
  try {
    fs.lstatSync(path.resolve(resolveUserPath(workspaceDir)));
    return true;
  } catch {
    return false;
  }
}

type WorkspaceIdentityResolution = {
  identity: WorkspaceStateIdentity;
  aliases: WorkspaceStateIdentity[];
  missingAliasKeys: string[];
};

export function resolveWorkspaceIdentityFromDatabase(params: {
  workspaceDir: string;
  database: WorkspaceStateDatabaseHandle;
}): WorkspaceIdentityResolution {
  const aliases = resolveWorkspaceStateAliases(params.workspaceDir);
  const canonicalIdentity = aliases.at(-1)!;
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    kysely
      .selectFrom("workspace_path_aliases")
      .selectAll()
      .where(
        "alias_key",
        "in",
        aliases.map((alias) => alias.workspaceKey),
      ),
  ).rows;
  const aliasesByKey = new Map(aliases.map((alias) => [alias.workspaceKey, alias]));
  let storedIdentity: WorkspaceStateIdentity | undefined;
  for (const row of rows) {
    const alias = aliasesByKey.get(row.alias_key);
    if (!alias || alias.workspacePath !== row.alias_path) {
      throw new Error("workspace path alias key collision");
    }
    const rowIdentity = createWorkspaceStateIdentity(row.workspace_path);
    if (rowIdentity.workspaceKey !== row.workspace_key) {
      throw new Error("workspace path alias target is invalid");
    }
    // A repointed alias can also resolve to an already initialized workspace.
    // Report the repairable alias failure before the two owners look like corruption.
    if (
      workspacePathEntryExists(params.workspaceDir) &&
      rowIdentity.workspaceKey !== canonicalIdentity.workspaceKey
    ) {
      throw new WorkspaceAliasRepointedError({
        aliasPath: aliases[0]!.workspacePath,
        storedWorkspacePath: rowIdentity.workspacePath,
        currentWorkspacePath: canonicalIdentity.workspacePath,
      });
    }
    if (storedIdentity && storedIdentity.workspaceKey !== rowIdentity.workspaceKey) {
      throw new Error("workspace path aliases resolve to conflicting state");
    }
    storedIdentity = rowIdentity;
  }
  const existingAliasKeys = new Set(rows.map((row) => row.alias_key));
  return {
    identity: storedIdentity ?? canonicalIdentity,
    aliases,
    missingAliasKeys: aliases
      .map((alias) => alias.workspaceKey)
      .filter((aliasKey) => !existingAliasKeys.has(aliasKey)),
  };
}

export function registerWorkspaceStateAliasIdentitiesInTransaction(params: {
  database: WorkspaceStateDatabaseHandle;
  identity: WorkspaceStateIdentity;
  aliases: readonly WorkspaceStateIdentity[];
  updatedAtMs: number;
}): void {
  assertCanonicalIntegerTimestamp(params.updatedAtMs, "path alias update");
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db);
  for (const alias of params.aliases) {
    const existing = executeSqliteQueryTakeFirstSync(
      params.database.db,
      kysely
        .selectFrom("workspace_path_aliases")
        .selectAll()
        .where("alias_key", "=", alias.workspaceKey),
    );
    if (existing) {
      if (
        existing.alias_path !== alias.workspacePath ||
        existing.workspace_key !== params.identity.workspaceKey ||
        existing.workspace_path !== params.identity.workspacePath
      ) {
        throw new Error("workspace path alias conflicts with canonical state");
      }
      continue;
    }
    executeSqliteQuerySync(
      params.database.db,
      kysely.insertInto("workspace_path_aliases").values({
        alias_key: alias.workspaceKey,
        alias_path: alias.workspacePath,
        workspace_key: params.identity.workspaceKey,
        workspace_path: params.identity.workspacePath,
        updated_at_ms: params.updatedAtMs,
      }),
    );
  }
}

export function registerWorkspaceStateAliasesInTransaction(params: {
  database: WorkspaceStateDatabaseHandle;
  workspaceDirs: readonly string[];
  identity: WorkspaceStateIdentity;
  updatedAtMs: number;
}): void {
  const aliases = new Map<string, WorkspaceStateIdentity>();
  for (const workspaceDir of params.workspaceDirs) {
    for (const alias of resolveWorkspaceStateAliases(workspaceDir)) {
      aliases.set(alias.workspaceKey, alias);
    }
  }
  registerWorkspaceStateAliasIdentitiesInTransaction({
    database: params.database,
    identity: params.identity,
    aliases: [...aliases.values()],
    updatedAtMs: params.updatedAtMs,
  });
}

export function readWorkspaceStateSnapshotFromDatabase(params: {
  identity: WorkspaceStateIdentity;
  database: WorkspaceStateDatabaseHandle;
}): WorkspaceStateSnapshot {
  const identity = params.identity;
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db);
  const setupRow = executeSqliteQueryTakeFirstSync(
    params.database.db,
    kysely
      .selectFrom("workspace_setup_state")
      .selectAll()
      .where("workspace_key", "=", identity.workspaceKey),
  );
  // A NULL path marks a legacy orphan attestation; the first live access to a
  // matching workspace adopts it, so only a differing recorded path collides.
  if (setupRow?.workspace_path != null && setupRow.workspace_path !== identity.workspacePath) {
    throw new Error("workspace state key collision");
  }
  if (setupRow?.version != null && setupRow.version !== WORKSPACE_SETUP_STATE_VERSION) {
    throw new Error(
      formatDoctorStateRepairFailure(
        `unsupported workspace setup version ${setupRow.version} in ${params.database.path} for ${identity.workspacePath}`,
        "Use a compatible OpenClaw build that supports this workspace version; preserve the database unchanged.",
      ),
    );
  }
  if (setupRow?.version != null) {
    assertCanonicalTimestamp(setupRow.bootstrap_seeded_at, "bootstrap seeded");
    assertCanonicalTimestamp(setupRow.setup_completed_at, "setup completed");
    if (setupRow.updated_at == null) {
      throw new Error("workspace setup update timestamp is invalid");
    }
    assertCanonicalIntegerTimestamp(setupRow.updated_at, "setup update");
  }
  const attestationPresent = setupRow?.attested_at_ms != null;
  const generatedHashes = new Map<string, string>();
  if (setupRow && attestationPresent) {
    assertCanonicalIntegerTimestamp(setupRow.attested_at_ms!, "attestation");
    const hashRows = executeSqliteQuerySync(
      params.database.db,
      kysely
        .selectFrom("workspace_generated_bootstrap_hashes")
        .select(["filename", "sha256"])
        .where("workspace_key", "=", identity.workspaceKey)
        .orderBy("filename", "asc"),
    ).rows;
    for (const row of hashRows) {
      // Validate names structurally rather than against today's bootstrap set:
      // retiring a seeded file must not make an existing attestation unreadable.
      if (
        !isSafeWorkspaceAttestationFilename(row.filename) ||
        !SHA256_HEX_PATTERN.test(row.sha256)
      ) {
        throw new Error("workspace attestation hash row is invalid");
      }
      generatedHashes.set(row.filename, row.sha256);
    }
  }
  const setupExists = setupRow?.version != null;
  return {
    identity,
    setupExists,
    ...(setupExists && setupRow?.updated_at != null
      ? { setupUpdatedAtMs: setupRow.updated_at }
      : {}),
    setup: {
      version: WORKSPACE_SETUP_STATE_VERSION,
      ...(setupRow?.bootstrap_seeded_at ? { bootstrapSeededAt: setupRow.bootstrap_seeded_at } : {}),
      ...(setupRow?.setup_completed_at ? { setupCompletedAt: setupRow.setup_completed_at } : {}),
    },
    ...(attestationPresent
      ? {
          attestation: {
            attestedAtMs: setupRow!.attested_at_ms!,
            generatedHashes,
          },
        }
      : {}),
  };
}

export function readWorkspaceStateSnapshotForDirectoryInDatabase(params: {
  workspaceDir: string;
  database: WorkspaceStateDatabaseHandle;
}): WorkspaceStateSnapshot {
  return runSqliteDeferredTransactionSync(params.database.db, () => {
    const { identity } = resolveWorkspaceIdentityFromDatabase(params);
    return readWorkspaceStateSnapshotFromDatabase({ identity, database: params.database });
  });
}

export type WorkspaceAttestationInput = {
  workspaceDir: string;
  attestedAtMs: number;
  generatedHashes: ReadonlyMap<string, string>;
  nowMs?: number;
};

export function replaceWorkspaceAttestationInDatabase(
  database: WorkspaceStateDatabaseHandle,
  params: WorkspaceAttestationInput,
): WorkspaceAttestation {
  assertCanonicalIntegerTimestamp(params.attestedAtMs, "attestation");
  if (params.nowMs !== undefined) {
    assertCanonicalIntegerTimestamp(params.nowMs, "attestation update");
  }
  for (const [filename, sha256] of params.generatedHashes) {
    if (!isSafeWorkspaceAttestationFilename(filename) || !SHA256_HEX_PATTERN.test(sha256)) {
      throw new Error("workspace attestation hash is invalid");
    }
  }
  const sortedHashes = [...params.generatedHashes.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  // Capture the comparison clock only after BEGIN IMMEDIATE acquires the
  // writer lock, so a newer committed row cannot look future-dated.
  const updatedAtMs = params.nowMs ?? Date.now();
  assertCanonicalIntegerTimestamp(updatedAtMs, "attestation update");
  const resolution = resolveWorkspaceIdentityFromDatabase({
    workspaceDir: params.workspaceDir,
    database,
  });
  const identity = resolution.identity;
  const snapshot = readWorkspaceStateSnapshotFromDatabase({ identity, database });
  if (
    snapshot.attestation &&
    snapshot.attestation.attestedAtMs > params.attestedAtMs &&
    snapshot.attestation.attestedAtMs <= updatedAtMs
  ) {
    registerWorkspaceStateAliasIdentitiesInTransaction({
      database,
      identity,
      aliases: resolution.aliases,
      updatedAtMs,
    });
    return snapshot.attestation;
  }
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    kysely
      .insertInto("workspace_setup_state")
      .values({
        workspace_key: identity.workspaceKey,
        workspace_path: identity.workspacePath,
        attested_at_ms: params.attestedAtMs,
        attestation_updated_at_ms: updatedAtMs,
      })
      .onConflict((conflict) =>
        conflict.column("workspace_key").doUpdateSet({
          // Heals the NULL path on adopted legacy orphan attestation rows.
          workspace_path: identity.workspacePath,
          attested_at_ms: params.attestedAtMs,
          attestation_updated_at_ms: updatedAtMs,
        }),
      ),
  );
  const committedHashes = snapshot.attestation?.generatedHashes;
  if (
    committedHashes?.size !== params.generatedHashes.size ||
    sortedHashes.some(([filename, sha256]) => committedHashes.get(filename) !== sha256)
  ) {
    executeSqliteQuerySync(
      database.db,
      kysely
        .deleteFrom("workspace_generated_bootstrap_hashes")
        .where("workspace_key", "=", identity.workspaceKey),
    );
    if (sortedHashes.length > 0) {
      executeSqliteQuerySync(
        database.db,
        kysely.insertInto("workspace_generated_bootstrap_hashes").values(
          sortedHashes.map(([filename, sha256]) => ({
            workspace_key: identity.workspaceKey,
            filename,
            sha256,
          })),
        ),
      );
    }
  }
  registerWorkspaceStateAliasIdentitiesInTransaction({
    database,
    identity,
    aliases: resolution.aliases,
    updatedAtMs,
  });
  return {
    attestedAtMs: params.attestedAtMs,
    generatedHashes: new Map(sortedHashes),
  };
}
