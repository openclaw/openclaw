/** Doctor checks and repair prompts for unavailable configured skills. */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ensureAbsoluteDirectory,
  findExistingAncestor,
  sanitizeUntrustedFileName,
} from "../infra/fs-safe.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import { resolveWorkspaceSkillInstallDir } from "../skills/lifecycle/archive-install.js";
import {
  resolveClawHubSkillStatusLinkSync,
  untrackClawHubSkill,
  type ClawHubSkillStatusLink,
} from "../skills/lifecycle/clawhub.js";
import {
  detectGhConfigDirMismatch,
  formatGhConfigDirMismatchHint,
  type GhConfigDiscoveryInput,
  type GhConfigDiscoveryResult,
} from "../skills/lifecycle/gh-config-discovery.js";
import {
  collectClawHubVerdictTargets,
  fetchOpenClawSkillSecurityVerdicts,
} from "../skills/security/clawhub-verdicts.js";
import { CONFIG_DIR, shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  collectUnavailableAgentSkills,
  disableUnavailableSkillsInConfig,
} from "./doctor-skills-core.js";

export {
  collectUnavailableAgentSkills,
  disableUnavailableSkillsInConfig,
} from "./doctor-skills-core.js";

type RevokedClawHubSkillCandidate = {
  workspaceDir: string;
  skillDir: string;
  skillKey: string;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
};

type QuarantineResult =
  | { ok: true; quarantinePath: string; lockWarning?: string }
  | { ok: false; error: string };

function revocationTupleKey(registry: string, slug: string, version: string): string {
  return `${registry}\0${slug}\0${version}`;
}

function isConfirmedRevocationVerdict(
  item: Awaited<ReturnType<typeof fetchOpenClawSkillSecurityVerdicts>>[number],
): boolean {
  const revoked = (item.revocation as { revoked?: unknown } | null | undefined)?.revoked;
  const ok = (item as { ok?: unknown }).ok;
  return (
    typeof revoked === "boolean" &&
    revoked &&
    typeof ok === "boolean" &&
    !ok &&
    item.decision === "fail" &&
    Array.isArray(item.reasons) &&
    item.reasons.includes("version.revoked") &&
    !item.error &&
    typeof item.requestedSlug === "string" &&
    typeof item.requestedVersion === "string"
  );
}

function isPathInsideOrEqual(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isSameLinkedInstall(
  candidate: RevokedClawHubSkillCandidate,
  link: ClawHubSkillStatusLink | undefined,
): boolean {
  return Boolean(
    link &&
    link.status === "linked" &&
    link.valid &&
    link.registry === candidate.registry &&
    link.slug === candidate.slug &&
    link.installedVersion === candidate.installedVersion &&
    link.installedAt === candidate.installedAt,
  );
}

function collectRevokedSkillScan(params: { cfg: OpenClawConfig }): {
  candidates: RevokedClawHubSkillCandidate[];
  targets: Array<{ registry: string; slug: string; version: string }>;
} {
  const roots = new Map<string, { workspaceDir: string; agentId?: string }>();
  for (const agentId of listAgentIds(params.cfg)) {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    roots.set(path.resolve(workspaceDir), { workspaceDir, agentId });
  }
  roots.set(path.resolve(CONFIG_DIR), { workspaceDir: CONFIG_DIR });

  const candidates = new Map<string, RevokedClawHubSkillCandidate>();
  const targets = new Map<string, { registry: string; slug: string; version: string }>();
  for (const root of roots.values()) {
    const report: SkillStatusReport = buildWorkspaceSkillStatus(root.workspaceDir, {
      config: params.cfg,
      ...(root.agentId ? { agentId: root.agentId } : {}),
    });
    const reportTargets = new Set(
      collectClawHubVerdictTargets(report).map((target) => {
        const key = revocationTupleKey(target.registry, target.slug, target.version);
        targets.set(key, target);
        return key;
      }),
    );
    for (const skill of report.skills) {
      const link = skill.clawhub;
      if (!link || link.status !== "linked" || !link.valid) {
        continue;
      }
      const key = revocationTupleKey(link.registry, link.slug, link.installedVersion);
      if (!reportTargets.has(key)) {
        continue;
      }
      candidates.set(path.resolve(skill.baseDir), {
        workspaceDir: root.workspaceDir,
        skillDir: skill.baseDir,
        skillKey: skill.skillKey,
        registry: link.registry,
        slug: link.slug,
        installedVersion: link.installedVersion,
        installedAt: link.installedAt,
      });
    }
  }
  return { candidates: [...candidates.values()], targets: [...targets.values()] };
}

async function quarantineRevokedClawHubSkill(
  candidate: RevokedClawHubSkillCandidate,
): Promise<QuarantineResult> {
  try {
    const expectedSkillDir = resolveWorkspaceSkillInstallDir(
      candidate.workspaceDir,
      candidate.slug,
    );
    if (path.resolve(expectedSkillDir) !== path.resolve(candidate.skillDir)) {
      return { ok: false, error: "installed path no longer matches the tracked slug" };
    }

    const initialLink = resolveClawHubSkillStatusLinkSync({
      workspaceDir: candidate.workspaceDir,
      skillDir: candidate.skillDir,
      skillKey: candidate.skillKey,
    });
    if (!isSameLinkedInstall(candidate, initialLink)) {
      return { ok: false, error: "ClawHub origin or lock identity changed before quarantine" };
    }

    const workspaceRealPath = await fs.realpath(candidate.workspaceDir);
    const skillsRealPath = await fs.realpath(path.join(candidate.workspaceDir, "skills"));
    const skillRealPath = await fs.realpath(candidate.skillDir);
    if (
      !isPathInsideOrEqual(workspaceRealPath, skillsRealPath) ||
      path.dirname(skillRealPath) !== skillsRealPath
    ) {
      return { ok: false, error: "installed path is not a direct child of the active skills root" };
    }

    const quarantineRoot = path.join(candidate.workspaceDir, ".clawhub", "quarantine", "skills");
    const existingAncestor = await findExistingAncestor(quarantineRoot);
    if (!existingAncestor) {
      return { ok: false, error: "unable to resolve a safe quarantine root" };
    }
    const existingAncestorRealPath = await fs.realpath(existingAncestor);
    if (
      !isPathInsideOrEqual(workspaceRealPath, existingAncestorRealPath) ||
      isPathInsideOrEqual(skillsRealPath, existingAncestorRealPath)
    ) {
      return { ok: false, error: "quarantine root must stay outside active skills" };
    }
    const ensured = await ensureAbsoluteDirectory(quarantineRoot, {
      scopeLabel: "the tracked workspace",
      mode: 0o700,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error.message };
    }
    const quarantineRealPath = await fs.realpath(ensured.path);
    if (
      !isPathInsideOrEqual(workspaceRealPath, quarantineRealPath) ||
      isPathInsideOrEqual(skillsRealPath, quarantineRealPath)
    ) {
      return { ok: false, error: "quarantine root must stay outside active skills" };
    }

    const finalLink = resolveClawHubSkillStatusLinkSync({
      workspaceDir: candidate.workspaceDir,
      skillDir: candidate.skillDir,
      skillKey: candidate.skillKey,
    });
    const finalSkillRealPath = await fs.realpath(candidate.skillDir);
    if (!isSameLinkedInstall(candidate, finalLink) || finalSkillRealPath !== skillRealPath) {
      return { ok: false, error: "ClawHub identity or installed path changed before quarantine" };
    }

    const quarantineName = sanitizeUntrustedFileName(
      `${candidate.slug}@${candidate.installedVersion}-${Date.now()}`,
      "revoked-skill",
    );
    const quarantinePath = path.join(quarantineRealPath, quarantineName);
    await fs.rename(skillRealPath, quarantinePath);
    try {
      await untrackClawHubSkill(candidate.workspaceDir, candidate.slug);
      return { ok: true, quarantinePath };
    } catch (error) {
      return {
        ok: true,
        quarantinePath,
        lockWarning: `skill moved but lock update failed: ${formatErrorMessage(error)}`,
      };
    }
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

export async function maybeRepairRevokedClawHubSkills(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<void> {
  const scan = collectRevokedSkillScan({ cfg: params.cfg });
  if (scan.targets.length === 0) {
    return;
  }

  let verdicts;
  try {
    verdicts = await fetchOpenClawSkillSecurityVerdicts(scan.targets);
  } catch (error) {
    note(
      `Unable to check exact installed skill versions: ${formatErrorMessage(error)}\nNo skills were changed.`,
      "ClawHub revocations",
    );
    return;
  }

  const revokedKeys = new Set(
    verdicts
      .filter(isConfirmedRevocationVerdict)
      .map((item) => revocationTupleKey(item.registry, item.requestedSlug, item.requestedVersion)),
  );
  const revoked = scan.candidates.filter((candidate) =>
    revokedKeys.has(
      revocationTupleKey(candidate.registry, candidate.slug, candidate.installedVersion),
    ),
  );
  if (revoked.length === 0) {
    return;
  }

  note(
    [
      "ClawHub reports these exact installed skill versions as revoked:",
      ...revoked.map(
        (candidate) =>
          `- ${candidate.slug}@${candidate.installedVersion} (${shortenHomePath(candidate.skillDir)})`,
      ),
      `Quarantine them outside active skills: ${formatCliCommand("openclaw doctor --fix")}`,
    ].join("\n"),
    "Revoked ClawHub skills",
  );
  const shouldQuarantine = await params.prompter.confirmAutoFix({
    message: `Quarantine ${revoked.length} revoked ClawHub skill${revoked.length === 1 ? "" : "s"}?`,
    initialValue: false,
  });
  if (!shouldQuarantine) {
    return;
  }

  const changes: string[] = [];
  for (const candidate of revoked) {
    const result = await quarantineRevokedClawHubSkill(candidate);
    if (!result.ok) {
      changes.push(
        `- Kept ${candidate.slug}@${candidate.installedVersion} active: ${result.error}`,
      );
      continue;
    }
    changes.push(
      `- Quarantined ${candidate.slug}@${candidate.installedVersion} to ${shortenHomePath(result.quarantinePath)}`,
    );
    if (result.lockWarning) {
      changes.push(`  ${result.lockWarning}`);
    }
  }
  note(changes.join("\n"), "Doctor changes");
}

function formatMissingSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ") || "unknown requirement";
}

function formatInstallHints(skill: SkillStatusEntry): string[] {
  if (skill.install.length === 0) {
    return [];
  }
  return skill.install.slice(0, 2).map((entry) => `  install option: ${entry.label}`);
}

function defaultGhConfigDiscoveryInput(): GhConfigDiscoveryInput {
  return {
    platform: process.platform,
    env: process.env as GhConfigDiscoveryInput["env"],
    fileExists: (absolutePath) => existsSync(absolutePath),
  };
}

/** Builds a GitHub CLI config-dir hint for eligible GitHub skill setups. */
export function describeGhConfigDirHint(skills: SkillStatusEntry[]): string[] {
  return describeGhConfigDirHintFromDiscovery(skills, defaultGhConfigDiscoveryInput());
}

/** Builds a GitHub CLI config-dir hint from injected discovery inputs for tests. */
export function describeGhConfigDirHintFromDiscovery(
  skills: SkillStatusEntry[],
  discoveryInput: GhConfigDiscoveryInput,
): string[] {
  const githubSkill = skills.find((skill) => skill.name === "github");
  if (!githubSkill) {
    return [];
  }
  if (
    !githubSkill.eligible ||
    githubSkill.blockedByAgentFilter ||
    githubSkill.disabled ||
    githubSkill.blockedByAllowlist
  ) {
    return [];
  }
  const result: GhConfigDiscoveryResult = detectGhConfigDirMismatch(discoveryInput);
  if (result.kind !== "mismatch") {
    return [];
  }
  return formatGhConfigDirMismatchHint(result);
}

/** Formats doctor note lines for skills that are allowed but unavailable. */
export function formatUnavailableSkillDoctorLines(skills: SkillStatusEntry[]): string[] {
  const lines: string[] = [
    "Some skills are allowed for this agent but are not usable in the current runtime environment.",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${formatMissingSummary(skill)}`);
    lines.push(...formatInstallHints(skill));
  }
  lines.push(`Disable unused skills: ${formatCliCommand("openclaw doctor --fix")}`);
  lines.push(
    `Inspect details: ${formatCliCommand("openclaw skills check --agent <id>")} or ${formatCliCommand("openclaw skills info <name> --agent <id>")}`,
  );
  return lines;
}

/** Checks default-agent skill readiness and optionally disables unavailable skills in config. */
export async function maybeRepairSkillReadiness(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<OpenClawConfig> {
  await maybeRepairRevokedClawHubSkills(params);

  const agentId = resolveDefaultAgentId(params.cfg);
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: params.cfg,
    agentId,
  });
  const githubHint = describeGhConfigDirHint(report.skills);
  if (githubHint.length > 0) {
    note(githubHint.join("\n"), "GitHub CLI");
  }
  const unavailable = collectUnavailableAgentSkills(report);
  if (unavailable.length === 0) {
    return params.cfg;
  }

  note(formatUnavailableSkillDoctorLines(unavailable).join("\n"), "Skills");
  const shouldDisable = await params.prompter.confirmAutoFix({
    message: `Disable ${unavailable.length} unavailable skill${unavailable.length === 1 ? "" : "s"} in config?`,
    initialValue: false,
  });
  if (!shouldDisable) {
    return params.cfg;
  }

  const next = disableUnavailableSkillsInConfig(params.cfg, unavailable);
  note(unavailable.map((skill) => `- Disabled ${skill.name}`).join("\n"), "Doctor changes");
  return next;
}
