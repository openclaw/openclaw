import type {
  SkillProposalEvaluation as ProtocolSkillProposalEvaluation,
  SkillProposalLifecycleEvent,
  SkillsProposalCreateParams,
  SkillsProposalRecordResult,
  SkillsProposalsListResult,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Schema id for persisted skill workshop proposal records. */
export const SKILL_WORKSHOP_SCHEMA = "openclaw.skill-workshop.proposal.v1" as const;
export const SKILL_WORKSHOP_MANIFEST_SCHEMA =
  "openclaw.skill-workshop.proposals-manifest.v1" as const;
export const SKILL_WORKSHOP_ROLLBACK_SCHEMA = "openclaw.skill-workshop.rollback.v1" as const;
export const MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS = 4096;

type ProtocolSkillProposalRecord = SkillsProposalRecordResult;
type ProtocolSkillProposalManifestEntry = SkillsProposalsListResult["proposals"][number];

export type SkillProposalStatus = ProtocolSkillProposalRecord["status"];
type SkillProposalSource = ProtocolSkillProposalRecord["createdBy"];
type SkillProposalEvaluationTrigger = ProtocolSkillProposalEvaluation["trigger"];
export type SkillProposalEventType = SkillProposalLifecycleEvent["type"];
export type SkillProposalEvaluation = ProtocolSkillProposalEvaluation;
export type SkillProposalEventActor = SkillProposalLifecycleEvent["actor"];
export type SkillProposalEvent = SkillProposalLifecycleEvent;
export type SkillProposalOrigin = NonNullable<ProtocolSkillProposalRecord["origin"]>;

export type SkillWorkshopPreparedPatch = {
  skillFile: string;
  contentHash: string;
  oldString: string;
};

/** Run-scoped budget shared by every workshop tool instance created across runner retries. */
export type SkillWorkshopProposalMutationBudget = {
  remaining: number;
  /** Run-local identity set used to keep idea counts distinct. */
  mutatedProposalIds?: Set<string>;
  /** Content hash per live skill read this run; autonomous updates require a matching receipt. */
  readSkillHashes?: Map<string, string>;
  /** Single-use exact-span patch authority prepared from authoritative live content. */
  preparedSkillPatches?: Map<string, SkillWorkshopPreparedPatch>;
};

/** Exact proposal revision an operator reviewed before requesting an agent-authored revision. */
export type SkillWorkshopProposalRevisionConstraint = {
  readonly agentId: string;
  readonly workspaceDir: string;
  readonly proposalId: string;
  readonly expectedRevisionHash: string;
};

export type SkillWorkshopRunOptions = {
  libraryAuthoring?: import("../library/authoring.js").SkillLibraryAuthoringCapability;
  env?: NodeJS.ProcessEnv;
  proposalOnly?: boolean;
  updateProposals?: boolean;
  autonomousCapture?: boolean;
  origin?: SkillProposalOrigin;
  proposalMutationBudget?: SkillWorkshopProposalMutationBudget;
  proposalRevision?: SkillWorkshopProposalRevisionConstraint;
};

export type SkillProposalScan = ProtocolSkillProposalRecord["scan"];
export type SkillProposalSupportFile = NonNullable<
  ProtocolSkillProposalRecord["supportFiles"]
>[number];

export type PreparedSkillProposalSupportFile = SkillProposalSupportFile & { content: string };

export type SkillProposalDraftFile = "PROPOSAL.md" | `generations/${string}/PROPOSAL.md`;

export type SkillProposalRecord = Omit<ProtocolSkillProposalRecord, "draftFile"> & {
  /** True only for proposals created by autonomous correction or experience capture. */
  autonomousCapture?: true;
  /** Immutable run attribution used to recover interrupted proposal-only reviews. */
  originRunIds?: string[];
  /** Durable mutation counts keyed by run id for bounded interrupted-run recovery. */
  originRunMutationCounts?: Record<string, number>;
  draftFile: SkillProposalDraftFile;
};

export type SkillProposalManifestEntry = Omit<
  ProtocolSkillProposalManifestEntry,
  "revisionHash"
> & {
  revisionHash: string;
};

export type SkillProposalManifest = {
  schema: typeof SKILL_WORKSHOP_MANIFEST_SCHEMA;
  updatedAt: string;
  proposals: SkillProposalManifestEntry[];
};

export type SkillProposalRollback = {
  schema: typeof SKILL_WORKSHOP_ROLLBACK_SCHEMA;
  proposalId: string;
  writtenAt: string;
  targetSkillFile: string;
  action: "create" | "update";
  previousContentHash?: string;
  previousContent?: string;
  supportFiles?: Array<{
    path: string;
    existed: boolean;
    previousContentHash?: string;
    previousContent?: string;
  }>;
};

export type SkillProposalSupportFileInput = NonNullable<
  SkillsProposalCreateParams["supportFiles"]
>[number];

type SkillProposalContext = {
  workspaceDir: string;
  agentId?: string;
  eventActor?: SkillProposalEventActor;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

export type SkillProposalCreateInput = SkillProposalContext & {
  name: string;
  description: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
  createdBy?: SkillProposalSource;
  autonomousCapture?: boolean;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

export type SkillProposalUpdateInput = Omit<
  SkillProposalCreateInput,
  "name" | "description" | "content"
> & {
  skillName: string;
  description?: string;
  /** Complete replacement body. Exactly one of content or composePatch is required. */
  content?: string;
  /**
   * Targeted find-and-replace composed onto the live body inside the same read that
   * hash-binds the proposal. An empty oldString appends newString to the end.
   */
  composePatch?: { oldString: string; newString: string };
  /** Refuse composition when the service's own read hashes differently (reviewer receipt). */
  expectedCurrentContentHash?: string;
  /** Runtime-only final authority check invoked at the proposal persistence boundary. */
  assertMutationAuthorized?: () => void;
};

export type SkillProposalReviseInput = SkillProposalRevisionInput & {
  content?: string;
  supportFiles?: SkillProposalSupportFileInput[];
  description?: string;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

type SkillProposalRevisionInput = SkillProposalContext & {
  proposalId: string;
  expectedRevisionHash?: string;
  correlationId?: string;
  /** Runtime-only final authority check invoked at the live artifact persistence boundary. */
  assertMutationAuthorized?: () => void;
};

export type SkillProposalActionInput = SkillProposalRevisionInput & { reason?: string };

export type SkillProposalEvaluateInput = SkillProposalRevisionInput & {
  trigger?: SkillProposalEvaluationTrigger;
};

export type SkillProposalEventsListInput = {
  agentId?: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  proposalId?: string;
  afterSequence?: number;
  limit?: number;
};

export type SkillProposalEventsListResult = {
  events: SkillProposalEvent[];
  nextSequence?: number;
};

export type SkillProposalReadResult = {
  record: SkillProposalRecord;
  revisionHash: string;
  content: string;
  supportFiles?: PreparedSkillProposalSupportFile[];
};

export type SkillProposalApplyResult = {
  record: SkillProposalRecord;
  targetSkillFile: string;
};

export type SkillProposalEvaluateResult = {
  record: SkillProposalRecord;
  evaluation: SkillProposalEvaluation;
};
