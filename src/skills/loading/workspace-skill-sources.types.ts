import type { WorkspaceSkillStatusFacts } from "../discovery/status.types.js";
import type { SkillEntry } from "../types.js";
import type { PluginSkillRoot } from "./plugin-skill-root.js";

export type ResolvedSkillDiscoveryLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillFileBytes: number;
};

/** Native discovery facts from the workspace host; Gateway retains filtering and policy. */
export type WorkspaceSkillSources = {
  entries: Array<SkillEntry & { sourceOrder?: number }>;
  executionEntries: SkillEntry[];
  runtime: { platform: string; bins: string[] };
  status?: WorkspaceSkillStatusFacts;
};

export type WorkspaceSkillSourceRequest = {
  sourcePlan: WorkspaceSkillSourcePlan;
  /** Direct bundled lookup, before workspace precedence is applied. */
  bundledSkillName?: string;
  executionWorkspaceDir?: string;
  limits: ResolvedSkillDiscoveryLimits;
  /** Requirements from Gateway-owned Library selections also run on the workspace host. */
  additionalBins: string[];
  status?: { skillCardKey?: string };
};

export type WorkspaceSkillSource = {
  dir: string;
  source: string;
  tier: "extra" | "bundled" | "workshop" | "managed" | "personal" | "workspace";
  rejectHardlinks?: boolean;
  /** Original root precedence, retained when discovery is split between hosts. */
  order?: number;
};

export type WorkspaceSkillSourcePlan = {
  workspaceDir: string;
  /** Admitted paths; adapters map them along with the source roots. */
  allowSymlinkTargets?: string[];
  roots: WorkspaceSkillSource[];
  pluginSkillsDir?: string;
  pluginSkillRoots: PluginSkillRoot[];
  managedSkillsDir: string;
  bundledSkillsDir?: string;
  stateDir?: string;
  userHomeDir?: string;
};
