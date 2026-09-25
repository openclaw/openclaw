import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import {
  captureSkillLibrarySelection,
  loadSkillLibrarySelection,
  prepareSkillLibrarySelection,
} from "../library/selection.js";
import { getSkillsSourceVersion, observeSkillsSnapshotSource } from "../runtime/refresh-state.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { hasBinary, prepareSkillBinaryProbe } from "./config.js";
import { resolveSkillInvocationPolicy, resolveSkillKey } from "./frontmatter.js";
import { loadSingleSkillDirectory } from "./local-loader.js";
import { resolveSkillEntryMetadata } from "./skill-entry-metadata.js";
import { resolvePluginSkillsDir, resolveSkillsUserHomeDir } from "./skill-paths.js";
import {
  mergeSkillRecords,
  reportSkillPrecedenceCollisions,
  type SkillCollision,
} from "./skill-precedence.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import {
  loadGeneratedPluginSkillRecords,
  loadSkillRootRecords,
  warnInvalidSkill,
  type LoadedSkillRecord,
} from "./skill-root-loader.js";
import { tryRealpath } from "./symlink-targets.js";
import {
  filterSkillEntries,
  resolveEffectiveWorkspaceSkillFilter,
} from "./workspace-skill-filter.js";
import {
  normalizeWorkspaceSkillRoots,
  resolveWorkspaceSkillDirectories,
} from "./workspace-skill-roots.js";
import {
  resolveCustodianSkillAgentId,
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
  type WorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
  type WorkspaceSkillSources,
} from "./workspace-skill-sources.js";

const MAX_SKILL_ENTRY_CACHE_SIZE = 64;
type LocalSkillTiers = {
  sourceKey: string;
  agent: SkillEntry[];
  execution: SkillEntry[];
  collisions: SkillCollision[];
};
const skillEntryCache = new Map<string, LocalSkillTiers>();

type WorkspaceSkillLoadOptions = {
  bundledSkillName?: string;
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

type LocalWorkspaceSkillLoadOptions = WorkspaceSkillLoadOptions & {
  /** Local menu discovery must not depend on a remote workspace being available. */
  gatewayOnly?: boolean;
};

function createSkillEntry(
  record: LoadedSkillRecord & { sourceOrder?: number },
): WorkspaceSkillSources["entries"][number] {
  const { skill, frontmatter } = record;
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const entry: WorkspaceSkillSources["entries"][number] = {
    ...(record.sourceOrder !== undefined ? { sourceOrder: record.sourceOrder } : {}),
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

/** Scan selected roots on their owning host, retaining native precedence and file rules. */
function loadWorkspaceSkillSourceEntries(
  plan: WorkspaceSkillSourcePlan,
  config?: OpenClawConfig,
  collisions?: SkillCollision[],
): WorkspaceSkillSources["entries"] {
  const grouped = new Map<string, Array<LoadedSkillRecord & { sourceOrder?: number }>>();
  for (const root of plan.roots) {
    const records = grouped.get(root.tier) ?? [];
    for (const record of loadSkillRootRecords({ ...root, config })) {
      records.push(Object.assign({}, record, { sourceOrder: root.order }));
    }
    grouped.set(root.tier, records);
  }
  const extra = grouped.get("extra") ?? [];
  if (plan.pluginSkillsDir) {
    for (const record of loadGeneratedPluginSkillRecords({
      pluginSkillsDir: plan.pluginSkillsDir,
      pluginSkillRoots: plan.pluginSkillRoots,
      source: "openclaw-extra",
      limits: resolveSkillDiscoveryLimits(config),
    })) {
      extra.push(
        Object.assign({}, record, {
          sourceOrder:
            (plan.roots.find((root) => root.tier !== "extra")?.order ??
              Math.max(-1, ...plan.roots.map((root) => root.order ?? -1)) + 1) - 0.5,
        }),
      );
    }
  }
  grouped.set("extra", extra);
  // Custodian and bundled records share a tier and deterministic collision order.
  grouped
    .get("bundled")
    ?.sort(
      (left, right) =>
        left.skill.name.localeCompare(right.skill.name, "en") ||
        left.skill.source.localeCompare(right.skill.source, "en"),
    );
  return mergeSkillRecords(
    ["extra", "bundled", "workshop", "managed", "personal", "workspace"].flatMap(
      (tier) => grouped.get(tier) ?? [],
    ),
    JSON.stringify(["sources", plan.workspaceDir]),
    collisions,
  ).map(createSkillEntry);
}

function loadExecutionSkillEntries(
  executionWorkspaceDir: string,
  config?: OpenClawConfig,
  collisions?: SkillCollision[],
): SkillEntry[] {
  return mergeSkillRecords(
    resolveWorkspaceSkillDirectories(executionWorkspaceDir).flatMap((root) =>
      loadSkillRootRecords({ ...root, config }),
    ),
    JSON.stringify(["execution", executionWorkspaceDir]),
    collisions,
  ).map(createSkillEntry);
}

/** Run on the workspace host using an admitted source plan and native discovery limits. */
export function readWorkspaceSkillSources(
  request: WorkspaceSkillSourceRequest,
): WorkspaceSkillSources {
  const config: OpenClawConfig = {
    skills: {
      limits: request.limits,
      load: { allowSymlinkTargets: request.sourcePlan.allowSymlinkTargets },
    },
  };
  const entries =
    request.bundledSkillName !== undefined
      ? readBundledSkillEntries(request.bundledSkillName, {
          config,
          bundledSkillsDir: request.sourcePlan.bundledSkillsDir,
        })
      : loadWorkspaceSkillSourceEntries(request.sourcePlan, config);
  const executionEntries = request.executionWorkspaceDir
    ? loadExecutionSkillEntries(request.executionWorkspaceDir, config)
    : [];
  const bins = [
    ...new Set([
      "brew",
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "uv",
      "go",
      ...request.additionalBins,
      ...entries
        .concat(executionEntries)
        .flatMap((entry) =>
          (entry.metadata?.requires?.bins ?? []).concat(entry.metadata?.requires?.anyBins ?? []),
        ),
    ]),
  ]
    .filter(hasBinary)
    .toSorted();
  return {
    entries,
    executionEntries,
    runtime: { platform: process.platform, bins },
    ...(request.status
      ? {
          status: readWorkspaceSkillStatusFacts({
            entries,
            workspaceDir: request.sourcePlan.workspaceDir,
            managedSkillsDir: request.sourcePlan.managedSkillsDir,
            skillCardKey: request.status.skillCardKey,
          }),
        }
      : {}),
  };
}

function loadLocalSkillTiers(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
): LocalSkillTiers {
  const workspaceOnly = opts?.workspaceOnly === true;
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const custodianAgentId = resolveCustodianSkillAgentId(opts?.config, opts?.agentId, workspaceOnly);
  const osHomeDir = resolveSkillsUserHomeDir();
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolvePluginSkillsDir();
  // Source revisions invalidate discovery even when resolved content stays unchanged.
  const sourceKey = JSON.stringify([
    workspaceDir,
    executionWorkspaceDir,
    workspaceOnly,
    opts?.gatewayOnly,
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

  const plan = resolveWorkspaceSkillSourcePlan(workspaceDir, opts);
  const collisions: SkillCollision[] = [];
  const entries = {
    sourceKey,
    collisions,
    agent: loadWorkspaceSkillSourceEntries(
      opts?.gatewayOnly ? splitSkillSourcePlan(plan).gatewayPlan : plan,
      opts?.config,
      collisions,
    ),
    execution:
      executionWorkspaceDir && !workspaceOnly && !opts?.gatewayOnly
        ? loadExecutionSkillEntries(executionWorkspaceDir, opts?.config, collisions)
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
  const sourceOptions: LocalWorkspaceSkillLoadOptions = {
    executionWorkspaceDir,
    workspaceOnly,
    gatewayOnly: opts?.gatewayOnly,
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

function loadSkillEntries(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
): SkillEntry[] {
  return mergeSkillTiers(loadLocalSkillTiers(workspaceDir, opts), opts);
}

function mergeSkillTiers(
  tiers: LocalSkillTiers,
  opts?: LocalWorkspaceSkillLoadOptions,
  libraryEntries = opts?.librarySelections?.length
    ? loadSkillLibrarySelection(opts.librarySelections)
    : [],
): SkillEntry[] {
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
  reportSkillPrecedenceCollisions(collisions, tiers.sourceKey);
  entries.push(...libraryEntries);
  return entries;
}

/** Keep Library pins and physical read authority fixed across workspace discovery retries. */
function captureWorkspaceSkillPreparation(
  workspaceDir: string,
  opts: (WorkspaceSkillLoadOptions & { entries?: SkillEntry[] }) | undefined,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  const needsLibrary =
    opts?.bundledSkillName === undefined &&
    (opts?.entries === undefined ||
      Boolean(getAgentWorkspaceAccess(workspaceDir, "loadSkills")?.loadSkills));
  const librarySelections = captureSkillLibrarySelection(
    needsLibrary ? (opts?.librarySelections ?? []) : [],
  );
  const libraryContext = librarySelections.length ? captureOpenClawStateWorkerContext() : undefined;
  return {
    librarySelections,
    libraryContext,
    assertCurrent: () => {
      assertCurrent?.();
      libraryContext?.maintenanceScope?.assertAdmission();
      libraryContext?.admission.assertCurrent();
    },
  };
}

async function prepareCapturedWorkspaceSkillEntries(
  workspaceDir: string,
  opts: Parameters<typeof prepareWorkspaceSkillEntries>[1],
  preparation: ReturnType<typeof captureWorkspaceSkillPreparation>,
): Promise<{
  entries: SkillEntry[];
  runtime?: WorkspaceSkillSources["runtime"];
  status?: WorkspaceSkillSources["status"];
}> {
  const { assertCurrent, libraryContext, librarySelections } = preparation;
  assertCurrent();
  const access = getAgentWorkspaceAccess(workspaceDir, "loadSkills");
  if (!access?.loadSkills && opts?.bundledSkillName !== undefined) {
    return { entries: readBundledSkillEntries(opts.bundledSkillName, opts) };
  }
  if (!access?.loadSkills && opts?.entries !== undefined) {
    return { entries: opts.entries };
  }
  const libraryEntries = libraryContext
    ? await prepareSkillLibrarySelection(
        librarySelections,
        { env: libraryContext.environment },
        assertCurrent,
      )
    : [];
  assertCurrent();
  if (!access?.loadSkills) {
    return {
      entries: mergeSkillTiers(loadLocalSkillTiers(workspaceDir, opts), opts, libraryEntries),
    };
  }
  const bundledOnly = opts?.bundledSkillName !== undefined;
  const { agentWorkspaceDir, executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const { gatewayPlan, workspacePlan } = splitSkillSourcePlan(
    resolveWorkspaceSkillSourcePlan(agentWorkspaceDir, opts),
  );
  const gatewaySourceEntries = bundledOnly
    ? readBundledSkillEntries(opts.bundledSkillName!, opts)
    : loadWorkspaceSkillSourceEntries(gatewayPlan, opts?.config);
  const gatewayEntries: SkillEntry[] = [];
  for (const entry of gatewaySourceEntries) {
    gatewayEntries.push({ ...entry, skill: { ...entry.skill, fileHost: "gateway" } });
  }
  const sources = await access.loadSkills({
    sourcePlan: bundledOnly ? { ...workspacePlan, roots: [] } : workspacePlan,
    executionWorkspaceDir: opts?.workspaceOnly || bundledOnly ? undefined : executionWorkspaceDir,
    limits: resolveSkillDiscoveryLimits(opts?.config),
    additionalBins: [
      ...new Set(
        libraryEntries
          .concat(gatewayEntries)
          .concat(opts?.entries ?? [])
          .flatMap((entry) =>
            (entry.metadata?.requires?.bins ?? []).concat(entry.metadata?.requires?.anyBins ?? []),
          ),
      ),
    ],
    status: opts?.status,
  });
  assertCurrent();
  // A host-supplied source label or path must never authorize Gateway-local reads.
  const onWorkspace = (entry: WorkspaceSkillSources["entries"][number]) => ({
    ...entry,
    skill: { ...entry.skill, fileHost: "workspace" as const },
  });
  const hostEntries = sources.entries.map(onWorkspace);
  // The order is discovery provenance, not permission to read Gateway files.
  const agentEntries = mergeSkillRecords(
    [...gatewayEntries, ...hostEntries].toSorted((left, right) => {
      const order = (entry: WorkspaceSkillSources["entries"][number]) =>
        entry.sourceOrder ??
        Math.max(
          -1,
          ...workspacePlan.roots
            .filter((root) => root.source === entry.skill.source)
            .map((root) => root.order ?? -1),
        );
      return order(left) - order(right);
    }),
    JSON.stringify(["remote-agent", agentWorkspaceDir]),
  );
  return {
    entries: bundledOnly
      ? gatewayEntries
      : (opts?.entries ??
        mergeSkillTiers(
          {
            sourceKey: JSON.stringify(["remote", agentWorkspaceDir, executionWorkspaceDir]),
            agent: agentEntries,
            execution: sources.executionEntries.map(onWorkspace),
            collisions: [],
          },
          opts,
          libraryEntries,
        )),
    runtime: sources.runtime,
    status: sources.status,
  };
}

/** Acquire host source tiers before the native node/execution/Library merge. */
export async function prepareWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions & {
    entries?: SkillEntry[];
    status?: { skillCardKey?: string };
  },
  assertCurrent?: () => void,
): Promise<{
  entries: SkillEntry[];
  runtime?: WorkspaceSkillSources["runtime"];
  status?: WorkspaceSkillSources["status"];
}> {
  const preparation = captureWorkspaceSkillPreparation(workspaceDir, opts, assertCurrent);
  const sources = await prepareCapturedWorkspaceSkillEntries(workspaceDir, opts, preparation);
  preparation.assertCurrent();
  return sources;
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
  const preparation = captureWorkspaceSkillPreparation(workspaceDir, opts, opts?.assertCurrent);
  for (;;) {
    preparation.assertCurrent();
    const sourceVersion = getSkillsSourceVersion(workspaceDir, opts);
    const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
    const sources = await prepareCapturedWorkspaceSkillEntries(workspaceDir, opts, preparation);
    preparation.assertCurrent();
    const skillEntries = sources.entries;
    const probe = await prepareSkillBinaryProbe(
      skillEntries,
      opts,
      preparation.assertCurrent,
      sources.runtime,
    );
    preparation.assertCurrent();
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
      sources.runtime?.platform,
    );
    preparation.assertCurrent();
    if (probe.needsRetry()) {
      continue;
    }
    return { eligible, skillFilter };
  }
}

function resolveWorkspaceSkillLoad(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
  preparedEntries?: SkillEntry[],
) {
  const roots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const entries = preparedEntries ?? loadSkillEntries(roots.agentWorkspaceDir, opts);
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
  const preparation = captureWorkspaceSkillPreparation(workspaceDir, opts, assertCurrent);
  for (;;) {
    preparation.assertCurrent();
    const sourceVersion = getSkillsSourceVersion(workspaceDir, opts);
    const sources = await prepareCapturedWorkspaceSkillEntries(workspaceDir, opts, preparation);
    preparation.assertCurrent();
    const { entries, effectiveSkillFilter, shouldFilter } = resolveWorkspaceSkillLoad(
      workspaceDir,
      opts,
      sources.entries,
    );
    if (!shouldFilter) {
      return entries;
    }
    const probe = await prepareSkillBinaryProbe(
      entries,
      opts,
      preparation.assertCurrent,
      sources.runtime,
    );
    preparation.assertCurrent();
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
      sources.runtime?.platform,
    );
    preparation.assertCurrent();
    if (probe.needsRetry()) {
      continue;
    }
    return eligible;
  }
}

export function loadWorkspaceSkills(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
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
    gatewayOnly?: boolean;
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

/** Read a single bundle with the same boundary and file limits as local discovery. */
function readBundledSkillEntries(
  skillName: string,
  opts?: { config?: OpenClawConfig; bundledSkillsDir?: string },
): SkillEntry[] {
  const normalizedName = skillName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalizedName)) {
    return [];
  }
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const rootRealPath = bundledSkillsDir ? tryRealpath(bundledSkillsDir) : undefined;
  if (!rootRealPath) {
    return [];
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
    return [];
  }
  return [createSkillEntry(loaded)];
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
