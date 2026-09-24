import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import type { OpenClawStateWorkerBackend } from "./openclaw-state-worker-contract.js";

type ExecutionArguments = [
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
  hasNativeDatabase: boolean,
];
type Result = ReturnType<OpenClawStateWorkerBackend["execute"]>;

export type PreparedSharedStateCommand = {
  prepare(): void | Promise<void>;
  execute(...args: ExecutionArguments): Result;
};

/** Cache code only; each invocation binds its command under the broker's current authority. */
function createSharedStateCommandRuntime<Module>(importer: () => Promise<Module>) {
  const load = createLazyRuntimeModule(importer);
  let runtime: Module | undefined;
  return {
    bind(
      execute: (runtime: Module, ...args: ExecutionArguments) => Result,
      prepare?: (runtime: Module) => void | Promise<void>,
    ): PreparedSharedStateCommand {
      return {
        prepare() {
          if (runtime !== undefined) {
            return prepare?.(runtime);
          }
          return load().then((loaded) => {
            runtime = loaded;
            return prepare?.(loaded);
          });
        },
        execute(...args) {
          if (runtime === undefined) {
            throw new Error("Shared-state worker command runtime is not prepared");
          }
          return execute(runtime, ...args);
        },
      };
    },
  };
}

export const sharedStateCommandRuntimes = {
  mcpOAuth: createSharedStateCommandRuntime(() => import("../agents/mcp-oauth-store.worker.js")),
  execApprovals: createSharedStateCommandRuntime(
    () => import("../infra/exec-approvals-authorization.worker.js"),
  ),
  operatorApprovals: createSharedStateCommandRuntime(
    () => import("../gateway/operator-approval-store.worker.js"),
  ),
  pairing: createSharedStateCommandRuntime(
    () => import("../infra/device-pairing-dispatch.worker.js"),
  ),
  workerEnvironments: createSharedStateCommandRuntime(
    () => import("../gateway/worker-environments/store.worker.js"),
  ),
  auditRead: createSharedStateCommandRuntime(() => import("../audit/audit-event-read.kernel.js")),
  auditWrite: createSharedStateCommandRuntime(
    () => import("../audit/audit-event-writer.worker.js"),
  ),
  conversationBindings: createSharedStateCommandRuntime(
    () => import("../infra/outbound/current-conversation-bindings.worker.js"),
  ),
  authProfiles: createSharedStateCommandRuntime(
    () => import("./openclaw-state-worker-auth-profiles.js"),
  ),
  promotions: createSharedStateCommandRuntime(() => import("../infra/promotions-feed.worker.js")),
  databaseBloat: createSharedStateCommandRuntime(
    () => import("../commands/doctor-db-bloat.read.js"),
  ),
  telemetry: createSharedStateCommandRuntime(() => import("../infra/telemetry-store.kernel.js")),
  webPushRead: createSharedStateCommandRuntime(() => import("../infra/push-web-store.kernel.js")),
  webPush: createSharedStateCommandRuntime(() => import("../infra/push-web-store.worker.js")),
  nativeHookRead: createSharedStateCommandRuntime(
    () => import("../agents/harness/native-hook-relay-store.kernel.js"),
  ),
  nativeHookWrite: createSharedStateCommandRuntime(
    () => import("../agents/harness/native-hook-relay-store.worker.js"),
  ),
  tasks: createSharedStateCommandRuntime(() => import("../tasks/task-registry.worker.js")),
  workshopMigration: createSharedStateCommandRuntime(
    () => import("../commands/doctor-skill-workshop-read.kernel.js"),
  ),
  remoteCatalog: createSharedStateCommandRuntime(() => import("../model-catalog/remote-store.js")),
  bindingApprovals: createSharedStateCommandRuntime(
    () => import("../plugins/conversation-binding-state.kernel.js"),
  ),
  interruptedUpdate: createSharedStateCommandRuntime(
    () => import("../infra/update-run-interruption-store.js"),
  ),
  deferredMigrations: createSharedStateCommandRuntime(
    () => import("../infra/deferred-plugin-migrations.worker.js"),
  ),
  clawProvenance: createSharedStateCommandRuntime(
    () => import("../claws/provenance-runtime-read.kernel.js"),
  ),
  onboarding: createSharedStateCommandRuntime(
    () => import("./onboarding-recommendations.kernel.js"),
  ),
  userPreferences: createSharedStateCommandRuntime(() => import("./user-preferences.worker.js")),
  userProfiles: createSharedStateCommandRuntime(() => import("./user-profiles.worker.js")),
  pluginBlob: createSharedStateCommandRuntime(
    () => import("../plugin-state/plugin-blob-store.worker.js"),
  ),
  pluginState: createSharedStateCommandRuntime(
    () => import("../plugin-state/plugin-state.worker.js"),
  ),
  configHealth: createSharedStateCommandRuntime(
    () => import("../config/io.health-state.kernel.js"),
  ),
  nodeJournal: createSharedStateCommandRuntime(
    () => import("../node-host/node-worker-journal.worker.js"),
  ),
  deviceAuth: createSharedStateCommandRuntime(() => import("../infra/device-auth-store.kernel.js")),
  githubPublication: createSharedStateCommandRuntime(
    () => import("../gateway/github-repository-publication.kernel.js"),
  ),
  workshop: createSharedStateCommandRuntime(() => import("../skills/workshop/store.worker.js")),
  transcriptWrite: createSharedStateCommandRuntime(
    () => import("../transcripts/store-worker-write.js"),
  ),
  transcriptRead: createSharedStateCommandRuntime(
    () => import("../transcripts/store-worker-read.js"),
  ),
  managedImages: createSharedStateCommandRuntime(
    () => import("../gateway/managed-image-record-store.kernel.js"),
  ),
  apns: createSharedStateCommandRuntime(() => import("../infra/push-apns-store.worker.js")),
  catalogSnapshot: createSharedStateCommandRuntime(async () => {
    const [store, source] = await Promise.all([
      import("../plugins/official-external-plugin-catalog-snapshot-store.kernel.js"),
      import("../plugins/official-external-plugin-catalog-source.js"),
    ]);
    return { store, source };
  }),
  sessionUpstream: createSharedStateCommandRuntime(
    () => import("../sessions/session-upstream-links.kernel.js"),
  ),
  cron: createSharedStateCommandRuntime(() => import("../cron/store/dispatch.worker.js")),
  sessionDelivery: createSharedStateCommandRuntime(
    () => import("../infra/session-delivery-queue.worker.js"),
  ),
  sandboxImport: createSharedStateCommandRuntime(
    () => import("../agents/sandbox/registry-import.worker.js"),
  ),
  sandboxWrite: createSharedStateCommandRuntime(
    () => import("../agents/sandbox/registry-write.worker.js"),
  ),
  secrets: createSharedStateCommandRuntime(
    () => import("../secrets/store/secret-store-expiry.kernel.js"),
  ),
  sessionGroups: createSharedStateCommandRuntime(
    () => import("../gateway/session-group-catalog.kernel.js"),
  ),
  delivery: createSharedStateCommandRuntime(() => import("../infra/delivery-queue.worker.js")),
  skillUploads: createSharedStateCommandRuntime(
    () => import("../skills/lifecycle/upload-store.worker.js"),
  ),
  fleet: createSharedStateCommandRuntime(() => import("../fleet/registry.worker.js")),
  provenance: createSharedStateCommandRuntime(async () => {
    const [kernel, schema] = await Promise.all([
      import("./agent-provenance.kernel.js"),
      import("./agent-provenance.schema.js"),
    ]);
    return { kernel, schema };
  }),
  sessionState: createSharedStateCommandRuntime(
    () => import("../sessions/session-state-events.worker.js"),
  ),
  subagents: createSharedStateCommandRuntime(
    () => import("../agents/subagents/registry/subagent-registry.store.kernel.js"),
  ),
  backup: createSharedStateCommandRuntime(() => import("./backup-run-records.kernel.js")),
  worktreeRead: createSharedStateCommandRuntime(
    () => import("../agents/worktrees/registry-read.worker.js"),
  ),
  worktreeLease: createSharedStateCommandRuntime(
    () => import("../agents/worktrees/run-lease-store.worker.js"),
  ),
  projects: createSharedStateCommandRuntime(() => import("../projects/project-registry.worker.js")),
  diagnostic: createSharedStateCommandRuntime(
    () => import("../infra/sqlite-audit-record.kernel.js"),
  ),
};
