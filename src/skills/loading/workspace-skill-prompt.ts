import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveEffectiveAgentSkillsLimits } from "../discovery/agent-filter.js";
import { isSkillPromptVisible } from "../discovery/skill-index.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { hasUnavailableSkillSecretOwners, isSkillSecretOwnerUnavailable } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import { compactSkillsPromptForContext, escapeSkillXml } from "./skill-contract.js";
import { compactPromptSkills } from "./skill-paths.js";
import { prepareSkillsForPrompt } from "./skill-prompt-limits.js";
import { resolveWorkspaceSkillPromptEntries } from "./workspace-skill-loader.js";

const skillsLogger = createSubsystemLogger("skills");

type WorkspaceSkillBuildOptions = NonNullable<
  Parameters<typeof resolveWorkspaceSkillPromptEntries>[1]
> & {
  preserveEntryOrder?: boolean;
};

export async function buildSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): Promise<SkillSnapshot> {
  const { eligible, skillFilter } = await resolveWorkspaceSkillPromptEntries(workspaceDir, opts);
  const promptEntries = eligible.filter(isSkillPromptVisible);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  const limits = opts?.config?.skills?.limits;
  const agentLimits = resolveEffectiveAgentSkillsLimits(opts?.config, opts?.agentId);
  const prepared = prepareSkillsForPrompt({
    skills: compactPromptSkills(resolvedSkills, {
      config: opts?.config,
      agentId: opts?.agentId,
    }),
    maxSkillsInPrompt: limits?.maxSkillsInPrompt,
    maxSkillsPromptChars: agentLimits?.maxSkillsPromptChars ?? limits?.maxSkillsPromptChars,
    remoteNote,
    preserveOrder: opts?.preserveEntryOrder,
  });
  const byName = new Map(resolvedSkills.map((skill) => [skill.name, skill]));
  return {
    prompt: prepared.prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      gatewayFilePath: entry.skill.fileHost === "gateway" ? entry.skill.filePath : undefined,
      skillKey: resolveSkillKey(entry.skill, entry),
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    ...(opts?.skillOverrides ? { skillOverrides: opts.skillOverrides } : {}),
    ...(opts?.eligibility?.nodeSkills
      ? { nodeSkillsEligibility: opts.eligibility.nodeSkills }
      : {}),
    resolvedSkills: prepared.skills.map((skill) => byName.get(skill.name)!),
    discoverySkills: resolvedSkills,
    version: opts?.snapshotVersion,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}

type ResolveSkillsPromptParams = {
  contextTokenBudget?: number;
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  loadEntries?: () => SkillEntry[] | Promise<SkillEntry[]>;
  preserveEntryOrder?: boolean;
  assertCurrent?: () => void;
};

async function buildSkillsPromptFromEntries(
  params: ResolveSkillsPromptParams,
  entries: SkillEntry[] | undefined,
): Promise<string> {
  if (!entries || entries.length === 0) {
    return "";
  }
  const { prompt } = await buildSkillSnapshot(params.workspaceDir, {
    entries,
    config: params.config,
    agentId: params.agentId,
    eligibility: params.eligibility,
    preserveEntryOrder: params.preserveEntryOrder,
    assertCurrent: params.assertCurrent,
  });
  return prompt.trim() ? prompt : "";
}

async function rebuildAfterUnsafeSnapshot(
  params: ResolveSkillsPromptParams,
  reason: "unsupported-prompt-format" | "legacy-skill-identity" | "invalid-catalog-structure",
): Promise<string> {
  skillsLogger.warn(
    "Cached skills prompt could not be safely filtered; rebuilding from current skill entries.",
    { reason },
  );
  const sourceEntries = params.entries ?? (await params.loadEntries?.());
  const entries = sourceEntries?.filter(
    (entry) => !isSkillSecretOwnerUnavailable(resolveSkillKey(entry.skill, entry)),
  );
  return buildSkillsPromptFromEntries(params, entries);
}

async function resolveSkillsPromptCatalog(params: ResolveSkillsPromptParams): Promise<string> {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (params.skillsSnapshot && !snapshotPrompt) {
    return "";
  }
  const snapshotHasLegacySkillIdentity = params.skillsSnapshot?.skills.some(
    (skill) => !skill.skillKey,
  );
  if (snapshotPrompt) {
    const snapshotHasUnavailableSkill =
      params.skillsSnapshot?.skills.some((skill) =>
        isSkillSecretOwnerUnavailable(skill.skillKey ?? skill.name),
      ) ||
      (snapshotHasLegacySkillIdentity && hasUnavailableSkillSecretOwners());
    if (
      snapshotHasUnavailableSkill &&
      params.skillsSnapshot?.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION
    ) {
      return rebuildAfterUnsafeSnapshot(params, "unsupported-prompt-format");
    }
    if (snapshotHasLegacySkillIdentity && hasUnavailableSkillSecretOwners()) {
      return rebuildAfterUnsafeSnapshot(params, "legacy-skill-identity");
    }
    const unavailableNames = new Set(
      params.skillsSnapshot?.skills
        .filter(
          (skill) => skill.skillKey !== undefined && isSkillSecretOwnerUnavailable(skill.skillKey),
        )
        .map((skill) => escapeSkillXml(skill.name)),
    );
    if (unavailableNames.size === 0) {
      return snapshotPrompt;
    }
    const catalogOpen = "<available_skills>";
    const catalogClose = "</available_skills>";
    const catalogStart = snapshotPrompt.indexOf(catalogOpen);
    const catalogEnd = snapshotPrompt.indexOf(catalogClose, catalogStart + catalogOpen.length);
    if (
      catalogStart < 0 ||
      catalogEnd < 0 ||
      snapshotPrompt.includes(catalogOpen, catalogStart + catalogOpen.length) ||
      snapshotPrompt.includes(catalogClose, catalogEnd + catalogClose.length)
    ) {
      return rebuildAfterUnsafeSnapshot(params, "invalid-catalog-structure");
    }
    const bodyStart = catalogStart + catalogOpen.length;
    const catalogBody = snapshotPrompt.slice(bodyStart, catalogEnd);
    const blockPattern = /\n[ ]{2}<skill>\n[\s\S]*?\n[ ]{2}<\/skill>/g;
    let cursor = 0;
    let filteredBody = "";
    for (const match of catalogBody.matchAll(blockPattern)) {
      const gap = catalogBody.slice(cursor, match.index);
      const block = match[0];
      const name = /^[ ]{4}<name>(.*)<\/name>$/m.exec(block)?.[1];
      if (gap.trim() || !name) {
        return rebuildAfterUnsafeSnapshot(params, "invalid-catalog-structure");
      }
      filteredBody += gap;
      if (!unavailableNames.has(name)) {
        filteredBody += block;
      }
      cursor = (match.index ?? 0) + block.length;
    }
    const tail = catalogBody.slice(cursor);
    if (tail.trim()) {
      return rebuildAfterUnsafeSnapshot(params, "invalid-catalog-structure");
    }
    return `${snapshotPrompt.slice(0, bodyStart)}${filteredBody}${tail}${snapshotPrompt.slice(catalogEnd)}`.trim();
  }
  return buildSkillsPromptFromEntries(params, params.entries);
}

export async function resolveSkillsPrompt(params: ResolveSkillsPromptParams): Promise<string> {
  return compactSkillsPromptForContext(
    await resolveSkillsPromptCatalog(params),
    params.contextTokenBudget,
  );
}
