import fs from "node:fs/promises";
import path from "node:path";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
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
  rowToProject,
  type ProjectRegistryIdentity,
  type ProjectRegistryRecord,
} from "./project-registry.kernel.js";

export type { ProjectRegistryRecord } from "./project-registry.kernel.js";
export {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
} from "./project-checkout.js";

type ProjectsDatabase = Pick<OpenClawStateKyselyDatabase, "projects">;

function openProjectsDatabase(options: OpenClawStateDatabaseOptions = {}) {
  ensureProjectRegistrySchema(options);
  const state = openOpenClawStateDatabase(options);
  return { sqlite: state.db, kysely: getNodeSqliteKysely<ProjectsDatabase>(state.db) };
}

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

export function resolveProjectRegistry(
  cfg: OpenClawConfig,
  id: string,
  options: OpenClawStateDatabaseOptions = {},
): ProjectRegistryRecord | undefined {
  if (id.startsWith("workspace:")) {
    const agentId = id.slice("workspace:".length);
    return listAgentIds(cfg).includes(agentId) ? workspaceProject(cfg, agentId) : undefined;
  }
  const { sqlite, kysely } = openProjectsDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    sqlite,
    kysely.selectFrom("projects").selectAll().where("id", "=", id),
  );
  return row ? rowToProject(row) : undefined;
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
      const db = getNodeSqliteKysely<ProjectsDatabase>(sqlite);
      const current = executeSqliteQueryTakeFirstSync(
        sqlite,
        db.selectFrom("projects").selectAll().where("id", "=", project.id),
      );
      if (!current) {
        return "missing";
      }
      if (current.source !== "cloned" || current.repo_root !== project.repoRoot) {
        return "changed";
      }
      executeSqliteQuerySync(sqlite, db.deleteFrom("projects").where("id", "=", project.id));
      const sibling = executeSqliteQueryTakeFirstSync(
        sqlite,
        db
          .selectFrom("projects")
          .selectAll()
          .where("repo_root", "=", project.repoRoot)
          .orderBy("id", "asc"),
      );
      if (!sibling) {
        return "final";
      }
      if (sibling.source === "registered") {
        executeSqliteQuerySync(
          sqlite,
          db
            .updateTable("projects")
            .set({
              source: "cloned",
              origin_url: sibling.origin_url ?? current.origin_url,
              updated_at_ms: Date.now(),
            })
            .where("id", "=", sibling.id),
        );
      }
      return "remaining";
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
    await import("../state/openclaw-state-worker-store.js");
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
        await import("../state/openclaw-state-worker-store.js");
      return await runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
        scope.execute({
          type: "projects.remove",
          input: { project: selectedProject, lease: identity },
        }),
      );
    },
  );
}
