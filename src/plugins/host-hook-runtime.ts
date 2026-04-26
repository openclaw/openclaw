import type { AgentEventPayload } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  isPluginJsonValue,
  type PluginHostCleanupReason,
  type PluginJsonValue,
  type PluginRunContextGetParams,
  type PluginRunContextPatch,
  type PluginSessionSchedulerJobHandle,
  type PluginSessionSchedulerJobRegistration,
} from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";

type PluginRunContextNamespaces = Map<string, PluginJsonValue>;
type PluginRunContextByPlugin = Map<string, PluginRunContextNamespaces>;

type SchedulerJobRecord = {
  pluginId: string;
  pluginName?: string;
  job: PluginSessionSchedulerJobRegistration;
};

type PluginHostRuntimeState = {
  runContextByRunId: Map<string, PluginRunContextByPlugin>;
  schedulerJobsByPlugin: Map<string, Map<string, SchedulerJobRecord>>;
};

const PLUGIN_HOST_RUNTIME_STATE_KEY = Symbol.for("openclaw.pluginHostRuntimeState");
const log = createSubsystemLogger("plugins/host-hooks");

function getPluginHostRuntimeState(): PluginHostRuntimeState {
  return resolveGlobalSingleton<PluginHostRuntimeState>(PLUGIN_HOST_RUNTIME_STATE_KEY, () => ({
    runContextByRunId: new Map(),
    schedulerJobsByPlugin: new Map(),
  }));
}

function normalizeNamespace(value: string | undefined): string {
  return (value ?? "").trim();
}

function copyJsonValue(value: PluginJsonValue): PluginJsonValue {
  return structuredClone(value);
}

function getPluginRunContextNamespaces(params: {
  runId: string;
  pluginId: string;
  create?: boolean;
}): PluginRunContextNamespaces | undefined {
  const state = getPluginHostRuntimeState();
  let byPlugin = state.runContextByRunId.get(params.runId);
  if (!byPlugin && params.create) {
    byPlugin = new Map();
    state.runContextByRunId.set(params.runId, byPlugin);
  }
  if (!byPlugin) {
    return undefined;
  }
  let namespaces = byPlugin.get(params.pluginId);
  if (!namespaces && params.create) {
    namespaces = new Map();
    byPlugin.set(params.pluginId, namespaces);
  }
  return namespaces;
}

export function setPluginRunContext(params: {
  pluginId: string;
  patch: PluginRunContextPatch;
}): boolean {
  const runId = normalizeOptionalString(params.patch.runId);
  const namespace = normalizeNamespace(params.patch.namespace);
  if (!runId || !namespace) {
    return false;
  }
  if (params.patch.unset || params.patch.value === undefined) {
    clearPluginRunContext({
      pluginId: params.pluginId,
      runId,
      namespace,
    });
    return true;
  }
  if (!isPluginJsonValue(params.patch.value)) {
    return false;
  }
  const namespaces = getPluginRunContextNamespaces({
    runId,
    pluginId: params.pluginId,
    create: true,
  });
  namespaces?.set(namespace, copyJsonValue(params.patch.value));
  return true;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Run-context JSON reads are caller-typed by namespace.
export function getPluginRunContext<T extends PluginJsonValue = PluginJsonValue>(params: {
  pluginId: string;
  get: PluginRunContextGetParams;
}): T | undefined {
  const runId = normalizeOptionalString(params.get.runId);
  const namespace = normalizeNamespace(params.get.namespace);
  if (!runId || !namespace) {
    return undefined;
  }
  const value = getPluginRunContextNamespaces({
    runId,
    pluginId: params.pluginId,
  })?.get(namespace);
  return value === undefined ? undefined : (copyJsonValue(value) as T);
}

export function clearPluginRunContext(params: {
  pluginId?: string;
  runId?: string;
  namespace?: string;
}): void {
  const state = getPluginHostRuntimeState();
  const runIds = params.runId ? [params.runId] : [...state.runContextByRunId.keys()];
  for (const runId of runIds) {
    const byPlugin = state.runContextByRunId.get(runId);
    if (!byPlugin) {
      continue;
    }
    const pluginIds = params.pluginId ? [params.pluginId] : [...byPlugin.keys()];
    for (const pluginId of pluginIds) {
      const namespaces = byPlugin.get(pluginId);
      if (!namespaces) {
        continue;
      }
      if (params.namespace) {
        namespaces.delete(params.namespace);
      } else {
        namespaces.clear();
      }
      if (namespaces.size === 0) {
        byPlugin.delete(pluginId);
      }
    }
    if (byPlugin.size === 0) {
      state.runContextByRunId.delete(runId);
    }
  }
}

function isTerminalAgentRunEvent(event: AgentEventPayload): boolean {
  const phase = event.data?.phase;
  return event.stream === "lifecycle" && (phase === "end" || phase === "error");
}

function logAgentEventSubscriptionFailure(params: {
  pluginId: string;
  subscriptionId: string;
  error: unknown;
}): void {
  log.warn(
    `plugin agent event subscription failed: plugin=${params.pluginId} subscription=${params.subscriptionId} error=${String(params.error)}`,
  );
}

export function dispatchPluginAgentEventSubscriptions(params: {
  registry: PluginRegistry | null | undefined;
  event: AgentEventPayload;
}): void {
  const subscriptions = params.registry?.agentEventSubscriptions ?? [];
  for (const registration of subscriptions) {
    const streams = registration.subscription.streams;
    if (streams && streams.length > 0 && !streams.includes(params.event.stream)) {
      continue;
    }
    const pluginId = registration.pluginId;
    const runId = params.event.runId;
    const ctx = {
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Run-context JSON reads are caller-typed by namespace.
      getRunContext: <T extends PluginJsonValue = PluginJsonValue>(namespace: string) =>
        getPluginRunContext<T>({ pluginId, get: { runId, namespace } }),
      setRunContext: (namespace: string, value: PluginJsonValue) => {
        setPluginRunContext({ pluginId, patch: { runId, namespace, value } });
      },
      clearRunContext: (namespace?: string) => {
        clearPluginRunContext({ pluginId, runId, namespace });
      },
    };
    try {
      void Promise.resolve(
        registration.subscription.handle(structuredClone(params.event), ctx),
      ).catch((error) => {
        logAgentEventSubscriptionFailure({
          pluginId,
          subscriptionId: registration.subscription.id,
          error,
        });
      });
    } catch (error) {
      logAgentEventSubscriptionFailure({
        pluginId,
        subscriptionId: registration.subscription.id,
        error,
      });
    }
  }
  if (isTerminalAgentRunEvent(params.event)) {
    clearPluginRunContext({ runId: params.event.runId });
  }
}

export function registerPluginSessionSchedulerJob(params: {
  pluginId: string;
  pluginName?: string;
  job: PluginSessionSchedulerJobRegistration;
}): PluginSessionSchedulerJobHandle | undefined {
  const id = normalizeOptionalString(params.job.id);
  const sessionKey = normalizeOptionalString(params.job.sessionKey);
  const kind = normalizeOptionalString(params.job.kind);
  if (!id || !sessionKey || !kind) {
    return undefined;
  }
  const state = getPluginHostRuntimeState();
  const jobs = state.schedulerJobsByPlugin.get(params.pluginId) ?? new Map();
  jobs.set(id, {
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    job: { ...params.job, id, sessionKey, kind },
  });
  state.schedulerJobsByPlugin.set(params.pluginId, jobs);
  return { id, pluginId: params.pluginId, sessionKey, kind };
}

function deletePluginSessionSchedulerJob(params: {
  pluginId: string;
  jobId: string;
  sessionKey?: string;
}): void {
  const state = getPluginHostRuntimeState();
  const jobs = state.schedulerJobsByPlugin.get(params.pluginId);
  const record = jobs?.get(params.jobId);
  if (!jobs || !record) {
    return;
  }
  if (params.sessionKey && record.job.sessionKey !== params.sessionKey) {
    return;
  }
  jobs.delete(params.jobId);
  if (jobs.size === 0) {
    state.schedulerJobsByPlugin.delete(params.pluginId);
  }
}

function hasPluginSessionSchedulerJob(params: {
  pluginId: string;
  jobId: string;
  sessionKey?: string;
}): boolean {
  const state = getPluginHostRuntimeState();
  const record = state.schedulerJobsByPlugin.get(params.pluginId)?.get(params.jobId);
  if (!record) {
    return false;
  }
  return !params.sessionKey || record.job.sessionKey === params.sessionKey;
}

export async function cleanupPluginSessionSchedulerJobs(params: {
  pluginId?: string;
  reason: PluginHostCleanupReason;
  sessionKey?: string;
  records?: readonly {
    pluginId: string;
    pluginName?: string;
    job: PluginSessionSchedulerJobRegistration;
  }[];
  preserveJobIds?: ReadonlySet<string>;
}): Promise<Array<{ pluginId: string; hookId: string; error: unknown }>> {
  const state = getPluginHostRuntimeState();
  const failures: Array<{ pluginId: string; hookId: string; error: unknown }> = [];
  if (params.records) {
    for (const record of params.records) {
      if (params.pluginId && record.pluginId !== params.pluginId) {
        continue;
      }
      const jobId = normalizeOptionalString(record.job.id);
      const sessionKey = normalizeOptionalString(record.job.sessionKey);
      if (!jobId || !sessionKey) {
        continue;
      }
      if (params.sessionKey && sessionKey !== params.sessionKey) {
        continue;
      }
      const preserveJob = params.preserveJobIds?.has(jobId) ?? false;
      if (preserveJob) {
        continue;
      }
      if (
        !hasPluginSessionSchedulerJob({
          pluginId: record.pluginId,
          jobId,
          sessionKey: params.sessionKey,
        })
      ) {
        continue;
      }
      try {
        await record.job.cleanup?.({
          reason: params.reason,
          sessionKey,
          jobId,
        });
      } catch (error) {
        failures.push({
          pluginId: record.pluginId,
          hookId: `scheduler:${jobId}`,
          error,
        });
        continue;
      }
      deletePluginSessionSchedulerJob({
        pluginId: record.pluginId,
        jobId,
        sessionKey: params.sessionKey,
      });
    }
    return failures;
  }
  const pluginIds = params.pluginId ? [params.pluginId] : [...state.schedulerJobsByPlugin.keys()];
  for (const pluginId of pluginIds) {
    const jobs = state.schedulerJobsByPlugin.get(pluginId);
    if (!jobs) {
      continue;
    }
    for (const [jobId, record] of jobs.entries()) {
      if (params.sessionKey && record.job.sessionKey !== params.sessionKey) {
        continue;
      }
      try {
        await record.job.cleanup?.({
          reason: params.reason,
          sessionKey: record.job.sessionKey,
          jobId,
        });
      } catch (error) {
        failures.push({
          pluginId,
          hookId: `scheduler:${jobId}`,
          error,
        });
        continue;
      }
      jobs.delete(jobId);
    }
    if (jobs.size === 0) {
      state.schedulerJobsByPlugin.delete(pluginId);
    }
  }
  return failures;
}

export function clearPluginHostRuntimeState(params?: { pluginId?: string; runId?: string }): void {
  clearPluginRunContext(params ?? {});
  if (params?.pluginId) {
    getPluginHostRuntimeState().schedulerJobsByPlugin.delete(params.pluginId);
  } else if (!params?.runId) {
    getPluginHostRuntimeState().schedulerJobsByPlugin.clear();
  }
}

export function listPluginSessionSchedulerJobs(
  pluginId?: string,
): PluginSessionSchedulerJobHandle[] {
  const state = getPluginHostRuntimeState();
  const records: PluginSessionSchedulerJobHandle[] = [];
  const pluginIds = pluginId ? [pluginId] : [...state.schedulerJobsByPlugin.keys()];
  for (const currentPluginId of pluginIds) {
    const jobs = state.schedulerJobsByPlugin.get(currentPluginId);
    if (!jobs) {
      continue;
    }
    for (const record of jobs.values()) {
      records.push({
        id: record.job.id,
        pluginId: currentPluginId,
        sessionKey: record.job.sessionKey,
        kind: record.job.kind,
      });
    }
  }
  return records.toSorted((left, right) => left.id.localeCompare(right.id));
}
