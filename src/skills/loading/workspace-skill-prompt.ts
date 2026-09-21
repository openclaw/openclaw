import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveEffectiveAgentSkillsLimits } from "../discovery/agent-filter.js";
import { filterPromptVisibleSkillEntries } from "../discovery/skill-index.js";
import { isSkillSearchEnabled } from "../experimental.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { hasUnavailableSkillSecretOwners, isSkillSecretOwnerUnavailable } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import {
  compactSkillsPromptForContext,
  escapeSkillXml,
  selectPromptSkills,
  type Skill,
} from "./skill-contract.js";
import { compactPromptSkills } from "./skill-paths.js";
import { prepareSkillsForPrompt } from "./skill-prompt-limits.js";
import { resolveWorkspaceSkillPromptEntries } from "./workspace-skill-loader.js";

const skillsLogger = createSubsystemLogger("skills");

type WorkspaceSkillBuildOptions = {
  executionWorkspaceDir?: string;
  librarySelections?: SkillSnapshot["librarySelections"];
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  agentId?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  eligibility?: SkillEligibilityContext;
  preserveEntryOrder?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  assertCurrent?: () => void;
};

async function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): Promise<{
  eligible: SkillEntry[];
  prompt: string;
  resolvedSkills: Skill[];
  skillFilter?: string[];
}> {
  const { eligible, skillFilter } = await resolveWorkspaceSkillPromptEntries(workspaceDir, opts);
  const promptEntries = filterPromptVisibleSkillEntries(eligible);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  // Exposure overrides are resolved above; carry that effective policy into runtime sources.
  const selectedSkills: Skill[] = [];
  for (const { skill } of promptEntries) {
    selectedSkills.push(
      skill.disableModelInvocation ? { ...skill, disableModelInvocation: false } : skill,
    );
  }
  const resolvedSkills = opts?.preserveEntryOrder
    ? selectedSkills
    : selectedSkills.toSorted((a, b) => a.name.localeCompare(b.name, "en"));
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
  const admittedNames = new Set(prepared.skills.map((skill) => skill.name));
  return {
    eligible,
    prompt: prepared.prompt,
    resolvedSkills: isSkillSearchEnabled(opts?.config)
      ? resolvedSkills
      : resolvedSkills.filter((skill) => admittedNames.has(skill.name)),
    skillFilter,
  };
}

export async function buildSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): Promise<SkillSnapshot> {
  const { eligible, prompt, resolvedSkills, skillFilter } = await resolveWorkspaceSkillPromptState(
    workspaceDir,
    opts,
  );
  return {
    prompt,
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
    resolvedSkills,
    version: opts?.snapshotVersion,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
    ...(isSkillSearchEnabled(opts?.config) ? { searchEnabled: true as const } : {}),
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

type SkillsContext = { prompt: string; skills: Skill[] };

async function buildSkillsPromptFromEntries(
  params: ResolveSkillsPromptParams,
  entries: SkillEntry[] | undefined,
): Promise<SkillsContext> {
  if (!entries || entries.length === 0) {
    return { prompt: "", skills: [] };
  }
  const { prompt, resolvedSkills } = await buildSkillSnapshot(params.workspaceDir, {
    entries,
    config: params.config,
    agentId: params.agentId,
    eligibility: params.eligibility,
    skillFilter: params.skillsSnapshot?.skillFilter,
    skillOverrides: params.skillsSnapshot?.skillOverrides,
    preserveEntryOrder: params.preserveEntryOrder,
    assertCurrent: params.assertCurrent,
  });
  return { prompt: prompt.trim() ? prompt : "", skills: resolvedSkills ?? [] };
}

async function rebuildAfterUnsafeSnapshot(
  params: ResolveSkillsPromptParams,
  reason: "unsupported-prompt-format" | "legacy-skill-identity" | "invalid-catalog-structure",
): Promise<SkillsContext> {
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

async function resolveSkillsPromptCatalog(
  params: ResolveSkillsPromptParams,
): Promise<SkillsContext> {
  const snapshot = params.skillsSnapshot;
  const snapshotPrompt = snapshot?.prompt?.trim() ?? "";
  // Cold snapshots retain eligibility identities but omit runtime sources on disk.
  // Hydrate through the same policy owner, never from the presentation subset.
  const hydrated =
    snapshot &&
    !snapshot.resolvedSkills &&
    snapshot.skills.length &&
    (snapshotPrompt || isSkillSearchEnabled(params.config))
      ? await buildSkillsPromptFromEntries(params, params.entries ?? (await params.loadEntries?.()))
      : undefined;
  const availableNames = new Set(
    snapshot?.skills
      .filter((entry) => !isSkillSecretOwnerUnavailable(entry.skillKey ?? entry.name))
      .map((entry) => entry.name),
  );
  const skills = (snapshot?.resolvedSkills ?? hydrated?.skills ?? []).filter(
    (skill) => !skill.disableModelInvocation && availableNames.has(skill.name),
  );
  const snapshotHasLegacySkillIdentity = params.skillsSnapshot?.skills.some(
    (skill) => !skill.skillKey,
  );
  if (snapshot) {
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
    if (!snapshotPrompt) {
      return { prompt: "", skills };
    }
    const unavailableNames = new Set(
      params.skillsSnapshot?.skills
        .filter(
          (skill) => skill.skillKey !== undefined && isSkillSecretOwnerUnavailable(skill.skillKey),
        )
        .map((skill) => escapeSkillXml(skill.name)),
    );
    if (unavailableNames.size === 0) {
      return { prompt: snapshotPrompt, skills };
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
    return {
      prompt:
        `${snapshotPrompt.slice(0, bodyStart)}${filteredBody}${tail}${snapshotPrompt.slice(catalogEnd)}`.trim(),
      skills,
    };
  }
  return buildSkillsPromptFromEntries(params, params.entries);
}

/** Resolve one policy-owned catalog; the prompt is only its bounded projection. */
export async function resolveSkillsContext(
  params: ResolveSkillsPromptParams,
): Promise<SkillsContext> {
  const context = await resolveSkillsPromptCatalog(params);
  return {
    ...context,
    skills: isSkillSearchEnabled(params.config)
      ? context.skills
      : selectPromptSkills(context.prompt, context.skills),
    prompt: compactSkillsPromptForContext(context.prompt, params.contextTokenBudget),
  };
}

export async function resolveSkillsPrompt(params: ResolveSkillsPromptParams): Promise<string> {
  return (await resolveSkillsContext(params)).prompt;
}
