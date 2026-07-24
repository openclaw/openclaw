import path from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import {
  assertInsideWorkspace,
  assertWorkspaceSkillWriteTarget,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
} from "../lifecycle/workspace-skill-write.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "../loading/symlink-targets.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { isProposalInWorkspace, readRequiredProposal } from "./service-query.js";
import {
  hashSkillProposalContent,
  readProposalSupportFiles,
  SkillProposalIntegrityError,
  type PreparedSkillProposalSupportFile,
} from "./store.js";
import type {
  SkillProposalReadResult,
  SkillProposalReviewResult,
  SkillProposalSupportFile,
} from "./types.js";

const MAX_SKILL_PROPOSAL_REVIEW_DIFF_BYTES = 512 * 1024;
const MAX_SKILL_PROPOSAL_REVIEW_EDIT_LENGTH = 20_000;
const MAX_SKILL_PROPOSAL_REVIEW_DIFF_MS = 250;

type SkillProposalReviewDiffFile = {
  oldFileName: string;
  newFileName: string;
  oldContent: string;
  newContent: string;
};

type SkillProposalReviewTargetRead =
  | { content: string | null }
  | { reason: "target-changed" | "target-missing" };

/** Returns the exact skill content for creates or a bounded live-target diff for updates. */
export async function reviewSkillProposal(input: {
  workspaceDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  proposalId: string;
}): Promise<SkillProposalReviewResult> {
  let read: SkillProposalReadResult;
  try {
    read = await readRequiredProposal(input.proposalId, input.workspaceDir, input.env);
  } catch (error) {
    if (
      error instanceof SkillProposalIntegrityError &&
      error.record &&
      isProposalInWorkspace(error.record, input.workspaceDir)
    ) {
      return { record: error.record, mode: "unavailable", reason: "proposal-changed" };
    }
    throw error;
  }
  const { record, content } = read;
  assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
  assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");
  if (hashSkillProposalContent(content) !== record.draftHash) {
    return { record, mode: "unavailable", reason: "proposal-changed" };
  }

  let supportFiles: PreparedSkillProposalSupportFile[];
  try {
    supportFiles = await readProposalSupportFiles(record, input.env ? { env: input.env } : {});
  } catch (error) {
    if (error instanceof SkillProposalIntegrityError) {
      return { record, mode: "unavailable", reason: "proposal-changed" };
    }
    throw error;
  }
  const proposedContent = stripProposalFrontmatterForSkill(content);
  const symlinkPolicy = resolveSkillWorkshopSymlinkPolicy(input.config);
  const skillTarget = await readReviewTarget(
    async () => {
      await assertWorkspaceSkillWriteTarget({
        workspaceDir: input.workspaceDir,
        filePath: record.target.skillFile,
        symlinkPolicy,
      });
      return await readWorkspaceSkillFile(record.target.skillFile);
    },
    record.kind === "update" ? "target-missing" : undefined,
  );
  if ("reason" in skillTarget) {
    return { record, mode: "unavailable", reason: skillTarget.reason };
  }
  const currentContent = skillTarget.content;
  if (record.kind === "create") {
    if (currentContent !== null) {
      return { record, mode: "unavailable", reason: "target-changed" };
    }
    for (const file of supportFiles) {
      const supportTarget = await readReviewTarget(async () => {
        await assertWorkspaceSkillWriteTarget({
          workspaceDir: input.workspaceDir,
          filePath: path.join(record.target.skillDir, ...file.path.split("/")),
          symlinkPolicy,
        });
        return await readWorkspaceSupportFile({
          skillDir: record.target.skillDir,
          relativePath: file.path,
        });
      });
      if ("reason" in supportTarget) {
        return { record, mode: "unavailable", reason: supportTarget.reason };
      }
      if (supportTarget.content !== null) {
        return { record, mode: "unavailable", reason: "target-changed" };
      }
    }
    return {
      record,
      mode: "full",
      content: proposedContent,
      supportFiles: supportFiles.map((file) => ({ path: file.path, content: file.content })),
    };
  }
  if (currentContent === null) {
    return { record, mode: "unavailable", reason: "target-missing" };
  }
  if (
    record.target.currentContentHash &&
    hashSkillProposalContent(currentContent) !== record.target.currentContentHash
  ) {
    return { record, mode: "unavailable", reason: "target-changed" };
  }

  const diffFiles: SkillProposalReviewDiffFile[] = [
    {
      oldFileName: "SKILL.md",
      newFileName: "SKILL.md",
      oldContent: currentContent,
      newContent: proposedContent,
    },
  ];
  for (const file of supportFiles) {
    const supportTarget = await readReviewTarget(async () => {
      await assertWorkspaceSkillWriteTarget({
        workspaceDir: input.workspaceDir,
        filePath: path.join(record.target.skillDir, ...file.path.split("/")),
        symlinkPolicy,
      });
      return await readWorkspaceSupportFile({
        skillDir: record.target.skillDir,
        relativePath: file.path,
      });
    });
    if ("reason" in supportTarget) {
      return { record, mode: "unavailable", reason: supportTarget.reason };
    }
    const currentSupportContent = supportTarget.content;
    const supportRecord = record.supportFiles?.find((entry) => entry.path === file.path);
    if (supportRecord && hasSupportTargetChanged(supportRecord, currentSupportContent)) {
      return { record, mode: "unavailable", reason: "target-changed" };
    }
    diffFiles.push({
      oldFileName: currentSupportContent === null ? "/dev/null" : file.path,
      newFileName: file.path,
      oldContent: currentSupportContent ?? "",
      newContent: file.content,
    });
  }
  const diff = createReviewDiff(diffFiles);
  return diff === undefined
    ? { record, mode: "unavailable", reason: "diff-limit" }
    : { record, mode: "diff", diff };
}

function resolveSkillWorkshopSymlinkPolicy(config?: OpenClawConfig) {
  const workshopConfig = resolveSkillWorkshopConfig(config);
  return {
    allowWrites: workshopConfig.allowSymlinkTargetWrites,
    allowedTargetRealPaths: workshopConfig.allowSymlinkTargetWrites
      ? resolveAllowedSkillSymlinkTargetRealPaths(config)
      : [],
  };
}

async function readReviewTarget(
  read: () => Promise<string | null>,
  missingReason?: "target-missing",
): Promise<SkillProposalReviewTargetRead> {
  try {
    return { content: await read() };
  } catch (error) {
    if (error instanceof FsSafeError && error.category === "policy") {
      if (error.code === "not-found") {
        return missingReason ? { reason: missingReason } : { content: null };
      }
      return { reason: "target-changed" };
    }
    throw error;
  }
}

function createReviewDiff(files: readonly SkillProposalReviewDiffFile[]): string | undefined {
  const deadline = Date.now() + MAX_SKILL_PROPOSAL_REVIEW_DIFF_MS;
  const patches: string[] = [];
  let sizeBytes = 0;
  for (const file of files) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) {
      return undefined;
    }
    const patch = createReviewPatch(file, timeout);
    if (patch === undefined) {
      return undefined;
    }
    if (!patch) {
      continue;
    }
    sizeBytes += Buffer.byteLength(patch, "utf8") + (patches.length > 0 ? 1 : 0);
    if (sizeBytes > MAX_SKILL_PROPOSAL_REVIEW_DIFF_BYTES) {
      return undefined;
    }
    patches.push(patch);
  }
  return patches.join("\n");
}

function createReviewPatch(file: SkillProposalReviewDiffFile, timeout: number): string | undefined {
  if (file.oldFileName === file.newFileName && file.oldContent === file.newContent) {
    return "";
  }
  return createTwoFilesPatch(
    file.oldFileName,
    file.newFileName,
    file.oldContent,
    file.newContent,
    undefined,
    undefined,
    {
      context: 4,
      headerOptions: FILE_HEADERS_ONLY,
      maxEditLength: MAX_SKILL_PROPOSAL_REVIEW_EDIT_LENGTH,
      timeout,
    },
  );
}

function hasSupportTargetChanged(
  file: SkillProposalSupportFile,
  currentContent: string | null,
): boolean {
  if (file.targetExisted === false) {
    return currentContent !== null;
  }
  if (file.targetExisted === true) {
    return (
      currentContent === null || hashSkillProposalContent(currentContent) !== file.targetContentHash
    );
  }
  return false;
}
