// Durable record of which Claw workspaces were adopted rather than created by the install.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import type { BootstrapPublicationIdentity } from "../agents/workspace.js";
import { isRootFileMissingFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

type WorkspaceOriginDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "claw_workspace_files" | "claw_installs"
>;

type WorkspaceOriginMarker = {
  adoptedFiles: string[];
  installId: string;
  bootstrapPublication?: BootstrapPublicationIdentity;
  filePublications?: Record<string, BootstrapPublicationIdentity>;
};

// Older releases treat every workspace-file row as a removable file. Pointing the reserved row at
// the directory itself makes those releases fail closed during file inspection instead of
// deleting an adopted workspace whose origin they cannot understand.
export const CLAW_ADOPTED_WORKSPACE_MARKER_PATH = ".";
const CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST = "openclaw:adopted-workspace";
const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION = "openclaw.clawWorkspaceFileRecord.v1";

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorkspaceOriginDatabase>(db);
}

/** True when the consented plan adopts an existing directory instead of creating one. */
export function planAdoptsWorkspace(plan: ClawAddPlan): boolean {
  return plan.actions.some((action) => action.kind === "workspace" && action.action === "adopt");
}

/** The declared-file ids the consented plan adopts (claims as already present), sorted. */
function consentedAdoptedFileIds(plan: ClawAddPlan): string[] {
  return plan.actions
    .filter((action) => action.kind === "workspaceFile" && action.action === "adopt")
    .map((action) => action.id)
    .toSorted();
}

/** Records the downgrade fence inside the caller's open install-record transaction. */
function recordAdoptedWorkspaceRow(params: {
  db: DatabaseSync;
  agentId: string;
  workspace: string;
  adoptedFiles: string[];
  nowMs: number;
}): void {
  // The consented adopted set is stored here, not derived from ownership rows: adopted and
  // written files persist identically shaped rows, so a retried adoption plan (rebuilt after a
  // later-phase failure) needs this to tell which declared destinations it may re-label "adopt".
  // A fresh install gets a fresh generation even when its plan, agent and workspace repeat.
  const sourcePath = JSON.stringify({
    adoptedFiles: params.adoptedFiles,
    installId: randomUUID(),
  });
  executeSqliteQuerySync(
    params.db,
    kyselyFor(params.db)
      .insertInto("claw_workspace_files")
      .values({
        agent_id: params.agentId,
        target_path: CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
        schema_version: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        workspace: params.workspace,
        source_path: sourcePath,
        content_digest: CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST,
        status: "complete",
        created_at_ms: params.nowMs,
        updated_at_ms: params.nowMs,
      })
      .onConflict((conflict) =>
        conflict.columns(["agent_id", "target_path"]).doUpdateSet({
          schema_version: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
          workspace: params.workspace,
          source_path: sourcePath,
          content_digest: CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST,
          status: "complete",
          created_at_ms: params.nowMs,
          updated_at_ms: params.nowMs,
        }),
      ),
  );
}

/** Persists whether this install adopted or created its workspace in the caller's transaction. */
export function persistClawWorkspaceOrigin(params: {
  db: DatabaseSync;
  plan: ClawAddPlan;
  nowMs: number;
}): void {
  if (planAdoptsWorkspace(params.plan)) {
    recordAdoptedWorkspaceRow({
      db: params.db,
      agentId: params.plan.agent.finalId,
      workspace: params.plan.agent.workspace,
      adoptedFiles: consentedAdoptedFileIds(params.plan),
      nowMs: params.nowMs,
    });
    return;
  }
  deleteAdoptedWorkspaceRow(params.db, params.plan.agent.finalId);
}

/** Drops the adopted-workspace marker inside the caller's open write transaction. */
export function deleteAdoptedWorkspaceRow(db: DatabaseSync, agentId: string): void {
  executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .deleteFrom("claw_workspace_files")
      .where("agent_id", "=", agentId)
      .where("target_path", "=", CLAW_ADOPTED_WORKSPACE_MARKER_PATH),
  );
}

export type ClawWorkspaceAdoption =
  | { adopted: false }
  | {
      adopted: true;
      adoptedFiles: readonly string[];
      bootstrapSeeded: boolean;
      bootstrapPublication?: BootstrapPublicationIdentity;
      filePublications?: Readonly<Record<string, BootstrapPublicationIdentity>>;
    };

function selectWorkspaceOriginRow(
  db: DatabaseSync,
  agentId: string,
  workspace: string,
): { source_path: string } | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    kyselyFor(db)
      .selectFrom("claw_workspace_files")
      .select("source_path")
      .where("agent_id", "=", agentId)
      .where("target_path", "=", CLAW_ADOPTED_WORKSPACE_MARKER_PATH)
      .where("workspace", "=", workspace)
      .where("content_digest", "=", CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST),
  );
}

/** The marker's stored shape is unshipped: a non-object or malformed value fails closed, no compat. */
function parseWorkspaceOriginMarker(agentId: string, sourcePath: string): WorkspaceOriginMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourcePath);
  } catch {
    throw new Error(
      `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} has a non-JSON consented record.`,
    );
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.adoptedFiles) ||
    parsed.adoptedFiles.some((value) => typeof value !== "string") ||
    typeof parsed.installId !== "string" ||
    !parsed.installId ||
    (parsed.bootstrapPublication !== undefined &&
      !isBootstrapPublication(parsed.bootstrapPublication)) ||
    (parsed.filePublications !== undefined &&
      !isBootstrapPublicationRecord(parsed.filePublications))
  ) {
    throw new Error(
      `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} has a malformed consented record.`,
    );
  }
  return {
    adoptedFiles: parsed.adoptedFiles,
    installId: parsed.installId,
    ...(parsed.bootstrapPublication ? { bootstrapPublication: parsed.bootstrapPublication } : {}),
    ...(parsed.filePublications ? { filePublications: parsed.filePublications } : {}),
  };
}

/**
 * Whether this agent's current workspace directory existed before the Claw adopted it, and,
 * when adopted, the consented declared-file ids a resume must relabel "adopt" to reconstruct
 * the identical plan, plus whether this install itself already seeded BOOTSTRAP.md.
 */
export function readClawWorkspaceAdoptionFromDatabase(
  db: DatabaseSync,
  agentId: string,
  workspace: string,
): ClawWorkspaceAdoption {
  // Read-only previews may run against schema-compatible but pre-migration state where this
  // table does not exist yet; absence reads as "not adopted", not a hard failure.
  if (!tableExists(db, "claw_workspace_files")) {
    return { adopted: false };
  }
  const row = selectWorkspaceOriginRow(db, agentId, workspace);
  if (!row) {
    return { adopted: false };
  }
  const marker = parseWorkspaceOriginMarker(agentId, row.source_path);
  return {
    adopted: true,
    adoptedFiles: marker.adoptedFiles,
    bootstrapSeeded: clawBootstrapPublicationMatches(workspace, marker.bootstrapPublication),
    ...(marker.bootstrapPublication ? { bootstrapPublication: marker.bootstrapPublication } : {}),
    ...(marker.filePublications ? { filePublications: marker.filePublications } : {}),
  };
}

export function readClawWorkspaceAdoption(
  agentId: string,
  workspace: string,
  options: OpenClawStateDatabaseOptions = {},
): ClawWorkspaceAdoption {
  const { db } = openOpenClawStateDatabase(options);
  return readClawWorkspaceAdoptionFromDatabase(db, agentId, workspace);
}

/** Validate the exact, JSON-safe prepublication identity; missing evidence never grants ownership. */
function isBootstrapPublication(value: unknown): value is BootstrapPublicationIdentity {
  return (
    isRecord(value) &&
    typeof value.directoryPath === "string" &&
    ["directoryDev", "directoryIno", "dev", "ino", "birthtimeNs"].every(
      (key) => typeof value[key] === "string" && /^\d+$/.test(value[key]),
    )
  );
}

function isBootstrapPublicationRecord(
  value: unknown,
): value is Record<string, BootstrapPublicationIdentity> {
  return isRecord(value) && Object.values(value).every(isBootstrapPublication);
}

/** Compare a safe, pinned final entry with the prepublication receipt, never just its bytes. */
export function clawBootstrapPublicationMatches(
  workspace: string,
  publication: BootstrapPublicationIdentity | undefined,
  relativePath = "BOOTSTRAP.md",
  observedFile?: fs.BigIntStats,
): boolean {
  if (!publication) {
    return false;
  }
  let fd: number | undefined;
  try {
    const directoryPath = fs.realpathSync(path.dirname(path.join(workspace, relativePath)));
    const opened = openRootFileSync({
      absolutePath: path.join(workspace, relativePath),
      maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
      rootPath: workspace,
      boundaryLabel: "Claw bootstrap",
      symlinks: "reject",
    });
    if (!opened.ok) {
      return false;
    }
    fd = opened.fd;
    const file = fs.fstatSync(fd, { bigint: true });
    const directory = fs.lstatSync(directoryPath, { bigint: true });
    return (
      (!observedFile ||
        (observedFile.dev === file.dev &&
          observedFile.ino === file.ino &&
          observedFile.birthtimeNs === file.birthtimeNs)) &&
      directory.isDirectory() &&
      directoryPath === publication.directoryPath &&
      directory.dev.toString() === publication.directoryDev &&
      directory.ino.toString() === publication.directoryIno &&
      file.dev.toString() === publication.dev &&
      file.ino.toString() === publication.ino &&
      file.birthtimeNs.toString() === publication.birthtimeNs &&
      file.nlink === 1n
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export type ClawBootstrapRemovalAuthority =
  | { owned: false; missing: boolean }
  | { owned: true; ownsFile: (relativePath: string) => boolean; close: () => void };

/** Pin the exact published bootstrap object so a digest-identical replacement stays unowned. */
export function openClawBootstrapRemovalAuthority(params: {
  workspace: string;
  relativePath: string;
  publication: BootstrapPublicationIdentity | undefined;
}): ClawBootstrapRemovalAuthority {
  const opened = openRootFileSync({
    absolutePath: path.join(params.workspace, params.relativePath),
    rootPath: params.workspace,
    boundaryLabel: "Claw bootstrap removal",
    symlinks: "reject",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  if (!opened.ok) {
    return { owned: false, missing: isRootFileMissingFailure(opened) };
  }
  const fd = opened.fd;
  try {
    const original = fs.fstatSync(fd, { bigint: true });
    const publication = params.publication;
    if (
      !publication ||
      !clawBootstrapPublicationMatches(params.workspace, publication, params.relativePath, original)
    ) {
      fs.closeSync(fd);
      return { owned: false, missing: false };
    }
    let closed = false;
    let acceptedPath = params.relativePath;
    let acceptedCtimeNs = original.ctimeNs;
    return {
      owned: true,
      ownsFile: (relativePath) => {
        const current = fs.fstatSync(fd, { bigint: true });
        if (
          current.size !== original.size ||
          current.mtimeNs !== original.mtimeNs ||
          (relativePath === acceptedPath && current.ctimeNs !== acceptedCtimeNs)
        ) {
          return false;
        }
        const matches = clawBootstrapPublicationMatches(
          params.workspace,
          { ...publication, birthtimeNs: current.birthtimeNs.toString() },
          relativePath,
          current,
        );
        if (matches) {
          // A rename changes ctime on some filesystems. Admit that transition only when the
          // receipt-bound inode moved to a different path; later in-place changes still revoke it.
          acceptedPath = relativePath;
          acceptedCtimeNs = current.ctimeNs;
        }
        return matches;
      },
      close: () => {
        if (!closed) {
          fs.closeSync(fd);
          closed = true;
        }
      },
    };
  } catch {
    fs.closeSync(fd);
    return { owned: false, missing: false };
  }
}

/** Bind a file producer to this exact active install before asynchronous publication. */
function prepareClawWorkspacePublication(
  plan: ClawAddPlan,
  relativePath: string,
  publicationLabel: "bootstrap" | "workspace file",
  readPublication: (marker: WorkspaceOriginMarker) => BootstrapPublicationIdentity | undefined,
  updateMarker: (
    marker: WorkspaceOriginMarker,
    publication: BootstrapPublicationIdentity,
  ) => WorkspaceOriginMarker,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
):
  | {
      beforePublish: (publication: BootstrapPublicationIdentity) => void;
      afterPublish: (publication: BootstrapPublicationIdentity) => void;
      ownsExisting: (file: fs.BigIntStats) => boolean;
      assertCurrent: () => void;
    }
  | undefined {
  if (!planAdoptsWorkspace(plan)) {
    return undefined;
  }
  const { db } = openOpenClawStateDatabase(options);
  const row = selectWorkspaceOriginRow(db, plan.agent.finalId, plan.agent.workspace);
  if (!row) {
    const install = executeSqliteQueryTakeFirstSync(
      db,
      kyselyFor(db)
        .selectFrom("claw_installs")
        .select("plan_integrity")
        .where("agent_id", "=", plan.agent.finalId)
        .where("workspace", "=", plan.agent.workspace),
    );
    if (install) {
      throw new Error("Claw workspace adoption disappeared before file publication preparation.");
    }
    return undefined;
  }
  const generation = parseWorkspaceOriginMarker(plan.agent.finalId, row.source_path).installId;
  const currentMarker = (database: DatabaseSync) => {
    const current = selectWorkspaceOriginRow(database, plan.agent.finalId, plan.agent.workspace);
    const marker = current && parseWorkspaceOriginMarker(plan.agent.finalId, current.source_path);
    const install = executeSqliteQueryTakeFirstSync(
      database,
      kyselyFor(database)
        .selectFrom("claw_installs")
        .select("plan_integrity")
        .where("agent_id", "=", plan.agent.finalId)
        .where("workspace", "=", plan.agent.workspace)
        .where("status", "in", ["workspace_ready", "config_committed"]),
    );
    if (
      !current ||
      !marker ||
      marker.installId !== generation ||
      install?.plan_integrity !== plan.planIntegrity
    ) {
      throw new Error(`Claw install changed before ${publicationLabel} publication.`);
    }
    return { current, marker };
  };
  const recordPublication = (publication: BootstrapPublicationIdentity) => {
    runOpenClawStateWriteTransaction(({ db: transactionDb }) => {
      const { current, marker } = currentMarker(transactionDb);
      const updated = executeSqliteQuerySync(
        transactionDb,
        kyselyFor(transactionDb)
          .updateTable("claw_workspace_files")
          .set({
            source_path: JSON.stringify(updateMarker(marker, publication)),
            updated_at_ms: options.nowMs ?? Date.now(),
          })
          .where("agent_id", "=", plan.agent.finalId)
          .where("target_path", "=", CLAW_ADOPTED_WORKSPACE_MARKER_PATH)
          .where("source_path", "=", current.source_path),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("Claw workspace file publication did not update its exact owner.");
      }
    }, options);
  };
  return {
    beforePublish: recordPublication,
    // The producer still holds the original descriptor and validates the final path.
    // A failed completion keeps the write-ahead receipt; resume never guesses ownership.
    afterPublish: recordPublication,
    // Native state commits recheck DB authority only; filesystem inspection stays outside BEGIN.
    assertCurrent: () => {
      currentMarker(db);
    },
    ownsExisting: (file) =>
      clawBootstrapPublicationMatches(
        plan.agent.workspace,
        readPublication(currentMarker(db).marker),
        relativePath,
        file,
      ),
  };
}

export function prepareClawBootstrapPublication(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
) {
  return prepareClawWorkspacePublication(
    plan,
    "BOOTSTRAP.md",
    "bootstrap",
    (marker) => marker.bootstrapPublication,
    (marker, publication) => ({ ...marker, bootstrapPublication: publication }),
    options,
  );
}

/** Records the exact file object this install publishes inside an adopted workspace. */
export function prepareClawWorkspaceFilePublication(
  plan: ClawAddPlan,
  relativePath: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
) {
  return prepareClawWorkspacePublication(
    plan,
    relativePath,
    "workspace file",
    (marker) => marker.filePublications?.[relativePath],
    (marker, publication) => ({
      ...marker,
      filePublications: { ...marker.filePublications, [relativePath]: publication },
    }),
    options,
  );
}

/**
 * Whether BOOTSTRAP.md in this workspace may be treated as this install's own seed. A created
 * workspace holds only this install's writes until its config commits; an adopted one holds only
 * the exact file identified before this install published it.
 */
export function clawBootstrapSeedOwned(origin: ClawWorkspaceAdoption, workspace: string): boolean {
  return !origin.adopted || clawBootstrapPublicationMatches(workspace, origin.bootstrapPublication);
}
