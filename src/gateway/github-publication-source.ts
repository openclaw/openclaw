import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  captureSessionActorStorageOwner,
  type CapturedSessionActorStorageOwner,
} from "../config/sessions/session-actor-storage-binding.js";
import {
  createSqliteSourceFenceAdmission,
  type SqliteSourceFenceOwner,
} from "../infra/sqlite-source-fence-admission.js";
import type { SqliteSourceFenceIdentity } from "../infra/sqlite-source-fence-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type { GitHubPublicationSourcePredicate } from "../state/github-publication-source-contract.js";
import type {
  GitHubPublicationSourceSelector,
  GitHubPublicationSessionFacts,
} from "../state/github-publication-source.types.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { observeUserGitHubConnectionAuthority } from "../state/user-github-connection-events.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";

type SourceBinding = {
  context: OpenClawStateWorkerContext;
  predicate: GitHubPublicationSourcePredicate;
  signal: AbortSignal;
  admitted: boolean;
} & (
  | { kind: "durable"; source: SqliteSourceFenceOwner; destination: SqliteSourceFenceOwner }
  | { kind: "memory"; assertCurrent(): void; retain: SqliteSourceFenceOwner["retain"] }
);
const { bindings, destinationIncarnations } = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPublicationSourceCapabilities"),
  () => ({
    bindings: new WeakMap<GitHubPublicationSourceCapability, SourceBinding>(),
    destinationIncarnations: new WeakMap<object, string>(),
  }),
);

/** A host-minted capability; serialized predicates alone never authorize publication. */
export type GitHubPublicationSourceCapability = Readonly<{
  version: 1;
  release(): Promise<void>;
}>;

/** Compose the publication runtime's lifetime before native admission captures its signals. */
export function bindGitHubPublicationSourceLifetime(
  capability: GitHubPublicationSourceCapability,
  lifetime: AbortSignal,
): GitHubPublicationSourceCapability {
  const binding = bindings.get(capability);
  if (!binding || binding.admitted) {
    throw new Error("GitHub publication source lifetime was already admitted.");
  }
  const signal = AbortSignal.any([binding.signal, lifetime]);
  signal.throwIfAborted();
  binding.signal = signal;
  if (binding.kind === "durable") {
    binding.source = { ...binding.source, signal };
    binding.destination = { ...binding.destination, signal };
  }
  return capability;
}

export function bindGitHubPublicationSource(
  capability: GitHubPublicationSourceCapability,
  assertAdmissionCurrent?: () => void,
) {
  const binding = bindings.get(capability);
  if (!binding) {
    throw new Error("GitHub publication source capability is unavailable.");
  }
  binding.signal.throwIfAborted();
  return {
    context: binding.context,
    predicate: binding.predicate,
    createAdmission: ((operation) => {
      binding.admitted = true;
      if (binding.kind === "memory") {
        binding.retain(operation);
        return {
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "prepare") {
              throw new Error("Memory publication authority requires a preparation grant.");
            }
            binding.signal.throwIfAborted();
            binding.assertCurrent();
            assertAdmissionCurrent?.();
            grant();
          }),
          nativeLocations: [binding.context.admission.databasePath],
        };
      }
      return createSqliteSourceFenceAdmission({
        destination: {
          ...binding.destination,
          assertCurrent() {
            binding.destination.assertCurrent();
            assertAdmissionCurrent?.();
          },
        },
        sources: [binding.source],
        signal: binding.signal,
        deadlineNs: process.hrtime.bigint() + 120_000_000_000n,
      })(operation);
    }) satisfies SqliteWorkerAdmissionFactory,
  };
}

function readMemorySourceFacts(
  captured: CapturedSessionActorStorageOwner,
  sessionKey: string,
): GitHubPublicationSessionFacts {
  const snapshot = captured.owner
    ? captured.owner.readSession(sessionKey, captured.authority)
    : captured.binding?.actor.storage?.readCurrent(
        { type: "session.members.read", input: {} },
        captured.authority,
      );
  const entry = snapshot?.entry;
  return {
    entry: entry && {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      archivedAt: entry.archivedAt,
      visibility: entry.visibility,
      incognito: entry.incognito,
      createdActor: entry.createdActor,
      owner: entry.owner,
      worktree: entry.worktree,
      repositoryWorkspaceId: entry.repositoryWorkspaceId,
    },
    members: snapshot?.members ?? [],
  };
}

async function prepareMemoryPublicationSource(
  params: Parameters<typeof prepareGitHubPublicationSource>[0],
  context: OpenClawStateWorkerContext,
  captured: CapturedSessionActorStorageOwner,
): Promise<GitHubPublicationSourceCapability> {
  const memory = readMemorySourceFacts(captured, params.selector.sessionKey);
  const source = { memory, selector: structuredClone(params.selector) };
  const expected = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "githubPublication.sourceFacts", input: { source } }),
    { signal: params.signal, assertCurrent: () => params.assertCurrent() },
  );
  const pending = new Set<Promise<unknown>>();
  let released = false;
  const capability: GitHubPublicationSourceCapability = Object.freeze({
    version: 1,
    async release() {
      released = true;
      await Promise.allSettled(pending);
    },
  });
  bindings.set(capability, {
    kind: "memory",
    context,
    predicate: { ...source, expected },
    signal: params.signal,
    admitted: false,
    assertCurrent() {
      context.admission.assertCurrent();
      params.assertCurrent();
      if (
        released ||
        !isDeepStrictEqual(readMemorySourceFacts(captured, params.selector.sessionKey), memory)
      ) {
        throw new Error("GitHub publication source authority changed.");
      }
    },
    retain(operation) {
      pending.add(operation.settled);
      void operation.settled.then(
        () => pending.delete(operation.settled),
        () => pending.delete(operation.settled),
      );
    },
  });
  return capability;
}

/** Host policy executes before reservation; the worker rechecks every durable source fact. */
export async function prepareGitHubPublicationSource(params: {
  sourcePath: string;
  selector: GitHubPublicationSourceSelector;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<GitHubPublicationSourceCapability> {
  params.signal.throwIfAborted();
  params.assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  const memory = captureSessionActorStorageOwner(
    { ...params.selector, storePath: params.sourcePath },
    { assertCurrent() {}, authorize() {} },
  );
  if (memory) {
    return prepareMemoryPublicationSource(params, context, memory);
  }
  const physical = readDatabasePathIdentitySync(params.sourcePath);
  if (!physical.key.startsWith("file:") || physical.birthtime === undefined) {
    throw new Error("GitHub publication requires an admitted durable source.");
  }
  const closed = new AbortController();
  const signal = AbortSignal.any([params.signal, closed.signal]);
  const pending = new Set<Promise<unknown>>();
  const releases: Array<() => void> = [];
  let releasing: Promise<void> | undefined;
  let binding: SourceBinding | undefined;
  const revoke = () => closed.abort(new Error("GitHub publication source authority changed."));
  const drain = async () => {
    revoke();
    await Promise.allSettled(pending);
  };
  const release = () =>
    (releasing ??= (async () => {
      await drain();
      for (const stop of releases.splice(0).toReversed()) {
        stop();
      }
    })());
  const assertCurrent = () => {
    signal.throwIfAborted();
    context.admission.assertCurrent();
    assertExistingDatabaseIdentity(params.sourcePath, physical.key, physical.birthtime);
  };
  const retain: SqliteSourceFenceOwner["retain"] = (operation) => {
    assertCurrent();
    pending.add(operation.settled);
    void operation.settled.then(
      () => pending.delete(operation.settled),
      () => pending.delete(operation.settled),
    );
  };
  const sourceIdentity: SqliteSourceFenceIdentity = { physical, incarnation: randomUUID() };
  releases.push(
    registerOpenClawAgentDatabaseAsyncResource({
      agentId: params.selector.agentId,
      path: params.sourcePath,
      revoke,
      close: drain,
    }),
    registerOpenClawStateDatabaseAsyncResource({ close: drain }),
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind !== "opened" && event.path === context.admission.databasePath) {
        revoke();
      }
    }),
    onUserProfilesChanged(revoke),
    observeUserGitHubConnectionAuthority(({ databasePath, changedOwners }) => {
      if (
        databasePath === context.admission.databasePath &&
        params.selector.personalOwnerProfileId !== undefined &&
        changedOwners.includes(params.selector.personalOwnerProfileId)
      ) {
        revoke();
      }
    }),
    githubPublicationReceipts.subscribeFacts((change, deletionPending) => {
      if (
        // Once admitted, native source reservations protect the write through destination commit.
        (change.kind === "pending" &&
          deletionPending &&
          change.identity === context.admission.identity.key &&
          !binding?.admitted) ||
        (change.kind === "unknown" && change.identity === context.admission.identity.key) ||
        (change.kind === "committed" &&
          change.receipt.source.identity === context.admission.identity.key &&
          [...change.receipt.facts.values()].some((fact) => fact.kind !== "postimage"))
      ) {
        revoke();
      }
    }),
    sessionChanges.subscribeFacts((change) => {
      if ("all" in change || change.sessionKey === params.selector.sessionKey) {
        revoke();
      }
    }),
  );
  try {
    let incarnation = destinationIncarnations.get(context.admission);
    if (!incarnation) {
      incarnation = randomUUID();
      destinationIncarnations.set(context.admission, incarnation);
    }
    const sourceRead = {
      source: sourceIdentity,
      destination: { physical: context.admission.identity, incarnation },
      selector: structuredClone(params.selector),
    };
    const expected = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({ type: "githubPublication.sourceFacts", input: { source: sourceRead } }),
      { signal, assertCurrent },
    );
    sourceRead.destination.physical = context.admission.identity;
    // Policy callbacks may write SQLite. Such a write revokes this captured basis.
    params.assertCurrent();
    assertCurrent();
    const capability: GitHubPublicationSourceCapability = Object.freeze({ version: 1, release });
    binding = {
      kind: "durable",
      context,
      predicate: { ...sourceRead, expected },
      source: {
        identity: sourceIdentity,
        signal,
        assertCurrent: () => {
          // S8 invokes this only before reservations, including its final prepare grant.
          params.assertCurrent();
          assertCurrent();
        },
        retain,
      },
      destination: { identity: sourceRead.destination, signal, assertCurrent, retain },
      signal,
      admitted: false,
    };
    bindings.set(capability, binding);
    return capability;
  } catch (error) {
    await release();
    throw error;
  }
}
