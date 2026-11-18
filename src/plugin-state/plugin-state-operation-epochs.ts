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

function namespaceEpoch(coordinationKey: string, scope: Namespace): Epoch {
  let namespaces = sources.get(coordinationKey);
  if (!namespaces) {
    namespaces = new Map();
    sources.set(coordinationKey, namespaces);
  }
  const key = JSON.stringify([scope.pluginId, scope.namespace]);
  let epoch = namespaces.get(key);
  if (!epoch) {
    epoch = { revision: 0, pending: new Set() };
    namespaces.set(key, epoch);
  }
  return epoch;
}

/** Invalidation precedes queueing, so a pending revocation already closes older receipts. */
export function beginPluginStateMutation(
  coordinationKey: string,
  scopes: readonly Namespace[],
): { token: object; ready: Promise<void> | undefined; finish(): void } {
  let finish!: () => void;
  const token: Mutation = {
    settled: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  const ready = capturePluginStateMutationSettlement(coordinationKey, scopes);
  const epochs = new Set(scopes.map((scope) => namespaceEpoch(coordinationKey, scope)));
  for (const epoch of epochs) {
    epoch.revision += 1;
    epoch.pending.add(token);
  }
  return {
    token,
    ready,
    finish() {
      for (const epoch of epochs) {
        epoch.pending.delete(token);
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
  const prior = new Set(
    scopes
      .flatMap((scope) => [...namespaceEpoch(coordinationKey, scope).pending])
      .filter((token) => token !== ownMutation),
  );
  return prior.size
    ? Promise.all([...prior].map((token) => token.settled)).then(() => {})
    : undefined;
}

export function invalidatePluginStateMutation(
  scope: Namespace & { env?: NodeJS.ProcessEnv },
): void {
  const source = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(scope.env ?? process.env),
  );
  beginPluginStateMutation(source.coordinationKey, [scope]).finish();
}

export function capturePluginStateEpochs(
  coordinationKey: string,
  scopes: readonly Namespace[],
  ownMutation?: object,
): () => void {
  const observations = scopes.map((scope) => {
    const epoch = namespaceEpoch(coordinationKey, scope);
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
