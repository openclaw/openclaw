import type { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import type { WorkspaceSkillStatusFacts } from "../discovery/status.types.js";
import type { PluginSkillContribution } from "../loading/plugin-skills.js";
import type { SkillSnapshotProjectionInput } from "../loading/skill-snapshot-projection.js";
import type { WorkspaceSkillSourcePlanOptions } from "../loading/workspace-skill-sources.js";
import type {
  WorkspaceSkillSourcePlan,
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSources,
} from "../loading/workspace-skill-sources.types.js";
import type { SkillSnapshot } from "../types.js";

export type SkillsSourcePlanInput = {
  workspaceDir: string;
  options?: Omit<WorkspaceSkillSourcePlanOptions, "pluginMetadataSnapshot" | "pluginSkillRoots">;
  pluginContributions?: PluginSkillContribution[];
  acpRuntimeAvailable: boolean;
};

export type SkillsDiscoveryInput =
  | { kind: "plan"; input: SkillsSourcePlanInput }
  | {
      kind: "scan";
      requests: Array<{
        key: string;
        request: WorkspaceSkillSourceRequest;
        plan?: { input: SkillsSourcePlanInput; scope?: "gateway" };
      }>;
      path: string | undefined;
    }
  | { kind: "project"; input: SkillSnapshotProjectionInput }
  | { kind: "status"; input: Parameters<typeof readWorkspaceSkillStatusFacts>[0] };

export type SkillsDiscoveryResult = {
  key: string;
  sources: WorkspaceSkillSources;
  fingerprint: string;
  plan?: WorkspaceSkillSourcePlan;
};

export type SkillsDiscoveryOutput =
  | { kind: "plan"; plan: WorkspaceSkillSourcePlan }
  | { kind: "scan"; results: SkillsDiscoveryResult[] }
  | { kind: "project"; snapshot: SkillSnapshot }
  | { kind: "status"; facts: WorkspaceSkillStatusFacts };
