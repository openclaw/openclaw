import fs from "node:fs/promises";
import path from "node:path";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { withProjectCheckoutLifecycle } from "./project-checkout.js";
import { registerResolvedProject } from "./project-registration.js";
import {
  ensureProjectRegistrySchema,
  removeProjectCheckoutReferenceInDatabase,
  type ProjectRegistryIdentity,
  type ProjectRegistryRecord,
} from "./project-registry.kernel.js";

export type { ProjectRegistryRecord } from "./project-registry.kernel.js";
export {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
} from "./project-checkout.js";

function workspaceProject(cfg: OpenClawConfig, agentId: string): ProjectRegistryRecord {
  const repoRoot = resolveAgentWorkspaceDir(cfg, agentId);
  return {
    id: `workspace:${agentId}`,
    displayName: path.basename(repoRoot) || agentId,
    repoRoot,
    source: "workspace",
    agentId,
  };
}

function compareProjects(left: ProjectRegistryRecord, right: ProjectRegistryRecord): number {
  const leftName = left.displayName.toLowerCase();
  const rightName = right.displayName.toLowerCase();
  if (leftName !== rightName) {
    return leftName < rightName ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export async function registerProjectRegistry(
  input: { path: string; name?: string },
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<ProjectRegistryRecord> {
  return await registerResolvedProject({ ...input, source: "registered" }, options);
}

export function listWorkspaceProjects(cfg: OpenClawConfig): ProjectRegistryRecord[] {
  return withAgentRosterFactsBatch(cfg, () =>
    listAgentIds(cfg)
      .map((agentId) => workspaceProject(cfg, agentId))
      .toSorted(compareProjects),
  );
}

export async function listProjectRegistry(
  cfg: OpenClawConfig,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<ProjectRegistryRecord[]> {
  const context = captureOpenClawStateWorkerContext(options);
  const workspaces = listWorkspaceProjects(cfg);
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  const stored = await executeOpenClawStateWorker(context, {
    type: "projects.list",
    input: undefined,
  });
  return [...workspaces, ...stored].toSorted(compareProjects);
}

export function resolveWorkspaceProject(
  cfg: OpenClawConfig,
  id: string,
): ProjectRegistryRecord | undefined {
  if (!id.startsWith("workspace:")) {
    return undefined;
  }
  const agentId = id.slice("workspace:".length);
  return listAgentIds(cfg).includes(agentId) ? workspaceProject(cfg, agentId) : undefined;
}

export async function resolveProjectRegistry(
  cfg: OpenClawConfig,
  id: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<ProjectRegistryRecord | undefined> {
  if (id.startsWith("workspace:")) {
    return resolveWorkspaceProject(cfg, id);
  }
  const context = captureOpenClawStateWorkerContext(options);
  return await readStoredProjectRegistry(context, id);
}

async function readStoredProjectRegistry(
  context: OpenClawStateWorkerContext,
  id: string,
): Promise<ProjectRegistryRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "projects.resolve", input: { id } });
}

type ProjectRegistrySelection = {
  project: ProjectRegistryRecord;
  withCurrent: <T>(
    run: (current: {
      project: ProjectRegistryRecord | undefined;
      assertCurrent: () => void;
      assertCheckoutCurrent: () => void;
      signal: AbortSignal;
    }) => T | Promise<T>,
  ) => Promise<T>;
  withRollback: <T>(run: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
};

/** Retain the original database and reacquire the selected checkout for each finite operation. */
export async function selectStoredProjectRegistry(
  id: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & { signal?: AbortSignal } = {},
): Promise<ProjectRegistrySelection | undefined> {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  const signal = options.signal;
  const project = await readStoredProjectRegistry(context, id);
  if (!project) {
    return undefined;
  }
  const repoRoot = project.repoRoot;
  return {
    project,
    withRollback: async (run) =>
      await withProjectCheckoutLifecycle(
        repoRoot,
        { path: context.admission.databasePath, env },
        async (lease) => {
          const { withOpenClawStateLeaseWorkerAdmission } =
            await import("../state/openclaw-state-lease-worker-owner.js");
          return await withOpenClawStateLeaseWorkerAdmission(
            lease,
            context.admission.databasePath,
            async (admission) =>
              await run(() => {
                context.admission.assertCurrent();
                admission.assertCurrent();
              }),
          );
        },
      ),
    withCurrent: async (run) => {
      const acquisition = new AbortController();
      const abortAcquisition = () => acquisition.abort(signal?.reason);
      signal?.addEventListener("abort", abortAcquisition, { once: true });
      if (signal?.aborted) {
        abortAcquisition();
      }
      try {
        return await withProjectCheckoutLifecycle(
          repoRoot,
          { path: context.admission.databasePath, env, signal: acquisition.signal },
          async (lease) => {
            // Cancellation stops new effects; checkout custody also owns their rollback.
            signal?.removeEventListener("abort", abortAcquisition);
            const operationSignal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
            try {
              const { withOpenClawStateLeaseWorkerAdmission } =
                await import("../state/openclaw-state-lease-worker-owner.js");
              const { runOpenClawStateWorkerOperation } =
                await import("../state/openclaw-state-worker-store.js");
              return await withOpenClawStateLeaseWorkerAdmission(
                lease,
                context.admission.databasePath,
                async (admission) => {
                  const assertCheckoutCurrent = () => {
                    context.admission.assertCurrent();
                    admission.assertCurrent();
                  };
                  const assertCurrent = () => {
                    assertCheckoutCurrent();
                    operationSignal.throwIfAborted();
                  };
                  return await runOpenClawStateWorkerOperation(
                    context,
                    async (scope) => {
                      const current = await scope.execute({
                        type: "projects.resolve",
                        input: { id },
                      });
                      assertCurrent();
                      return await run({
                        project: current,
                        assertCurrent,
                        assertCheckoutCurrent,
                        signal: operationSignal,
                      });
                    },
                    { assertCurrent, createAdmission: admission.createAdmission },
                  );
                },
              );
            } finally {
              // Resume cancellation while the native owner drains retained settlement and
              // selects unknown/lost/abort errors after this callback's cleanup has settled.
              signal?.addEventListener("abort", abortAcquisition, { once: true });
              if (signal?.aborted) {
                abortAcquisition();
              }
            }
          },
        );
      } finally {
        signal?.removeEventListener("abort", abortAcquisition);
      }
    },
  };
}

export function removeProjectCheckoutReference(
  project: ProjectRegistryRecord,
  lease: OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions = {},
): "missing" | "changed" | "remaining" | "final" {
  ensureProjectRegistrySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      lease.assertOwnedInTransaction(sqlite);
      return removeProjectCheckoutReferenceInDatabase(sqlite, project);
    },
    options,
    { operationLabel: "projects.registry.checkout-reference.remove" },
  );
}

export async function resolveProjectCloneRefreshOwner(
  project: ProjectRegistryIdentity,
  lease: OpenClawStateLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<ProjectRegistryRecord | undefined> {
  const { runWithOpenClawStateLeaseWorker } =
    await import("../state/openclaw-state-lease-worker-storage.js");
  return await runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
    scope.execute({
      type: "projects.resolveRefreshOwner",
      input: { project, lease: identity },
    }),
  );
}

export async function resolveRecordedProjectRoot(
  projectPath: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<string | undefined> {
  const context = captureOpenClawStateWorkerContext(options);
  const repoRoot = await fs.realpath(projectPath).catch(() => undefined);
  if (!repoRoot) {
    return undefined;
  }
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "projects.findRoot",
    input: { repoRoot },
  });
}

export async function removeProjectRegistry(
  project: ProjectRegistryRecord,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<boolean> {
  const selectedProject: ProjectRegistryIdentity = {
    id: project.id,
    repoRoot: project.repoRoot,
    source: project.source,
    originUrl: project.originUrl,
  };
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  return await withProjectCheckoutLifecycle(
    selectedProject.repoRoot,
    { path: context.admission.databasePath, env },
    async (lease) => {
      const { runWithOpenClawStateLeaseWorker } =
        await import("../state/openclaw-state-lease-worker-storage.js");
      return await runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
        scope.execute({
          type: "projects.remove",
          input: { project: selectedProject, lease: identity },
        }),
      );
    },
  );
}
