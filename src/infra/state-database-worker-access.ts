import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Grants are synchronous; callbacks must not carry this refusal into later async work.
const workerNativeAccess = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseWorkerNativeAccess"),
  (): Array<(() => void) | undefined> => [],
);

export function assertStateDatabaseWorkerAccessAllowed(): void {
  workerNativeAccess.at(-1)?.();
}

export function withStateDatabaseWorkerGrant<T>(operation: () => T): T {
  workerNativeAccess.push(undefined);
  try {
    return operation();
  } finally {
    workerNativeAccess.pop();
  }
}

export function withoutStateDatabaseWorkerAccess(message: string, operation: () => void): void {
  if (workerNativeAccess.length === 0) {
    return operation();
  }
  workerNativeAccess.push(() => {
    throw new Error(message);
  });
  try {
    operation();
  } finally {
    workerNativeAccess.pop();
  }
}
