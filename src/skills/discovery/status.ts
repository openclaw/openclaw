import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../../shared/entry-status.js";
import { CONFIG_DIR } from "../../utils.js";
import { loadSkillLibrarySelection } from "../library/selection.js";
import { resolveBundledSkillsDir } from "../loading/bundled-dir.js";
import {
  hasBinary,
  isBundledSkillAllowed,
  isSkillEnvRequirementSatisfied,
  isSkillConfigPathTruthy,
  resolveBundledAllowlist,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
} from "../loading/config.js";
import { resolveSkillKey } from "../loading/frontmatter.js";
import { resolveSkillSource } from "../loading/source.js";
import {
  loadWorkspaceSkills,
  prepareWorkspaceSkillEntries,
} from "../loading/workspace-skill-loader.js";
import type { WorkspaceSkillSources } from "../loading/workspace-skill-sources.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import type {
  SkillEntry,
  SkillEligibilityContext,
  SkillInstallSpec,
  SkillsInstallPreferences,
  SkillSnapshot,
} from "../types.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import {
  isSkillPromptVisible,
  isSkillUserInvocable,
  normalizeSkillIndexName,
} from "./skill-index.js";
import { readWorkspaceSkillStatusFacts } from "./status-files.js";
import type {
  SkillInstallOption,
  SkillStatusEntry,
  SkillStatusReport,
  WorkspaceSkillStatusFacts,
} from "./status.types.js";
export type { SkillStatusEntry, SkillStatusReport } from "./status.types.js";

/** Missing prerequisites exclude intentional disablement and are independent of agent exposure. */
export function hasMissingSkillRequirements(
  skill: Pick<SkillStatusEntry, "eligible" | "disabled" | "blockedByAllowlist">,
): boolean {
  return !skill.eligible && !skill.disabled && !skill.blockedByAllowlist;
}

const skillsLogger = createSubsystemLogger("skills");
let hasWarnedMissingBundledDir = false;

export function resolveSkillStatusEntry<T extends Pick<SkillStatusEntry, "name" | "skillKey">>(
  skills: readonly T[],
  requestedName: string,
): T | null {
  const raw = requestedName.trim();
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();
  const normalized = normalizeSkillIndexName(raw);
  // Names outrank metadata aliases. A tie at the strongest matching level
  // must not redirect inspection or Workshop updates to the first loaded skill.
  const matchers: Array<(skill: T) => boolean> = [
    (skill) => skill.name === raw,
    (skill) => skill.skillKey === raw,
    (skill) => skill.name.toLowerCase() === lower || skill.skillKey.toLowerCase() === lower,
    (skill) =>
      Boolean(normalized) &&
      (normalizeSkillIndexName(skill.name) === normalized ||
        normalizeSkillIndexName(skill.skillKey) === normalized),
  ];
  for (const matches of matchers) {
    const candidates = skills.filter(matches);
    if (candidates.length > 0) {
      return candidates.length === 1 ? candidates[0]! : null;
    }
  }
  return null;
}

function selectPreferredInstallSpec(
  install: SkillInstallSpec[],
  prefs: SkillsInstallPreferences,
  hasLocalBin: typeof hasBinary,
): SkillInstallSpec | undefined {
  const findKind = (kind: SkillInstallSpec["kind"]) => install.find((spec) => spec.kind === kind);

  const brewSpec = findKind("brew");
  const brewAvailable = brewSpec && hasLocalBin("brew");
  return (
    (prefs.preferBrew && brewAvailable ? brewSpec : undefined) ??
    findKind("uv") ??
    findKind("node") ??
    // Only prefer brew when available to avoid guaranteed failure on Linux/Docker.
    (brewAvailable ? brewSpec : undefined) ??
    findKind("go") ??
    // Prefer download over an unavailable brew spec.
    findKind("download") ??
    // Last resort: surface descriptive brew-missing error instead of "no installer found".
    brewSpec ??
    install[0]
  );
}

function normalizeInstallOptions(
  entry: SkillEntry,
  prefs: SkillsInstallPreferences,
  hasLocalBin: typeof hasBinary,
  platform: string,
): SkillInstallOption[] {
  // Recipes execute where the workspace dependencies live.
  const requiredOs = entry.metadata?.os ?? [];
  if (requiredOs.length > 0 && !requiredOs.includes(platform)) {
    return [];
  }

  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  const supportsPlatform = (spec: SkillInstallSpec) => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  };
  const filtered = install.filter(supportsPlatform);
  if (filtered.length === 0) {
    return [];
  }

  const toOption = (spec: SkillInstallSpec, index: number): SkillInstallOption => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();
    if (spec.kind === "node" && spec.package) {
      label = `Install ${spec.package} (${prefs.nodeManager})`;
    }
    if (!label) {
      if (spec.kind === "brew" && spec.formula) {
        label = `Install ${spec.formula} (brew)`;
      } else if (spec.kind === "go" && spec.module) {
        label = `Install ${spec.module} (go)`;
      } else if (spec.kind === "uv" && spec.package) {
        label = `Install ${spec.package} (uv)`;
      } else if (spec.kind === "download" && spec.url) {
        const url = spec.url.trim();
        const last = url.split("/").pop();
        label = `Download ${last && last.length > 0 ? last : url}`;
      } else {
        label = "Run installer";
      }
    }
    return { id, kind: spec.kind, label, bins };
  };

  const allDownloads = filtered.every((spec) => spec.kind === "download");
  if (allDownloads) {
    const options: SkillInstallOption[] = [];
    for (const [index, spec] of install.entries()) {
      if (supportsPlatform(spec)) {
        options.push(toOption(spec, index));
      }
    }
    return options;
  }

  const preferred = selectPreferredInstallSpec(filtered, prefs, hasLocalBin);
  if (!preferred) {
    return [];
  }
  // installSkill resolves implicit IDs in the original metadata list, before OS filtering.
  return [toOption(preferred, install.indexOf(preferred))];
}

type SkillRequirementsContext = {
  config?: OpenClawConfig;
  hasWorkspaceBin: typeof hasBinary;
  platform: string;
  eligibility?: SkillEligibilityContext;
  allowBundled: ReadonlySet<string> | undefined;
};

type BuildSkillStatusContext = Readonly<
  SkillRequirementsContext & {
    prefs: SkillsInstallPreferences;
    agentSkillSet: ReadonlySet<string> | undefined;
    files: WorkspaceSkillStatusFacts["files"];
  }
>;

function buildSkillRequirements(entry: SkillEntry, context: SkillRequirementsContext) {
  const skillKey = resolveSkillKey(entry.skill, entry);
  const { config, eligibility, allowBundled } = context;
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const always = entry.metadata?.always === true;
  const isEnvSatisfied = (envName: string) =>
    isSkillEnvRequirementSatisfied({
      envName,
      skillConfig,
      primaryEnv: entry.metadata?.primaryEnv,
    });
  const isConfigSatisfied = (pathStr: string) => isSkillConfigPathTruthy(config, pathStr);

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always,
      entry,
      hasLocalBin: context.hasWorkspaceBin,
      platform: context.platform,
      remote: eligibility?.remote,
      isEnvSatisfied,
      isConfigSatisfied,
    });
  const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;
  return {
    skillKey,
    always,
    disabled,
    blockedByAllowlist,
    eligible,
    emoji,
    homepage,
    required,
    missing,
    configChecks,
  };
}

function buildSkillStatus(entry: SkillEntry, context: BuildSkillStatusContext): SkillStatusEntry {
  const { prefs, agentSkillSet } = context;
  const { required, ...requirements } = buildSkillRequirements(entry, context);
  const blockedByAgentFilter = agentSkillSet !== undefined && !agentSkillSet.has(entry.skill.name);
  const skillSource = resolveSkillSource(entry.skill);
  // Loader provenance owns bundled status; a matching name cannot establish source.
  const bundled = skillSource === "openclaw-bundled" || skillSource === "openclaw-custodian";
  const availableToAgent = requirements.eligible && !blockedByAgentFilter;
  const userInvocable = isSkillUserInvocable(entry);

  const fileFacts = context.files.find(
    (facts) => facts.name === entry.skill.name && facts.filePath === entry.skill.filePath,
  );
  const clawhub = fileFacts?.clawhub;
  const card = fileFacts?.skillCard;
  // Card bodies belong to skills.skillCard, not the inventory response.
  const skillCard = card
    ? { present: true as const, path: card.path, sizeBytes: card.sizeBytes }
    : undefined;

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: skillSource,
    bundled,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    ...requirements,
    primaryEnv: entry.metadata?.primaryEnv,
    blockedByAgentFilter,
    // The evaluator includes remote OS eligibility.
    platformIncompatible: requirements.missing.os.length > 0,
    modelVisible: availableToAgent && isSkillPromptVisible(entry),
    userInvocable,
    commandVisible: availableToAgent && userInvocable,
    requirements: required,
    install: normalizeInstallOptions(entry, prefs, context.hasWorkspaceBin, context.platform),
    ...(clawhub ? { clawhub } : {}),
    ...(skillCard ? { skillCard } : {}),
  };
}

type WorkspaceSkillStatusOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  entries?: SkillEntry[];
  eligibility?: SkillEligibilityContext;
  agentId?: string;
};

function prepareWorkspaceSkillRequirements(
  workspaceDir: string,
  opts?: WorkspaceSkillStatusOptions & { runtime?: WorkspaceSkillSources["runtime"] },
) {
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledSkillsDir = resolveBundledSkillsDir();
  if (!bundledSkillsDir && !hasWarnedMissingBundledDir) {
    hasWarnedMissingBundledDir = true;
    skillsLogger.warn(
      "Bundled skills directory could not be resolved; built-in skills may be missing.",
    );
  }
  const agentSkillFilter = opts?.agentId
    ? resolveEffectiveAgentSkillFilter(opts.config, opts.agentId)
    : undefined;
  // Status reports every skill (disabled/ineligible included) with flags, so
  // the loader must stay unfiltered; node-hosted skills merge in separately.
  const skillEntries = mergeRemoteNodeSkillEntries(
    opts?.entries ??
      loadWorkspaceSkills(workspaceDir, {
        config: opts?.config,
        // agentId scopes custodian-source discovery only; the "ignore" mode
        // keeps the entry list unfiltered per the invariant above.
        agentId: opts?.agentId,
        agentSkillFilter: "ignore",
        managedSkillsDir,
        bundledSkillsDir,
      }),
    {
      canExec: opts?.eligibility?.nodeSkills?.canExec,
      node: opts?.eligibility?.nodeSkills?.node,
    },
  );
  const allowBundled = resolveBundledAllowlist(opts?.config);
  // Missing binaries may appear between reports; reuse probes only within this synchronous read.
  const binaryAvailability = new Map<string, boolean>();
  const hostBins = opts?.runtime ? new Set(opts.runtime.bins) : undefined;
  const hasLocalBin = (bin: string): boolean => {
    let available = binaryAvailability.get(bin);
    if (available === undefined) {
      available = hasBinary(bin);
      binaryAvailability.set(bin, available);
    }
    return available;
  };
  return {
    managedSkillsDir,
    agentSkillFilter,
    skillEntries,
    context: {
      config: opts?.config,
      hasWorkspaceBin: hostBins ? (bin: string) => hostBins.has(bin) : hasLocalBin,
      platform: opts?.runtime?.platform ?? process.platform,
      eligibility: opts?.eligibility,
      allowBundled,
    },
  };
}

/** Assemble status from the workspace host's files and Gateway-owned policy. */
export async function prepareWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: WorkspaceSkillStatusOptions & {
    librarySelections?: SkillSnapshot["librarySelections"];
    skillCardKey?: string;
  },
): Promise<{ report: SkillStatusReport; files: WorkspaceSkillStatusFacts["files"] }> {
  const { eligibility: _eligibility, ...loadOptions } = opts ?? {};
  const sources = await prepareWorkspaceSkillEntries(workspaceDir, {
    ...loadOptions,
    agentSkillFilter: "ignore",
    status: { skillCardKey: opts?.skillCardKey },
  });
  if (sources.runtime && !sources.status) {
    throw new Error("Remote workspace skill status is unavailable");
  }
  const localEntries = sources.status
    ? [
        ...loadSkillLibrarySelection(opts?.librarySelections ?? []),
        ...sources.entries.filter((entry) => entry.skill.fileHost === "gateway"),
      ]
    : sources.entries;
  const localFacts =
    localEntries.length || !sources.status
      ? readWorkspaceSkillStatusFacts({
          entries: localEntries,
          workspaceDir,
          managedSkillsDir: opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills"),
          skillCardKey: opts?.skillCardKey,
        })
      : undefined;
  const hostPaths = new Set(
    sources.entries
      .filter((entry) => entry.skill.fileHost === "workspace")
      .map((entry) => entry.skill.filePath),
  );
  const files = [
    ...(sources.status?.files.filter((file) => hostPaths.has(file.filePath)) ?? []),
    ...(localFacts?.files ?? []),
  ];
  return {
    report: buildWorkspaceSkillStatus(workspaceDir, {
      ...opts,
      entries: sources.entries,
      files,
      runtime: sources.runtime,
    }),
    files,
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: WorkspaceSkillStatusOptions & {
    files?: WorkspaceSkillStatusFacts["files"];
    runtime?: WorkspaceSkillSources["runtime"];
  },
): SkillStatusReport {
  const { managedSkillsDir, agentSkillFilter, skillEntries, context } =
    prepareWorkspaceSkillRequirements(workspaceDir, opts);
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  const files =
    opts?.files ??
    readWorkspaceSkillStatusFacts({
      entries: skillEntries,
      workspaceDir,
      managedSkillsDir,
    }).files;
  const statusContext: BuildSkillStatusContext = {
    ...context,
    prefs,
    agentSkillSet: agentSkillFilter === undefined ? undefined : new Set(agentSkillFilter),
    files,
  };
  return {
    workspaceDir,
    managedSkillsDir,
    agentId: opts?.agentId,
    agentSkillFilter,
    skills: skillEntries.map((entry) => buildSkillStatus(entry, statusContext)),
  };
}

/** Readiness uses the same discovery and requirements without detailed install metadata. */
export function buildWorkspaceSkillReadiness(
  workspaceDir: string,
  opts?: WorkspaceSkillStatusOptions,
): { workspaceDir: string; eligible: number; missing: number } {
  const { skillEntries, context } = prepareWorkspaceSkillRequirements(workspaceDir, opts);
  let eligible = 0;
  let missing = 0;
  for (const entry of skillEntries) {
    const requirements = buildSkillRequirements(entry, context);
    if (requirements.eligible) {
      eligible += 1;
    }
    if (hasMissingSkillRequirements(requirements)) {
      missing += 1;
    }
  }
  return { workspaceDir, eligible, missing };
}
