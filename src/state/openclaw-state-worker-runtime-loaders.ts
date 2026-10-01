import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { OpenClawStateWorkerRuntimeCommand } from "./openclaw-state-worker-contract.js";
import {
  stateWorkerRegistry,
  type RegisteredStateWorkerOperations,
} from "./openclaw-state-worker-registry.js";

type PreparedCommandRuntime<T> = {
  prepare: (type: PropertyKey) => Promise<void> | undefined;
  get: () => T;
};

function commandRuntime<T>(
  importer: () => Promise<T>,
  prepare?: (runtime: T, type: PropertyKey) => Promise<void> | undefined,
): PreparedCommandRuntime<T> {
  const load = createLazyRuntimeModule(importer);
  let runtime: T | undefined;
  return {
    prepare(type) {
      if (runtime) {
        return prepare?.(runtime, type);
      }
      return load().then((loaded) => {
        runtime = loaded;
        return prepare?.(loaded, type);
      });
    },
    get() {
      if (!runtime) {
        throw new Error("Shared-state worker command runtime is not prepared");
      }
      return runtime;
    },
  };
}

export const sharedStateCommandRuntimes = {
  sandboxImport: commandRuntime(() => import("../agents/sandbox/registry-import.worker.js")),
  sandboxWrite: commandRuntime(() => import("../agents/sandbox/registry-write.worker.js")),
  subagents: commandRuntime(
    () => import("../agents/subagents/registry/subagent-registry.store.kernel.js"),
  ),
  workspace: commandRuntime(() => import("../agents/workspace-state-store.kernel.js")),
  claws: commandRuntime(() => import("../claws/provenance-runtime-read.kernel.js")),
  configSnapshot: commandRuntime(() => import("../config/config-journal-snapshot.kernel.js")),
  configHealth: commandRuntime(() => import("../config/io.health-state.kernel.js")),
  cron: commandRuntime(
    () => import("../cron/store/dispatch.worker.js"),
    (runtime, type) => runtime.prepareCronStateWorkerCommand(type),
  ),
  githubRepository: commandRuntime(
    () => import("../gateway/github-repository-publication.kernel.js"),
  ),
  sessionGroups: commandRuntime(() => import("../gateway/session-group-catalog.kernel.js")),
  workerInference: commandRuntime(
    () => import("../gateway/worker-environments/inference-store.worker.js"),
  ),
  workerPlacements: commandRuntime(
    () => import("../gateway/worker-environments/placement-dispatch-store.worker.js"),
  ),
  placementTools: commandRuntime(
    () => import("../gateway/worker-environments/placement-session-tool-operations.worker.js"),
  ),
  placementTurns: commandRuntime(
    () => import("../gateway/worker-environments/placement-turn-claims.worker.js"),
  ),
  placementJournals: commandRuntime(
    () => import("../gateway/worker-environments/placement-workspace-journal.worker.js"),
  ),
  workerEnvironments: commandRuntime(
    () => import("../gateway/worker-environments/store.worker.js"),
  ),
  deviceAuth: commandRuntime(() => import("../infra/device-auth-store.kernel.js")),
  diagnostic: commandRuntime(() => import("../infra/sqlite-audit-record.kernel.js")),
  updateInterrupted: commandRuntime(() => import("../infra/update-run-interruption-store.js")),
  updateMutation: commandRuntime(() => import("../infra/update-run-mutation.worker.js")),
  updateReconcile: commandRuntime(() => import("../infra/update-run-reconciliation.worker.js")),
  projects: commandRuntime(() => import("../projects/project-registry.worker.js")),
  secretsConfigRef: commandRuntime(
    () => import("../secrets/store/secret-store-config-ref.kernel.js"),
  ),
  secretsPurge: commandRuntime(() => import("../secrets/store/secret-store-expiry.kernel.js")),
  sessionState: commandRuntime(() => import("../sessions/session-state-events.worker.js")),
  sessionUpstreamRead: commandRuntime(() => import("../sessions/session-upstream-links.kernel.js")),
  sessionUpstream: commandRuntime(() => import("../sessions/session-upstream-links.worker.js")),
  transcripts: commandRuntime(() => import("../transcripts/store-worker-read.js")),
  tuiClear: commandRuntime(() => import("../tui/tui-last-session.kernel.js")),
  agentProvenance: commandRuntime(async () => {
    const [kernel, schema] = await Promise.all([
      import("./agent-provenance.kernel.js"),
      import("./agent-provenance.schema.js"),
    ]);
    return { ...kernel, ...schema };
  }),
  backup: commandRuntime(() => import("./backup-run-records.kernel.js")),
  tuiWrite: commandRuntime(() => import("./config-machine-state-write.js")),
  githubPublication: commandRuntime(() => import("./github-personal-publication-lifecycle.js")),
  repositoryWorkspaces: commandRuntime(() => import("./session-repository-workspaces.worker.js")),
  userPreferences: commandRuntime(() => import("./user-preferences.worker.js")),
};

const runtimes = sharedStateCommandRuntimes;

type UnregisteredCommandType = Exclude<
  OpenClawStateWorkerRuntimeCommand["type"],
  keyof RegisteredStateWorkerOperations | "database.generationMatches"
>;

// Mixed namespaces select exact commands so transcript reads never prepare writes.
type RuntimeKey<Type> = Type extends
  | `transcripts.${string}`
  | `sandboxRegistry.${string}`
  | `config.${string}`
  | `updateRuns.${string}`
  | `secrets.${string}`
  | `sessionUpstream.${string}`
  | `tui.${string}`
  ? Type
  : Type extends `${infer Domain}.${string}`
    ? Domain
    : never;

const commandRuntimes: Readonly<Partial<Record<string, PreparedCommandRuntime<unknown>>>> = {
  "sandboxRegistry.insertIfMissing": runtimes.sandboxImport,
  "sandboxRegistry.write": runtimes.sandboxWrite,
  "config.health.read": runtimes.configHealth,
  "config.health.patch": runtimes.configHealth,
  "config.snapshot.upsert": runtimes.configSnapshot,
  "updateRuns.recordStep": runtimes.updateMutation,
  "updateRuns.recordPhase": runtimes.updateMutation,
  "updateRuns.reconcile": runtimes.updateReconcile,
  "updateRuns.reconcileInterrupted": runtimes.updateInterrupted,
  "secrets.purge": runtimes.secretsPurge,
  "secrets.writeForConfigRef": runtimes.secretsConfigRef,
  "sessionUpstream.listWatched": runtimes.sessionUpstreamRead,
  "sessionUpstream.current": runtimes.sessionUpstream,
  "sessionUpstream.settle": runtimes.sessionUpstream,
  "tui.lastSession.clear": runtimes.tuiClear,
  "tui.lastSession.write": runtimes.tuiWrite,
  "transcripts.canonicalSessionRow": runtimes.transcripts,
  "transcripts.readEntries": runtimes.transcripts,
  "transcripts.exportOwnership": runtimes.transcripts,
  "transcripts.exportPathCollisions": runtimes.transcripts,
  "transcripts.exportPathOwners": runtimes.transcripts,
  "transcripts.summarySnapshot": runtimes.transcripts,
  "transcripts.sessionEntries": runtimes.transcripts,
  "transcripts.matches": runtimes.transcripts,
  "transcripts.session": runtimes.transcripts,
  "transcripts.entry": runtimes.transcripts,
  "transcripts.latest": runtimes.transcripts,
  "transcripts.notes": runtimes.transcripts,
  "transcripts.libraryEntry": runtimes.transcripts,
  "transcripts.recentStopped": runtimes.transcripts,
  "transcripts.summaryRevision": runtimes.transcripts,
  "transcripts.utterances": runtimes.transcripts,
  "transcripts.summary": runtimes.transcripts,
  "transcripts.exportDigest": runtimes.transcripts,
  subagents: runtimes.subagents,
  workspace: runtimes.workspace,
  claws: runtimes.claws,
  githubRepository: runtimes.githubRepository,
  sessionGroups: runtimes.sessionGroups,
  workerInference: runtimes.workerInference,
  workerPlacements: runtimes.workerPlacements,
  placementTools: runtimes.placementTools,
  placementTurns: runtimes.placementTurns,
  placementJournals: runtimes.placementJournals,
  workerEnvironments: runtimes.workerEnvironments,
  deviceAuth: runtimes.deviceAuth,
  diagnostic: runtimes.diagnostic,
  projects: runtimes.projects,
  sessionState: runtimes.sessionState,
  backup: runtimes.backup,
  githubPublication: runtimes.githubPublication,
  repositoryWorkspaces: runtimes.repositoryWorkspaces,
  userPreferences: runtimes.userPreferences,
  cron: runtimes.cron,
  agentProvenance: runtimes.agentProvenance,
} satisfies Record<RuntimeKey<UnregisteredCommandType>, PreparedCommandRuntime<unknown>>;

function runtimeFor(type: PropertyKey) {
  if (typeof type !== "string") {
    return undefined;
  }
  const key = Object.hasOwn(commandRuntimes, type) ? type : type.slice(0, type.indexOf("."));
  return Object.hasOwn(commandRuntimes, key) ? commandRuntimes[key] : undefined;
}

export function prepareSharedStateCommand(type: PropertyKey): Promise<void> | undefined {
  const runtime = runtimeFor(type);
  return runtime ? runtime.prepare(type) : stateWorkerRegistry.prepare(type);
}

export function requirePreparedSharedStateCommand(command: OpenClawStateWorkerRuntimeCommand) {
  const runtime = runtimeFor(command.type);
  if (runtime) {
    runtime.get();
  } else if (command.type !== "database.generationMatches" && !stateWorkerRegistry.has(command)) {
    throw new Error(`Shared-state worker command runtime is not prepared: ${command.type}`);
  }
  return runtime;
}
