// Embedded run entry helpers serialize runtime skill metadata for agent run records.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { prepareSkillLibrarySelection } from "../library/selection.js";
import { resolveSkillRuntimeConfig } from "../loading/runtime-config.js";
import { prepareWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";
import {
  WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  type SkillEligibilityContext,
  type SkillEntry,
  type SkillSnapshot,
} from "../types.js";

/** Resolves skill entries embedded into a run payload into runtime-visible entries. */
export async function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  skillsSnapshot?: SkillSnapshot;
  workspaceOnly?: boolean;
  assertCurrent?: () => void;
}): Promise<{
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
  loadSkillEntries: () => Promise<SkillEntry[]>;
  preserveEntryOrder: boolean;
}> {
  const shouldLoadSkillEntries =
    !params.skillsSnapshot ||
    (Boolean(params.skillsSnapshot.prompt.trim()) && !params.skillsSnapshot.resolvedSkills);
  const config = resolveSkillRuntimeConfig(params.config);
  // Materialized sandbox copies are the sole read root, including lazy rebuilds
  // of hydrated library snapshots that still carry their host provenance.
  const skillRoots = normalizeWorkspaceSkillRoots(
    params.workspaceOnly === true
      ? { agentWorkspaceDir: params.workspaceDir }
      : ((params.skillsSnapshot?.promptFormatVersion === WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION
          ? params.skillsSnapshot.skillRoots
          : undefined) ?? {
          agentWorkspaceDir: params.workspaceDir,
          executionWorkspaceDir: params.executionWorkspaceDir,
        }),
  );
  let cachedSkillEntries: SkillEntry[] | undefined;
  const loadSkillEntries = async (): Promise<SkillEntry[]> => {
    if (cachedSkillEntries) {
      return cachedSkillEntries;
    }
    params.assertCurrent?.();
    const librarySelections =
      params.workspaceOnly !== true ? params.skillsSnapshot?.librarySelections : undefined;
    const libraryCaller = librarySelections?.length
      ? { context: captureOpenClawStateWorkerContext(), assertCurrent: params.assertCurrent }
      : undefined;
    const options = {
      config,
      agentId: params.agentId,
      ...(params.eligibility ? { eligibility: params.eligibility } : {}),
      ...(params.skillsSnapshot?.skillFilter
        ? { skillFilter: params.skillsSnapshot.skillFilter }
        : {}),
      ...(params.skillsSnapshot?.skillOverrides
        ? { skillOverrides: params.skillsSnapshot.skillOverrides }
        : {}),
      ...(params.workspaceOnly === true ? { workspaceOnly: true } : {}),
    };
    const workspaceEntries = await prepareWorkspaceSkills(
      skillRoots.agentWorkspaceDir,
      {
        ...options,
        executionWorkspaceDir: skillRoots.executionWorkspaceDir,
      },
      params.assertCurrent,
    );
    params.assertCurrent?.();
    const libraryEntries = libraryCaller
      ? await prepareSkillLibrarySelection(
          librarySelections!,
          { env: libraryCaller.context.environment },
          libraryCaller,
        )
      : undefined;
    params.assertCurrent?.();
    cachedSkillEntries = libraryEntries
      ? [...workspaceEntries, ...libraryEntries]
      : workspaceEntries;
    return cachedSkillEntries;
  };
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries ? await loadSkillEntries() : [],
    loadSkillEntries,
    // Merged loading orders agent skills first so prompt caps keep their priority.
    preserveEntryOrder: skillRoots.executionWorkspaceDir !== undefined,
  };
}
