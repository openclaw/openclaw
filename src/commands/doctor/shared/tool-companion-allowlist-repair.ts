import { expandToolGroups, normalizeToolList } from "../../../agents/tool-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentToolsConfig, ToolsConfig } from "../../../config/types.tools.js";

type ToolConfigLike = ToolsConfig | AgentToolsConfig;

type ToolCompanionFinding = {
  path: string;
  additions: string[];
};

function hasExplicitToolSection(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function companionAdditionsForTools(params: {
  tools: ToolConfigLike | undefined;
  profile?: string;
  inheritedExec?: unknown;
  inheritedFs?: unknown;
}): string[] {
  if (params.profile !== "messaging" && params.profile !== "minimal") {
    return [];
  }
  const alsoAllow = Array.isArray(params.tools?.alsoAllow) ? params.tools.alsoAllow : undefined;
  if (!alsoAllow || alsoAllow.length === 0) {
    return [];
  }

  const normalized = normalizeToolList(alsoAllow);
  const expanded = new Set(expandToolGroups(alsoAllow));
  const additions: string[] = [];
  const hasExecConfig =
    hasExplicitToolSection(params.tools?.exec) || hasExplicitToolSection(params.inheritedExec);
  const hasFsConfig =
    hasExplicitToolSection(params.tools?.fs) || hasExplicitToolSection(params.inheritedFs);

  if (hasExecConfig && normalized.includes("exec") && !expanded.has("process")) {
    additions.push("process");
  }
  if (hasFsConfig && normalized.includes("write") && !expanded.has("edit")) {
    additions.push("edit");
  }
  return additions;
}

function collectToolCompanionFindings(cfg: OpenClawConfig): ToolCompanionFinding[] {
  const findings: ToolCompanionFinding[] = [];
  const globalAdditions = companionAdditionsForTools({
    tools: cfg.tools,
    profile: cfg.tools?.profile,
  });
  if (globalAdditions.length > 0) {
    findings.push({ path: "tools.alsoAllow", additions: globalAdditions });
  }

  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const additions = companionAdditionsForTools({
      tools: agent.tools,
      profile: agent.tools?.profile ?? cfg.tools?.profile,
      inheritedExec: cfg.tools?.exec,
      inheritedFs: cfg.tools?.fs,
    });
    if (additions.length > 0) {
      findings.push({ path: `agents.list[${index}].tools.alsoAllow`, additions });
    }
  }

  return findings;
}

function formatAdditions(additions: string[]): string {
  return additions.map((value) => `"${value}"`).join(", ");
}

export function collectToolCompanionAllowlistWarnings(
  cfg: OpenClawConfig,
  doctorFixCommand: string,
): string[] {
  return collectToolCompanionFindings(cfg).map(
    (finding) =>
      `- ${finding.path}: add ${formatAdditions(
        finding.additions,
      )} so restricted profiles that already allow exec/write also expose the companion runtime/edit tools. Run "${doctorFixCommand}" to repair.`,
  );
}

export function maybeRepairToolCompanionAllowlists(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const findings = collectToolCompanionFindings(cfg);
  if (findings.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];
  for (const finding of findings) {
    const target =
      finding.path === "tools.alsoAllow"
        ? next.tools
        : next.agents?.list?.[Number(finding.path.match(/^agents\.list\[(\d+)\]/)?.[1])]?.tools;
    if (!target) {
      continue;
    }
    const current = Array.isArray(target.alsoAllow) ? target.alsoAllow : [];
    const merged = [...current];
    for (const addition of finding.additions) {
      if (!normalizeToolList(merged).includes(addition)) {
        merged.push(addition);
      }
    }
    target.alsoAllow = merged;
    changes.push(`Added ${formatAdditions(finding.additions)} to ${finding.path}.`);
  }

  return { config: next, changes };
}
