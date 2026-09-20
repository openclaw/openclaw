import path from "node:path";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { prepareBinaryAvailability } from "../../shared/config-eval.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  isSessionSkillEnabled,
  resolveEffectiveAgentSkillFilter,
} from "../discovery/agent-filter.js";
import { normalizeSkillFilter } from "../discovery/filter.js";
import { assertUnambiguousManagedSkillNames } from "../library/command-name.js";
import { loadSkillLibrarySelection } from "../library/selection.js";
import { getSkillsSourceVersion, observeSkillsSnapshotSource } from "../runtime/refresh-state.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { resolveBundledAllowlist, shouldIncludeSkill } from "./config.js";
import { resolveSkillInvocationPolicy, resolveSkillKey } from "./frontmatter.js";
import { loadSingleSkillDirectory } from "./local-loader.js";
import { resolvePluginSkillRoots, resolvePluginSkillRootsFromMetadata } from "./plugin-skills.js";
import type { Skill } from "./skill-contract.js";
import { resolveSkillEntryMetadata } from "./skill-entry-metadata.js";
import {
  compactSkillPath,
  resolvePluginSkillsDir,
  resolveSkillsUserHomeDir,
} from "./skill-paths.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import {
  loadGeneratedPluginSkillRecords,
  loadSkillRootRecords,
  warnInvalidSkill,
  type LoadedSkillRecord,
} from "./skill-root-loader.js";
import { tryRealpath } from "./symlink-targets.js";
import {
  normalizeWorkspaceSkillRoots,
  resolveWorkspaceSkillDirectories,
} from "./workspace-skill-roots.js";

const skillsLogger = createSubsystemLogger("skills");
const CUSTODIAN_SKILLS_DIR_NAME = "custodian-skills";
const MAX_SKILL_ENTRY_CACHE_SIZE = 64;
type SkillCollision = { winner: Skill; loser: Skill };
type LocalSkillTiers = {
  sourceKey: string;
  agent: SkillEntry[];
  execution: SkillEntry[];
  collisions: SkillCollision[];
};
const skillEntryCache = new Map<string, LocalSkillTiers>();
const reportedSkillCollisions = new Set<string>();

type WorkspaceSkillLoadOptions = {
  executionWorkspaceDir?: string;
  librarySelections?: SkillSnapshot["librarySelections"];
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  agentId?: string;
  /**
   * "ignore" keeps agentId scoping source discovery (custodian skills) without
   * activating the agent allowlist filter — status/inventory views need the
   * full entry list so excluded skills stay present-but-marked.
   */
  agentSkillFilter?: "apply" | "ignore";
  eligibility?: SkillEligibilityContext;
  workspaceOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

// Content includes declared frontmatter. Paths identify copies, not new conflicts.
function warnSkillPrecedenceCollisions(collisions: SkillCollision[]): void {
  for (const { winner, loser } of collisions) {
    if (
      winner.contentHash &&
      winner.contentHash === loser.contentHash &&
      winner.name === loser.name &&
      winner.description === loser.description &&
      winner.disableModelInvocation === loser.disableModelInvocation
    ) {
      continue;
    }
    const fingerprint = sha256Hex(
      JSON.stringify(
        [winner, loser].map((skill) => [
          skill.name,
          skill.contentHash ?? skill.filePath,
          skill.description,
          skill.disableModelInvocation,
        ]),
      ),
    );
    if (reportedSkillCollisions.has(fingerprint)) {
      continue;
    }
    reportedSkillCollisions.add(fingerprint);
    warnSkillPrecedenceCollision(winner, loser);
  }
}

function warnSkillPrecedenceCollision(winner: Skill, loser: Skill): void {
  const collisionName = winner.name.slice(0, 128);
  skillsLogger.warn("Skill precedence collision resolved.", {
    skill: collisionName,
    winnerSource: winner.source,
    loserSource: loser.source,
    winnerPath: winner.filePath,
    loserPath: loser.filePath,
    consoleMessage:
      `Skill precedence collision: skill="${collisionName}" ` +
      `winner=${winner.source}:${compactSkillPath(winner.filePath)} ` +
      `loser=${loser.source}:${compactSkillPath(loser.filePath)}`,
  });
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  skillOverrides?: Readonly<Record<string, boolean>>,
  eligibility?: SkillEligibilityContext,
  hasBin?: (bin: string) => boolean,
): SkillEntry[] {
  const bundledAllowlist = resolveBundledAllowlist(config);
  assertUnambiguousManagedSkillNames(entries);
  let filtered = entries.filter((entry) =>
    shouldIncludeSkill({ entry, config, bundledAllowlist, eligibility, hasBin }),
  );
  if (skillFilter !== undefined || skillOverrides !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    const resolvedFilter = skillFilter === undefined ? undefined : normalized;
    filtered = filtered.filter((entry) =>
      isSessionSkillEnabled(
        entry.skill.name,
        resolvedFilter,
        skillOverrides,
        resolveSkillKey(entry.skill, entry),
      ),
    );
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

function createSkillEntry(record: LoadedSkillRecord): SkillEntry {
  const { skill, frontmatter } = record;
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const entry: SkillEntry = {
    skill,
    frontmatter,
    metadata: resolveSkillEntryMetadata({ frontmatter, skillDir: skill.baseDir }),
    invocation,
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
      userInvocable: invocation.userInvocable ?? true,
    },
  };
  if (record.syncSourceDir !== undefined) {
    entry.syncSourceDir = record.syncSourceDir;
  }
  if (record.syncDirName !== undefined) {
    entry.syncDirName = record.syncDirName;
  }
  return entry;
}

function loadLocalSkillTiers(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
): LocalSkillTiers {
  const workspaceOnly = opts?.workspaceOnly === true;
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const configuredCustodianAgentId = opts?.config
    ? tryResolveAmbientOwnerAgentId(opts.config)
    : undefined;
  const custodianAgentId =
    !workspaceOnly &&
    opts?.agentId &&
    configuredCustodianAgentId &&
    normalizeAgentId(opts.agentId) === configuredCustodianAgentId
      ? configuredCustodianAgentId
      : undefined;
  const osHomeDir = resolveSkillsUserHomeDir();
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolvePluginSkillsDir();
  // Source revisions invalidate discovery even when resolved content stays unchanged.
  const sourceKey = JSON.stringify([
    workspaceDir,
    executionWorkspaceDir,
    workspaceOnly,
    opts?.agentId ? normalizeAgentId(opts.agentId) : undefined,
    custodianAgentId,
    opts?.managedSkillsDir,
    opts?.bundledSkillsDir,
    pluginSkillsDir,
    osHomeDir,
    process.env.OPENCLAW_STATE_DIR,
  ]);
  const cacheKey = JSON.stringify([
    sourceKey,
    opts?.config ? fingerprintSkillSnapshotConfig(opts.config) : undefined,
    getSkillsSourceVersion(workspaceDir, opts),
  ]);
  const cachedEntries = skillEntryCache.get(cacheKey);
  if (cachedEntries) {
    return cachedEntries;
  }

  const limits = resolveSkillDiscoveryLimits(opts?.config);
  const loadSkills = (params: {
    dir: string;
    source: string;
    rejectHardlinks?: boolean;
  }): LoadedSkillRecord[] => loadSkillRootRecords({ ...params, config: opts?.config });
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledSkillsDir = workspaceOnly
    ? undefined
    : (opts?.bundledSkillsDir ?? resolveBundledSkillsDir());
  const extraDirsRaw = workspaceOnly ? [] : (opts?.config?.skills?.load?.extraDirs ?? []);
  const extraDirs = normalizeTrimmedStringList(extraDirsRaw);
  const pluginSkillRoots = workspaceOnly
    ? []
    : opts?.pluginMetadataSnapshot
      ? resolvePluginSkillRootsFromMetadata({
          workspaceDir,
          config: opts.config,
          pluginSkillsDir,
          metadataSnapshot: opts.pluginMetadataSnapshot,
        })
      : resolvePluginSkillRoots({ workspaceDir, config: opts?.config, pluginSkillsDir });

  const bundledSkills = bundledSkillsDir
    ? loadSkills({ dir: bundledSkillsDir, source: "openclaw-bundled" })
    : [];
  const custodianSkillsDir =
    bundledSkillsDir && custodianAgentId
      ? path.join(path.dirname(bundledSkillsDir), CUSTODIAN_SKILLS_DIR_NAME)
      : undefined;
  const custodianSkills = custodianSkillsDir
    ? loadSkills({ dir: custodianSkillsDir, source: "openclaw-custodian" })
    : [];
  const extraSkills = [
    ...extraDirs.flatMap((dir) =>
      loadSkills({ dir: resolveUserPath(dir), source: "openclaw-extra" }),
    ),
    ...pluginSkillRoots.flatMap((root) =>
      loadSkills({
        dir: root.dir,
        source: "openclaw-extra",
        rejectHardlinks: root.rejectHardlinks,
      }),
    ),
    ...loadGeneratedPluginSkillRecords({
      pluginSkillsDir,
      pluginSkillRoots,
      source: "openclaw-extra",
      limits,
    }),
  ];
  const managedSkills = workspaceOnly
    ? []
    : loadSkills({ dir: managedSkillsDir, source: "openclaw-managed" });
  const workshopSkills =
    !workspaceOnly && opts?.config && opts.agentId
      ? loadSkills({
          dir: resolveWorkshopSkillsDir(opts.config, opts.agentId),
          source: "openclaw-workshop",
        })
      : [];
  const personalAgentsSkillsDir = osHomeDir
    ? path.resolve(osHomeDir, ".agents", "skills")
    : path.resolve(".agents", "skills");
  const personalAgentsSkills =
    workspaceOnly || !isDefaultStateDir()
      ? []
      : loadSkills({ dir: personalAgentsSkillsDir, source: "agents-skills-personal" });
  const workspaceSkills = resolveWorkspaceSkillDirectories(workspaceDir, workspaceOnly).flatMap(
    loadSkills,
  );

  const collisions: SkillCollision[] = [];
  const mergeRecords = (records: LoadedSkillRecord[]) => {
    const merged = new Map<string, LoadedSkillRecord>();
    for (const record of records) {
      const replaced = merged.get(record.skill.name);
      if (
        replaced &&
        canonicalizePath(record.skill.filePath) !== canonicalizePath(replaced.skill.filePath)
      ) {
        collisions.push({ winner: record.skill, loser: replaced.skill });
      }
      merged.set(record.skill.name, record);
    }
    return Array.from(merged.values()).toSorted((a, b) =>
      a.skill.name.localeCompare(b.skill.name, "en"),
    );
  };
  // Custodian skills share bundled precedence. Sort the tier so source traversal
  // remains deterministic even if a package accidentally ships a duplicate name.
  const bundledTierSkills = [...bundledSkills, ...custodianSkills].toSorted(
    (left, right) =>
      left.skill.name.localeCompare(right.skill.name, "en") ||
      left.skill.source.localeCompare(right.skill.source, "en"),
  );
  const records = mergeRecords([
    ...extraSkills,
    ...bundledTierSkills,
    ...workshopSkills,
    ...managedSkills,
    ...personalAgentsSkills,
    ...workspaceSkills,
  ]);
  const entries = {
    sourceKey,
    collisions,
    agent: records.map(createSkillEntry),
    execution:
      executionWorkspaceDir && !workspaceOnly
        ? mergeRecords(
            resolveWorkspaceSkillDirectories(executionWorkspaceDir).flatMap(loadSkills),
          ).map(createSkillEntry)
        : [],
  };
  skillEntryCache.set(cacheKey, entries);
  pruneMapToMaxSize(skillEntryCache, MAX_SKILL_ENTRY_CACHE_SIZE);
  const winners = new Map(entries.agent.map((entry) => [entry.skill.name, entry]));
  for (const entry of entries.execution) {
    const winner = winners.get(entry.skill.name);
    if (!winner) {
      winners.set(entry.skill.name, entry);
    } else if (canonicalizePath(winner.skill.filePath) !== canonicalizePath(entry.skill.filePath)) {
      collisions.push({ winner: winner.skill, loser: entry.skill });
    }
  }
  // Retain only discovery inputs, never the turn's assertions, eligibility, or session state.
  const sourceOptions: WorkspaceSkillLoadOptions = {
    executionWorkspaceDir,
    workspaceOnly,
    agentId: opts?.agentId,
    config: opts?.config,
    managedSkillsDir: opts?.managedSkillsDir,
    bundledSkillsDir: opts?.bundledSkillsDir,
    pluginSkillsDir: opts?.pluginSkillsDir,
    pluginMetadataSnapshot: opts?.pluginMetadataSnapshot,
  };
  observeSkillsSnapshotSource({
    workspaceDir,
    sourceKey,
    sourceScope: sourceOptions,
    entries: Array.from(winners.values())
      .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
      .map((entry) => ({ skill: entry.skill, skillKey: resolveSkillKey(entry.skill, entry) })),
    reconcile: (inputs) => {
      if (inputs) {
        sourceOptions.config = inputs.config;
        sourceOptions.pluginMetadataSnapshot = inputs.pluginMetadataSnapshot;
      }
      return loadLocalSkillTiers(workspaceDir, sourceOptions).sourceKey;
    },
    suspend: () => {
      sourceOptions.config = undefined;
      sourceOptions.pluginMetadataSnapshot = undefined;
    },
  });
  return entries;
}

function loadSkillEntries(workspaceDir: string, opts?: WorkspaceSkillLoadOptions): SkillEntry[] {
  const tiers = loadLocalSkillTiers(workspaceDir, opts);
  const entries = mergeRemoteNodeSkillEntries(tiers.agent, opts?.eligibility?.nodeSkills);
  const collisions = [...tiers.collisions];
  if (tiers.execution.length > 0) {
    const agentByName = new Map(entries.map((entry) => [entry.skill.name, entry]));
    const localNames = new Set(tiers.agent.map((entry) => entry.skill.name));
    // Include node skills in the agent tier before admitting execution-local names.
    // Agent entries also stay first when the prompt budget truncates the catalog.
    for (const entry of tiers.execution) {
      const agentEntry = agentByName.get(entry.skill.name);
      if (agentEntry) {
        if (!localNames.has(entry.skill.name)) {
          collisions.push({ winner: agentEntry.skill, loser: entry.skill });
        }
      } else {
        entries.push(entry);
      }
    }
  }
  warnSkillPrecedenceCollisions(collisions);
  if (opts?.librarySelections?.length) {
    entries.push(...loadSkillLibrarySelection(opts.librarySelections));
  }
  return entries;
}

function resolveEffectiveWorkspaceSkillFilter(opts?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentSkillFilter?: "apply" | "ignore";
  skillFilter?: string[];
}): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (opts?.agentSkillFilter === "ignore" || !opts?.config || !opts.agentId) {
    return undefined;
  }
  return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}

export async function resolveWorkspaceSkillPromptEntries(
  workspaceDir: string,
  opts?: {
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
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    assertCurrent?: () => void;
  },
): Promise<{ eligible: SkillEntry[]; skillFilter: string[] | undefined }> {
  for (;;) {
    opts?.assertCurrent?.();
    const sourceVersion = getSkillsSourceVersion(workspaceDir, opts);
    const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
    const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
    const probe = await prepareSkillBinaryProbe(skillEntries, opts, opts?.assertCurrent);
    if (
      probe.needsRetry() ||
      (!opts?.entries && getSkillsSourceVersion(workspaceDir, opts) !== sourceVersion)
    ) {
      continue;
    }
    const eligible = filterSkillEntries(
      skillEntries,
      opts?.config,
      skillFilter,
      opts?.skillOverrides,
      opts?.eligibility,
      probe.hasBin,
    );
    opts?.assertCurrent?.();
    if (probe.needsRetry()) {
      continue;
    }
    return { eligible, skillFilter };
  }
}

async function prepareSkillBinaryProbe(
  entries: SkillEntry[],
  opts?: Pick<WorkspaceSkillLoadOptions, "config" | "eligibility">,
  assertCurrent?: () => void,
) {
  const bins = new Set<string>();
  const bundledAllowlist = resolveBundledAllowlist(opts?.config);
  let needsBinaries: boolean;
  const recordBinaryRequirement = () => {
    needsBinaries = true;
    return true;
  };
  for (const entry of entries) {
    const requires = entry.metadata?.requires;
    if (!requires?.bins?.length && !requires?.anyBins?.length) {
      continue;
    }
    needsBinaries = false;
    shouldIncludeSkill({
      entry,
      config: opts?.config,
      bundledAllowlist,
      eligibility: opts?.eligibility,
      hasBin: recordBinaryRequirement,
    });
    if (needsBinaries) {
      for (const bin of entry.metadata?.requires?.bins ?? []) {
        bins.add(bin);
      }
      for (const bin of entry.metadata?.requires?.anyBins ?? []) {
        bins.add(bin);
      }
    }
  }
  const facts = await prepareBinaryAvailability(bins, assertCurrent);
  let unprepared = false;
  return {
    hasBin: (bin: string) => {
      // Eligibility can change while probing; prepare newly requested facts before publishing.
      if (!bins.has(bin)) {
        unprepared = true;
        return false;
      }
      return facts.hasBinary(bin);
    },
    needsRetry: () => unprepared || !facts.isCurrent(),
  };
}

function resolveWorkspaceSkillLoad(workspaceDir: string, opts?: WorkspaceSkillLoadOptions) {
  const roots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const entries = loadSkillEntries(roots.agentWorkspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return {
    entries,
    effectiveSkillFilter,
    shouldFilter:
      Boolean(roots.executionWorkspaceDir) ||
      effectiveSkillFilter !== undefined ||
      opts?.skillOverrides !== undefined ||
      opts?.eligibility !== undefined,
  };
}

/** Runtime preparation shares discovery and filtering with synchronous SDK inventory reads. */
export async function prepareWorkspaceSkills(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
  assertCurrent?: () => void,
): Promise<SkillEntry[]> {
  for (;;) {
    assertCurrent?.();
    const sourceVersion = getSkillsSourceVersion(workspaceDir, opts);
    const { entries, effectiveSkillFilter, shouldFilter } = resolveWorkspaceSkillLoad(
      workspaceDir,
      opts,
    );
    if (!shouldFilter) {
      return entries;
    }
    const probe = await prepareSkillBinaryProbe(entries, opts, assertCurrent);
    if (probe.needsRetry() || getSkillsSourceVersion(workspaceDir, opts) !== sourceVersion) {
      continue;
    }
    const eligible = filterSkillEntries(
      entries,
      opts?.config,
      effectiveSkillFilter,
      opts?.skillOverrides,
      opts?.eligibility,
      probe.hasBin,
    );
    assertCurrent?.();
    if (probe.needsRetry()) {
      continue;
    }
    return eligible;
  }
}

export function loadWorkspaceSkills(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
): SkillEntry[] {
  const { entries, effectiveSkillFilter, shouldFilter } = resolveWorkspaceSkillLoad(
    workspaceDir,
    opts,
  );
  if (!shouldFilter) {
    return entries;
  }
  return filterSkillEntries(
    entries,
    opts?.config,
    effectiveSkillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

export function loadVisibleSkills(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    librarySelections?: SkillSnapshot["librarySelections"];
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    agentId?: string;
    agentSkillFilter?: "apply" | "ignore";
    eligibility?: SkillEligibilityContext;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): SkillEntry[] {
  const entries = loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(
    entries,
    opts?.config,
    effectiveSkillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

/** Loads one eligible bundled skill before higher-precedence workspace sources can replace it. */
export function loadBundledSkillEntryByName(
  skillName: string,
  opts?: {
    config?: OpenClawConfig;
    bundledSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry | undefined {
  const normalizedName = skillName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalizedName)) {
    return undefined;
  }
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const rootRealPath = bundledSkillsDir ? tryRealpath(bundledSkillsDir) : undefined;
  if (!rootRealPath) {
    return undefined;
  }
  const limits = resolveSkillDiscoveryLimits(opts?.config);
  const loaded = loadSingleSkillDirectory({
    skillDir: path.join(rootRealPath, normalizedName),
    source: "openclaw-bundled",
    rootRealPath,
    maxBytes: limits.maxSkillFileBytes,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: "bundled",
      rootDir: rootRealPath,
    }),
    onDiagnostic: (diagnostic) => warnInvalidSkill("openclaw-bundled", diagnostic),
  });
  if (!loaded || loaded.skill.name.trim().toLowerCase() !== normalizedName) {
    return undefined;
  }
  return filterSkillEntries(
    [createSkillEntry(loaded)],
    opts?.config,
    resolveEffectiveWorkspaceSkillFilter(opts),
    undefined,
    opts?.eligibility,
  )[0];
}

export function filterWorkspaceSkills(
  entries: SkillEntry[],
  opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  return filterSkillEntries(
    entries,
    opts?.config,
    opts?.skillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}
