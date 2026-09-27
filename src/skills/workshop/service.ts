import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertInsideSkillsRoot,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
} from "../lifecycle/workspace-skill-write.js";
import {
  applySkillProposalTransition,
  assertSkillProposalSupportTargetUnchanged,
  markSkillProposalStale,
  withSkillProposalLifecycleDispatch,
  type SkillProposalApplyTransitionDependencies,
  type SkillProposalTransitionInput,
} from "./apply-transition.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { resolveDraftedSkillDescription, resolveSkillProposalName } from "./frontmatter.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { nextProposalVersion, prepareSkillProposalDraft } from "./proposal-draft.js";
import { createSkillProposalGenerationDraftFile } from "./proposal-generation.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import {
  assertExpectedRevisionHash,
  evaluateSkillProposal,
  SkillProposalCreateTargetConflictError,
} from "./service-evaluation.js";
import {
  buildSupportFileMetadata,
  mergeProposalOriginRunProvenance,
  normalizeProposalOrigin,
} from "./service-propose.js";
import { readRequiredProposal } from "./service-query.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { captureSkillWorkshopStoreOptions } from "./store-client.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import {
  hashSkillProposalContent,
  readSkillProposalRecord,
  replaceSkillProposalDraft,
  updateSkillProposalRecord,
  withSkillProposalTargetLock,
} from "./store.js";
import type {
  SkillProposalActionInput,
  SkillProposalApplyResult,
  SkillProposalReadResult,
  SkillProposalRecord,
  SkillProposalReviseInput,
} from "./types.js";
export { readSkillProposalDraftDirectory, readSkillProposalDraftFile } from "./proposal-draft.js";
export {
  composeSkillBodyPatch,
  findUniqueSkillPatchSpan,
  proposeCreateSkill,
  proposeUpdateSkill,
  SkillProposalStaleTargetError,
} from "./service-propose.js";
export {
  inspectSkillProposal,
  listSkillProposals,
  resolvePendingSkillProposal,
} from "./service-query.js";
export { evaluateSkillProposal, listSkillProposalEvents } from "./service-evaluation.js";

function proposalStoreOptions(
  env: NodeJS.ProcessEnv | undefined,
  agentId: string | undefined,
  config: OpenClawConfig,
) {
  if (!agentId) {
    throw new Error("Skill Workshop requires the active agent id.");
  }
  return { ...(env ? { env } : {}), agentId, config };
}

function workshopSkillsDir(input: {
  config: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (!input.agentId) {
    throw new Error("Skill Workshop requires the active agent id.");
  }
  return resolveWorkshopSkillsDir(input.config, input.agentId, input.env);
}

const APPLY_TRANSITION_DEPENDENCIES = {
  assertExpectedRevisionHash,
  evaluateSkillProposal,
  isCreateTargetConflict: (error: unknown) =>
    error instanceof SkillProposalCreateTargetConflictError,
  readRequiredProposal,
} satisfies SkillProposalApplyTransitionDependencies;

export async function reviseSkillProposal(
  input: SkillProposalReviseInput,
): Promise<SkillProposalReadResult> {
  if (
    input.content === undefined &&
    input.supportFiles === undefined &&
    input.description === undefined &&
    input.goal === undefined &&
    input.evidence === undefined
  ) {
    throw new Error("Skill proposal revision requires at least one changed field.");
  }
  const request = {
    ...input,
    supportFiles: structuredClone(input.supportFiles),
    origin: structuredClone(input.origin),
    eventActor: structuredClone(input.eventActor),
  };
  const config = resolveSkillWorkshopConfig(request.config);
  const revision = withPendingSkillProposalRevision(request, async (read, store) => {
    const lockedRequest = { ...request, env: store.env };
    const { record } = read;
    const skillsRoot = workshopSkillsDir(lockedRequest);
    assertInsideSkillsRoot(skillsRoot, record.target.skillFile, "skill file");
    assertInsideSkillsRoot(skillsRoot, record.target.skillDir, "skill directory");

    const currentContent = await readWorkspaceSkillFile(record.target.skillFile);
    if (record.kind === "create") {
      if (currentContent !== null) {
        await markSkillProposalStale({
          store,
          record,
          reason: "Target skill was created after proposal creation.",
          message: "Target skill was created after proposal creation; proposal marked stale.",
          input: lockedRequest,
        });
      }
    } else {
      if (currentContent === null) {
        throw new Error(`Target skill is missing: ${record.target.skillFile}`);
      }
      if (
        record.target.currentContentHash &&
        hashSkillProposalContent(currentContent) !== record.target.currentContentHash
      ) {
        await markSkillProposalStale({
          store,
          record,
          reason: "Target skill changed after proposal creation.",
          message: "Target skill changed after proposal creation; proposal marked stale.",
          input: lockedRequest,
        });
      }
      await assertSupportTargetsUnchanged(record, lockedRequest, store);
    }

    const supportFiles =
      lockedRequest.supportFiles === undefined
        ? (read.supportFiles ?? [])
        : lockedRequest.supportFiles;
    const requestedContent = lockedRequest.content ?? read.content;
    const nextVersion = nextProposalVersion(record.proposedVersion);
    const explicitDescription = normalizeOptionalString(lockedRequest.description);
    const description = explicitDescription ?? record.description;
    const now = new Date().toISOString();
    const prepared = prepareSkillProposalDraft({
      name: resolveSkillProposalName(record.kind, record.target),
      description,
      // The listing label is the skill description only for proposals whose
      // content never carried one; otherwise the description comes from the drafted
      // or previously rendered content. An explicitly revised description still wins
      // for create proposals so description-only revisions reach the applied skill.
      skillDescription: resolveDraftedSkillDescription({
        content: requestedContent,
        fallbackContent: read.content,
        label: description,
        ...(record.kind === "create" && explicitDescription ? { explicitDescription } : {}),
      }),
      content: requestedContent,
      fallbackFrontmatterContent: read.content,
      version: nextVersion,
      date: now,
      maxSkillBytes: config.maxSkillBytes,
      supportFiles,
      goal: lockedRequest.goal === undefined ? record.goal : lockedRequest.goal,
      evidence: lockedRequest.evidence === undefined ? record.evidence : lockedRequest.evidence,
    });
    if (!prepared.ok) {
      throw prepared.error.cause;
    }
    const {
      content: proposalContent,
      draftHash,
      evidence,
      goal,
      scan,
      supportFiles: preparedSupportFiles,
    } = prepared.value;
    const supportFileMetadata =
      preparedSupportFiles.length > 0
        ? await buildSupportFileMetadata(
            preparedSupportFiles,
            record.kind === "update" ? record.target.skillDir : undefined,
          )
        : [];
    const origin = normalizeProposalOrigin(lockedRequest.origin);
    const originRunProvenance = mergeProposalOriginRunProvenance(record, origin);
    const revised: SkillProposalRecord = {
      ...record,
      description,
      updatedAt: now,
      proposedVersion: nextVersion,
      draftFile: createSkillProposalGenerationDraftFile(),
      draftHash,
      scan,
      ...(origin ? { origin } : {}),
      ...originRunProvenance,
    };
    delete revised.evaluation;
    if (preparedSupportFiles.length > 0) {
      revised.supportFiles = supportFileMetadata;
    } else {
      delete revised.supportFiles;
    }
    if (goal) {
      revised.goal = goal;
    } else {
      delete revised.goal;
    }
    if (evidence) {
      revised.evidence = evidence;
    } else {
      delete revised.evidence;
    }
    const event = await replaceSkillProposalDraft({
      expected: record,
      record: revised,
      content: proposalContent,
      supportFiles: preparedSupportFiles,
      event: createSkillProposalEvent({
        record: revised,
        type: "revised",
        actor: lockedRequest.eventActor,
        ...(lockedRequest.correlationId ? { correlationId: lockedRequest.correlationId } : {}),
        occurredAt: now,
      }),
      store,
    });
    return {
      read: {
        record: revised,
        revisionHash: hashSkillProposalRevision(revised),
        content: proposalContent,
      },
      event,
    };
  });
  const revisedResult = await withSkillProposalLifecycleDispatch(request, revision);
  await dispatchSkillProposalChanged({
    event: revisedResult.event,
    record: revisedResult.read.record,
    workspaceDir: request.workspaceDir,
    ...(request.agentId ? { agentId: request.agentId } : {}),
  });
  return revisedResult.read;
}

export async function rejectSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "rejected");
}

export async function quarantineSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "quarantined");
}

export async function applySkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalApplyResult> {
  return await applySkillProposalTransition(input, APPLY_TRANSITION_DEPENDENCIES);
}

async function markProposal(
  input: SkillProposalActionInput,
  status: "quarantined" | "rejected",
): Promise<SkillProposalRecord> {
  const store = captureSkillWorkshopStoreOptions(
    proposalStoreOptions(input.env, input.agentId, input.config),
  );
  const request = { ...input, env: store.env, eventActor: structuredClone(input.eventActor) };
  const scope = request.agentId ? { agentId: request.agentId } : {};
  const initial = await readSkillProposalRecord(request.proposalId, store, scope, {
    config: request.config,
  });
  if (!initial) {
    throw new Error(`Skill proposal not found: ${request.proposalId}`);
  }
  const result = await withSkillProposalTargetLock(
    initial,
    async (lockedStore) => {
      const current = await readSkillProposalRecord(
        request.proposalId,
        { ...lockedStore, config: request.config },
        scope,
        { config: request.config, reconcile: false },
      );
      if (!current) {
        throw new Error(`Skill proposal not found: ${request.proposalId}`);
      }
      if (current.status !== "pending") {
        throw new Error(
          `Only pending proposals can be ${status}. Current status: ${current.status}.`,
        );
      }
      assertExpectedRevisionHash(hashSkillProposalRevision(current), request.expectedRevisionHash);
      const now = new Date().toISOString();
      const base = {
        ...current,
        status,
        updatedAt: now,
        statusReason: normalizeOptionalString(request.reason),
      };
      const record: SkillProposalRecord =
        status === "rejected"
          ? { ...base, rejectedAt: now }
          : {
              ...base,
              quarantinedAt: now,
              scan: { ...current.scan, state: "quarantined" },
            };
      const event = await updateSkillProposalRecord({
        record,
        event: createSkillProposalEvent({
          record,
          type: status,
          actor: request.eventActor,
          ...(request.correlationId ? { correlationId: request.correlationId } : {}),
          occurredAt: now,
        }),
        store: lockedStore,
      });
      return { record, event };
    },
    store,
  );
  if (result.event) {
    await dispatchSkillProposalChanged({
      event: result.event,
      record: result.record,
      workspaceDir: request.workspaceDir,
      ...(request.agentId ? { agentId: request.agentId } : {}),
    });
  }
  return result.record;
}

async function withPendingSkillProposalRevision<T>(
  input: Pick<
    SkillProposalActionInput,
    "agentId" | "config" | "env" | "expectedRevisionHash" | "proposalId" | "workspaceDir"
  >,
  fn: (read: SkillProposalReadResult, store: SkillWorkshopStoreOptions) => Promise<T>,
): Promise<T> {
  const store = captureSkillWorkshopStoreOptions(
    proposalStoreOptions(input.env, input.agentId, input.config),
  );
  const request = { ...input, env: store.env };
  const recoveryReadOptions = { config: request.config, store };
  const lockedReadOptions = {
    config: request.config,
    reconcile: false,
  };
  const initial = await readRequiredProposal(
    request.proposalId,
    request.env,
    request.agentId,
    recoveryReadOptions,
  );
  return await withSkillProposalTargetLock(
    initial.record,
    async (lockedStore) => {
      const read = await readRequiredProposal(request.proposalId, request.env, request.agentId, {
        ...lockedReadOptions,
        store: lockedStore,
      });
      if (read.record.status !== "pending") {
        throw new Error(
          `Only pending proposals can be revised. Current status: ${read.record.status}.`,
        );
      }
      assertExpectedRevisionHash(read.revisionHash, request.expectedRevisionHash);
      if (hashSkillProposalContent(read.content) !== read.record.draftHash) {
        throw new Error("Proposal draft changed without updating proposal metadata.");
      }
      return await fn(read, lockedStore);
    },
    store,
  );
}

async function assertSupportTargetsUnchanged(
  record: SkillProposalRecord,
  input: SkillProposalTransitionInput,
  store: SkillWorkshopStoreOptions,
): Promise<void> {
  if (record.kind !== "update" || !record.supportFiles) {
    return;
  }
  for (const file of record.supportFiles) {
    if (file.targetExisted === undefined) {
      continue;
    }
    const currentContent = await readWorkspaceSupportFile({
      skillDir: record.target.skillDir,
      relativePath: file.path,
    });
    await assertSkillProposalSupportTargetUnchanged({
      store,
      record,
      file,
      currentContent,
      input,
    });
  }
}
