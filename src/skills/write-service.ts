import type {
  installExtractedSkillRoot,
  installSkillArchiveFromPath,
} from "./lifecycle/archive-install.js";
import { bumpSkillsSnapshotVersion } from "./runtime/refresh-state.js";
import { applySkillProposal, proposeCreateSkill, proposeUpdateSkill } from "./workshop/service.js";
import type {
  SkillProposalActionInput,
  SkillProposalApplyResult,
  SkillProposalCreateInput,
  SkillProposalReadResult,
  SkillProposalUpdateInput,
} from "./workshop/types.js";

export type SkillsWriteProposalInput =
  | ({ kind: "create" } & SkillProposalCreateInput)
  | ({ kind: "update"; agentId?: string } & SkillProposalUpdateInput);

type InstallExtractedSkillRootInput = Parameters<typeof installExtractedSkillRoot>[0];
type InstallSkillArchiveFromPathInput = Parameters<typeof installSkillArchiveFromPath>[0];

export type SkillsWriteInstallBundleInput =
  | ({ kind: "directory" } & InstallExtractedSkillRootInput)
  | ({ kind: "archive" } & InstallSkillArchiveFromPathInput);

export type SkillsWriteInstallBundleResult = Awaited<ReturnType<typeof installExtractedSkillRoot>>;

export type SkillsWriteService = {
  propose(input: SkillsWriteProposalInput): Promise<SkillProposalReadResult>;
  applyProposal(input: SkillProposalActionInput): Promise<SkillProposalApplyResult>;
  /** Commits a full bundle; the lifecycle owner writes origin metadata before refreshing. */
  installBundle(input: SkillsWriteInstallBundleInput): Promise<SkillsWriteInstallBundleResult>;
  refreshSnapshot(workspaceDir: string): number;
};

async function proposeSkillWrite(
  input: SkillsWriteProposalInput,
): Promise<SkillProposalReadResult> {
  // Snapshot mutable caller-owned fields before the first await so the scan and
  // persisted proposal always describe the same bundle.
  const snapshot: SkillsWriteProposalInput = {
    ...input,
    ...(input.origin ? { origin: { ...input.origin } } : {}),
    ...(input.supportFiles
      ? { supportFiles: input.supportFiles.map((file) => ({ ...file })) }
      : {}),
  };
  if (snapshot.kind === "create") {
    return await proposeCreateSkill(snapshot);
  }
  return await proposeUpdateSkill(snapshot);
}

async function applySkillWriteProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalApplyResult> {
  return await applySkillProposal({ ...input });
}

async function installSkillBundle(
  input: SkillsWriteInstallBundleInput,
): Promise<SkillsWriteInstallBundleResult> {
  // Gateway and agent startup load this service. Keep extraction and install-security
  // machinery cold until a lifecycle caller actually installs a bundle.
  const { installExtractedSkillRoot, installSkillArchiveFromPath } =
    await import("./lifecycle/archive-install.js");
  if (input.kind === "archive") {
    const { kind: _kind, ...params } = input;
    return await installSkillArchiveFromPath(params);
  }
  const { kind: _kind, ...params } = input;
  return await installExtractedSkillRoot(params);
}

export const skillsWriteService: SkillsWriteService = {
  propose: proposeSkillWrite,
  applyProposal: applySkillWriteProposal,
  installBundle: installSkillBundle,
  refreshSnapshot: (workspaceDir) => bumpSkillsSnapshotVersion({ workspaceDir, reason: "manual" }),
};
