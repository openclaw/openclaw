import path from "node:path";
import { resolveSkillSource } from "../loading/source.js";
import type { SkillEntry } from "../types.js";

export type SkillSourceKind =
  | "workspace"
  | "generated"
  | "bundled"
  | "clawhub"
  | "plugin"
  | "extra"
  | "system";

export type SkillWritablePolicy = {
  writable: boolean;
  reason: string;
};

export type SkillTrustInfo = {
  sourceLabel: string;
  sourceKind: SkillSourceKind;
  owner: string;
  writable: boolean;
  writableReason: string;
};

export function classifySkillSourceKind(sourceLabel: string): SkillSourceKind {
  switch (sourceLabel) {
    case "openclaw-workspace":
    case "agents-skills-project":
      return "workspace";
    case "openclaw-managed":
      return "clawhub";
    case "openclaw-bundled":
      return "bundled";
    case "agents-skills-personal":
    case "openclaw-extra":
      return "extra";
    default:
      return "extra";
  }
}

export function resolveSkillOwner(params: {
  sourceKind: SkillSourceKind;
  sourceLabel: string;
  skillPath: string;
}): string {
  if (params.sourceKind === "workspace") {
    return "workspace";
  }
  if (params.sourceKind === "generated") {
    return "workspace";
  }
  if (params.sourceKind === "bundled") {
    return "openclaw-release";
  }
  if (params.sourceKind === "clawhub") {
    return "clawhub";
  }
  if (params.sourceKind === "plugin") {
    return "plugin";
  }
  if (params.sourceKind === "system") {
    return "openclaw-system";
  }
  if (params.sourceLabel === "agents-skills-personal") {
    return "user";
  }
  return path.basename(path.dirname(params.skillPath)) || "extra";
}

export function resolveSkillWritablePolicy(sourceKind: SkillSourceKind): SkillWritablePolicy {
  switch (sourceKind) {
    case "workspace":
    case "generated":
      return { writable: true, reason: "workspace-owned-skill" };
    case "bundled":
      return { writable: false, reason: "release-owned-skill" };
    case "clawhub":
      return { writable: false, reason: "installer-owned-skill" };
    case "plugin":
      return { writable: false, reason: "plugin-owned-skill" };
    case "system":
      return { writable: false, reason: "system-owned-skill" };
    case "extra":
      return { writable: false, reason: "extra-root-load-only" };
  }
  return { writable: false, reason: "unknown-source-load-only" };
}

export function resolveSkillTrustInfo(entry: SkillEntry): SkillTrustInfo {
  const sourceLabel = resolveSkillSource(entry.skill);
  const sourceKind = classifySkillSourceKind(sourceLabel);
  const writable = resolveSkillWritablePolicy(sourceKind);
  return {
    sourceLabel,
    sourceKind,
    owner: resolveSkillOwner({
      sourceKind,
      sourceLabel,
      skillPath: entry.skill.filePath,
    }),
    writable: writable.writable,
    writableReason: writable.reason,
  };
}
