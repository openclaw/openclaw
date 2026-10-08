import { AsyncLocalStorage } from "node:async_hooks";
import {
  captureSqliteWorkerStateContext,
  runWithSqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

const current = new AsyncLocalStorage<{
  context: OpenClawStateWorkerContext;
  scope: AsyncWorkScope;
  active: boolean;
}>();
const lifetimes = new Map<string, ReturnType<typeof createLifetime>>();

function createLifetime({ admission }: OpenClawStateWorkerContext) {
  let work = new AsyncWorkScope();
  const scopes = new Set([work]);
  let gateways = 0;
  let closing = false;
  const drain = (scope: AsyncWorkScope) =>
    AsyncWorkScope.runWhenAllIdle(
      () => [scope],
      async () => {
        await scope.drain();
        scopes.delete(scope);
      },
    );
  const owner = {
    matchesDatabase(context: OpenClawStateWorkerContext) {
      const identity = context.admission.identity;
      return (
        admission.identity.key === identity.key &&
        admission.identity.birthtime === identity.birthtime
      );
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
    assertOpen(inherited: boolean) {
      if (closing && !inherited) {
        throw new Error("Voice session persistence admission is closed");
      }
    },
    scope: () => work,
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
        if (gateways > 0) {
          // A store reopen retires admitted work, not the Gateways that still own cleanup.
          work = new AsyncWorkScope();
          scopes.add(work);
          closing = false;
        } else {
          for (const [key, candidate] of lifetimes) {
            if (candidate === owner) {
              lifetimes.delete(key);
            }
          }
          unregister();
        }
      }
    },
  });
  return owner;
}

function lifetime(context: OpenClawStateWorkerContext) {
  let owner = lifetimes.get(context.admission.coordinationKey);
  if (!owner) {
    // First creation preserves a path coordination key; reopening the same file gets a file key.
    owner = [...lifetimes.values()].find((candidate) => candidate.matchesDatabase(context));
    owner ??= createLifetime(context);
    lifetimes.set(context.admission.coordinationKey, owner);
  }
  return owner;
}

/** Retain the original owner for later admissions without retaining an accepted permit. */
export function captureClientVoiceSessionSettlementContext(
  env: NodeJS.ProcessEnv,
): OpenClawStateWorkerContext {
  const inherited = current.getStore()?.context;
  const selected =
    inherited && inherited.environment.OPENCLAW_STATE_DIR === env.OPENCLAW_STATE_DIR
      ? inherited
      : captureOpenClawStateWorkerContext({ env });
  return { ...captureSqliteWorkerStateContext(selected), admission: selected.admission };
}

/** Retain accepted work before a bounded queue or provider can yield. */
export function captureClientVoiceSessionSettlement(source?: OpenClawStateWorkerContext) {
  const inherited = current.getStore();
  const selected = source ?? inherited?.context ?? captureOpenClawStateWorkerContext();
  const inheritedSource =
    inherited && matchesSettlementContext(inherited.context, selected) ? inherited : undefined;
  if (inheritedSource && !inheritedSource.active) {
    throw new Error("Voice session persistence lost its accepted owner");
  }
  selected.admission.assertCurrent();
  const context = inheritedSource?.context ?? {
    ...captureSqliteWorkerStateContext(selected),
    admission: selected.admission,
  };
  const owner = lifetime(context);
  owner.assertOpen(Boolean(inheritedSource));
  const scope = inheritedSource?.scope ?? owner.scope();
  const settled = createDeferredCore();
  void scope.track(() => settled.promise);
  const operation = { context, scope, active: true };
  return {
    run<T>(run: () => T): T {
      if (!operation.active) {
        throw new Error("Voice session persistence lost its accepted owner");
      }
      context.admission.assertCurrent();
      return scope.run(() =>
        current.run(operation, () => runWithSqliteWorkerStateContext(context, run)),
      );
    },
    // Refused entry does not settle accepted work; its lifetime owner releases it.
    release() {
      operation.active = false;
      settled.resolve();
    },
  };
}

export async function withClientVoiceSessionSettlement<T>(
  run: () => Promise<T>,
  onAdmissionFailure?: (error: unknown) => Promise<T>,
  source?: OpenClawStateWorkerContext,
): Promise<T> {
  let accepted: ReturnType<typeof captureClientVoiceSessionSettlement> | undefined;
  let entered = false;
  try {
    accepted = captureClientVoiceSessionSettlement(source);
    return await accepted.run(() => {
      entered = true;
      return run();
    });
  } catch (error) {
    // Close still owns provider teardown after refusal, but may not replay entered work.
    if (!entered && onAdmissionFailure) {
      return await onAdmissionFailure(error);
    }
    throw error;
  } finally {
    accepted?.release();
  }
}

export function assertClientVoiceSessionAdmission(source?: OpenClawStateWorkerContext): void {
  const accepted = captureClientVoiceSessionSettlement(source);
  accepted.release();
}

function matchesSettlementContext(
  left: OpenClawStateWorkerContext,
  right: OpenClawStateWorkerContext,
) {
  return (
    left.admission.coordinationKey === right.admission.coordinationKey &&
    left.admission.identity.key === right.admission.identity.key &&
    left.admission.identity.birthtime === right.admission.identity.birthtime
  );
}

export function assertClientVoiceSessionSettlementCurrent(
  source?: OpenClawStateWorkerContext,
): void {
  const accepted = current.getStore();
  if (accepted && (!source || matchesSettlementContext(accepted.context, source))) {
    if (!accepted.active) {
      throw new Error("Voice session persistence lost its accepted owner");
    }
    accepted.context.admission.assertCurrent();
  }
}

export function prepareClientVoiceSessionClose() {
  return lifetime(captureOpenClawStateWorkerContext()).retainGateway();
}
