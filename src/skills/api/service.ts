import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  writeWorkspaceSkill,
  type WorkspaceSkillWriteRollback,
} from "../lifecycle/workspace-skill-write.js";
import { parseFrontmatter } from "../loading/frontmatter.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "../loading/symlink-targets.js";
import {
  assertSkillContentSize,
  resolveMaxSkillFileBytes,
  validateSkillDescription,
  validateSkillName,
} from "../loading/validation.js";
import { resolveSkillWorkshopConfig } from "../workshop/config.js";
import { scanProposalBundle } from "../workshop/proposal-scan.js";
import { applySkillProposal, proposeCreateSkill, proposeUpdateSkill } from "../workshop/service.js";
import { prepareSkillProposalSupportFiles, withSkillTargetLock } from "../workshop/store.js";
import type { SkillProposalReadResult } from "../workshop/types.js";
import { refreshSkillsSnapshot } from "./refresh.js";
import type {
  SkillsWriteDirectInput,
  SkillsWriteDirectResult,
  SkillsWriteDirectRollback,
  SkillsWriteInstallBundleInput,
  SkillsWriteInstallBundleResult,
  SkillsWriteProposalInput,
  SkillsWriteService,
  SkillsWriteValidationInput,
  SkillsWriteValidationResult,
} from "./types.js";

function assertValidSkillName(name: string): void {
  const errors = validateSkillName(name);
  if (errors.length > 0) {
    throw new Error(`Invalid skill name: ${errors.join("; ")}.`);
  }
}

function assertValidSkillDescription(
  description: string | undefined,
): asserts description is string {
  const errors = validateSkillDescription(description);
  if (errors.length > 0) {
    throw new Error(`Invalid skill description: ${errors.join("; ")}.`);
  }
}

function validateSkillWrite(input: SkillsWriteValidationInput): SkillsWriteValidationResult {
  assertSkillContentSize(input.content, resolveMaxSkillFileBytes(input.config));
  const frontmatter = parseFrontmatter(input.content);
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (!name) {
    throw new Error("Skill frontmatter must include a name.");
  }
  assertValidSkillName(name);
  if (input.name !== undefined && name !== input.name.trim()) {
    throw new Error(`Skill frontmatter name must match target name: ${input.name.trim()}.`);
  }
  assertValidSkillDescription(description);
  const supportFiles = prepareSkillProposalSupportFiles(input.supportFiles);
  return {
    name,
    description,
    scan: scanProposalBundle(input.content, supportFiles, [
      { file: "skill-name", content: name },
      { file: "description", content: description },
    ]),
  };
}

async function proposeSkillWrite(
  input: SkillsWriteProposalInput,
): Promise<SkillProposalReadResult> {
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
  input: Parameters<typeof applySkillProposal>[0],
): ReturnType<typeof applySkillProposal> {
  return await applySkillProposal({ ...input });
}

function buildDirectRollback(
  action: SkillsWriteDirectInput["mode"],
  skillFile: string,
  previous: WorkspaceSkillWriteRollback,
): SkillsWriteDirectRollback {
  return {
    action,
    targetSkillFile: skillFile,
    ...(previous.previousContent !== null
      ? {
          previousContent: previous.previousContent,
          previousContentHash: sha256Hex(previous.previousContent),
        }
      : {}),
    ...(previous.supportFiles.length > 0
      ? {
          supportFiles: previous.supportFiles.map((file) => ({
            path: file.path,
            existed: file.existed,
            ...(file.previousContent !== undefined
              ? {
                  previousContent: file.previousContent,
                  previousContentHash: sha256Hex(file.previousContent),
                }
              : {}),
          })),
        }
      : {}),
  };
}

async function writeSkillDirect(input: SkillsWriteDirectInput): Promise<SkillsWriteDirectResult> {
  const { workspaceDir, config, env, name, content, mode, refresh } = input;
  const supportFiles = input.supportFiles?.map((file) => ({ ...file }));
  const maxSkillFileBytes = resolveMaxSkillFileBytes(config);
  const validation = validateSkillWrite({
    config,
    name,
    content,
    supportFiles,
  });
  if (validation.scan.state !== "clean") {
    throw new Error("Skill write scan failed.");
  }
  const skillDir = path.resolve(workspaceDir, "skills", validation.name);
  const skillFile = path.join(skillDir, "SKILL.md");
  const workshopConfig = resolveSkillWorkshopConfig(config);
  const symlinkPolicy = {
    allowWrites: workshopConfig.allowSymlinkTargetWrites,
    allowedTargetRealPaths: workshopConfig.allowSymlinkTargetWrites
      ? resolveAllowedSkillSymlinkTargetRealPaths(config)
      : [],
  };
  return await withSkillTargetLock(
    skillFile,
    async () => {
      const previous = await writeWorkspaceSkill({
        workspaceDir,
        skillDir,
        skillFile,
        content,
        supportFiles,
        mode,
        // Preserve the existing 1 MiB rollback-read allowance when an operator
        // lowers the loader limit, so a direct update can repair an oversized skill.
        maxPreviousSkillFileBytes: Math.max(1024 * 1024, maxSkillFileBytes),
        symlinkPolicy,
      });
      const snapshotVersion = refresh === false ? undefined : refreshSkillsSnapshot(workspaceDir);
      return {
        targetSkillFile: skillFile,
        scan: validation.scan,
        rollback: buildDirectRollback(mode, skillFile, previous),
        ...(snapshotVersion === undefined ? {} : { snapshotVersion }),
      };
    },
    { env },
  );
}

async function installSkillBundle(
  input: SkillsWriteInstallBundleInput,
): Promise<SkillsWriteInstallBundleResult> {
  // The write service is loaded by Gateway and agent-tool startup; keep archive
  // extraction and install-security machinery cold until an install is requested.
  const { installExtractedSkillRoot, installSkillArchiveFromPath } =
    await import("../lifecycle/archive-install.js");
  if (input.kind === "archive") {
    const { kind: _kind, ...params } = input;
    return await installSkillArchiveFromPath(params);
  }
  const { kind: _kind, ...params } = input;
  return await installExtractedSkillRoot(params);
}

export const skillsWriteService: SkillsWriteService = {
  validate: validateSkillWrite,
  propose: proposeSkillWrite,
  applyProposal: applySkillWriteProposal,
  writeDirect: writeSkillDirect,
  installBundle: installSkillBundle,
  refreshSnapshot: refreshSkillsSnapshot,
};
