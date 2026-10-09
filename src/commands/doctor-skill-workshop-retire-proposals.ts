import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { isMissingPathError } from "../infra/errors.js";
import { pathExists, root } from "../infra/fs-safe.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { isPathInside } from "../infra/path-guards.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { isUpdateRehearsalReadOnlyPath } from "../infra/update-rehearsal-paths.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  prepareWorkspaceSkillRestoration,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
  restoreWorkspaceSkillMutation,
} from "../skills/lifecycle/workspace-skill-write.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { dropRetiredSkillWorkshopProposalTables } from "../state/openclaw-state-db-table-retirements.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

// Retired proposal storage: `<state>/skill-workshop/proposals/<id>/[generations/<uuid>/]PROPOSAL.md`
// plus support files beside the draft; pre-SQLite bundles also carry `proposal.json`.
const LEGACY_PROPOSALS_DIR = path.join("skill-workshop", "proposals");
const LEGACY_PROPOSALS_MANIFEST = path.join("skill-workshop", "proposals.json");
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/u;
const DRAFT_FILE_PATTERN =
  /^(?:generations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)?PROPOSAL\.md$/u;
const MAX_EXPORT_FILE_BYTES = 8 * 1024 * 1024;
// Legacy rollback JSON holds a whole SKILL.md plus every replaced support file.
const MAX_ROLLBACK_BYTES = 128 * 1024 * 1024;
const EXPORTED_STATUSES = new Set(["pending", "quarantined"]);

type RetiredProposal = {
  id: string;
  /** Unset when no configured agent provably owns the proposal. */
  ownerAgentId: string | undefined;
  draftFile: string;
  supportFiles: string[];
};

/** Pre-apply contents an apply recorded before its first write and never committed. */
type UnfinishedApply = {
  proposalId: string;
  skillFile: string;
  previousContent: string | null;
  supportFiles: Array<{
    path: string;
    previousContent: string | null;
    proposedContentHash: string;
  }>;
};

/** Reads only the export-relevant fields; malformed records keep their tables for manual review. */
function parseRetiredProposal(
  id: string,
  record: unknown,
  ownerAgentId: string | undefined,
): RetiredProposal {
  if (!isRecord(record)) {
    throw new Error("proposal record is not an object");
  }
  const { draftFile = "PROPOSAL.md", supportFiles = [] } = record;
  if (typeof draftFile !== "string" || !DRAFT_FILE_PATTERN.test(draftFile)) {
    throw new Error("proposal record has an invalid draft path");
  }
  if (!Array.isArray(supportFiles)) {
    throw new Error("proposal record has invalid support files");
  }
  const supportPaths = supportFiles.map((file: unknown) => {
    const filePath = isRecord(file) ? file.path : undefined;
    if (
      typeof filePath !== "string" ||
      path.posix.isAbsolute(filePath) ||
      filePath.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      filePath === "SKILL.md"
    ) {
      throw new Error("proposal record has an invalid support file path");
    }
    return filePath;
  });
  return { id, ownerAgentId, draftFile, supportFiles: supportPaths };
}

/**
 * Pairs a rollback (SQLite row or legacy `rollback.json`) with the hashes its proposal wrote, so
 * recovery only ever replaces bytes that apply itself put there.
 */
function parseUnfinishedApply(
  proposalId: string,
  record: unknown,
  rollback: Record<string, unknown>,
): UnfinishedApply {
  const target = isRecord(record) && isRecord(record.target) ? record.target : {};
  const skillFile = rollback.targetSkillFile;
  if (
    typeof skillFile !== "string" ||
    !path.isAbsolute(skillFile) ||
    path.basename(skillFile) !== "SKILL.md" ||
    target.skillFile !== skillFile
  ) {
    throw new Error("rollback does not match its proposal target");
  }
  const proposedHashes = new Map(
    (isRecord(record) && Array.isArray(record.supportFiles) ? record.supportFiles : [])
      .filter(isRecord)
      .map((file) => [file.path, file.hash]),
  );
  const rollbackSupport = rollback.supportFiles ?? [];
  if (!Array.isArray(rollbackSupport)) {
    throw new Error("rollback has invalid support files");
  }
  const supportFiles = rollbackSupport.map((file: unknown) => {
    const filePath = isRecord(file) ? file.path : undefined;
    const proposedContentHash = proposedHashes.get(filePath);
    const previousContent = isRecord(file) && file.existed === true ? file.previousContent : null;
    if (
      typeof filePath !== "string" ||
      typeof proposedContentHash !== "string" ||
      (previousContent !== null && typeof previousContent !== "string")
    ) {
      throw new Error("rollback has an invalid support file");
    }
    return { path: filePath, previousContent, proposedContentHash };
  });
  const previousContent = rollback.previousContent ?? null;
  if (previousContent !== null && typeof previousContent !== "string") {
    throw new Error("rollback has invalid previous content");
  }
  return { proposalId, skillFile, previousContent, supportFiles };
}

function readDatabaseProposals(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): {
  proposals: RetiredProposal[];
  unfinishedApplies: UnfinishedApply[];
  /** Every proposal id with a row, whatever its status; their bundles need no sidecar. */
  recordedIds: Set<string>;
  failures: string[];
  hasTables: boolean;
} {
  const { db } = openOpenClawStateDatabase({ env });
  const hasTables = [
    "skill_workshop_proposals",
    "skill_workshop_proposal_events",
    "skill_workshop_proposal_rollbacks",
    "skill_workshop_collection_reviews",
  ].some((table) => tableExists(db, table));
  if (!tableExists(db, "skill_workshop_proposals")) {
    return {
      proposals: [],
      unfinishedApplies: [],
      recordedIds: new Set(),
      failures: [],
      hasTables,
    };
  }
  const rows = db // sqlite-allow-raw -- Retired table has no generated Kysely type; Doctor reads it once before dropping it.
    .prepare(
      `SELECT proposal_id, record_json, owner_agent_id, status FROM skill_workshop_proposals
        ORDER BY proposal_id`,
    )
    .all();
  const proposals: RetiredProposal[] = [];
  const recordedIds = new Set<string>();
  const failures: string[] = [];
  for (const row of rows) {
    const id = String(row.proposal_id);
    recordedIds.add(id);
    if (!EXPORTED_STATUSES.has(String(row.status))) {
      continue;
    }
    try {
      const record: unknown = JSON.parse(String(row.record_json));
      // A removed or renamed owner has no live archive; keep its draft rather than strand it.
      const rowOwner =
        typeof row.owner_agent_id === "string" ? normalizeAgentId(row.owner_agent_id) : undefined;
      const ownerAgentId =
        rowOwner !== undefined
          ? listAgentIds(config).includes(rowOwner)
            ? rowOwner
            : undefined
          : isRecord(record)
            ? inferOwnerAgentId(record, config, env)
            : undefined;
      proposals.push(parseRetiredProposal(id, record, ownerAgentId));
    } catch (error) {
      failures.push(`Could not read Skill Workshop proposal ${id}: ${String(error)}`);
    }
  }
  // Apply wrote its rollback before touching files and committed `applied` last, so any other
  // status still holding a rollback may have stopped between the two.
  const rollbackRows = tableExists(db, "skill_workshop_proposal_rollbacks")
    ? db // sqlite-allow-raw -- Retired table has no generated Kysely type; Doctor reads it once before dropping it.
        .prepare(
          `SELECT r.proposal_id, r.target_skill_file, r.previous_content, r.support_files_json,
                  p.record_json
             FROM skill_workshop_proposal_rollbacks r
             JOIN skill_workshop_proposals p USING (proposal_id)
            WHERE p.status != 'applied'
            ORDER BY r.proposal_id`,
        )
        .all()
    : [];
  const unfinishedApplies: UnfinishedApply[] = [];
  for (const row of rollbackRows) {
    const id = String(row.proposal_id);
    try {
      unfinishedApplies.push(
        parseUnfinishedApply(id, JSON.parse(String(row.record_json)), {
          targetSkillFile: row.target_skill_file,
          previousContent: row.previous_content,
          supportFiles:
            typeof row.support_files_json === "string" ? JSON.parse(row.support_files_json) : [],
        }),
      );
    } catch (error) {
      failures.push(
        `Could not read the unfinished apply of Skill Workshop proposal ${id}: ${String(error)}`,
      );
    }
  }
  return { proposals, unfinishedApplies, recordedIds, failures, hasTables };
}

/**
 * Records without an owner (legacy sidecars, NULL owner rows) use the recorded origin agent, else
 * the one agent whose workspace or Workshop holds the target skill, else the sole configured
 * agent. A recorded owner that is no longer configured is never reassigned; that proposal stays
 * for manual recovery.
 */
function inferOwnerAgentId(
  record: Record<string, unknown>,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const agentIds = listAgentIds(config);
  const soleAgentId = agentIds.length === 1 ? agentIds[0] : undefined;
  const origin = isRecord(record.origin) ? record.origin : {};
  const recordedOwner =
    (typeof origin.agentId === "string" && origin.agentId.trim()) ||
    (typeof origin.sessionKey === "string"
      ? parseAgentSessionKey(origin.sessionKey)?.agentId
      : undefined);
  if (recordedOwner) {
    const ownerAgentId = normalizeAgentId(recordedOwner);
    return agentIds.includes(ownerAgentId) ? ownerAgentId : undefined;
  }
  const target = isRecord(record.target) ? record.target : {};
  if (typeof target.skillDir !== "string") {
    return soleAgentId;
  }
  const skillDir = resolveCanonicalWorkspacePath(path.resolve(target.skillDir));
  const claims = agentIds.flatMap((agentId) => {
    const workspaceDir = resolveCanonicalWorkspacePath(
      resolveAgentWorkspaceDir(config, agentId, env),
    );
    return [
      path.join(workspaceDir, "skills"),
      path.join(workspaceDir, ".agents", "skills"),
      resolveCanonicalWorkspacePath(resolveWorkshopSkillsDir(config, agentId, env)),
    ]
      .filter((skillsRoot) => isPathInside(skillsRoot, skillDir))
      .map((skillsRoot) => ({ agentId, skillsRoot }));
  });
  // The innermost skills root wins; agents sharing it make the owner ambiguous.
  const innermost = Math.max(...claims.map(({ skillsRoot }) => skillsRoot.length));
  const owners = new Set(
    claims
      .filter(({ skillsRoot }) => skillsRoot.length === innermost)
      .map(({ agentId }) => agentId),
  );
  return owners.size === 1 ? [...owners][0] : owners.size === 0 ? soleAgentId : undefined;
}

/** Pre-SQLite bundles keep their record in `proposal.json`; SQLite-backed bundles have none. */
async function readLegacyJsonProposals(params: {
  stateDir: string;
  recordedIds: ReadonlySet<string>;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  proposals: RetiredProposal[];
  unfinishedApplies: UnfinishedApply[];
  failures: string[];
}> {
  const proposals: RetiredProposal[] = [];
  const unfinishedApplies: UnfinishedApply[] = [];
  const failures: string[] = [];
  const stateRoot = await root(params.stateDir);
  const readOptions = { hardlinks: "reject", symlinks: "reject" } as const;
  for (const entry of await stateRoot.list(LEGACY_PROPOSALS_DIR, { withFileTypes: true })) {
    if (
      !entry.isDirectory ||
      !PROPOSAL_ID_PATTERN.test(entry.name) ||
      params.recordedIds.has(entry.name)
    ) {
      continue;
    }
    const bundleDir = path.join(params.stateDir, LEGACY_PROPOSALS_DIR, entry.name);
    try {
      const read = await stateRoot.read(`${LEGACY_PROPOSALS_DIR}/${entry.name}/proposal.json`, {
        ...readOptions,
        maxBytes: MAX_EXPORT_FILE_BYTES,
      });
      const record: unknown = JSON.parse(read.buffer.toString("utf8"));
      if (!isRecord(record) || typeof record.status !== "string") {
        throw new Error("proposal record has no status");
      }
      if (record.status !== "applied") {
        const rollback = await stateRoot
          .read(`${LEGACY_PROPOSALS_DIR}/${entry.name}/rollback.json`, {
            ...readOptions,
            maxBytes: MAX_ROLLBACK_BYTES,
          })
          .catch((error: unknown) => {
            if (isMissingPathError(error)) {
              return undefined;
            }
            throw error;
          });
        if (rollback) {
          const facts: unknown = JSON.parse(rollback.buffer.toString("utf8"));
          if (!isRecord(facts)) {
            throw new Error("rollback is not an object");
          }
          unfinishedApplies.push(parseUnfinishedApply(entry.name, record, facts));
        }
      }
      if (!EXPORTED_STATUSES.has(record.status)) {
        continue;
      }
      proposals.push(
        parseRetiredProposal(
          entry.name,
          record,
          inferOwnerAgentId(record, params.config, params.env),
        ),
      );
    } catch (error) {
      failures.push(
        isMissingPathError(error)
          ? `Skill Workshop proposal ${entry.name} has no record; kept ${bundleDir}. Copy anything worth keeping, delete that directory, then rerun openclaw doctor --fix.`
          : `Could not read Skill Workshop proposal ${entry.name}: ${String(error)}`,
      );
    }
  }
  return { proposals, unfinishedApplies, failures };
}

/**
 * Apply wrote support files first and SKILL.md last; its compensation restored support files
 * first and SKILL.md last. SKILL.md at its pre-apply content means the apply never activated,
 * so every support file it provably wrote is put back. SKILL.md past it with every support file
 * at its proposed bytes means only the status commit was lost. Anything else stopped mid-way
 * and keeps its rollback for the operator.
 */
async function undoUnfinishedApply(apply: UnfinishedApply): Promise<boolean> {
  const skillDir = path.dirname(apply.skillFile);
  const support = await Promise.all(
    apply.supportFiles.map(async (file) => ({
      ...file,
      current: await readWorkspaceSupportFile({ skillDir, relativePath: file.path }),
    })),
  );
  if ((await readWorkspaceSkillFile(apply.skillFile)) !== apply.previousContent) {
    if (
      support.every(
        ({ current, proposedContentHash }) =>
          current !== null && sha256Hex(current) === proposedContentHash,
      )
    ) {
      return false;
    }
    throw new Error("SKILL.md is past its pre-apply content but its support files are not");
  }
  if (support.every(({ current, previousContent }) => current === previousContent)) {
    return false;
  }
  const restoration = await prepareWorkspaceSkillRestoration({
    skillsRoot: path.dirname(skillDir),
    skillDir,
    skillFile: apply.skillFile,
    previousContent: apply.previousContent,
    // Never compared: SKILL.md already holds its previous content, so restoration skips it.
    proposedContentHash: "",
    supportFiles: apply.supportFiles,
    mode: "update",
  });
  await restoreWorkspaceSkillMutation(restoration);
  // An undone create leaves only empty directories; remove them so the name is usable again.
  if (apply.previousContent === null) {
    const entries = await fs.readdir(skillDir, { recursive: true, withFileTypes: true });
    if (entries.every((entry) => entry.isDirectory())) {
      await fs.rm(skillDir, { recursive: true });
    }
  }
  return true;
}

/** Copies one draft bundle; an existing export is never overwritten. */
async function exportProposal(
  proposal: RetiredProposal,
  stateDir: string,
  exportRoot: string,
): Promise<"exported" | "existing" | "missing-draft"> {
  const destination = path.join(exportRoot, proposal.id);
  if (await pathExists(destination)) {
    return "existing";
  }
  const bundleDir = path.join(
    stateDir,
    LEGACY_PROPOSALS_DIR,
    proposal.id,
    path.posix.dirname(proposal.draftFile),
  );
  const readOptions = {
    hardlinks: "reject",
    maxBytes: MAX_EXPORT_FILE_BYTES,
    symlinks: "reject",
  } as const;
  let files: Array<[string, Buffer]>;
  try {
    const bundle = await root(bundleDir);
    files = [["SKILL.md", (await bundle.read("PROPOSAL.md", readOptions)).buffer]];
    for (const supportFile of proposal.supportFiles) {
      files.push([supportFile, (await bundle.read(supportFile, readOptions)).buffer]);
    }
  } catch (error) {
    if (isMissingPathError(error) && !(await pathExists(path.join(bundleDir, "PROPOSAL.md")))) {
      return "missing-draft";
    }
    throw error;
  }
  // Stage beside the destination so a crash never leaves a partial export under the final name.
  const staging = path.join(exportRoot, `.${proposal.id}.partial`);
  await fs.rm(staging, { recursive: true, force: true });
  for (const [relativePath, content] of files) {
    const target = path.join(staging, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: "wx" });
  }
  await fs.rename(staging, destination);
  return "exported";
}

async function retireProposals(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
}): Promise<MigrationMessages> {
  const { config, env, assertCurrent } = params;
  const stateDir = resolveStateDir(env);
  const legacyDirExists = await pathExists(path.join(stateDir, LEGACY_PROPOSALS_DIR));
  const database = readDatabaseProposals(config, env);
  if (!database.hasTables && !legacyDirExists) {
    return { changes: [], warnings: [] };
  }
  const legacy = legacyDirExists
    ? await readLegacyJsonProposals({
        stateDir,
        recordedIds: database.recordedIds,
        config,
        env,
      })
    : { proposals: [], unfinishedApplies: [], failures: [] };
  const warnings = [...database.failures, ...legacy.failures];
  // Any unread or unexported proposal keeps the tables and files for the next Doctor run.
  let blocked = warnings.length > 0;
  const changes: string[] = [];
  const migrationResult = (): MigrationMessages => ({
    changes,
    warnings,
    ...(warnings.length > 0 ? { warningDisposition: "recoverable" as const } : {}),
  });
  // Dropping the rollbacks forgets what an interrupted apply half-wrote, so undo that first.
  for (const apply of [...database.unfinishedApplies, ...legacy.unfinishedApplies]) {
    assertCurrent();
    const skillDir = path.dirname(apply.skillFile);
    // An update rehearsal must not write outside its copied state; the real Doctor run restores.
    if (isUpdateRehearsalReadOnlyPath(skillDir, env)) {
      blocked = true;
      continue;
    }
    try {
      if (await undoUnfinishedApply(apply)) {
        changes.push(
          `Restored ${skillDir} from the unfinished apply of Skill Workshop proposal ${apply.proposalId}.`,
        );
      }
    } catch (error) {
      blocked = true;
      const causes = error instanceof AggregateError ? error.errors : [error];
      warnings.push(
        `Could not undo the unfinished apply of Skill Workshop proposal ${apply.proposalId} in ${skillDir}: ${causes.map(String).join("; ")}. Its proposal tables and files are kept with the recorded pre-apply contents; restore those files by hand, then rerun openclaw doctor --fix.`,
      );
    }
  }
  const exportedIds = new Set<string>();
  const exportedByRoot = new Map<string, number>();
  for (const proposal of [...database.proposals, ...legacy.proposals]) {
    assertCurrent();
    const proposalDir = path.join(stateDir, LEGACY_PROPOSALS_DIR, proposal.id);
    if (!(await pathExists(proposalDir))) {
      warnings.push(
        `Skill Workshop proposal ${proposal.id} has no draft left to export; retired its record.`,
      );
      exportedIds.add(proposal.id);
      continue;
    }
    if (!proposal.ownerAgentId) {
      blocked = true;
      warnings.push(
        `No configured agent owns Skill Workshop proposal ${proposal.id}; kept ${proposalDir}. To keep it, add its agent back to your config and rerun openclaw doctor --fix, or have an agent save that whole directory (draft and support files) with /learn and then delete the directory; otherwise delete the directory and rerun openclaw doctor --fix.`,
      );
      continue;
    }
    const exportRoot = path.join(
      resolveWorkshopSkillsDir(config, proposal.ownerAgentId, env),
      ".archive",
      ".retired-proposals",
    );
    // An update rehearsal must not write outside its copied state; the real Doctor run exports.
    if (isUpdateRehearsalReadOnlyPath(exportRoot, env)) {
      blocked = true;
      continue;
    }
    try {
      await fs.mkdir(exportRoot, { recursive: true });
      const outcome = await exportProposal(proposal, stateDir, exportRoot);
      if (outcome === "missing-draft") {
        // Its directory may still hold support files or other generations.
        blocked = true;
        warnings.push(
          `Skill Workshop proposal ${proposal.id} has no draft; kept ${proposalDir}. Copy anything worth keeping, delete that directory, then rerun openclaw doctor --fix.`,
        );
        continue;
      }
      if (outcome === "exported") {
        exportedByRoot.set(exportRoot, (exportedByRoot.get(exportRoot) ?? 0) + 1);
      }
      exportedIds.add(proposal.id);
    } catch (error) {
      blocked = true;
      warnings.push(
        `Could not export Skill Workshop proposal ${proposal.id} to ${exportRoot}: ${String(error)}. Its proposal tables and files are kept; rerun openclaw doctor --fix after fixing the cause.`,
      );
    }
  }
  for (const [exportRoot, count] of exportedByRoot) {
    changes.push(
      `Exported ${count} pending Skill Workshop proposal draft${count === 1 ? "" : "s"} to ${exportRoot}${path.sep}.`,
    );
  }
  if (blocked) {
    return migrationResult();
  }
  assertCurrent();
  const dropped = runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      // Reread inside the transaction: a proposal written since planning keeps the tables.
      const pending = tableExists(db, "skill_workshop_proposals")
        ? db // sqlite-allow-raw -- Retired table has no generated Kysely type.
            .prepare(
              "SELECT proposal_id FROM skill_workshop_proposals WHERE status IN ('pending', 'quarantined')",
            )
            .all()
        : [];
      if (pending.some((row) => !exportedIds.has(String(row.proposal_id)))) {
        return undefined;
      }
      // Files go before the tables: a crash in between leaves records (whose exports already
      // exist), never recordless bundles that would block the next run.
      if (legacyDirExists) {
        rmSync(path.join(stateDir, LEGACY_PROPOSALS_DIR), { recursive: true, force: true });
        rmSync(path.join(stateDir, LEGACY_PROPOSALS_MANIFEST), { force: true });
      }
      return dropRetiredSkillWorkshopProposalTables(db);
    },
    { env },
    { operationLabel: "doctor.skill-workshop.retire-proposals" },
  );
  if (dropped === undefined) {
    warnings.push(
      "Skill Workshop proposals changed during export; rerun openclaw doctor --fix to finish retiring the proposal tables.",
    );
    return migrationResult();
  }
  if (dropped) {
    changes.push("Retired the Skill Workshop proposal tables.");
  }
  if (legacyDirExists) {
    changes.push(
      `Removed retired Skill Workshop proposal files from ${path.join(stateDir, LEGACY_PROPOSALS_DIR)}.`,
    );
  }
  return migrationResult();
}

/**
 * Exports pending and quarantined Skill Workshop proposal drafts into each owning agent's
 * Workshop archive, then drops the retired proposal tables and legacy proposal files.
 */
export async function retireSkillWorkshopProposals(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const env = params.env ?? process.env;
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (maintenance?.ownsSchemaMaintenance) {
    return await maintenance.run(() =>
      retireProposals({
        config: params.config,
        env,
        assertCurrent: () => maintenance.assertOwnerCurrent(),
      }),
    );
  }
  const owner = await acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true });
  if (!owner) {
    throw new Error("Skill Workshop proposal retirement requires exclusive state ownership");
  }
  try {
    return await owner.run(() =>
      retireProposals({ config: params.config, env, assertCurrent: () => owner.assertCurrent() }),
    );
  } finally {
    await owner.release();
  }
}
