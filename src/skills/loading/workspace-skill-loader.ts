import { canonicalizePath } from "../../agents/utils/paths.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  captureSkillLibraryPreparation,
  loadSkillLibrarySelection,
  prepareSkillLibrarySelection,
} from "../library/selection.js";
import { getSkillsSourceVersion } from "../runtime/refresh-state.js";
import { prepareLocalSkillSources, prepareSkillSourcePlan } from "../runtime/refresh.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import { recordSkillFileHost } from "../skill-file-host.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { prepareSkillBinaryProbe, resolveSkillRequiredBins } from "./config.js";
import type { Skill } from "./skill-contract.js";
import { resolvePluginSkillsDir, resolveSkillsUserHomeDir } from "./skill-paths.js";
import {
  appendLowerPrecedenceSkillRecords,
  mergeSkillRecords,
  reportSkillPrecedenceCollisions,
  type SkillCollision,
} from "./skill-precedence.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import { loadWorkspaceSkillSourceEntries, loadExecutionSkillEntries } from "./skill-root-loader.js";
import {
  filterSkillEntries,
  resolveEffectiveWorkspaceSkillFilter,
} from "./workspace-skill-filter.js";
import { normalizeWorkspaceSkillRoots } from "./workspace-skill-roots.js";
import {
  resolveCustodianSkillAgentId,
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
  type WorkspaceSkillSources,
} from "./workspace-skill-sources.js";

const MAX_SKILL_ENTRY_CACHE_SIZE = 64;
type LocalSkillTiers = {
  sourceKey: string;
  agent: SkillEntry[];
  execution: SkillEntry[];
};
const skillEntryCache = new Map<string, LocalSkillTiers>();
const agentSkillEntryCache = new Map<string, SkillEntry[]>();
const pluginMetadataIds = new WeakMap<PluginMetadataSnapshot, number>();
let nextPluginMetadataId = 0;

type WorkspaceSkillLoadOptions = {
  watch?: boolean;
  matchesSnapshotSkill?: (skill: Skill) => boolean;
  bundledSkillName?: string;
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
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

function loadLocalSkillTiers(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
): LocalSkillTiers {
  const workspaceOnly = opts?.workspaceOnly === true;
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
    executionWorkspaceFileHost: opts?.executionWorkspaceFileHost,
  });
  const custodianAgentId = resolveCustodianSkillAgentId(opts?.config, opts?.agentId, workspaceOnly);
  const metadata = opts?.pluginMetadataSnapshot;
  let metadataId = metadata && pluginMetadataIds.get(metadata);
  if (metadata && metadataId === undefined) {
    metadataId = ++nextPluginMetadataId;
    pluginMetadataIds.set(metadata, metadataId);
  }
  // Source revisions invalidate discovery even when resolved content stays unchanged.
  const agentSourceKey = JSON.stringify([
    workspaceDir,
    workspaceOnly,
    opts?.gatewayOnly,
    opts?.agentId ? normalizeAgentId(opts.agentId) : undefined,
    custodianAgentId,
    opts?.managedSkillsDir,
    opts?.bundledSkillsDir,
    opts?.pluginSkillsDir ?? resolvePluginSkillsDir(),
    resolveSkillsUserHomeDir(),
    process.env.OPENCLAW_STATE_DIR,
  ]);
  const agentCacheKey = JSON.stringify([
    agentSourceKey,
    opts?.config ? fingerprintSkillSnapshotConfig(opts.config) : undefined,
    metadataId,
    getSkillsSourceVersion(workspaceDir),
  ]);
  const sourceKey = JSON.stringify([
    agentSourceKey,
    executionWorkspaceDir,
    opts?.executionWorkspaceFileHost,
  ]);
  const cacheKey = JSON.stringify([
    agentCacheKey,
    executionWorkspaceDir,
    opts?.executionWorkspaceFileHost,
    getSkillsSourceVersion(workspaceDir, opts),
  ]);
  const cachedEntries = skillEntryCache.get(cacheKey);
  if (cachedEntries) {
    return cachedEntries;
  }

  let agentTier = agentSkillEntryCache.get(agentCacheKey);
  if (!agentTier) {
    const plan = resolveWorkspaceSkillSourcePlan(workspaceDir, opts);
    agentTier = loadWorkspaceSkillSourceEntries(
      opts?.gatewayOnly ? splitSkillSourcePlan(plan).gatewayPlan : plan,
      opts?.config,
    );
    agentSkillEntryCache.set(agentCacheKey, agentTier);
    pruneMapToMaxSize(agentSkillEntryCache, MAX_SKILL_ENTRY_CACHE_SIZE);
  }
  const entries = {
    sourceKey,
    agent: agentTier,
    execution:
      executionWorkspaceDir && !workspaceOnly && !opts?.gatewayOnly
        ? loadExecutionSkillEntries(executionWorkspaceDir, opts?.config)
        : [],
  };
  skillEntryCache.set(cacheKey, entries);
  pruneMapToMaxSize(skillEntryCache, MAX_SKILL_ENTRY_CACHE_SIZE);
  return entries;
}

function mergeSkillTiers(
  tiers: LocalSkillTiers,
  opts?: LocalWorkspaceSkillLoadOptions,
  libraryEntries = opts?.librarySelections?.length
    ? loadSkillLibrarySelection(opts.librarySelections)
    : [],
): SkillEntry[] {
  const select = (entries: SkillEntry[]) =>
    entries.filter(
      (entry) => !opts?.matchesSnapshotSkill || opts.matchesSnapshotSkill(entry.skill),
    );
  const collisions: SkillCollision[] = [];
  const entries = mergeSkillRecords(
    mergeRemoteNodeSkillEntries(
      select(tiers.agent),
      opts?.eligibility?.nodeSkills,
      opts?.matchesSnapshotSkill,
    ),
    tiers.sourceKey,
    collisions,
  );
  if (tiers.execution.length > 0) {
    // Include node skills in the agent tier before admitting execution-local names.
    // Agent entries also stay first when the prompt budget truncates the catalog.
    appendLowerPrecedenceSkillRecords(
      entries,
      mergeSkillRecords(select(tiers.execution), tiers.sourceKey, collisions),
      (winner, loser) => {
        if (canonicalizePath(winner.skill.filePath) !== canonicalizePath(loser.skill.filePath)) {
          collisions.push({ winner: winner.skill, loser: loser.skill });
        }
      },
    );
  }
  if (!opts?.matchesSnapshotSkill) {
    reportSkillPrecedenceCollisions(collisions, tiers.sourceKey);
  }
  entries.push(...select(libraryEntries));
  return entries;
}

/** Keep Library pins and physical read authority fixed throughout workspace discovery. */
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
  return captureSkillLibraryPreparation(
    needsLibrary ? (opts?.librarySelections ?? []) : [],
    assertCurrent,
  );
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
  const bundledOnly = opts?.bundledSkillName !== undefined;
  if (!access?.loadSkills && !bundledOnly && opts?.entries !== undefined) {
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
    const preparedPlan = await prepareSkillSourcePlan(workspaceDir, opts);
    const sourcePlan = preparedPlan.plan;
    const sources = await prepareLocalSkillSources(
      {
        sourcePlan: opts?.gatewayOnly ? splitSkillSourcePlan(sourcePlan).gatewayPlan : sourcePlan,
        bundledSkillName: opts?.bundledSkillName,
        executionWorkspaceDir:
          opts?.workspaceOnly || opts?.gatewayOnly || bundledOnly
            ? undefined
            : opts?.executionWorkspaceDir,
        limits: resolveSkillDiscoveryLimits(opts?.config),
        additionalBins: libraryEntries.flatMap(resolveSkillRequiredBins),
        status: opts?.status,
      },
      {
        watch: opts?.watch !== false && opts?.config?.skills?.load?.watch !== false,
        plan: {
          input: preparedPlan.input,
          ...(opts?.gatewayOnly ? { scope: "gateway" as const } : {}),
        },
      },
    );
    assertCurrent();
    return {
      entries: bundledOnly
        ? sources.entries
        : mergeSkillTiers(
            {
              sourceKey: JSON.stringify(sourcePlan),
              agent: sources.entries,
              execution: sources.executionEntries,
            },
            opts,
            libraryEntries,
          ),
      runtime: sources.runtime,
      status: sources.status,
    };
  }
  const { agentWorkspaceDir, executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
    executionWorkspaceFileHost: opts?.executionWorkspaceFileHost,
  });
  const preparedPlan = await prepareSkillSourcePlan(agentWorkspaceDir, opts);
  const {
    gatewayPlan,
    workspacePlan,
    gatewayExecutionWorkspaceDir,
    workspaceExecutionWorkspaceDir,
  } = splitSkillSourcePlan(preparedPlan.plan, {
    executionWorkspaceDir,
    executionWorkspaceFileHost: opts?.executionWorkspaceFileHost,
  });
  const gatewaySources = await prepareLocalSkillSources(
    {
      sourcePlan: gatewayPlan,
      bundledSkillName: opts?.bundledSkillName,
      executionWorkspaceDir:
        opts?.workspaceOnly || bundledOnly ? undefined : gatewayExecutionWorkspaceDir,
      limits: resolveSkillDiscoveryLimits(opts?.config),
      additionalBins: libraryEntries.flatMap(resolveSkillRequiredBins),
      status: opts?.status,
    },
    {
      watch: opts?.watch !== false && opts?.config?.skills?.load?.watch !== false,
      plan: { input: preparedPlan.input, scope: "gateway" },
    },
  );
  assertCurrent();
  const onGateway = (entry: SkillEntry): SkillEntry => ({
    ...entry,
    skill: recordSkillFileHost({ ...entry.skill }, "gateway"),
  });
  const gatewayEntries = gatewaySources.entries.map(onGateway);
  const gatewayExecutionEntries = gatewaySources.executionEntries.map(onGateway);
  const sources = await access.loadSkills({
    sourcePlan: bundledOnly ? { ...workspacePlan, roots: [] } : workspacePlan,
    executionWorkspaceDir:
      opts?.workspaceOnly || bundledOnly ? undefined : workspaceExecutionWorkspaceDir,
    limits: resolveSkillDiscoveryLimits(opts?.config),
    additionalBins: [
      ...new Set(
        libraryEntries
          .concat(gatewayEntries, gatewayExecutionEntries)
          .concat(opts?.entries ?? [])
          .flatMap(resolveSkillRequiredBins),
      ),
    ],
    status: opts?.status,
  });
  assertCurrent();
  // A host-supplied source label or path must never authorize Gateway-local reads.
  const onWorkspace = (entry: WorkspaceSkillSources["entries"][number]) => ({
    ...entry,
    skill: recordSkillFileHost({ ...entry.skill }, "workspace"),
  });
  const hostEntries = sources.entries.map(onWorkspace);
  // The order is discovery provenance, not permission to read Gateway files.
  const agentEntries = [...gatewayEntries, ...hostEntries].toSorted((left, right) => {
    const order = (entry: WorkspaceSkillSources["entries"][number]) =>
      entry.sourceOrder ??
      Math.max(
        -1,
        ...workspacePlan.roots
          .filter((root) => root.source === entry.skill.source)
          .map((root) => root.order ?? -1),
      );
    return order(left) - order(right);
  });
  return {
    entries: bundledOnly
      ? gatewayEntries
      : (opts?.entries ??
        mergeSkillTiers(
          {
            sourceKey: JSON.stringify(["remote", agentWorkspaceDir, executionWorkspaceDir]),
            agent: agentEntries,
            execution: gatewayExecutionWorkspaceDir
              ? gatewayExecutionEntries
              : sources.executionEntries.map(onWorkspace),
          },
          opts,
          libraryEntries,
        )),
    runtime: sources.runtime,
    status: sources.status
      ? {
          ...sources.status,
          files: [...(gatewaySources.status?.files ?? []), ...sources.status.files],
        }
      : undefined,
  };
}

/** Acquire host source tiers before the native node/execution/Library merge. */
export async function prepareWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions & {
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
  opts?: Omit<
    WorkspaceSkillLoadOptions,
    "bundledSkillName" | "pluginSkillsDir" | "agentSkillFilter" | "workspaceOnly"
  > & {
    entries?: SkillEntry[];
    assertCurrent?: () => void;
  },
): Promise<{ eligible: SkillEntry[]; skillFilter: string[] | undefined }> {
  const { entries, skillFilter } = await prepareWorkspaceSkillSelection(
    workspaceDir,
    opts,
    "prompt",
    opts?.assertCurrent,
  );
  return { eligible: entries, skillFilter };
}

async function prepareWorkspaceSkillSelection(
  workspaceDir: string,
  opts: Parameters<typeof prepareWorkspaceSkillEntries>[1],
  mode: "prompt" | "runtime",
  assertCurrent?: () => void,
): Promise<{ entries: SkillEntry[]; skillFilter: string[] | undefined }> {
  const preparation = captureWorkspaceSkillPreparation(workspaceDir, opts, assertCurrent);
  let skillFilter = mode === "prompt" ? resolveEffectiveWorkspaceSkillFilter(opts) : undefined;
  const sources = await prepareCapturedWorkspaceSkillEntries(workspaceDir, opts, preparation);
  preparation.assertCurrent();
  const entries = sources.entries;
  if (mode === "runtime") {
    const selection = resolveWorkspaceSkillLoad(workspaceDir, opts, entries);
    skillFilter = selection.effectiveSkillFilter;
    if (!selection.shouldFilter) {
      return { entries, skillFilter };
    }
  }
  const probe = await prepareSkillBinaryProbe(
    entries,
    { ...opts, skillFilter },
    preparation.assertCurrent,
    // Local binaries can change between discovery scans; remote hosts supply their own facts.
    getAgentWorkspaceAccess(workspaceDir, "loadSkills")?.loadSkills ? sources.runtime : undefined,
  );
  preparation.assertCurrent();
  // Source or eligibility changes during preparation take effect on the next scan/turn.
  const eligible = filterSkillEntries(entries, {
    ...opts,
    skillFilter,
    hasBin: probe.hasBin,
    platform: sources.runtime?.platform,
  });
  preparation.assertCurrent();
  return { entries: eligible, skillFilter };
}

function resolveWorkspaceSkillLoad(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
  preparedEntries?: SkillEntry[],
) {
  const roots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
    executionWorkspaceFileHost: opts?.executionWorkspaceFileHost,
  });
  const entries =
    preparedEntries ?? mergeSkillTiers(loadLocalSkillTiers(roots.agentWorkspaceDir, opts), opts);
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
  opts?: LocalWorkspaceSkillLoadOptions,
  assertCurrent?: () => void,
): Promise<SkillEntry[]> {
  return (await prepareWorkspaceSkillSelection(workspaceDir, opts, "runtime", assertCurrent))
    .entries;
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
  return filterSkillEntries(entries, { ...opts, skillFilter: effectiveSkillFilter });
}

export function loadVisibleSkills(
  workspaceDir: string,
  opts?: Omit<
    LocalWorkspaceSkillLoadOptions,
    "bundledSkillName" | "executionWorkspaceDir" | "pluginSkillsDir" | "workspaceOnly"
  >,
): SkillEntry[] {
  const entries = mergeSkillTiers(loadLocalSkillTiers(workspaceDir, opts), opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(entries, { ...opts, skillFilter: effectiveSkillFilter });
}
