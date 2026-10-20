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

export function captureSkillsDiscoveryEnvironment() {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_BUNDLED_SKILLS_DIR: process.env.OPENCLAW_BUNDLED_SKILLS_DIR,
    OPENCLAW_BUNDLED_PLUGINS_DIR: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
    PREFIX: process.env.PREFIX,
    ANDROID_DATA: process.env.ANDROID_DATA,
  };
}

export type SkillsDiscoveryEnvironment = ReturnType<typeof captureSkillsDiscoveryEnvironment>;

export type SkillsSourcePlanInput = {
  workspaceDir: string;
  environment: SkillsDiscoveryEnvironment;
  options?: Omit<WorkspaceSkillSourcePlanOptions, "pluginMetadataSnapshot" | "pluginSkillRoots">;
  pluginContributions?: PluginSkillContribution[];
  acpRuntimeAvailable: boolean;
};

export type SkillsDiscoverySourceSelection =
  | {
      kind: "selected";
      request: WorkspaceSkillSourceRequest;
      plan?: { input: SkillsSourcePlanInput; scope?: "gateway" };
    }
  | {
      kind: "planned";
      request: Omit<WorkspaceSkillSourceRequest, "sourcePlan">;
      plan: { input: SkillsSourcePlanInput };
    };

export type SkillsDiscoveryInput =
  | { kind: "plan"; input: SkillsSourcePlanInput }
  | {
      kind: "scan";
      requests: Array<{
        key: string;
        environment: SkillsDiscoveryEnvironment;
        selection: SkillsDiscoverySourceSelection;
      }>;
      path: string | undefined;
    }
  | {
      kind: "project";
      input: SkillSnapshotProjectionInput;
      environment: SkillsDiscoveryEnvironment;
    }
  | {
      kind: "status";
      input: Parameters<typeof readWorkspaceSkillStatusFacts>[0];
      environment: SkillsDiscoveryEnvironment;
    };

export type SkillsDiscoveryResult = {
  key: string;
  sources: WorkspaceSkillSources;
  fingerprint: string;
  watchDirectories: string[];
  plan?: WorkspaceSkillSourcePlan;
};

export type SkillsDiscoveryOutput =
  | { kind: "plan"; plan: WorkspaceSkillSourcePlan }
  | { kind: "scan"; results: SkillsDiscoveryResult[] }
  | { kind: "project"; snapshot: SkillSnapshot }
  | { kind: "status"; facts: WorkspaceSkillStatusFacts };
