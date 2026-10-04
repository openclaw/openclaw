import { AsyncLocalStorage } from "node:async_hooks";
import { isNativeError } from "node:util/types";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
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
    run<T>(run: () => Promise<T>): Promise<T> {
      if (closing) {
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
        lifetimes.delete(admission.coordinationKey);
        unregister();
      }
    },
  });
  return owner;
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

export function withWorktreeRunEnd<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const context = captureWorktreeRunEndContext(env);
  if (current.getStore()) {
    return trackAsyncWork(run);
  }
  const operation: RunEndOperation = { context, active: true };
  return lifetime(context).run(() =>
    current.run(operation, async () => {
      try {
        return await run();
      } finally {
        operation.active = false;
      }
    }),
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
