import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  InstallExtractedSkillRootInput,
  InstallSkillArchiveFromPathInput,
  SkillArchiveInstallResult,
} from "../lifecycle/archive-install.js";
import type { SkillProposalScan } from "../workshop/types.js";
import type {
  SkillProposalActionInput,
  SkillProposalApplyResult,
  SkillProposalCreateInput,
  SkillProposalReadResult,
  SkillProposalSupportFileInput,
  SkillProposalUpdateInput,
} from "../workshop/types.js";

export type SkillsWriteValidationInput = {
  config?: OpenClawConfig;
  name?: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
};

export type SkillsWriteValidationResult = {
  name: string;
  description: string;
  scan: SkillProposalScan;
};

export type SkillsWriteProposalInput =
  | ({ kind: "create" } & SkillProposalCreateInput)
  | ({ kind: "update"; agentId?: string } & SkillProposalUpdateInput);

export type SkillsWriteInstallBundleInput =
  | ({ kind: "directory" } & InstallExtractedSkillRootInput)
  | ({ kind: "archive" } & InstallSkillArchiveFromPathInput);
export type SkillsWriteInstallBundleResult = SkillArchiveInstallResult;

export type SkillsWriteDirectInput = {
  workspaceDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  name: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
  mode: "create" | "update";
  /**
   * Defaults to true. False skips this call's explicit snapshot bump; the workspace
   * watcher can still observe the file write and invalidate snapshots independently.
   */
  refresh?: boolean;
};

export type SkillsWriteDirectRollback = {
  action: "create" | "update";
  targetSkillFile: string;
  previousContent?: string;
  previousContentHash?: string;
  supportFiles?: Array<{
    path: string;
    existed: boolean;
    previousContent?: string;
    previousContentHash?: string;
  }>;
};

export type SkillsWriteDirectResult = {
  targetSkillFile: string;
  scan: SkillProposalScan;
  rollback: SkillsWriteDirectRollback;
  snapshotVersion?: number;
};

export type SkillsWriteService = {
  validate(input: SkillsWriteValidationInput): SkillsWriteValidationResult;
  propose(input: SkillsWriteProposalInput): Promise<SkillProposalReadResult>;
  applyProposal(input: SkillProposalActionInput): Promise<SkillProposalApplyResult>;
  writeDirect(input: SkillsWriteDirectInput): Promise<SkillsWriteDirectResult>;
  /** Commits a full bundle; the lifecycle owner writes origin metadata before refreshing. */
  installBundle(input: SkillsWriteInstallBundleInput): Promise<SkillsWriteInstallBundleResult>;
  refreshSnapshot(workspaceDir: string): number;
};
