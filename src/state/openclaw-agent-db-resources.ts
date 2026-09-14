import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isPathInside } from "../infra/path-guards.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

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

/** Candidate paths are lexical; numberedPath also covers its .2, .3, ... siblings. */
export type OpenClawAgentDatabaseResourceSelection = {
  agentId?: string;
  paths: readonly string[];
  numberedPath?: string;
};
type RegisteredResource = {
  target: OpenClawAgentDatabaseResourceSelection;
  revoked: boolean;
  revoke: () => void;
  close: () => Promise<void>;
};

function containsPath(target: OpenClawAgentDatabaseResourceSelection, pathname: string): boolean {
  if (target.paths.includes(pathname)) {
    return true;
  }
  if (!target.numberedPath || path.dirname(pathname) !== path.dirname(target.numberedPath)) {
    return false;
  }
  const extension = path.extname(target.numberedPath);
  const prefix = `${path.basename(target.numberedPath, extension)}.`;
  const name = path.basename(pathname);
  if (!name.startsWith(prefix) || !name.endsWith(extension)) {
    return false;
  }
  const number = name.slice(prefix.length, name.length - extension.length);
  return /^[1-9]\d*$/.test(number) && Number.isSafeInteger(Number(number)) && Number(number) >= 2;
}

function matchesSelection(
  selection: AgentDatabaseCloseSelection,
  target: OpenClawAgentDatabaseResourceSelection,
): boolean {
  return (
    (selection.agentId === undefined ||
      target.agentId === undefined ||
      selection.agentId === target.agentId) &&
    (selection.path === undefined || containsPath(target, selection.path)) &&
    (selection.rootPath === undefined ||
      target.paths.some((pathname) => isPathInside(selection.rootPath!, pathname)))
  );
}

function selectionsOverlap(
  left: OpenClawAgentDatabaseResourceSelection,
  right: OpenClawAgentDatabaseResourceSelection,
): boolean {
  return (
    (left.agentId === undefined || right.agentId === undefined || left.agentId === right.agentId) &&
    (left.paths.some((pathname) => containsPath(right, pathname)) ||
      right.paths.some((pathname) => containsPath(left, pathname)))
  );
}

const resources = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseAsyncResources"),
  () => ({
    active: new Set<RegisteredResource>(),
    closing: new Map<RegisteredResource, Promise<void> | undefined>(),
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

function registerResource(
  target: OpenClawAgentDatabaseResourceSelection,
  resource: Pick<OpenClawAgentDatabaseAsyncResource, "revoke" | "close">,
) {
  const normalize = (selection: OpenClawAgentDatabaseResourceSelection) => ({
    ...selection,
    ...(selection.agentId !== undefined ? { agentId: normalizeAgentId(selection.agentId) } : {}),
    paths: selection.paths.map((pathname) => path.resolve(pathname)),
    ...(selection.numberedPath ? { numberedPath: path.resolve(selection.numberedPath) } : {}),
  });
  const owned: RegisteredResource = { target: normalize(target), revoked: false, ...resource };
  const assertAvailable = (candidate: OpenClawAgentDatabaseResourceSelection) => {
    if (
      owned.revoked ||
      [...resources.selections].some((selection) => matchesSelection(selection, candidate)) ||
      [...resources.closing.keys()].some((closing) => selectionsOverlap(closing.target, candidate))
    ) {
      throw new Error(`Agent database resources are closing: ${candidate.paths[0]}`);
    }
  };
  assertAvailable(owned.target);
  resources.active.add(owned);
  return {
    unregister: () => {
      resources.active.delete(owned);
    },
    bind: (resolved: { agentId: string; path: string }) => {
      const exact = normalize({ agentId: resolved.agentId, paths: [resolved.path] });
      if (!matchesSelection({ agentId: exact.agentId, path: exact.paths[0] }, owned.target)) {
        throw new Error("Resolved agent database is outside the captured resource selection");
      }
      assertAvailable(exact);
      owned.target = exact;
    },
  };
}

/** Register before admitting a Worker; revocation is synchronous, native drainage is joined. */
export function registerOpenClawAgentDatabaseAsyncResource(
  resource: OpenClawAgentDatabaseAsyncResource,
): () => void {
  return registerResource({ agentId: resource.agentId, paths: [resource.path] }, resource)
    .unregister;
}

/** Narrow the same retained registration after asynchronous physical target discovery. */
export function registerUnresolvedOpenClawAgentDatabaseAsyncResource(
  target: OpenClawAgentDatabaseResourceSelection,
  resource: Pick<OpenClawAgentDatabaseAsyncResource, "revoke" | "close">,
) {
  return registerResource(target, resource);
}

export function revokeAgentDatabaseResources(
  selection: AgentDatabaseCloseSelection,
  onCloseError?: (pathname: string, error: unknown) => void,
): Promise<void>[] {
  const closing = new Set([...resources.active, ...resources.closing.keys()]);
  const pending: Promise<void>[] = [];
  for (const resource of closing) {
    if (!matchesSelection(selection, resource.target)) {
      continue;
    }
    resource.revoked = true;
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
            onCloseError?.(resource.target.paths[0]!, error);
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
