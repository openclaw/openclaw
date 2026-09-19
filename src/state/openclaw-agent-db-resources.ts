import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isPathInside } from "../infra/path-guards.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawAgentDatabaseAsyncResource = {
  agentId: string;
  path: string;
  revoke: () => void;
  close: () => Promise<void>;
};
export type AgentDatabaseCloseSelection = {
  path?: string;
  rootPath?: string;
  agentId?: string;
};

const resources = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseAsyncResources"),
  () => ({
    active: new Set<OpenClawAgentDatabaseAsyncResource>(),
    closing: new Map<OpenClawAgentDatabaseAsyncResource, Promise<void> | undefined>(),
    selections: new Set<AgentDatabaseCloseSelection>(),
  }),
);

/** CLI cleanup can skip loading native database owners when no Worker was admitted. */
export function hasOpenClawAgentDatabaseAsyncResources(): boolean {
  return resources.active.size > 0 || resources.closing.size > 0;
}

export function matchesAgentDatabaseClose(
  selection: AgentDatabaseCloseSelection,
  resource: { agentId: string; path: string },
): boolean {
  return (
    (selection.path === undefined || selection.path === resource.path) &&
    (selection.rootPath === undefined || isPathInside(selection.rootPath, resource.path)) &&
    (selection.agentId === undefined || selection.agentId === resource.agentId)
  );
}

/** Register before admitting a Worker; revocation is synchronous, native drainage is joined. */
export function registerOpenClawAgentDatabaseAsyncResource(
  resource: OpenClawAgentDatabaseAsyncResource,
): () => void {
  const owned = {
    ...resource,
    agentId: normalizeAgentId(resource.agentId),
    path: path.resolve(resource.path),
  };
  if (
    [...resources.selections].some((selection) => matchesAgentDatabaseClose(selection, owned)) ||
    [...resources.closing.keys()].some(
      (closing) => closing.path === owned.path && closing.agentId === owned.agentId,
    )
  ) {
    throw new Error(`Agent database resources are closing: ${owned.path}`);
  }
  resources.active.add(owned);
  getOpenClawDatabaseMaintenanceScope()?.own(owned, "agent-resources", async () => {
    owned.revoke();
    await owned.close();
    resources.active.delete(owned);
    resources.closing.delete(owned);
  });
  return () => resources.active.delete(owned);
}

export function revokeAgentDatabaseResources(
  selection: AgentDatabaseCloseSelection,
  onCloseError?: (pathname: string, error: unknown) => void,
): Promise<void>[] {
  const closing = new Set([...resources.active, ...resources.closing.keys()]);
  const pending: Promise<void>[] = [];
  for (const resource of closing) {
    if (!matchesAgentDatabaseClose(selection, resource)) {
      continue;
    }
    resource.revoke();
    let operation = resources.closing.get(resource);
    if (!operation) {
      operation = Promise.resolve().then(() => resource.close());
      resources.closing.set(resource, operation);
      void operation
        .then(
          () => {
            resources.active.delete(resource);
            resources.closing.delete(resource);
          },
          (error: unknown) => {
            // Keep exact custody even if the actor unregisters while its close fails.
            resources.closing.set(resource, undefined);
            onCloseError?.(resource.path, error);
          },
        )
        .catch(() => {});
    }
    pending.push(operation);
  }
  return pending;
}

export async function drainAgentDatabaseResources<T>(
  selection: AgentDatabaseCloseSelection,
  closeNative: () => Promise<T>,
): Promise<T> {
  resources.selections.add(selection);
  try {
    const results = await Promise.allSettled(revokeAgentDatabaseResources(selection));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent database resource drainage failed");
    }
    return await closeNative();
  } finally {
    resources.selections.delete(selection);
  }
}
