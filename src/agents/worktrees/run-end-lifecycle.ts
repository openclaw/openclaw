import { AsyncLocalStorage } from "node:async_hooks";
import { isNativeError } from "node:util/types";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

type RunEndOperation = {
  context: OpenClawStateWorkerContext;
  active: boolean;
  uncertain?: Error;
};
const current = new AsyncLocalStorage<RunEndOperation>();
const lifetimes = new Map<string, ReturnType<typeof createLifetime>>();

export type WorktreeRegistryField =
  | "identity"
  | "fingerprint"
  | "activity"
  | "removal"
  | "snapshot"
  | "provisioned"
  | "cleanup"
  | "leases";
export type WorktreeRegistryChange = {
  id: string;
  fields: readonly WorktreeRegistryField[];
};
export function worktreeOwnerSelectionKey(ownerKind: string, ownerId: string): string {
  return JSON.stringify(["worktree-owner", ownerKind, ownerId]);
}
export const WORKTREE_UNKNOWN_OWNER_SELECTION = "worktree-owner:*";
type RegistryRevision = { version: number; pending: Set<object>; lastMutation?: object };
type MutationAuthority = { validating: boolean };
const mutationAuthority = new AsyncLocalStorage<MutationAuthority>();

function createLifetime({ admission }: OpenClawStateWorkerContext) {
  let work = new AsyncWorkScope();
  const scopes = new Set([work]);
  let gateways = 0;
  let closing = false;
  let retired = false;
  let uncertain = false;
  const cleanupFailures = new Map<object, unknown>();
  const revisions = new Map<string, Map<WorktreeRegistryField, RegistryRevision>>();
  const selectRevisions = (changes: readonly WorktreeRegistryChange[]) => {
    const selected = new Set<RegistryRevision>();
    for (const { id, fields } of changes) {
      let row = revisions.get(id);
      if (!row) {
        row = new Map();
        revisions.set(id, row);
      }
      for (const field of fields) {
        let revision = row.get(field);
        if (!revision) {
          revision = { version: 0, pending: new Set() };
          row.set(field, revision);
        }
        selected.add(revision);
      }
    }
    return [...selected];
  };
  const drain = (scope: AsyncWorkScope) =>
    AsyncWorkScope.runWhenAllIdle(
      () => [scope],
      async () => {
        await scope.drain();
        if (cleanupFailures.size > 0) {
          throw new AggregateError(
            [...cleanupFailures.values()],
            "Managed worktree cleanup remains unsettled",
          );
        }
        scopes.delete(scope);
      },
    );
  const owner = {
    assertRegistryAdmission(settlement = false) {
      const operation = current.getStore();
      if (
        closing &&
        !settlement &&
        (!operation?.active ||
          operation.context.admission.coordinationKey !== admission.coordinationKey)
      ) {
        throw new Error("Managed worktree run-end admission is closed");
      }
      if (uncertain) {
        throw new SqliteWorkerError(
          "Managed worktree registry settlement is unknown",
          "outcome-unknown",
        );
      }
    },
    captureRegistry(changes: readonly WorktreeRegistryChange[]) {
      owner.assertRegistryAdmission();
      const selected = selectRevisions(changes).map((revision) => ({
        revision,
        version: revision.version,
      }));
      return () => {
        owner.assertRegistryAdmission();
        if (retired) {
          throw new Error("Managed worktree registry owner is closed");
        }
        const activeMutation = mutationAuthority.getStore();
        const ownMutation = activeMutation?.validating ? activeMutation : undefined;
        for (const { revision, version } of selected) {
          const ownChange =
            ownMutation !== undefined &&
            revision.lastMutation === ownMutation &&
            revision.version === version + 1;
          if (
            (revision.version !== version && !ownChange) ||
            [...revision.pending].some((pending) => pending !== ownMutation)
          ) {
            throw new Error(
              "Managed worktree registry authority changed; prepare the operation again",
            );
          }
        }
      };
    },
    setCleanupFailure(key: object, failure?: { error: unknown }) {
      if (failure) {
        cleanupFailures.set(key, failure.error);
      } else {
        cleanupFailures.delete(key);
      }
    },
    registryMutation(changes: readonly WorktreeRegistryChange[], settlement = false) {
      owner.assertRegistryAdmission(settlement);
      const selected = selectRevisions([
        ...changes,
        { id: "*", fields: changes.flatMap((change) => change.fields) },
      ]);
      const token: MutationAuthority = { validating: false };
      let started = false;
      let finished = false;
      return {
        observeTransaction() {
          if (started) {
            return;
          }
          if (retired || finished) {
            throw new Error("Managed worktree registry mutation is closed");
          }
          started = true;
          for (const revision of selected) {
            revision.version += 1;
            revision.lastMutation = token;
            revision.pending.add(token);
          }
        },
        assertAuthority(assertCurrent: () => void) {
          if (finished) {
            throw new Error("Managed worktree registry mutation has settled");
          }
          const validating = token.validating;
          token.validating = true;
          try {
            mutationAuthority.run(token, assertCurrent);
          } finally {
            token.validating = validating;
          }
        },
        settle(unknown: boolean) {
          finished = true;
          uncertain ||= unknown;
          if (!unknown) {
            for (const revision of selected) {
              revision.pending.delete(token);
            }
          }
        },
      };
    },
    retainGateway() {
      if (closing) {
        work = new AsyncWorkScope();
        scopes.add(work);
        closing = false;
      }
      gateways += 1;
      let released = false;
      let pending: Promise<void> | undefined;
      const beginClose = () => {
        if (!released) {
          released = true;
          if (--gateways === 0) {
            closing = true;
            pending = drain(work);
            void pending.catch(() => {});
          }
        }
      };
      return {
        beginClose,
        drain: () => {
          beginClose();
          return pending ?? Promise.resolve();
        },
      };
    },
    run<T>(run: () => Promise<T>, acceptedParent = false): Promise<T> {
      if (closing && !acceptedParent) {
        return Promise.reject(new Error("Managed worktree run-end admission is closed"));
      }
      // Accepted persistence owns this scope, independently of scheduler cancellation.
      return work.track(run);
    },
  };
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (
        !identity ||
        identity.key === admission.identity.key ||
        identity.canonicalPath === admission.identity.canonicalPath
      ) {
        closing = true;
        await Promise.all([...scopes].map(drain));
        retired = true;
        lifetimes.delete(admission.coordinationKey);
        unregister();
      }
    },
  });
  return owner;
}

/** These generations describe owner mutations, never cached database rows. */
export function captureWorktreeRegistryAuthority(
  context: OpenClawStateWorkerContext,
  changes: readonly WorktreeRegistryChange[],
): () => void {
  return lifetime(context).captureRegistry(changes);
}

export function captureWorktreeRegistryMutation(
  context: OpenClawStateWorkerContext,
  changes: readonly WorktreeRegistryChange[],
  options: { settlement?: boolean } = {},
) {
  return lifetime(context).registryMutation(changes, options.settlement);
}

/** Failed exact-token cleanup retains the existing owner until its retry is acknowledged. */
export function setWorktreeRunEndCleanupFailure(
  context: OpenClawStateWorkerContext,
  key: object,
  failure?: { error: unknown },
): void {
  lifetimes.get(context.admission.coordinationKey)?.setCleanupFailure(key, failure);
}

function lifetime(context: OpenClawStateWorkerContext) {
  let owner = lifetimes.get(context.admission.coordinationKey);
  if (!owner) {
    owner = createLifetime(context);
    lifetimes.set(context.admission.coordinationKey, owner);
  }
  return owner;
}

export function captureWorktreeRunEndContext(env: NodeJS.ProcessEnv): OpenClawStateWorkerContext {
  const captured = captureOpenClawStateWorkerContext({ env });
  const operation = current.getStore();
  if (!operation) {
    return captured;
  }
  if (!operation.active) {
    throw new Error("Worktree settlement scope is closed");
  }
  if (operation.uncertain) {
    throw operation.uncertain;
  }
  if (operation.context.admission.coordinationKey !== captured.admission.coordinationKey) {
    throw new Error("Worktree settlement database changed");
  }
  operation.context.admission.assertCurrent();
  return {
    ...captured,
    admission: {
      ...captured.admission,
      get identity() {
        return captured.admission.identity;
      },
      assertCurrent() {
        operation.context.admission.assertCurrent();
        captured.admission.assertCurrent();
      },
    },
  };
}

export function withWorktreeRunEnd<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
  options: { independent?: boolean } = {},
): Promise<T> {
  const context = captureWorktreeRunEndContext(env);
  const acceptedParent = current.getStore() !== undefined;
  if (acceptedParent && !options.independent) {
    return trackAsyncWork(run);
  }
  const operation: RunEndOperation = { context, active: true };
  return lifetime(context).run(
    () =>
      current.run(operation, async () => {
        try {
          return await run();
        } finally {
          operation.active = false;
        }
      }),
    acceptedParent,
  );
}

export function retainWorktreeRunEndFailure(error: unknown): void {
  const operation = current.getStore();
  if (operation && hasSqliteWorkerOutcomeUnknown(error) && isNativeError(error)) {
    operation.uncertain ??= error;
  }
}

export function prepareWorktreeRunEndClose() {
  const owner = lifetime(captureOpenClawStateWorkerContext());
  return owner.retainGateway();
}
