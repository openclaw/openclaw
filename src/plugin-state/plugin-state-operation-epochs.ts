import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { PluginStateOperationInvalidatedError } from "./plugin-state-operation-error.js";

type Namespace = { pluginId: string; namespace: string };
type Mutation = { settled: Promise<void> };
type Epoch = { revision: number; pending: Set<Mutation> };
const sources = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginStateOperationEpochs"),
  () => new Map<string, Map<string, Epoch>>(),
);

function namespaceKey(scope: Namespace): string {
  return JSON.stringify([scope.pluginId, scope.namespace]);
}

function namespaceEpoch(coordinationKey: string, key: string): Epoch {
  let namespaces = sources.get(coordinationKey);
  if (!namespaces) {
    namespaces = new Map();
    sources.set(coordinationKey, namespaces);
  }
  let epoch = namespaces.get(key);
  if (!epoch) {
    epoch = { revision: 0, pending: new Set() };
    namespaces.set(key, epoch);
  }
  return epoch;
}

function forgetSettledNamespace(coordinationKey: string, key: string, epoch: Epoch): void {
  const namespaces = sources.get(coordinationKey);
  if (epoch.pending.size || namespaces?.get(key) !== epoch) {
    return;
  }
  namespaces.delete(key);
  if (!namespaces.size) {
    sources.delete(coordinationKey);
  }
}

function earlierMutations(epochs: Iterable<Epoch | undefined>, ownMutation?: object) {
  const waits = new Set<Promise<void>>();
  for (const epoch of epochs) {
    for (const token of epoch?.pending ?? []) {
      if (token !== ownMutation) {
        waits.add(token.settled);
      }
    }
  }
  return waits.size ? Promise.all(waits).then(() => {}) : undefined;
}

/** Invalidation precedes queueing, so a pending revocation already closes older receipts. */
export function beginPluginStateMutation(
  coordinationKey: string,
  scopes: readonly Namespace[],
  mode: "receipt" | "command" = "receipt",
): { token: object; ready: Promise<void> | undefined; finish(): void } {
  let finish!: () => void;
  const token: Mutation = {
    settled: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  const epochs = new Map(
    scopes.map((scope) => {
      const key = namespaceKey(scope);
      return [key, namespaceEpoch(coordinationKey, key)] as const;
    }),
  );
  const ready = earlierMutations(epochs.values());
  for (const epoch of epochs.values()) {
    epoch.revision += 1;
    epoch.pending.add(token);
  }
  return {
    token,
    ready,
    finish() {
      for (const [key, epoch] of epochs) {
        // A command issues no receipt. Older guards saw the prior revision, and any
        // guard captured during this command saw a foreign pending mutation.
        if (epoch.pending.delete(token) && mode === "command") {
          forgetSettledNamespace(coordinationKey, key, epoch);
        }
      }
      finish();
    },
  };
}

/** Capture only earlier work; later mutations must never form a wait cycle. */
export function capturePluginStateMutationSettlement(
  coordinationKey: string,
  scopes: readonly Namespace[],
  ownMutation?: object,
): Promise<void> | undefined {
  const namespaces = sources.get(coordinationKey);
  return (
    namespaces &&
    earlierMutations(
      scopes.map((scope) => namespaces.get(namespaceKey(scope))),
      ownMutation,
    )
  );
}

export function invalidatePluginStateMutation(
  scope: Namespace & { env?: NodeJS.ProcessEnv },
): void {
  const source = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(scope.env ?? process.env),
  );
  const key = namespaceKey(scope);
  const epoch = sources.get(source.coordinationKey)?.get(key);
  if (epoch) {
    epoch.revision += 1;
    forgetSettledNamespace(source.coordinationKey, key, epoch);
  }
}

export function capturePluginStateEpochs(
  coordinationKey: string,
  scopes: readonly Namespace[],
  ownMutation?: object,
): () => void {
  const observations = scopes.map((scope) => {
    const epoch = namespaceEpoch(coordinationKey, namespaceKey(scope));
    return {
      epoch,
      revision: epoch.revision,
      pending: [...epoch.pending].some((token) => token !== ownMutation),
    };
  });
  return () => {
    for (const { epoch, revision, pending } of observations) {
      if (
        epoch.revision !== revision ||
        pending ||
        [...epoch.pending].some((token) => token !== ownMutation)
      ) {
        throw new PluginStateOperationInvalidatedError();
      }
    }
  };
}
