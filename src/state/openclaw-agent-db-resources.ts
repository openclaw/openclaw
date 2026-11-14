import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerAgentDatabaseReaderCloser,
} from "../infra/agent-database-readers.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { reserveAgentCreationClaimAdmission } from "./agent-creation-claim.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";
import { captureAgentDeletionResourceOwner } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawAgentDatabaseAsyncResource = {
  agentId: string;
  path: string;
  revoke: () => void;
  close: () => Promise<void>;
  /** A native executor retains its database lease until dependent readers and publications settle. */
  retireAfterResources?: true;
};
export type OpenClawAgentDatabaseReadCandidateResource = Omit<
  OpenClawAgentDatabaseAsyncResource,
  "agentId"
> & { scope?: "sibling-family" };
type AgentDatabaseResource = (
  | (OpenClawAgentDatabaseAsyncResource & { ownership: "known"; closeSync?: () => void })
  | (OpenClawAgentDatabaseReadCandidateResource & {
      ownership: "unresolved";
      agentId?: never;
    })
) & { cleanupOwner?: object };
export type AgentDatabaseCloseSelection = {
  path?: string;
  rootPath?: string;
  agentId?: string;
};

const resources = resolveGlobalSingleton<{
  active: Set<AgentDatabaseResource>;
  closing: Map<AgentDatabaseResource, Promise<void> | undefined>;
  selections: Map<AgentDatabaseCloseSelection, Promise<unknown> | undefined>;
  onRelease?: (resource: AgentDatabaseResource) => void;
}>(Symbol.for("openclaw.agentDatabaseAsyncResources"), () => ({
  active: new Set<AgentDatabaseResource>(),
  closing: new Map<AgentDatabaseResource, Promise<void> | undefined>(),
  selections: new Map<AgentDatabaseCloseSelection, Promise<unknown> | undefined>(),
}));

/** Query existing close custody without admitting or revoking another resource. */
export function hasOpenClawAgentDatabaseAsyncResources(
  selection?: AgentDatabaseCloseSelection,
): boolean {
  return selection
    ? [...resources.active, ...resources.closing.keys()].some((resource) =>
        matchesAgentDatabaseClose(selection, resource),
      )
    : resources.active.size > 0 || resources.closing.size > 0;
}

/** The writable lifecycle owns idle handles; retirement only notifies that owner. */
export function registerAgentDatabaseResourceReleaseHandler(
  onRelease: (resource: AgentDatabaseResource) => void,
): void {
  resources.onRelease = onRelease;
}

/** Observe a full close without admitting a reader into its retiring lifetime. */
export function isAgentDatabaseClosing(
  target: Pick<OpenClawAgentDatabaseAsyncResource, "agentId" | "path">,
): boolean {
  const owned = { agentId: normalizeAgentId(target.agentId), path: path.resolve(target.path) };
  return [...resources.selections.keys()].some((selection) =>
    matchesAgentDatabaseClose(selection, owned),
  );
}

export { matchesAgentDatabaseReadCandidatePath };

registerAgentDatabaseReaderCloser(async (candidates, retainedPaths) => {
  const results = await Promise.allSettled(
    [...new Set([...resources.active, ...resources.closing.keys()])]
      .filter(
        (resource) =>
          !retainedPaths?.has(path.resolve(resource.path)) &&
          candidates.some((candidate) =>
            matchesAgentDatabaseReadCandidatePath(candidate, resource.path),
          ),
      )
      .map((resource) => closeAgentDatabaseResource(resource)),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Agent database resource cleanup failed");
  }
});

export function matchesAgentDatabaseClose(
  selection: AgentDatabaseCloseSelection,
  resource:
    | { agentId: string; path: string; ownership?: "known" }
    | (Pick<OpenClawAgentDatabaseReadCandidateResource, "path" | "scope"> & {
        agentId?: never;
        ownership: "unresolved";
      }),
): boolean {
  return (
    (selection.path === undefined ||
      selection.path === resource.path ||
      (resource.ownership === "unresolved" &&
        matchesAgentDatabaseReadCandidatePath(resource, selection.path))) &&
    (selection.rootPath === undefined ||
      isPathInside(selection.rootPath, resource.path) ||
      (resource.ownership === "unresolved" &&
        matchesAgentDatabaseReadCandidatePath(resource, selection.rootPath))) &&
    (selection.agentId === undefined ||
      resource.ownership === "unresolved" ||
      selection.agentId === resource.agentId)
  );
}

/** Register before admitting a Worker; revocation is synchronous, native drainage is joined. */
export function registerOpenClawAgentDatabaseAsyncResource(
  resource: OpenClawAgentDatabaseAsyncResource,
  creationOptions?: OpenClawAgentDatabaseOptions,
): () => void {
  return registerAgentDatabaseResource(
    { ...resource, ownership: "known", agentId: normalizeAgentId(resource.agentId) },
    creationOptions,
  );
}

/** Native readers close synchronously, so successful retirement leaves no asynchronous barrier. */
export function registerOpenClawAgentDatabaseSyncResource(
  resource: Omit<OpenClawAgentDatabaseAsyncResource, "close"> & { close: () => void },
): () => void {
  return registerAgentDatabaseResource({
    ...resource,
    ownership: "known",
    agentId: normalizeAgentId(resource.agentId),
    close: async () => resource.close(),
    closeSync: resource.close,
  });
}

/** Retain discovery until the known owner is registered, then release this candidate. */
export function registerOpenClawAgentDatabaseReadCandidateResource(
  resource: OpenClawAgentDatabaseReadCandidateResource,
): () => void {
  return registerAgentDatabaseResource({ ...resource, ownership: "unresolved" });
}

function registerAgentDatabaseResource(
  resource: AgentDatabaseResource,
  creationOptions?: OpenClawAgentDatabaseOptions,
): () => void {
  const owned: AgentDatabaseResource = {
    ...resource,
    path: path.resolve(resource.path),
  };
  owned.cleanupOwner = captureAgentDeletionResourceOwner((target) =>
    matchesAgentDatabaseClose(target, owned),
  );
  assertAgentDatabaseResourceAdmission(owned);
  const releaseCreation =
    creationOptions && owned.ownership === "known"
      ? reserveAgentCreationClaimAdmission(owned, creationOptions, () =>
          closeAgentDatabaseResource(owned),
        )
      : undefined;
  const unregister = () => {
    resources.active.delete(owned);
    releaseCreation?.();
    resources.onRelease?.(owned);
  };
  getOpenClawDatabaseMaintenanceScope()?.own(unregister, "agent-resources", () =>
    closeAgentDatabaseResource(owned),
  );
  resources.active.add(owned);
  return unregister;
}

/** Fresh native opens and resource registrations share the same close custody. */
export function assertAgentDatabaseResourceAdmission(
  owned: Parameters<typeof matchesAgentDatabaseClose>[1],
): void {
  if (
    [...resources.selections.keys()].some((selection) =>
      matchesAgentDatabaseClose(selection, owned),
    ) ||
    [...resources.closing.keys()].some(
      (closing) =>
        (closing.path === owned.path ||
          (closing.ownership === "unresolved" &&
            matchesAgentDatabaseReadCandidatePath(closing, owned.path)) ||
          (owned.ownership === "unresolved" &&
            matchesAgentDatabaseReadCandidatePath(owned, closing.path))) &&
        (closing.ownership === "unresolved" ||
          owned.ownership === "unresolved" ||
          closing.agentId === owned.agentId),
    )
  ) {
    throw new AgentDatabaseExecutionAdmissionClosedError(
      `Agent database resources are closing: ${owned.path}`,
    );
  }
}

function closeAgentDatabaseResource(
  resource: AgentDatabaseResource,
  onCloseError?: (pathname: string, error: unknown) => void,
): Promise<void> {
  if (resource.ownership === "known" && resource.closeSync) {
    resources.closing.set(resource, undefined);
    try {
      resource.revoke();
      resource.closeSync();
      resources.active.delete(resource);
      resources.closing.delete(resource);
      resources.onRelease?.(resource);
      return Promise.resolve();
    } catch (error) {
      if (onCloseError) {
        onCloseError(resource.path, error);
      }
      const failed = Promise.reject<void>(toErrorObject(error, "Agent database cleanup failed"));
      void failed.catch(() => {});
      return failed;
    }
  }
  let operation = resources.closing.get(resource);
  if (!operation) {
    operation = Promise.resolve().then(() => resource.close());
    resources.closing.set(resource, operation);
    void operation
      .then(
        () => {
          resources.active.delete(resource);
          resources.closing.delete(resource);
          resources.onRelease?.(resource);
        },
        () => {
          // Keep exact custody even if the actor unregisters while its close fails.
          resources.closing.set(resource, undefined);
        },
      )
      .catch(() => {});
  }
  if (onCloseError) {
    void operation.catch((error: unknown) => onCloseError(resource.path, error)).catch(() => {});
  }
  // Retain closing custody before revocation can synchronously attempt admission.
  resource.revoke();
  return operation;
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
    pending.push(closeAgentDatabaseResource(resource, onCloseError));
  }
  return pending;
}

export async function drainAgentDatabaseResources<T>(
  selection: AgentDatabaseCloseSelection,
  closeNative: () => Promise<T>,
  cleanupOwner?: object,
): Promise<T> {
  return withAgentDatabaseCloseFence(selection, async () => {
    const selected = [...new Set([...resources.active, ...resources.closing.keys()])].filter(
      (resource) =>
        matchesAgentDatabaseClose(selection, resource) &&
        (!cleanupOwner || resource.cleanupOwner === cleanupOwner),
    );
    const nativeOwners = selected.filter((resource) => resource.retireAfterResources);
    for (const resource of nativeOwners) {
      // Retain exact failed-close custody before revocation can cause another admission.
      if (!resources.closing.has(resource)) {
        resources.closing.set(resource, undefined);
      }
      resource.revoke();
    }
    const results = await Promise.allSettled(
      selected
        .filter((resource) => !resource.retireAfterResources)
        .map((resource) => closeAgentDatabaseResource(resource)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent database resource drainage failed");
    }
    const nativeResults = await Promise.allSettled(
      nativeOwners.map((resource) => closeAgentDatabaseResource(resource)),
    );
    const nativeErrors = nativeResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (nativeErrors.length > 0) {
      throw new AggregateError(nativeErrors, "Agent database native retirement failed");
    }
    return closeNative();
  });
}

/** Keep the complete selection fenced while its physical databases retire independently. */
export async function withAgentDatabaseCloseFence<T>(
  selection: AgentDatabaseCloseSelection,
  close: (resourcePaths: readonly string[]) => Promise<T>,
): Promise<T> {
  const ownedSelection = { ...selection };
  resources.selections.set(ownedSelection, undefined);
  try {
    const resourcePaths = [...new Set([...resources.active, ...resources.closing.keys()])]
      .filter((resource) => matchesAgentDatabaseClose(ownedSelection, resource))
      .map((resource) => resource.path);
    const operation = close(resourcePaths);
    // Teardown joins the real native close, without a separate completion mirror.
    resources.selections.set(ownedSelection, operation);
    return await operation;
  } finally {
    resources.selections.delete(ownedSelection);
  }
}
