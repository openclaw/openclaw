import crypto from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FsSafeError, root, type Root } from "../../infra/fs-safe.js";
import { logWarn } from "../../logger.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  assertInsideSkillsRoot,
  assertWorkspaceSkillSupportPathSetIsFileOnly,
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
} from "../lifecycle/workspace-skill-write.js";
import {
  cleanupSkillProposalGenerations,
  discardSkillProposalGeneration,
  proposalBundleRelativePath,
  resolveSkillWorkshopStateDir,
  stageSkillProposalGeneration,
} from "./proposal-generation.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { reconcileInterruptedSkillProposalApply } from "./reconcile-transition.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import {
  captureSkillWorkshopStoreOptions,
  ensureSkillWorkshopStore,
  executeSkillWorkshopOperation,
  readStoredProposal,
} from "./store-client.js";
import {
  assertProposalId,
  MAX_PROPOSAL_SUPPORT_FILES,
  PROPOSAL_DRAFT_FILE,
} from "./store-record.js";
import { readSkillProposalRollback } from "./store-rollback.js";
import type { NewSkillProposalEvent } from "./store-sqlite-event.js";
import type {
  SkillProposalRow,
  SkillWorkshopDirectoryStoreOptions,
  SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import {
  commitPendingSkillProposalTransition,
  readCommittedSkillProposalTransition,
} from "./store-transition.js";
import { withSkillProposalTargetLock } from "./target-lock.js";
import {
  SKILL_WORKSHOP_MANIFEST_SCHEMA,
  type PreparedSkillProposalSupportFile,
  type SkillProposalManifest,
  type SkillProposalManifestEntry,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalSupportFileInput,
  type SkillProposalEvent,
} from "./types.js";

const MAX_PROPOSAL_BYTES = 1024 * 1024;
const MAX_PROPOSAL_SUPPORT_FILES_TOTAL_BYTES = 2 * 1024 * 1024;
export {
  MAX_PROPOSAL_SUPPORT_FILES,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "./store-record.js";
export { hashSkillProposalContent } from "./proposal-hash.js";
export { readSkillProposalRollback };
export { withSkillProposalTargetLock };

type SkillProposalLookupScope = {
  agentId?: string;
};

type SkillProposalReadOptions = {
  config: OpenClawConfig;
  reconcile?: boolean;
};

export function createSkillProposalId(name: string, now = new Date()): string {
  const normalized = normalizeSkillIndexName(name) || "skill";
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return `${normalized.slice(0, 60)}-${date}-${suffix}`;
}

function assertSkillProposalContentSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_PROPOSAL_BYTES) {
    throw new Error("Skill proposal is too large.");
  }
}

export function prepareSkillProposalSupportFiles(
  input: readonly SkillProposalSupportFileInput[] | undefined,
): PreparedSkillProposalSupportFile[] {
  if (!input || input.length === 0) {
    return [];
  }
  if (input.length > MAX_PROPOSAL_SUPPORT_FILES) {
    throw new Error(`A skill proposal can include at most ${MAX_PROPOSAL_SUPPORT_FILES} files.`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files: PreparedSkillProposalSupportFile[] = [];
  for (const file of input) {
    const filePath = normalizeWorkspaceSkillSupportPath(file.path);
    if (seen.has(filePath)) {
      throw new Error(`Duplicate support file path: ${filePath}`);
    }
    seen.add(filePath);
    const sizeBytes = Buffer.byteLength(file.content, "utf8");
    if (sizeBytes > MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES) {
      throw new Error(`Support file is too large: ${filePath}`);
    }
    if (file.content.includes("\0")) {
      throw new Error(`Support files must be UTF-8 text: ${filePath}`);
    }
    totalBytes += sizeBytes;
    if (totalBytes > MAX_PROPOSAL_SUPPORT_FILES_TOTAL_BYTES) {
      throw new Error("Skill proposal support files exceed the total size limit.");
    }
    files.push({
      path: filePath,
      sizeBytes,
      hash: hashSkillProposalContent(file.content),
      content: file.content,
    });
  }
  assertWorkspaceSkillSupportPathSetIsFileOnly(files.map((file) => file.path));
  return files;
}

export function resolveSkillProposalTarget(params: {
  skillName: string;
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): {
  skillKey: string;
  skillDir: string;
  skillFile: string;
} {
  const skillKey = normalizeSkillIndexName(params.skillName);
  if (!skillKey) {
    throw new Error("Skill name must contain at least one letter or number.");
  }
  const skillsRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
  const skillDir = path.resolve(skillsRoot, skillKey);
  const skillFile = path.join(skillDir, "SKILL.md");
  assertInsideSkillsRoot(skillsRoot, skillDir, "skill directory");
  assertInsideSkillsRoot(skillsRoot, skillFile, "skill file");
  return { skillKey, skillDir, skillFile };
}

function isStoredProposalVisible(row: SkillProposalRow, scope: SkillProposalLookupScope): boolean {
  return row.owner_agent_id !== null && (!scope.agentId || row.owner_agent_id === scope.agentId);
}

export class SkillProposalDraftMissingError extends Error {
  constructor(
    readonly proposalId: string,
    options?: ErrorOptions,
  ) {
    super(
      `Skill proposal draft is missing: ${proposalId}. Run openclaw doctor --fix for recovery.`,
      options,
    );
  }
}

export async function readSkillProposal(
  proposalId: string,
  sourceOptions: SkillWorkshopDirectoryStoreOptions,
  lookupScope: SkillProposalLookupScope,
  readRequest: SkillProposalReadOptions,
): Promise<SkillProposalReadResult | null> {
  const options = captureSkillWorkshopStoreOptions(sourceOptions);
  const scope = { agentId: lookupScope.agentId };
  const readOptions = { config: readRequest.config, reconcile: readRequest.reconcile };
  let stored = await readStoredProposal(proposalId, options);
  if (!stored || !isStoredProposalVisible(stored.row, scope)) {
    return null;
  }
  const scopedOptions = {
    ...options,
    config: readOptions.config,
    ...(scope.agentId
      ? { agentId: scope.agentId }
      : stored.row.owner_agent_id
        ? { agentId: stored.row.owner_agent_id }
        : {}),
  };
  // Terminal generations cannot be revised or retired by proposal writers.
  // Keep filesystem integrity checks, but do not acquire a write lease to read them.
  if (readOptions.reconcile === false || stored.record.status !== "pending") {
    return await readSkillProposalBundle(stored.record, options);
  }
  if (await reconcileInterruptedApply(proposalId, scopedOptions)) {
    stored = await readStoredProposal(proposalId, options);
    if (!stored || !isStoredProposalVisible(stored.row, scope)) {
      return null;
    }
  }
  return await withSkillProposalTargetLock(
    stored.record,
    async (store) => {
      const current = await readStoredProposal(proposalId, store);
      return current && isStoredProposalVisible(current.row, scope)
        ? await readSkillProposalBundle(current.record, store)
        : null;
    },
    scopedOptions,
  );
}

export async function readSkillProposalRecord(
  proposalId: string,
  sourceOptions: SkillWorkshopDirectoryStoreOptions,
  lookupScope: SkillProposalLookupScope,
  readRequest: SkillProposalReadOptions,
): Promise<SkillProposalRecord | null> {
  const options = captureSkillWorkshopStoreOptions(sourceOptions);
  const scope = { agentId: lookupScope.agentId };
  const readOptions = { config: readRequest.config, reconcile: readRequest.reconcile };
  let stored = await readStoredProposal(proposalId, options);
  if (!stored || !isStoredProposalVisible(stored.row, scope)) {
    return null;
  }
  if (stored.record.status !== "pending") {
    return stored.record;
  }
  const scopedOptions = {
    ...options,
    config: readOptions.config,
    ...(scope.agentId
      ? { agentId: scope.agentId }
      : stored.row.owner_agent_id
        ? { agentId: stored.row.owner_agent_id }
        : {}),
  };
  if (readOptions.reconcile !== false) {
    await reconcileInterruptedApply(proposalId, scopedOptions);
  }
  stored = await readStoredProposal(proposalId, options);
  return stored && isStoredProposalVisible(stored.row, scope) ? stored.record : null;
}

export async function writeSkillProposal(request: {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  ownerAgentId: string;
  maxPending: number;
  event: NewSkillProposalEvent;
  assertMutationAuthorized?: () => void;
  store?: SkillWorkshopStoreOptions;
}): Promise<SkillProposalEvent> {
  assertProposalId(request.record.id);
  assertSkillProposalContentSize(request.content);
  const params = {
    ...structuredClone({
      record: request.record,
      content: request.content,
      supportFiles: request.supportFiles,
      ownerAgentId: request.ownerAgentId,
      maxPending: request.maxPending,
      event: request.event,
    }),
    store: captureSkillWorkshopStoreOptions(request.store ?? {}),
  };
  await ensureSkillWorkshopStore(params.store);
  await stageSkillProposalGeneration(params);

  try {
    request.assertMutationAuthorized?.();
    return await executeSkillWorkshopOperation(
      "workshop.proposal.create",
      {
        record: params.record,
        ownerAgentId: params.ownerAgentId,
        maxPending: params.maxPending,
        event: params.event,
      },
      params.store,
      request.assertMutationAuthorized,
    );
  } catch (error) {
    const committed = await readCommittedSkillProposalTransition({
      record: params.record,
      event: params.event,
      store: params.store,
    });
    if (committed) {
      return committed.event;
    }
    const authoritative = await readStoredProposal(params.record.id, params.store);
    if (authoritative?.row.record_json === JSON.stringify(params.record)) {
      throw new Error("Created Skill Workshop proposal is missing its committed event.", {
        cause: error,
      });
    }
    await discardSkillProposalGeneration(params.record, params.store).catch(() => undefined);
    throw error;
  }
}

export async function replaceSkillProposalDraft(request: {
  expected: SkillProposalRecord;
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  event: NewSkillProposalEvent;
  store?: SkillWorkshopStoreOptions;
}): Promise<SkillProposalEvent> {
  assertProposalId(request.record.id);
  assertSkillProposalContentSize(request.content);
  const params = {
    ...structuredClone({
      expected: request.expected,
      record: request.record,
      content: request.content,
      supportFiles: request.supportFiles,
      event: request.event,
    }),
    store: captureSkillWorkshopStoreOptions(request.store ?? {}),
  };
  await cleanupSkillProposalGenerations(params.expected, params.store).catch((error: unknown) => {
    logWarn(`skill-workshop: failed to clean unowned proposal generations: ${String(error)}`);
  });
  await stageSkillProposalGeneration(params);

  let commit;
  try {
    commit = await commitPendingSkillProposalTransition({
      expected: params.expected,
      record: params.record,
      event: params.event,
      store: params.store,
      operationLabel: "skill-workshop.revision.commit",
      invalidateRollback: true,
    });
  } catch (error) {
    const committed = await readCommittedSkillProposalTransition({
      record: params.record,
      event: params.event,
      store: params.store,
    });
    if (!committed) {
      const authoritative = await readStoredProposal(params.record.id, params.store);
      if (authoritative?.row.record_json === JSON.stringify(params.record)) {
        throw new Error("Revised Skill Workshop proposal is missing its committed event.", {
          cause: error,
        });
      }
      await discardSkillProposalGeneration(params.record, params.store).catch(() => undefined);
      throw error;
    }
    commit = committed;
  }
  if (commit.state === "conflict") {
    await discardSkillProposalGeneration(params.record, params.store).catch(() => undefined);
    throw new Error("Skill proposal changed before revision commit.");
  }
  await cleanupSkillProposalGenerations(params.record, params.store).catch((error: unknown) => {
    logWarn(`skill-workshop: failed to retire prior proposal generation: ${String(error)}`);
  });
  return commit.event;
}

export async function updateSkillProposalRecord(params: {
  record: SkillProposalRecord;
  ownerAgentId?: string;
  store?: SkillWorkshopStoreOptions;
  invalidateRollback?: boolean;
  event?: NewSkillProposalEvent;
}): Promise<SkillProposalEvent | undefined> {
  assertProposalId(params.record.id);
  return executeSkillWorkshopOperation(
    "workshop.proposal.update",
    {
      record: params.record,
      ownerAgentId: params.ownerAgentId,
      invalidateRollback: params.invalidateRollback,
      event: params.event,
    },
    params.store,
  );
}

export async function readSkillProposalManifest(
  sourceOptions: SkillWorkshopDirectoryStoreOptions,
  lookupScope: SkillProposalLookupScope & { status?: SkillProposalRecord["status"] } = {},
): Promise<SkillProposalManifest> {
  const options = captureSkillWorkshopStoreOptions(sourceOptions);
  const scope = { agentId: lookupScope.agentId, status: lookupScope.status };
  const before = await executeSkillWorkshopOperation(
    "workshop.proposals.list",
    { agentId: scope.agentId, status: "pending" },
    options,
  );
  await Promise.all(
    before.map(({ record, row }) =>
      reconcileInterruptedApply(record.id, {
        ...options,
        ...(scope.agentId
          ? { agentId: scope.agentId }
          : row.owner_agent_id
            ? { agentId: row.owner_agent_id }
            : {}),
      }),
    ),
  );
  const proposals = (
    await executeSkillWorkshopOperation("workshop.proposals.list", scope, options)
  ).map(({ record }) => manifestEntryFromRecord(record));
  return {
    schema: SKILL_WORKSHOP_MANIFEST_SCHEMA,
    updatedAt: proposals[0]?.updatedAt ?? new Date(0).toISOString(),
    proposals,
  };
}

async function reconcileInterruptedApply(
  proposalId: string,
  options: SkillWorkshopDirectoryStoreOptions,
): Promise<boolean> {
  const stored = await readStoredProposal(proposalId, options);
  if (!stored || stored.record.status !== "pending" || !options.agentId) {
    return false;
  }
  // Avoid acquiring the target lock on ordinary reads. Apply and revise reread
  // proposals while already holding that lock.
  if (!(await readSkillProposalRollback(proposalId, options))) {
    return false;
  }
  let draftContent: string;
  try {
    draftContent = await readSkillProposalDraft(stored.record, options);
  } catch {
    return false;
  }
  return await reconcileInterruptedSkillProposalApply({
    record: stored.record,
    expectedRecordJson: stored.row.record_json,
    draftContent,
    skillsRoot: resolveWorkshopSkillsDir(options.config, options.agentId, options.env),
    store: options,
  });
}

async function readProposalSupportFiles(
  record: SkillProposalRecord,
  stateRoot: Root,
): Promise<PreparedSkillProposalSupportFile[]> {
  const out: PreparedSkillProposalSupportFile[] = [];
  for (const file of record.supportFiles ?? []) {
    const filePath = normalizeWorkspaceSkillSupportPath(file.path);
    const read = await stateRoot.read(proposalBundleRelativePath(record, filePath), {
      hardlinks: "reject",
      maxBytes: MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
      symlinks: "reject",
    });
    const content = read.buffer.toString("utf8");
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const hash = hashSkillProposalContent(content);
    if (file.sizeBytes !== sizeBytes || file.hash !== hash) {
      throw new Error(`Proposal support file changed without updating metadata: ${filePath}`);
    }
    out.push({ path: filePath, sizeBytes, hash, content });
  }
  assertWorkspaceSkillSupportPathSetIsFileOnly(out.map((file) => file.path));
  return out;
}

export async function readSkillProposalDraft(
  record: SkillProposalRecord,
  options: SkillWorkshopStoreOptions,
): Promise<string> {
  const stateRoot = await root(resolveSkillWorkshopStateDir(options));
  try {
    const draft = await stateRoot.read(proposalBundleRelativePath(record, PROPOSAL_DRAFT_FILE), {
      hardlinks: "reject",
      maxBytes: MAX_PROPOSAL_BYTES,
      symlinks: "reject",
    });
    return draft.buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      throw new SkillProposalDraftMissingError(record.id, { cause: error });
    }
    throw error;
  }
}

export async function readSkillProposalBundle(
  record: SkillProposalRecord,
  options: SkillWorkshopStoreOptions,
): Promise<SkillProposalReadResult> {
  const content = await readSkillProposalDraft(record, options);
  const supportFiles = await readProposalSupportFiles(
    record,
    await root(resolveSkillWorkshopStateDir(options)),
  );
  return {
    record,
    revisionHash: hashSkillProposalRevision(record),
    content,
    ...(supportFiles.length > 0 ? { supportFiles } : {}),
  };
}

export async function importLegacySkillProposal(params: {
  record: SkillProposalRecord;
  rollback?: SkillProposalRollback;
  ownerAgentId: string;
  store?: SkillWorkshopStoreOptions;
}): Promise<"imported" | "already-imported"> {
  assertProposalId(params.record.id);
  return executeSkillWorkshopOperation(
    "workshop.proposal.import",
    { record: params.record, rollback: params.rollback, ownerAgentId: params.ownerAgentId },
    params.store,
  );
}

function manifestEntryFromRecord(record: SkillProposalRecord): SkillProposalManifestEntry {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    title: record.title,
    description: record.description,
    skillName: record.target.skillName,
    skillKey: record.target.skillKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    scanState: record.scan.state,
    revisionHash: hashSkillProposalRevision(record),
  };
}
