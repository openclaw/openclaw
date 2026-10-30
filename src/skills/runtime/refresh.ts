import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { throwSettledAggregate } from "../../infra/error-graph-internal.js";
import { observeOwnedDirectory } from "../../infra/owned-directory-observation.js";
import { isPathInside } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import type { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import type { Skill } from "../loading/skill-contract.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import type { SkillSnapshotProjectionInput } from "../loading/skill-snapshot-projection.js";
import {
  splitSkillSourcePlan,
  type WorkspaceSkillSourcePlanOptions,
} from "../loading/workspace-skill-sources.js";
import type {
  WorkspaceSkillSourcePlan,
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSources,
} from "../loading/workspace-skill-sources.types.js";
import type { SkillSnapshot } from "../types.js";
import {
  captureSkillsDiscoveryEnvironment,
  type SkillsDiscoveryEnvironment,
  type SkillsDiscoveryInput,
  type SkillsDiscoveryResult,
  type SkillsDiscoveryOutput,
  type SkillsDiscoverySourceSelection,
  type SkillsSourcePlanInput,
} from "./discovery-worker-contract.js";
import {
  captureSkillsSourcePlanInput,
  type SkillsWatcherParams,
} from "./discovery-worker-input.js";
import {
  closeRemoteSkillsWatchers,
  disposeRemoteSkillsWatcher,
  ensureRemoteSkillsWatcher,
} from "./refresh-remote.js";
import {
  bumpSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
  notifySkillsWatchAvailable,
  resetSkillsRefreshStateForTest,
} from "./refresh-state.js";
export { registerSkillsChangeListener } from "./refresh-state.js";

const log = createSubsystemLogger("gateway/skills");
const runInDiscoveryContext = AsyncLocalStorage.snapshot();
const SAFETY_REFRESH_MS = 30 * 60_000;
const MAX_SOURCES = 128;
type Source = {
  selection: SkillsDiscoverySourceSelection;
  workspaceDir: string;
  environment: SkillsDiscoveryEnvironment;
  watch: boolean;
  dirty: boolean;
  sources?: WorkspaceSkillSources;
  fingerprint?: string;
  unavailable?: boolean;
  watchDirectories?: string[];
  observations: Map<string, ReturnType<typeof observeOwnedDirectory>>;
};
type DiscoveryState = {
  catalog: Map<string, Skill>;
  sources: Map<string, Source>;
  plans: Map<string, Promise<{ plan: WorkspaceSkillSourcePlan; input: SkillsSourcePlanInput }>>;
  pool?: WorkerTaskPool<SkillsDiscoveryInput, SkillsDiscoveryOutput>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  closing?: Promise<void>;
};

const state = resolveGlobalSingleton<DiscoveryState>(
  Symbol.for("openclaw.skillsDiscovery"),
  () => ({ sources: new Map(), plans: new Map(), catalog: new Map() }),
  () => closeSkillsWatchers(),
);

/** Share parsed facts, never agent selection or workspace read authority. */
function shareCatalogSkill(skill: Skill): Skill {
  const key = JSON.stringify([
    skill.filePath,
    skill.sourceInfo,
    skill.discoveryRoot,
    skill.fileHost,
    skill.source,
  ]);
  const previous = state.catalog.get(key);
  if (previous === skill || (previous && isDeepStrictEqual(previous, skill))) {
    return previous;
  }
  // A completed scan supplies the current content hash and metadata. Replace
  // edited facts; snapshots already in use retain their immutable old revision.
  Object.freeze(skill.sourceInfo);
  if (skill.discoveryRoot) {
    Object.freeze(skill.discoveryRoot);
  }
  state.catalog.set(key, Object.freeze(skill));
  // Bound catalogs from retired workspaces and transient resource locations.
  if (state.catalog.size > 4096) {
    state.catalog.delete(state.catalog.keys().next().value!);
  }
  return skill;
}

function pool() {
  return (state.pool ??= runInDiscoveryContext(
    () =>
      new WorkerTaskPool({
        workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.skillsDiscovery),
        workerClass: "singleton",
        idleTimeoutMs: 0,
      }),
  ));
}

function observeSource(source: Source) {
  if (!source.watch || !source.watchDirectories) {
    return;
  }
  const directories = new Set(source.watchDirectories);
  for (const [directory, observation] of source.observations) {
    if (!directories.has(directory)) {
      observation.close();
      source.observations.delete(directory);
    }
  }
  for (const directory of directories) {
    if (!source.observations.has(directory)) {
      // Windows cannot rename a workspace while a watch holds a descendant directory.
      // One recursive workspace handle still reports edits in each selected subtree.
      const watchRoot =
        process.platform === "win32"
          ? ([source.workspaceDir, source.selection.request.executionWorkspaceDir]
              .filter((root): root is string => Boolean(root && isPathInside(root, directory)))
              .toSorted((a, b) => a.length - b.length)[0] ?? path.dirname(directory))
          : undefined;
      source.observations.set(
        directory,
        observeOwnedDirectory(
          directory,
          () => {
            source.dirty = true;
            state.refreshTimer ??= runInDiscoveryContext(() =>
              setTimeout(() => {
                state.refreshTimer = undefined;
                void scanDirtySources().catch((error: unknown) =>
                  log.warn(`passive skills refresh failed: ${String(error)}`),
                );
              }, 50).unref(),
            );
          },
          { recursive: true, reconcileIntervalMs: SAFETY_REFRESH_MS, watchRoot },
        ),
      );
    }
  }
}

function closeSource(source: Source) {
  for (const observation of source.observations.values()) {
    observation.close();
  }
  source.observations.clear();
}

function scanDirtySources(): Promise<void> {
  if (state.closing) {
    return Promise.reject(new Error("Skills discovery is closing"));
  }
  state.pending ??= runInDiscoveryContext(async () => {
    while (!state.closing) {
      const selected = [...state.sources].filter(([, source]) => source.dirty);
      if (!selected.length) {
        return;
      }
      for (const [, source] of selected) {
        source.dirty = false;
      }
      let results: SkillsDiscoveryResult[];
      try {
        const response = await pool().run(
          {
            kind: "scan",
            requests: selected.map(([key, source]) => ({
              key,
              environment: source.environment,
              selection: source.selection,
            })),
            path: process.env.PATH,
          },
          { timeoutMs: 120_000 },
        );
        if (response.kind !== "scan") {
          throw new Error("Unexpected Skills discovery response");
        }
        results = response.results;
      } catch (error) {
        for (const [key, source] of selected) {
          if (state.sources.get(key) !== source) {
            continue;
          }
          source.dirty = true;
          if (!state.closing && !source.unavailable) {
            source.unavailable = true;
            bumpSkillsSnapshotVersion({
              workspaceDir: source.workspaceDir,
              reason: "watch-unavailable",
            });
          }
        }
        throw error;
      }
      if (state.closing) {
        return;
      }
      const changed = new Set<string>();
      const refreshed = new Set<string>();
      const recovered: Source[] = [];
      // Install the completed batch before publishing any revision or listener event.
      for (const result of results) {
        const source = state.sources.get(result.key);
        if (
          !source ||
          source !== selected.find(([key]) => key === result.key)?.[1] ||
          source.dirty
        ) {
          continue;
        }
        if (source.fingerprint !== undefined && source.fingerprint !== result.fingerprint) {
          changed.add(source.workspaceDir);
        }
        if (source.unavailable) {
          source.unavailable = false;
          recovered.push(source);
        }
        if (result.plan && source.selection.plan) {
          const input = source.selection.plan.input;
          state.plans.set(JSON.stringify(input), Promise.resolve({ plan: result.plan, input }));
        }
        for (const entry of [...result.sources.entries, ...result.sources.executionEntries]) {
          entry.skill = shareCatalogSkill(entry.skill);
        }
        source.sources = result.sources;
        source.fingerprint = result.fingerprint;
        source.watchDirectories = result.watchDirectories;
        observeSource(source);
        refreshed.add(source.workspaceDir);
      }
      while (state.plans.size > MAX_SOURCES) {
        state.plans.delete(state.plans.keys().next().value!);
      }
      // A completed bounded pass also invalidates supporting-file copies. This
      // deliberately conservative revision avoids a second recursive tree scan.
      for (const workspaceDir of refreshed) {
        markSkillsSupportingFilesChanged({ workspaceDir });
      }
      for (const workspaceDir of changed) {
        bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      }
      for (const source of recovered) {
        notifySkillsWatchAvailable({
          workspaceDir: source.workspaceDir,
        });
      }
    }
  }).finally(() => {
    state.pending = undefined;
  });
  return state.pending;
}

async function registerSource(selection: SkillsDiscoverySourceSelection, watch?: boolean) {
  if (state.closing) {
    await state.closing;
  }
  const environment = selection.plan?.input.environment ?? captureSkillsDiscoveryEnvironment();
  const { request } = selection;
  const key = JSON.stringify(
    selection.plan
      ? { ...request, sourcePlan: undefined, plan: selection.plan }
      : { ...request, environment },
  );
  let source = state.sources.get(key);
  if (!source) {
    if (state.sources.size >= MAX_SOURCES) {
      const oldestKey = state.sources.keys().next().value!;
      const oldest = state.sources.get(oldestKey)!;
      closeSource(oldest);
      state.sources.delete(oldestKey);
      // An evicted source has no retained fingerprint to compare on readmission.
      bumpSkillsSnapshotVersion({
        workspaceDir: oldest.workspaceDir,
        reason: "watch",
      });
    }
    source = {
      selection,
      workspaceDir:
        selection.kind === "planned"
          ? selection.plan.input.workspaceDir
          : selection.request.sourcePlan.workspaceDir,
      environment,
      watch: watch !== false,
      dirty: true,
      observations: new Map(),
    };
    state.sources.set(key, source);
  } else {
    // An opt-out read must not withdraw another consumer's passive observation.
    source.watch ||= watch !== false;
    state.sources.delete(key);
    state.sources.set(key, source);
  }
  observeSource(source);
  return { key, source };
}

function readRegisteredSource({ key, source }: Awaited<ReturnType<typeof registerSource>>) {
  if (state.sources.get(key) !== source || !source.sources) {
    throw new Error("Skills discovery was retired before publication");
  }
  return source.sources;
}

async function publishRegisteredSource(registration: Awaited<ReturnType<typeof registerSource>>) {
  const { source } = registration;
  if (source.dirty || !source.sources) {
    await scanDirtySources();
  }
  return readRegisteredSource(registration);
}

/** The only asynchronous local discovery boundary, shared by all Gateway consumers. */
export async function prepareLocalSkillSources(
  request: WorkspaceSkillSourceRequest,
  options: { watch?: boolean; plan?: SkillsDiscoverySourceSelection["plan"] } = {},
): Promise<WorkspaceSkillSources> {
  return publishRegisteredSource(
    await registerSource({ kind: "selected", request, plan: options.plan }, options.watch),
  );
}

/** Compose roots on the same worker, reusing facts until its next completed scan. */
export async function prepareSkillSourcePlan(
  workspaceDir: string,
  options: WorkspaceSkillSourcePlanOptions = {},
) {
  if (state.closing) {
    await state.closing;
  }
  const input = captureSkillsSourcePlanInput(workspaceDir, options);
  const key = JSON.stringify(input);
  return getOrCreatePromise(
    state.plans,
    key,
    () => {
      if (state.plans.size >= MAX_SOURCES) {
        state.plans.delete(state.plans.keys().next().value!);
      }
      return pool()
        .run({ kind: "plan", input }, { timeoutMs: 120_000 })
        .then((result) => {
          if (result.kind !== "plan") {
            throw new Error("Unexpected Skills source plan response");
          }
          return { plan: result.plan, input };
        });
    },
    { cacheRejections: false },
  );
}

export async function projectSkillSnapshot(
  input: SkillSnapshotProjectionInput,
): Promise<SkillSnapshot> {
  if (state.closing) {
    await state.closing;
  }
  const skills = input.eligible.map((entry) => shareCatalogSkill(entry.skill));
  const result = await pool().run(
    { kind: "project", input, environment: captureSkillsDiscoveryEnvironment() },
    { timeoutMs: 120_000 },
  );
  if (result.kind !== "project") {
    throw new Error("Unexpected Skills projection response");
  }
  return {
    ...result.snapshot,
    resolvedSkills: result.resolvedIndices.map((index) => skills[index]!),
    discoverySkills: result.discoveryIndices.map((index) => skills[index]!),
  };
}

export async function prepareSkillStatusFacts(
  input: Parameters<typeof readWorkspaceSkillStatusFacts>[0],
) {
  if (state.closing) {
    await state.closing;
  }
  const result = await pool().run(
    { kind: "status", input, environment: captureSkillsDiscoveryEnvironment() },
    { timeoutMs: 120_000 },
  );
  if (result.kind !== "status") {
    throw new Error("Unexpected Skills status response");
  }
  return result.facts;
}

async function registerSkillsWatcher(params: SkillsWatcherParams) {
  if (state.closing) {
    await state.closing;
  }
  const access = getAgentWorkspaceAccess(params.workspaceDir, "loadSkills");
  const watcherKey = JSON.stringify([
    params.workspaceDir,
    params.executionWorkspaceDir,
    params.executionWorkspaceFileHost,
  ]);
  if (!access?.loadSkills && !params.sourcePlan) {
    await disposeRemoteSkillsWatcher(watcherKey);
    // Local discovery selects roots and reads them in one worker pass.
    return registerSource(
      {
        kind: "planned",
        request: {
          executionWorkspaceDir: params.executionWorkspaceDir,
          limits: resolveSkillDiscoveryLimits(params.config),
          additionalBins: [],
        },
        plan: { input: captureSkillsSourcePlanInput(params.workspaceDir, params) },
      },
      params.config?.skills?.load?.watch,
    );
  }
  const prepared = params.sourcePlan
    ? undefined
    : await prepareSkillSourcePlan(params.workspaceDir, params);
  const plan = params.sourcePlan ?? prepared!.plan;
  const split = access?.loadSkills ? splitSkillSourcePlan(plan, params) : undefined;
  if (split && params.config?.skills?.load?.watch !== false) {
    await ensureRemoteSkillsWatcher({
      watcherKey,
      workspaceDir: params.workspaceDir,
      executionWorkspaceDir: split.workspaceExecutionWorkspaceDir,
      access: access!,
      sourcePlan: split.workspacePlan,
    });
  } else {
    await disposeRemoteSkillsWatcher(watcherKey);
  }
  return registerSource(
    {
      kind: "selected",
      request: {
        sourcePlan: split?.gatewayPlan ?? plan,
        executionWorkspaceDir: split
          ? split.gatewayExecutionWorkspaceDir
          : params.executionWorkspaceDir,
        limits: resolveSkillDiscoveryLimits(params.config),
        additionalBins: [],
      },
      plan: prepared
        ? { input: prepared.input, ...(split ? { scope: "gateway" as const } : {}) }
        : undefined,
    },
    params.config?.skills?.load?.watch,
  );
}

/** Keep remote observation on its owning host; await the local source publication. */
export async function ensureSkillsWatcher(params: SkillsWatcherParams): Promise<void> {
  await publishRegisteredSource(await registerSkillsWatcher(params));
}

/** Explicit actions await a completed worker publication. */
export async function refreshSkillsDiscovery(
  params: {
    workspaceDir?: string;
    config?: OpenClawConfig;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    reason?: "manual" | "workshop" | "config-change";
  } = {},
): Promise<void> {
  if (params.reason === "config-change") {
    await resetSkillsDiscoverySources(false);
  }
  for (const source of state.sources.values()) {
    source.dirty = true;
  }
  if (params.config) {
    const { listAgentIds, resolveAgentWorkspaceDir } =
      await import("../../agents/agent-scope-config.js");
    const agentIds = listAgentIds(params.config);
    // Register each bounded batch before dispatch; roots are selected once per source.
    for (let offset = 0; offset < agentIds.length; offset += MAX_SOURCES) {
      const registrations = await Promise.all(
        agentIds.slice(offset, offset + MAX_SOURCES).map((agentId) =>
          registerSkillsWatcher({
            workspaceDir: resolveAgentWorkspaceDir(params.config!, agentId),
            config: params.config,
            pluginMetadataSnapshot: params.pluginMetadataSnapshot,
            agentId,
          }),
        ),
      );
      await scanDirtySources();
      registrations.forEach(readRegisteredSource);
    }
  } else {
    if (!state.sources.size && params.workspaceDir) {
      await registerSkillsWatcher({
        workspaceDir: params.workspaceDir,
        pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      });
    }
    await scanDirtySources();
  }
  bumpSkillsSnapshotVersion({
    workspaceDir: params.workspaceDir,
    reason: params.reason ?? "manual",
  });
}

async function resetSkillsDiscoverySources(
  retireWorker: boolean,
  resetState = false,
): Promise<void> {
  if (state.closing) {
    await state.closing;
    // A concurrent shutdown must still retire the worker a source reset retained.
    if (!retireWorker || !state.pool) {
      return;
    }
  }
  clearTimeout(state.refreshTimer);
  state.refreshTimer = undefined;
  // Config changes replace plans and subscriptions, not the healthy discovery worker.
  // Its requests already carry their own environment and freshly selected source plan.
  const activePool = retireWorker ? state.pool : undefined;
  if (retireWorker) {
    state.pool = undefined;
  }
  for (const source of state.sources.values()) {
    closeSource(source);
  }
  state.sources.clear();
  state.plans.clear();
  if (retireWorker) {
    state.catalog.clear();
  }
  state.closing = Promise.allSettled([
    state.pending?.catch(() => {}),
    activePool?.close(),
    closeRemoteSkillsWatchers(),
  ])
    .then((results) => {
      if (resetState) {
        resetSkillsRefreshStateForTest();
      }
      throwSettledAggregate(results, "Skills discovery shutdown failed");
    })
    .finally(() => {
      state.closing = undefined;
    });
  return state.closing;
}

export function closeSkillsWatchers(resetState = false): Promise<void> {
  return resetSkillsDiscoverySources(true, resetState);
}

export const detachSkillsWatchers = closeSkillsWatchers;
