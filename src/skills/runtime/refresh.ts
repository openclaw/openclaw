import { AsyncLocalStorage } from "node:async_hooks";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import { capturePluginSkillContributions } from "../loading/plugin-skills.js";
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
  type SkillsSourcePlanInput,
} from "./discovery-worker-contract.js";
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
const PASSIVE_REFRESH_MS = 60_000;
const MAX_SOURCES = 128;
type Source = {
  request: WorkspaceSkillSourceRequest;
  environment: SkillsDiscoveryEnvironment;
  watch: boolean;
  dirty: boolean;
  sources?: WorkspaceSkillSources;
  fingerprint?: string;
  unavailable?: boolean;
  plan?: { input: SkillsSourcePlanInput; scope?: "gateway" };
};
type DiscoveryState = {
  sources: Map<string, Source>;
  plans: Map<string, Promise<{ plan: WorkspaceSkillSourcePlan; input: SkillsSourcePlanInput }>>;
  pool?: WorkerTaskPool<SkillsDiscoveryInput, SkillsDiscoveryOutput>;
  timer?: ReturnType<typeof setInterval>;
  pending?: Promise<void>;
  closing?: Promise<void>;
};

const state = resolveGlobalSingleton<DiscoveryState>(
  Symbol.for("openclaw.skillsDiscovery"),
  () => ({ sources: new Map(), plans: new Map() }),
  () => closeSkillsWatchers(),
);

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

function startPassiveRefresh() {
  if (state.timer || ![...state.sources.values()].some((source) => source.watch)) {
    return;
  }
  // No filesystem events, classification, or discovery run on the Gateway thread.
  state.timer = runInDiscoveryContext(() =>
    setInterval(() => {
      for (const source of state.sources.values()) {
        if (source.watch) {
          source.dirty = true;
        }
      }
      void scanDirtySources().catch((error: unknown) =>
        log.warn(`passive skills refresh failed: ${String(error)}`),
      );
    }, PASSIVE_REFRESH_MS),
  );
  state.timer.unref();
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
              request: source.request,
              environment: source.environment,
              plan: source.plan,
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
              workspaceDir: source.request.sourcePlan.workspaceDir,
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
          changed.add(source.request.sourcePlan.workspaceDir);
        }
        if (source.unavailable) {
          source.unavailable = false;
          recovered.push(source);
        }
        if (result.plan && source.plan) {
          const input = source.plan.input;
          state.plans.set(JSON.stringify(input), Promise.resolve({ plan: result.plan, input }));
        }
        source.sources = result.sources;
        source.fingerprint = result.fingerprint;
        refreshed.add(source.request.sourcePlan.workspaceDir);
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
          workspaceDir: source.request.sourcePlan.workspaceDir,
          sourceScope: { executionWorkspaceDir: source.request.executionWorkspaceDir },
        });
      }
    }
  }).finally(() => {
    state.pending = undefined;
  });
  return state.pending;
}

/** The only asynchronous local discovery boundary, shared by all Gateway consumers. */
export async function prepareLocalSkillSources(
  request: WorkspaceSkillSourceRequest,
  options: { watch?: boolean; plan?: Source["plan"] } = {},
): Promise<WorkspaceSkillSources> {
  if (state.closing) {
    await state.closing;
  }
  const environment = options.plan?.input.environment ?? captureSkillsDiscoveryEnvironment();
  const key = JSON.stringify(
    options.plan
      ? { ...request, sourcePlan: undefined, plan: options.plan }
      : { ...request, environment },
  );
  let source = state.sources.get(key);
  if (!source) {
    if (state.sources.size >= MAX_SOURCES) {
      const oldestKey = state.sources.keys().next().value!;
      const oldest = state.sources.get(oldestKey)!;
      state.sources.delete(oldestKey);
      // An evicted source has no retained fingerprint to compare on readmission.
      bumpSkillsSnapshotVersion({
        workspaceDir: oldest.request.sourcePlan.workspaceDir,
        reason: "watch",
      });
    }
    source = {
      request,
      environment,
      plan: options.plan,
      watch: options.watch !== false,
      dirty: true,
    };
    state.sources.set(key, source);
  } else {
    // An opt-out read must not withdraw another consumer's passive observation.
    source.watch ||= options.watch !== false;
    state.sources.delete(key);
    state.sources.set(key, source);
  }
  startPassiveRefresh();
  if (source.dirty || !source.sources || state.pending) {
    await scanDirtySources();
  }
  if (state.sources.get(key) !== source || !source.sources) {
    throw new Error("Skills discovery was retired before publication");
  }
  return source.sources;
}

/** Compose roots on the same worker, reusing facts until its next completed scan. */
export async function prepareSkillSourcePlan(
  workspaceDir: string,
  options: WorkspaceSkillSourcePlanOptions = {},
) {
  if (state.closing) {
    await state.closing;
  }
  const { pluginMetadataSnapshot } = options;
  const acpRuntimeAvailable = isAcpRuntimeSpawnAvailable({ config: options.config });
  const input: SkillsSourcePlanInput = {
    workspaceDir,
    environment: captureSkillsDiscoveryEnvironment(),
    options: {
      config: options.config,
      agentId: options.agentId,
      workspaceOnly: options.workspaceOnly,
      managedSkillsDir: options.managedSkillsDir,
      bundledSkillsDir: options.bundledSkillsDir,
      pluginSkillsDir: options.pluginSkillsDir,
    },
    acpRuntimeAvailable,
    ...(pluginMetadataSnapshot
      ? {
          pluginContributions: capturePluginSkillContributions({
            metadataSnapshot: pluginMetadataSnapshot,
            config: options.config,
            acpRuntimeAvailable,
          }),
        }
      : {}),
  };
  const key = JSON.stringify(input);
  let pending = state.plans.get(key);
  if (!pending) {
    if (state.plans.size >= MAX_SOURCES) {
      state.plans.delete(state.plans.keys().next().value!);
    }
    pending = pool()
      .run({ kind: "plan", input }, { timeoutMs: 120_000 })
      .then((result) => {
        if (result.kind !== "plan") {
          throw new Error("Unexpected Skills source plan response");
        }
        return { plan: result.plan, input };
      });
    state.plans.set(key, pending);
    void pending.catch(() => {
      if (state.plans.get(key) === pending) {
        state.plans.delete(key);
      }
    });
  }
  return pending;
}

export async function projectSkillSnapshot(
  input: SkillSnapshotProjectionInput,
): Promise<SkillSnapshot> {
  if (state.closing) {
    await state.closing;
  }
  const result = await pool().run(
    { kind: "project", input, environment: captureSkillsDiscoveryEnvironment() },
    { timeoutMs: 120_000 },
  );
  if (result.kind !== "project") {
    throw new Error("Unexpected Skills projection response");
  }
  return result.snapshot;
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

/** Keep remote observation on its owning host; local registration does no scanning. */
export async function ensureSkillsWatcher(params: {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
  config?: OpenClawConfig;
  agentId?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  sourcePlan?: WorkspaceSkillSourcePlan;
}): Promise<void> {
  const prepared = params.sourcePlan
    ? undefined
    : await prepareSkillSourcePlan(params.workspaceDir, params);
  const plan = params.sourcePlan ?? prepared!.plan;
  const access = getAgentWorkspaceAccess(params.workspaceDir, "loadSkills");
  const watcherKey = JSON.stringify([
    params.workspaceDir,
    params.executionWorkspaceDir,
    params.executionWorkspaceFileHost,
  ]);
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
  await prepareLocalSkillSources(
    {
      sourcePlan: split?.gatewayPlan ?? plan,
      executionWorkspaceDir: split
        ? split.gatewayExecutionWorkspaceDir
        : params.executionWorkspaceDir,
      limits: resolveSkillDiscoveryLimits(params.config),
      additionalBins: [],
    },
    {
      watch: params.config?.skills?.load?.watch,
      plan: prepared
        ? { input: prepared.input, ...(split ? { scope: "gateway" as const } : {}) }
        : undefined,
    },
  );
}

/** Explicit actions bypass the passive interval and await a completed worker publication. */
export async function refreshSkillsDiscovery(
  params: {
    workspaceDir?: string;
    config?: OpenClawConfig;
    reason?: "manual" | "workshop" | "config-change";
  } = {},
): Promise<void> {
  if (params.reason === "config-change") {
    await closeSkillsWatchers();
  }
  for (const source of state.sources.values()) {
    source.dirty = true;
  }
  if (params.config) {
    const { listAgentIds, resolveAgentWorkspaceDir } =
      await import("../../agents/agent-scope-config.js");
    await Promise.all(
      listAgentIds(params.config).map((agentId) =>
        ensureSkillsWatcher({
          workspaceDir: resolveAgentWorkspaceDir(params.config!, agentId),
          config: params.config,
          agentId,
        }),
      ),
    );
  } else if (!state.sources.size && params.workspaceDir) {
    await ensureSkillsWatcher({ workspaceDir: params.workspaceDir });
  }
  await scanDirtySources();
  bumpSkillsSnapshotVersion({
    workspaceDir: params.workspaceDir,
    reason: params.reason ?? "manual",
  });
}

export async function closeSkillsWatchers(resetState = false): Promise<void> {
  if (state.closing) {
    return state.closing;
  }
  clearInterval(state.timer);
  state.timer = undefined;
  const activePool = state.pool;
  state.pool = undefined;
  state.sources.clear();
  state.plans.clear();
  state.closing = Promise.allSettled([
    state.pending?.catch(() => {}),
    activePool?.close(),
    closeRemoteSkillsWatchers(),
  ])
    .then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (resetState) {
        resetSkillsRefreshStateForTest();
      }
      if (failures.length) {
        throw new AggregateError(failures, "Skills discovery shutdown failed");
      }
    })
    .finally(() => {
      state.closing = undefined;
    });
  return state.closing;
}

export const detachSkillsWatchers = closeSkillsWatchers;
